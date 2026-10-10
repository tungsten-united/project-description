import type { Motion } from '../session/types';

/**
 * Ported from the nav-engine recorder (frontend/app.js, main at 73dfa7a), which now lives here as /map
 * (mapping/recorder.ts uses this detector and heading), so live and recorded walks agree.
 * The live speed is a 4 s window average. The recorder calls it "display only"; the better
 * estimate there is computed offline with zero-phase filters that cannot run live.
 */
export const STEP = { lpMs: 60, baseMs: 1500, varMs: 3000, frac: 0.4, floor: 0.1, minGapMs: 400, windowMs: 4000, minSteps: 3 };
export const DEFAULT_STEP_LENGTH_M = 0.7;

/** Step detector on |acceleration including gravity|: low-pass, slow baseline, bounce above a fraction of its own size. */
export class StepDetector {
  private last: number | null = null;
  private lp = 0;
  private base = 0;
  private variance = 0.04;
  private armed = true;
  private times: number[] = [];
  count = 0;

  /** Feeds one magnitude sample (m/s^2) at time `ts` (ms). Returns true when it completes a step. */
  push(magnitude: number, ts: number): boolean {
    if (this.last == null) {
      this.lp = this.base = magnitude;
      this.last = ts;
      return false;
    }
    const dt = Math.max(ts - this.last, 1);
    const k = (tau: number) => 1 - Math.exp(-dt / tau); // time constants, any sensor rate
    this.last = ts;
    this.lp += k(STEP.lpMs) * (magnitude - this.lp);
    this.base += k(STEP.baseMs) * (this.lp - this.base);
    const d = this.lp - this.base;
    this.variance += k(STEP.varMs) * (d * d - this.variance);
    const hi = Math.max(STEP.floor, STEP.frac * Math.sqrt(this.variance));
    if (this.armed && d > hi) {
      this.armed = false;
      const previous = this.times.at(-1);
      if (previous === undefined || ts - previous > STEP.minGapMs) {
        this.times.push(ts);
        this.count += 1;
        return true;
      }
    } else if (!this.armed && d < -0.3 * hi) {
      this.armed = true;
    }
    return false;
  }

  /** Steps per second over the last window, 0 below the minimum step count. */
  cadence(ts: number): number {
    this.times = this.times.filter((t) => ts - t < STEP.windowMs);
    return this.times.length >= STEP.minSteps ? this.times.length / (STEP.windowMs / 1000) : 0;
  }
}

/** Heading of the rear-camera axis (device -z) from W3C Euler angles. Degrees clockwise from north. */
export function cameraHeading(alpha: number, beta: number, gamma: number): number | null {
  const r = Math.PI / 180;
  const cA = Math.cos(alpha * r);
  const sA = Math.sin(alpha * r);
  const sB = Math.sin(beta * r);
  const cG = Math.cos(gamma * r);
  const sG = Math.sin(gamma * r);
  const east = -cA * sG - sA * sB * cG;
  const north = -sA * sG + cA * sB * cG;
  if (Math.hypot(east, north) < 0.2) return null; // camera pointing at the floor or ceiling
  return (Math.atan2(east, north) / r + 360) % 360;
}

export type MotionPermission = 'granted' | 'denied' | 'unsupported';

/** Which sensors have reported since start(). */
export interface MotionReadiness {
  motion: boolean;
  orientation: boolean;
}

/** How long start-up waits for the first accelerometer sample. Sensors report at 50-60 Hz. */
export const MOTION_READY_MS = 2000;
/** Once the accelerometer reports, how much longer to wait for the compass, for the log only. */
const ORIENTATION_GRACE_MS = 300;

export interface MotionSource {
  /**
   * Asks for motion access (iOS, newer Chrome) and starts listening. Call inside the Start tap.
   * Listens even after a denial: what decides is whether samples arrive (see ready()).
   */
  start(): Promise<MotionPermission>;
  /** Resolves once the accelerometer has reported since start(), or after `timeoutMs` without. */
  ready(timeoutMs?: number): Promise<MotionReadiness>;
  stop(): void;
  /** Current motion, or null when no sensor has reported yet. `measuredAt` is local `Date.now()`. */
  snapshot(): Motion | null;
}

export const noMotion: MotionSource = {
  start: async () => 'unsupported',
  ready: async () => ({ motion: false, orientation: false }),
  stop() {},
  snapshot: () => null,
};

interface PermissionAware {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export function createMotionTracker(stepLengthM = DEFAULT_STEP_LENGTH_M): MotionSource {
  const detector = new StepDetector();
  let sawMotion = false;
  let sawOrientation = false;
  let lastSampleAt = 0;
  let heading: number | null = null;
  let source: Motion['headingSource'] = null;
  let accuracy: number | null = null;
  let angles: Motion['orientation'] = null;

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    sawMotion = true;
    lastSampleAt = Date.now();
    detector.push(Math.hypot(a.x, a.y, a.z), e.timeStamp);
  };

  const onOrientation = (e: DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number }) => {
    const compass = e.webkitCompassHeading;
    if (e.alpha == null && compass == null) return;
    sawOrientation = true;
    lastSampleAt = Date.now();
    const absolute = e.type === 'deviceorientationabsolute' || e.absolute;
    if (compass != null) {
      heading = compass; // iOS: already relative to north
      source = 'compass_ios';
      accuracy = e.webkitCompassAccuracy ?? null;
    } else if (absolute && e.alpha != null && e.beta != null && e.gamma != null) {
      heading = cameraHeading(e.alpha, e.beta, e.gamma);
      source = heading == null ? null : 'orientation_absolute';
      accuracy = null;
    }
    angles =
      e.alpha != null && e.beta != null && e.gamma != null
        ? { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute }
        : null;
  };

  const orientationEvent = typeof window !== 'undefined' && 'ondeviceorientationabsolute' in window
    ? 'deviceorientationabsolute'
    : 'deviceorientation';

  return {
    async start() {
      if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return 'unsupported';
      sawMotion = false; // a new run must prove its own samples
      sawOrientation = false;
      // iOS (and newer Chrome) ask inside the tap. Both requests are made before either is awaited.
      const asks = [window.DeviceMotionEvent, window.DeviceOrientationEvent as unknown as PermissionAware | undefined].map(
        (E) => (E as PermissionAware | undefined)?.requestPermission?.().catch(() => 'denied' as const),
      );
      const results = await Promise.all(asks);
      // Android Chrome 155 answered "denied" without a prompt on every start (2026-10-10). Listen anyway:
      // if samples still arrive, motion works; if not, ready() says so and the session does not start.
      window.addEventListener('devicemotion', onMotion);
      window.addEventListener(orientationEvent, onOrientation as EventListener);
      return results.some((r) => r === 'denied') ? 'denied' : 'granted';
    },
    ready(timeoutMs = MOTION_READY_MS) {
      return new Promise<MotionReadiness>((resolve) => {
        const begun = Date.now();
        let motionAt: number | null = null;
        let timer: ReturnType<typeof setInterval> | undefined;
        const check = () => {
          const now = Date.now();
          if (sawMotion && motionAt == null) motionAt = now;
          const done =
            (sawMotion && sawOrientation) ||
            (motionAt != null && now - motionAt >= ORIENTATION_GRACE_MS) ||
            now - begun >= timeoutMs;
          if (!done) return false;
          clearInterval(timer);
          resolve({ motion: sawMotion, orientation: sawOrientation });
          return true;
        };
        if (!check()) timer = setInterval(check, 50);
      });
    },
    stop() {
      if (typeof window === 'undefined') return;
      window.removeEventListener('devicemotion', onMotion);
      window.removeEventListener(orientationEvent, onOrientation as EventListener);
    },
    snapshot() {
      if (!sawMotion && !sawOrientation) return null;
      const now = performance.now();
      const cadence = detector.cadence(now);
      const walked = detector.count >= STEP.minSteps;
      return {
        speedMps: walked ? Math.round(cadence * stepLengthM * 1e4) / 1e4 : null,
        cadenceHz: Math.round(cadence * 1e4) / 1e4,
        stepCount: detector.count,
        stepLengthM,
        headingDeg: heading == null ? null : Math.round(heading * 1e4) / 1e4,
        headingSource: source,
        headingAccuracyDeg: accuracy,
        orientation: angles,
        measuredAt: lastSampleAt,
      };
    },
  };
}
