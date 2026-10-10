import { DEFAULT_STEP_LENGTH_M, StepDetector, cameraHeading } from '../motion/tracker';
import type { Holding, MapApi, Manifest, SampleBatch, Tag } from './mapApi';
import type { UploadQueue } from './uploadQueue';

/**
 * One mapping walk: full rear-camera video, raw motion and orientation, push-to-talk voice notes and tags,
 * uploaded to map-api while walking. Ported from the nav-engine recorder (frontend/app.js) with the same
 * recording format (nav/schemas/recording.py), so the map pipeline reads both alike.
 * One clock for everything: t_ms = performance.now() - t0 (event.timeStamp shares that time base).
 */

const VIDEO_TIMESLICE_MS = 2000;
const BATCH_MS = 1000;
const VIDEO_BPS = 5_000_000;
// WebM first: Chrome's MP4 muxer only emits data at keyframes (in practice at stop), WebM honours the timeslice.
// H.264 is copied into video.mp4 on the server without re-encoding. iOS Safari only offers MP4.
export const VIDEO_MIMES = [
  'video/webm;codecs=h264',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1',
  'video/mp4',
];
export const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
/** Talk pressed shorter than this toggles instead of push-to-talk. */
export const TAP_MS = 350;

export interface WalkOptions {
  place: string;
  notes: string;
  holding: Holding;
  stepLengthM: number;
}

export interface WalkSnapshot {
  elapsedMs: number;
  steps: number;
  /** Display only: steps in the last window times the step length. The real estimate is computed offline. */
  speedMps: number;
  heading: number | null;
  talking: boolean;
}

type Row = Record<string, number | boolean | string | null>;
interface WalkEvent {
  t_ms: number;
  type: string;
  data: Record<string, unknown>;
}

const r4 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const pick = (list: string[]) =>
  list.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
const buzz = (ms: number) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // no vibration motor or not allowed
  }
};

interface PermissionAware {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

type OrientationLike = DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };

export class Walk {
  readonly id: string;
  readonly video: MediaStream;
  readonly audio: MediaStream | null;
  readonly warnings: string[];
  readonly place: string;
  private readonly t0: number;
  private readonly stepLength: number;
  private readonly audioMime = pick(AUDIO_MIMES);
  private readonly detector = new StepDetector();
  private imu: Row[] = [];
  private orientation: Row[] = [];
  private events: WalkEvent[] = [];
  private batchSeq = 0;
  private videoSeq = 0;
  private clipSeq = 0;
  private heading: number | null = null;
  private recorder: MediaRecorder | null = null;
  private stopped: Promise<unknown> = Promise.resolve();
  private voice: MediaRecorder | null = null;
  private voiceDone: Promise<unknown> | null = null;
  /** null while held, true after a short tap (keeps talking), false when the next press will stop it. */
  private voiceToggle: boolean | null = null;
  private pressAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private wakeLock: WakeLockSentinel | null = null;
  private stopping = false;
  private readonly orientationEvent =
    'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';

  private constructor(
    private readonly api: MapApi,
    private readonly queue: UploadQueue,
    manifest: Manifest,
    t0: number,
    video: MediaStream,
    audio: MediaStream | null,
    warnings: string[],
  ) {
    this.id = manifest.rec_id;
    this.place = manifest.place;
    this.stepLength = manifest.step_length_m;
    this.t0 = t0;
    this.video = video;
    this.audio = audio;
    this.warnings = warnings;
  }

  /** Call inside the Start tap: iOS (and newer Chrome) only ask for motion access from a user gesture. */
  static async start(api: MapApi, queue: UploadQueue, options: WalkOptions): Promise<Walk> {
    const warnings: string[] = [];
    // A motion denial must not abort recording: video and voice are still useful.
    for (const E of [window.DeviceMotionEvent, window.DeviceOrientationEvent] as unknown as PermissionAware[]) {
      const ask = E?.requestPermission;
      const granted = typeof ask !== 'function' || (await ask.call(E).catch(() => 'denied')) === 'granted';
      if (!granted && !warnings.length) warnings.push('Motion sensors denied: recording video and voice only.');
    }
    if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record video.');
    const video = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
    let audio: MediaStream | null = null;
    try {
      audio = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: false } });
    } catch {
      warnings.push('No microphone: Talk is off, tags still work.');
    }

    try {
      const track = video.getVideoTracks()[0];
      const cs = track.getSettings();
      const mime = pick(VIDEO_MIMES);
      const t0 = performance.now();
      const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
      const manifest = await api.create({
        place: options.place,
        notes: options.notes,
        holding: options.holding,
        step_length_m: options.stepLengthM || DEFAULT_STEP_LENGTH_M,
        t0_epoch_ms: Math.round(performance.timeOrigin + t0),
        device: {
          user_agent: navigator.userAgent,
          platform: nav.userAgentData?.platform || navigator.platform || null,
          screen_w: screen.width,
          screen_h: screen.height,
          pixel_ratio: devicePixelRatio,
        },
        camera: {
          width: cs.width ?? 0,
          height: cs.height ?? 0,
          fps: cs.frameRate ?? null,
          mime: mime || 'video/webm',
          facing: cs.facingMode ?? null,
          label: track.label || null,
        },
      });
      const walk = new Walk(api, queue, manifest, t0, video, audio, warnings);
      await walk.begin(mime);
      return walk;
    } catch (error) {
      [video, audio].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
      throw error;
    }
  }

  private now() {
    return performance.now() - this.t0;
  }

  private at(ts: number) {
    return r4(ts - this.t0) as number;
  }

  private event(type: string, data: Record<string, unknown> = {}, t = this.now()) {
    this.events.push({ t_ms: r4(t) as number, type, data });
  }

  private async begin(mime: string) {
    this.event('start', { rec_id: this.id });
    const recorder = new MediaRecorder(this.video, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: VIDEO_BPS,
      // Not in the TypeScript DOM types yet; Chrome uses it to keep chunks arriving every timeslice.
      videoKeyFrameIntervalDuration: 1000,
    } as MediaRecorderOptions);
    recorder.onstart = () => this.event('video_start', { mime: recorder.mimeType });
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const seq = this.videoSeq++;
      this.event('video_chunk', { seq, bytes: e.data.size });
      this.queue.add(`video ${seq}`, e.data.size, () => this.api.putVideo(this.id, seq, e.data));
    };
    this.stopped = new Promise((resolve) => (recorder.onstop = resolve));
    this.recorder = recorder;
    recorder.start(VIDEO_TIMESLICE_MS);
    this.listen(true);
    this.timer = setInterval(() => this.flush(), BATCH_MS);
    await this.lockScreen();
    this.warnings.forEach((message) => this.event('error', { message }));
    buzz(80);
  }

  // --- sensors ---------------------------------------------------------------------------------------------
  private onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    const l = e.acceleration;
    const g = e.rotationRate;
    if (a?.x == null && g?.alpha == null) return;
    // Chrome (Android) reports rotationRate alpha/beta/gamma around device x/y/z: stored as gx/gy/gz = beta/gamma/alpha.
    this.imu.push({
      t_ms: this.at(e.timeStamp),
      ax: r4(a?.x),
      ay: r4(a?.y),
      az: r4(a?.z),
      lax: r4(l?.x),
      lay: r4(l?.y),
      laz: r4(l?.z),
      gx: r4(g?.beta),
      gy: r4(g?.gamma),
      gz: r4(g?.alpha),
      interval_ms: e.interval ?? null,
    });
    if (a?.x != null && a.y != null && a.z != null && this.detector.push(Math.hypot(a.x, a.y, a.z), e.timeStamp)) {
      const cadence = this.detector.cadence(e.timeStamp);
      this.event('step', { cadence: r4(cadence), speed_mps: r4(cadence * this.stepLength) }, e.timeStamp - this.t0);
    }
  };

  private onOrientation = (e: OrientationLike) => {
    if (e.alpha == null && e.webkitCompassHeading == null) return;
    const absolute = e.type === 'deviceorientationabsolute' || !!e.absolute;
    let heading: number | null = null;
    if (e.webkitCompassHeading != null) heading = e.webkitCompassHeading; // iOS: already relative to north
    else if (absolute && e.alpha != null && e.beta != null && e.gamma != null)
      heading = cameraHeading(e.alpha, e.beta, e.gamma);
    this.orientation.push({
      t_ms: this.at(e.timeStamp),
      alpha: r4(e.alpha),
      beta: r4(e.beta),
      gamma: r4(e.gamma),
      absolute,
      compass_deg: r4(e.webkitCompassHeading),
      compass_acc: r4(e.webkitCompassAccuracy),
      heading_deg: r4(heading),
      screen_angle: screen.orientation?.angle ?? null,
    });
    if (heading != null) this.heading = heading;
  };

  private onVisibility = () => {
    this.event(document.hidden ? 'hidden' : 'visible');
    if (!document.hidden) void this.lockScreen();
  };

  private onRotate = () => this.event('orientation_change', { angle: screen.orientation?.angle ?? null });

  private async lockScreen() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      // not supported, or the page is hidden
    }
  }

  private listen(on: boolean) {
    const f = on ? 'addEventListener' : 'removeEventListener';
    window[f]('devicemotion', this.onMotion as EventListener);
    window[f](this.orientationEvent, this.onOrientation as EventListener);
    document[f]('visibilitychange', this.onVisibility);
    screen.orientation?.[f]('change', this.onRotate);
  }

  private flush() {
    if (!this.imu.length && !this.orientation.length && !this.events.length) return;
    const batch: SampleBatch = { seq: this.batchSeq++, imu: this.imu, orientation: this.orientation, events: this.events };
    this.imu = [];
    this.orientation = [];
    this.events = [];
    this.queue.add(`samples ${batch.seq}`, JSON.stringify(batch).length, () => this.api.postSamples(this.id, batch));
  }

  snapshot(): WalkSnapshot {
    const ts = performance.now();
    return {
      elapsedMs: this.now(),
      steps: this.detector.count,
      speedMps: this.detector.cadence(ts) * this.stepLength,
      heading: this.heading,
      talking: this.voice != null,
    };
  }

  // --- tags and push-to-talk ---------------------------------------------------------------------------------
  tag(tag: Tag) {
    this.event('mark', { tag });
    buzz(60);
  }

  /** Talk pressed. Returns true when a voice note started. */
  pressTalk(): boolean {
    if (!this.audio || this.stopping) return false;
    if (this.voice) {
      this.voiceToggle = false; // pressed while toggled on: stops on release
      return false;
    }
    this.pressAt = performance.now();
    this.startVoice();
    return true;
  }

  /** Talk released. Returns what the note is doing now. */
  releaseTalk(): 'toggled' | 'stopped' | 'talking' | 'idle' {
    if (!this.voice) return 'idle';
    if (this.voiceToggle === null && performance.now() - this.pressAt < TAP_MS) {
      this.voiceToggle = true; // short tap: keep talking until the next tap
      return 'toggled';
    }
    if (this.voiceToggle) return 'talking';
    this.stopVoice();
    return 'stopped';
  }

  private startVoice() {
    const clip = this.clipSeq++;
    const rec = new MediaRecorder(this.audio!, this.audioMime ? { mimeType: this.audioMime } : {});
    const parts: Blob[] = [];
    const tStart = r4(this.now()) as number;
    rec.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    rec.onstop = () => {
      const tEnd = r4(this.now()) as number;
      const blob = new Blob(parts, { type: rec.mimeType || this.audioMime || 'audio/webm' });
      this.queue.add(`voice ${clip}`, blob.size, () => this.api.putVoice(this.id, clip, blob, tStart, tEnd));
      this.event('voice_end', { clip }, tEnd);
    };
    this.voiceDone = new Promise((resolve) => rec.addEventListener('stop', resolve));
    rec.start();
    this.voice = rec;
    this.voiceToggle = null;
    this.event('voice_start', { clip });
    buzz(30);
  }

  private stopVoice() {
    if (!this.voice) return;
    this.voice.stop();
    this.voice = null;
    this.voiceToggle = null;
    buzz(30);
  }

  // --- stop --------------------------------------------------------------------------------------------------
  /**
   * Stops capture, waits for every upload, tells map-api the walk is over and waits while it processes.
   * `progress` gets short status lines for the screen.
   */
  async stop(progress: (line: string) => void): Promise<Manifest> {
    if (this.stopping) throw new Error('Already stopping');
    this.stopping = true;
    const voiceDone = this.voice && this.voiceDone;
    this.stopVoice();
    await voiceDone; // its upload is queued
    this.event('stop');
    this.recorder?.stop();
    await this.stopped; // the last video chunk is queued
    this.listen(false);
    clearInterval(this.timer);
    this.flush();
    this.video.getTracks().forEach((t) => t.stop());
    this.audio?.getTracks().forEach((t) => t.stop());
    this.wakeLock?.release().catch(() => {});

    const report = () => progress(`Uploading… ${this.queue.state().pending} left`);
    report();
    const unsubscribe = this.queue.subscribe(report);
    await this.queue.idle();
    unsubscribe();

    const fin = {
      duration_ms: r4(this.now()) as number,
      video_chunks: this.videoSeq,
      sample_batches: this.batchSeq,
      voice_clips: this.clipSeq,
    };
    let manifest: Manifest | null = null;
    for (let i = 0; !manifest; i++) {
      manifest = await this.api.finish(this.id, fin).catch(() => null);
      if (!manifest) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** i, 15000)));
    }
    progress('Processing on the server…');
    while (manifest.status === 'finalizing' || manifest.status === 'recording') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      manifest = (await this.api.get(manifest.rec_id).catch(() => null)) ?? manifest;
    }
    buzz(120);
    return manifest;
  }
}
