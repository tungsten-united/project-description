import { describe, expect, it } from 'vitest';
import { initialView, reduce, type MachineEvent, type ViewState } from './machine';

const run = (events: MachineEvent[], from: ViewState = initialView) => events.reduce(reduce, from);

describe('client state machine', () => {
  it('follows the happy path from the contract table', () => {
    const v = run([
      { type: 'start' },
      { type: 'prompt_done' },
      { type: 'recording_done' },
      { type: 'speak', text: 'Turn left.' },
      { type: 'speech_done', then: 'wait' },
    ]);
    expect(v.state).toBe('waiting');
    expect(v.spoken).toBe('Turn left.');
  });

  it('returns to listening after needs_input speech', () => {
    const v = run([
      { type: 'start' },
      { type: 'prompt_done' },
      { type: 'recording_done' },
      { type: 'speak', text: 'Say it again.' },
      { type: 'speech_done', then: 'listen' },
    ]);
    expect(v.state).toBe('listening');
  });

  it('ignores speech that arrives while already speaking', () => {
    const v = run([
      { type: 'start' },
      { type: 'prompt_done' },
      { type: 'recording_done' },
      { type: 'speak', text: 'first' },
      { type: 'speak', text: 'second' },
    ]);
    expect(v.spoken).toBe('first');
  });

  it('stop works from every running state and records the reason', () => {
    const states: MachineEvent[][] = [
      [{ type: 'start' }],
      [{ type: 'start' }, { type: 'prompt_done' }],
      [{ type: 'start' }, { type: 'prompt_done' }, { type: 'recording_done' }],
      [{ type: 'start' }, { type: 'prompt_done' }, { type: 'recording_done' }, { type: 'speak', text: 'x' }],
    ];
    for (const events of states) {
      const v = run([...events, { type: 'stop', reason: 'user_stop' }]);
      expect(v.state).toBe('stopped');
      expect(v.stopReason).toBe('user_stop');
    }
  });

  it('does not restart from late events after stop', () => {
    const v = run([{ type: 'start' }, { type: 'stop', reason: 'user_stop' }, { type: 'prompt_done' }, { type: 'speak', text: 'late' }]);
    expect(v.state).toBe('stopped');
    expect(v.spoken).toBe('');
  });

  it('keeps technical detail from an error stop and clears it on restart', () => {
    const stopped = run([{ type: 'start' }, { type: 'stop', reason: 'error', error: 'x', detail: 'NotAllowedError: denied' }]);
    expect(stopped.detail).toBe('NotAllowedError: denied');
    expect(reduce(stopped, { type: 'start' }).detail).toBeNull();
  });

  it('allows a new session after stop', () => {
    const v = run([{ type: 'start' }, { type: 'stop', reason: 'error', error: 'x' }, { type: 'start' }]);
    expect(v.state).toBe('prompting');
    expect(v.error).toBeNull();
  });
});
