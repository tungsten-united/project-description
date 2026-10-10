import { describe, expect, it } from 'vitest';
import { cameraHeading, StepDetector, STEP } from './tracker';

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
