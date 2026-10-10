import { describe, expect, it } from 'vitest';
import { describePhoneEvent, describeServerEntry, formatLine } from './timeline';

describe('phone events', () => {
  it('summarises Start with browser and OS, not the raw user agent', () => {
    const line = describePhoneEvent(
      'info',
      'start',
      'ua=Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36 secure=true standalone=false viewport=375x661',
    );
    expect(line).toMatchObject({ src: 'FE' });
    expect(line.text).toBe('START tapped (Chrome 155 on Android, secure=true)');
  });

  it('tags speech output as TTS and warns on a failed fallback', () => {
    expect(describePhoneEvent('info', 'tts_start', 'Where would you like to go?')).toMatchObject({ src: 'TTS' });
    expect(describePhoneEvent('info', 'tts_end', 'failed').level).toBe('warn');
  });

  it('keeps per-frame sends as minor lines', () => {
    expect(describePhoneEvent('info', 'frame_sent', '#14 38 KB').minor).toBe(true);
  });
});

describe('orchestrator trace entries', () => {
  it('splits a voice input into STT, Jev and orchestrator lines', () => {
    const lines = describeServerEntry({
      kind: 'input',
      transcript: 'Go to the stage',
      command: 'start',
      destinationId: 'n8',
      sessionId: 'f41d3254-76b0',
      timingsMs: { stt: 910, command: 209, total: 1377 },
    });
    expect(lines.map((l) => l.src)).toEqual(['STT', 'JEV', 'ORCH']);
    expect(lines[0].text).toBe('heard "Go to the stage" (910 ms)');
    expect(lines[1].text).toBe('command: start → n8 (209 ms)');
  });

  it('adds Jev confidence and the two likeliest choices to the command line', () => {
    const lines = describeServerEntry({
      kind: 'input',
      transcript: 'go to the stage',
      command: 'start',
      destinationId: 'n8',
      timingsMs: { stt: 500, command: 200 },
      jev: { source: 'jev', choice: 'n8', confidence: 0.86, probabilities: { n8: 0.9, unsupported: 0.08, cancel: 0.02 } },
    });
    expect(lines.find((l) => l.src === 'JEV')!.text).toBe('command: start → n8, conf 0.86 (n8 0.90, unsupported 0.08) (200 ms)');
  });

  it('marks the keyword fallback and a failed Jev call', () => {
    const base = { kind: 'input', transcript: 'kitchen', command: 'start', destinationId: 'n7' };
    expect(describeServerEntry({ ...base, jev: { source: 'keywords' } }).find((l) => l.src === 'JEV')!.text).toContain('[keywords, no Jev]');
    expect(describeServerEntry({ ...base, jev: { source: 'jev', error: 'timeout' } }).find((l) => l.src === 'JEV')!.text).toContain('[jev error: timeout]');
  });

  it('shows the worth-saying answer with its confidence', () => {
    const lines = describeServerEntry({
      kind: 'frame',
      spoke: false,
      quietReason: 'not_worth_saying',
      action: 'continue',
      routeStepId: 'n2',
      timingsMs: { jev: 210, total: 400 },
      jev: { source: 'jev', choice: 'quiet', confidence: 0.81, probabilities: { quiet: 0.81, speak: 0.19 } },
    });
    expect(lines.find((l) => l.src === 'JEV')!.text).toBe('worth saying? no, says quiet, conf 0.81 (quiet 0.81, speak 0.19) (210 ms)');
  });

  it('shows the GPU embed time and the localization verdict for a frame', () => {
    const lines = describeServerEntry({
      kind: 'frame',
      requestId: 'aaaaaaaa-0000-0000-0000-000000abcd12',
      framesSent: 4,
      action: 'wait',
      routeStepId: 'n1',
      spoke: false,
      timingsMs: { localize: 168, total: 300 },
      localize: {
        status: 'lost',
        margin: 0.03,
        candidates: [{ node: 'n4', name: 'Stage corridor', score: 0.42 }],
        took_ms: { embed: 30, total: 40 },
      },
    });
    const nav = lines.find((l) => l.src === 'NAV')!;
    expect(nav.level).toBe('warn');
    expect(nav.text).toContain('lost');
    expect(nav.text).toContain('best n4 Stage corridor score 0.42');
    expect(nav.text).toContain('GPU embed 30 ms');
    const decision = lines.find((l) => l.src === 'ORCH')!;
    expect(decision.text).toContain('quiet (unchanged)');
    expect(decision.minor).toBe(true);
  });

  it('prints the spoken sentence and the route hop when guidance is sent', () => {
    const lines = describeServerEntry({
      kind: 'frame',
      spoke: true,
      action: 'turn',
      routeStepId: 'n2',
      text: 'Turn left at the drinks cooler.',
      localize: { status: 'confirmed', candidates: [{ node: 'n2', name: 'Drinks', score: 0.71 }], took_ms: { embed: 28 } },
      route: { found: true, length_m: 9.3, hops: [{ source: 'n2', target: 'n3', instruction: 'Bear left past the cooler.' }] },
      timingsMs: { localize: 150, route: 30, total: 320 },
    });
    expect(lines.map((l) => l.src)).toEqual(['NAV', 'NAV', 'ORCH']);
    expect(lines[1].text).toContain('route n2 → n3');
    expect(lines[2].text).toContain('decision: SPEAK turn at n2');
  });

  it('calls out an echo drop and a stale frame', () => {
    const echo = describeServerEntry({ kind: 'input', transcript: 'Please hold still', command: 'empty', dropped: 'echo' });
    expect(echo.some((l) => l.text.includes('echo'))).toBe(true);
    const stale = describeServerEntry({ kind: 'frame', dropped: 'stale_generation', action: 'wait' });
    expect(stale.some((l) => l.text.includes('dropped: stale_generation'))).toBe(true);
  });

  it('formats lines with a time since Start and a flag for warnings', () => {
    const text = formatLine({ id: 1, at: 12_400, src: 'NAV', level: 'warn', text: 'localize lost' }, 0);
    expect(text).toBe('  +12.40s NAV?  localize lost');
  });
});
