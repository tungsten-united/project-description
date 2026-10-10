/**
 * Client-side "nearest voice wins" for a room full of other phones and people.
 *
 * What it can and cannot do: it uses the browser's echo cancellation and noise suppression, removes rumble,
 * and gates the microphone so that anything much quieter than the person holding the phone is muted. It cannot
 * separate two voices at the same loudness, and it cannot tell whose voice is whose. All constants are
 * untuned guesses and must be checked on the demo phone in the demo room (the debug panel has a switch).
 */

export const VOICE = {
  highPassHz: 120,
  /** Audio delay so the gate opens before the word it opens for arrives. */
  lookaheadMs: 80,
  frameMs: 20,
  /** Gate opens above the noise floor times this (10 dB). */
  margin: 3.16,
  /** Absolute floor for the gate threshold, about -38 dBFS. A silent room must not open the gate. */
  minThreshold: 0.012,
  holdMs: 250,
  attackSeconds: 0.01,
  releaseSeconds: 0.08,
  /** Noise floor is this percentile of the last windowMs of frame levels. */
  floorPercentile: 0.2,
  windowMs: 3000,
  makeupGain: 2, // +6 dB, since automatic gain control is off in this mode
} as const;

export const toDb = (linear: number) => (linear <= 0 ? -120 : 20 * Math.log10(linear));

/** Root mean square of a block of samples in [-1, 1]. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Slow estimate of the background level: a low percentile of recent frame levels, so speech does not raise it. */
export class NoiseFloor {
  private levels: number[] = [];
  constructor(
    private readonly capacity = Math.round(VOICE.windowMs / VOICE.frameMs),
    private readonly percentile = VOICE.floorPercentile,
  ) {}

  push(level: number): void {
    this.levels.push(level);
    if (this.levels.length > this.capacity) this.levels.shift();
  }

  value(): number {
    if (this.levels.length === 0) return 0;
    const sorted = [...this.levels].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * this.percentile))];
  }
}

/** Opens above max(minThreshold, floor x margin), then stays open for holdMs after the level falls. */
export class Gate {
  private heldUntil = -Infinity;
  isOpen = false;

  step(level: number, floor: number, nowMs: number): boolean {
    const threshold = Math.max(VOICE.minThreshold, floor * VOICE.margin);
    if (level >= threshold) this.heldUntil = nowMs + VOICE.holdMs;
    this.isOpen = nowMs <= this.heldUntil;
    return this.isOpen;
  }
}

export interface VoiceStats {
  noiseFloorDb: number;
  peakDb: number;
  openRatio: number;
  frames: number;
}

/** Audio constraints for getUserMedia. With isolation on, automatic gain control is off so far voices are not boosted. */
export function audioConstraints(isolation: boolean, supported: Record<string, boolean | undefined> = {}) {
  const constraints: Record<string, unknown> = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: !isolation,
    channelCount: 1,
  };
  if (isolation && supported.voiceIsolation) constraints.voiceIsolation = true;
  return constraints;
}

const PREF_KEY = 'orient.voiceIsolation';

/** Build default from VITE_VOICE_ISOLATION, overridden per device by the debug panel switch. */
export function voiceIsolationEnabled(buildDefault = import.meta.env.VITE_VOICE_ISOLATION === 'true'): boolean {
  try {
    const stored = localStorage.getItem(PREF_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // storage blocked: use the build default
  }
  return buildDefault;
}

export function setVoiceIsolation(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

export interface VoiceChain {
  /** The processed audio, to give to MediaRecorder. */
  output: MediaStream;
  stats(): VoiceStats;
  dispose(): void;
}

/** microphone -> high-pass -> (level tap) -> delay -> gate -> makeup gain -> limiter -> recorder. */
export function createVoiceChain(source: MediaStream): VoiceChain {
  const Ctx: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio is not available');
  const ctx = new Ctx();
  void ctx.resume().catch(() => undefined);

  const input = ctx.createMediaStreamSource(source);
  const highPass = ctx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = VOICE.highPassHz;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const delay = ctx.createDelay(0.5);
  delay.delayTime.value = VOICE.lookaheadMs / 1000;
  const gate = ctx.createGain();
  gate.gain.value = 0;
  const makeup = ctx.createGain();
  makeup.gain.value = VOICE.makeupGain;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  const destination = ctx.createMediaStreamDestination();

  input.connect(highPass);
  highPass.connect(analyser);
  highPass.connect(delay);
  delay.connect(gate);
  gate.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(destination);

  const floor = new NoiseFloor();
  const decision = new Gate();
  const block = new Float32Array(analyser.fftSize);
  let frames = 0;
  let open = 0;
  let peak = 0;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(block);
    const level = rms(block);
    floor.push(level);
    const isOpen = decision.step(level, floor.value(), performance.now());
    gate.gain.setTargetAtTime(isOpen ? 1 : 0, ctx.currentTime, isOpen ? VOICE.attackSeconds : VOICE.releaseSeconds);
    frames += 1;
    if (isOpen) open += 1;
    if (level > peak) peak = level;
  }, VOICE.frameMs);

  return {
    output: destination.stream,
    stats: () => ({
      noiseFloorDb: Math.round(toDb(floor.value())),
      peakDb: Math.round(toDb(peak)),
      openRatio: frames === 0 ? 0 : Math.round((open / frames) * 100) / 100,
      frames,
    }),
    dispose() {
      clearInterval(timer);
      input.disconnect();
      void ctx.close().catch(() => undefined);
    },
  };
}
