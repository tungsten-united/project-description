import { describe, expect, it } from 'vitest';
import { audioConstraints, Gate, NoiseFloor, rms, toDb, VOICE } from './voiceIsolation';

describe('rms and decibels', () => {
  it('measures a square wave and silence', () => {
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([])).toBe(0);
  });
  it('converts to dBFS', () => {
    expect(toDb(1)).toBeCloseTo(0);
    expect(toDb(0.1)).toBeCloseTo(-20);
    expect(toDb(0)).toBe(-120);
  });
});

describe('noise floor', () => {
  it('stays near the background even while speech is loud', () => {
    const f = new NoiseFloor(100, 0.2);
    for (let i = 0; i < 100; i++) f.push(i % 3 === 0 ? 0.3 : 0.01); // two thirds quiet, one third speech bursts
    expect(f.value()).toBeCloseTo(0.01);
  });
  it('is zero before any data', () => {
    expect(new NoiseFloor().value()).toBe(0);
  });
});

describe('gate', () => {
  const quietFloor = 0.004;
  it('stays closed for room noise and a far voice', () => {
    const g = new Gate();
    expect(g.step(0.006, quietFloor, 0)).toBe(false); // below the 0.012 absolute minimum
    expect(g.step(0.011, quietFloor, 20)).toBe(false);
  });
  it('opens for a near voice and holds briefly, then closes', () => {
    const g = new Gate();
    expect(g.step(0.08, quietFloor, 0)).toBe(true);
    expect(g.step(0.002, quietFloor, VOICE.holdMs - 10)).toBe(true);
    expect(g.step(0.002, quietFloor, VOICE.holdMs + 50)).toBe(false);
  });
  it('raises its threshold with a noisy room', () => {
    const g = new Gate();
    const noisyFloor = 0.05; // threshold = 0.158
    expect(g.step(0.1, noisyFloor, 0)).toBe(false);
    expect(g.step(0.2, noisyFloor, 20)).toBe(true);
  });
});

describe('audio constraints', () => {
  it('turns automatic gain control off in isolation mode and asks for voice isolation when supported', () => {
    expect(audioConstraints(true, { voiceIsolation: true })).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      voiceIsolation: true,
    });
  });
  it('keeps the browser defaults otherwise, and never sets an unsupported constraint', () => {
    const c = audioConstraints(false, { voiceIsolation: true });
    expect(c.autoGainControl).toBe(true);
    expect('voiceIsolation' in c).toBe(false);
    expect('voiceIsolation' in audioConstraints(true, {})).toBe(false);
  });
});
