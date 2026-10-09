import type { StopReason } from './types';

/** Client states from the table in docs/contracts.md. */
export type ClientState = 'idle' | 'prompting' | 'listening' | 'waiting' | 'speaking' | 'stopped';

export interface ViewState {
  state: ClientState;
  /** Last sentence spoken, shown as large text for low-vision users. */
  spoken: string;
  stopReason: StopReason | null;
  error: string | null;
}

export type MachineEvent =
  | { type: 'start' }
  | { type: 'prompt_started'; text: string }
  | { type: 'prompt_done' }
  | { type: 'recording_done' }
  | { type: 'speak'; text: string }
  | { type: 'speech_done'; then: 'listen' | 'wait' }
  | { type: 'stop'; reason: StopReason; error?: string };

export const initialView: ViewState = { state: 'idle', spoken: '', stopReason: null, error: null };

export function reduce(view: ViewState, event: MachineEvent): ViewState {
  switch (event.type) {
    case 'start':
      return view.state === 'idle' || view.state === 'stopped'
        ? { state: 'prompting', spoken: '', stopReason: null, error: null }
        : view;
    case 'prompt_started':
      return view.state === 'prompting' ? { ...view, spoken: event.text } : view;
    case 'prompt_done':
      return view.state === 'prompting' ? { ...view, state: 'listening' } : view;
    case 'recording_done':
      return view.state === 'listening' ? { ...view, state: 'waiting' } : view;
    case 'speak':
      // One utterance at a time: ignore anything that arrives while speaking.
      return view.state === 'waiting' ? { ...view, state: 'speaking', spoken: event.text } : view;
    case 'speech_done':
      if (view.state !== 'speaking') return view;
      return { ...view, state: event.then === 'listen' ? 'listening' : 'waiting' };
    case 'stop':
      return view.state === 'idle' || view.state === 'stopped'
        ? view
        : { ...view, state: 'stopped', stopReason: event.reason, error: event.error ?? null };
  }
}

export const isRunning = (s: ClientState) => s !== 'idle' && s !== 'stopped';
