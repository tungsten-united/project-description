import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraHeading, createMotionTracker, noMotion, StepDetector, STEP } from './tracker';

/** Bouncing magnitude around gravity at `hz` steps per second, sampled at 50 Hz. */
function walk(detector: StepDetector, hz: number, seconds: number, amplitude = 2): number {
  let steps = 0;
  for (let i = 0; i < seconds * 50; i++) {
    const t = (i / 50) * 1000;
    const mag = 9.81 + amplitude * Math.sin(2 * Math.PI * hz * (t / 1000));
    if (detector.push(mag, t)) steps += 1;
  }
  return steps;
}

describe('step detector', () => {
  it('counts about two steps a second for a 2 Hz bounce', () => {
    const d = new StepDetector();
    const steps = walk(d, 2, 10);
    expect(steps).toBeGreaterThanOrEqual(15);
    expect(steps).toBeLessThanOrEqual(21);
  });

  it('reports cadence only after the minimum number of steps in the window', () => {
    const d = new StepDetector();
    walk(d, 2, 10);
    expect(d.cadence(10_000)).toBeGreaterThan(1.5);
    expect(d.cadence(10_000 + STEP.windowMs + 1000)).toBe(0); // stood still: window empties
  });

  it('finds no steps while standing still', () => {
    const d = new StepDetector();
    expect(walk(d, 2, 10, 0.02)).toBe(0);
  });
});

describe('camera heading', () => {
  it('points north for a phone held upright and facing north', () => {
    expect(cameraHeading(0, 90, 0)).toBeCloseTo(0, 1);
  });

  it('turns clockwise as alpha decreases', () => {
    // W3C alpha grows anticlockwise, so a quarter turn clockwise is alpha = 270.
    expect(cameraHeading(270, 90, 0)).toBeCloseTo(90, 1);
    expect(cameraHeading(180, 90, 0)).toBeCloseTo(180, 1);
  });

  it('is unknown when the camera points at the floor', () => {
    expect(cameraHeading(0, 0, 0)).toBeNull();
  });
});

/** A devicemotion event with acceleration including gravity, as phones send it. */
function motionEvent(): Event {
  return Object.assign(new Event('devicemotion'), { accelerationIncludingGravity: { x: 0, y: 9.81, z: 0 } });
}

describe('motion start-up', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'DeviceMotionEvent');
  });

  function withPermission(answer: 'granted' | 'denied') {
    vi.stubGlobal('DeviceMotionEvent', Object.assign(function DeviceMotionEvent() {}, { requestPermission: () => Promise.resolve(answer) }));
  }

  it('listens after a denial, and is ready when samples still arrive (Android Chrome 155)', async () => {
    withPermission('denied');
    const tracker = createMotionTracker();
    expect(await tracker.start()).toBe('denied');
    window.dispatchEvent(motionEvent());
    expect((await tracker.ready(500)).motion).toBe(true);
    expect(tracker.snapshot()).not.toBeNull();
    tracker.stop();
  });

  it('is not ready when no sample arrives, even if granted', async () => {
    vi.useFakeTimers();
    withPermission('granted');
    const tracker = createMotionTracker();
    expect(await tracker.start()).toBe('granted');
    const ready = tracker.ready(2000);
    await vi.advanceTimersByTimeAsync(2100);
    expect(await ready).toEqual({ motion: false, orientation: false });
    tracker.stop();
  });

  it('needs new samples after a restart', async () => {
    vi.useFakeTimers();
    withPermission('granted');
    const tracker = createMotionTracker();
    await tracker.start();
    window.dispatchEvent(motionEvent());
    tracker.stop();
    await tracker.start();
    const ready = tracker.ready(2000);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await ready).motion).toBe(false);
    tracker.stop();
  });

  it('reports nothing without sensors', async () => {
    expect(await noMotion.start()).toBe('unsupported');
    expect(await noMotion.ready()).toEqual({ motion: false, orientation: false });
  });
});
