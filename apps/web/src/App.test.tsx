import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createMockApi } from './session/mockApi';
import type { SpeechAdapter } from './session/types';

function fakeSpeech() {
  const spoken: string[] = [];
  const stop = vi.fn<() => void>();
  const adapter: SpeechAdapter & { spoken: string[] } = {
    spoken,
    initializeAfterUserGesture: () => undefined,
    speak: (text) => {
      spoken.push(text);
      return Promise.resolve('finished');
    },
    stop,
  };
  return Object.assign(adapter, { stopSpy: stop });
}

describe('App', () => {
  it('starts a session, speaks the prompt and shows Stop', async () => {
    const speech = fakeSpeech();
    render(<App api={createMockApi(10)} speech={speech} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    expect(await screen.findByRole('heading', { name: 'Listening' })).toBeInTheDocument();
    expect(speech.spoken[0]).toMatch(/Where would you like to go/);
    expect(screen.getByRole('button', { name: 'Stop guidance' })).toBeInTheDocument();
  });

  it('runs the scripted route to arrival', async () => {
    const speech = fakeSpeech();
    render(<App api={createMockApi(5)} speech={speech} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Finish recording' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Arrived' })).toBeInTheDocument());
    expect(speech.spoken.at(-1)).toBe('You have arrived at the counter.');
  });

  it('Stop silences speech and ignores late guidance', async () => {
    const speech = fakeSpeech();
    render(<App api={createMockApi(30)} speech={speech} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Finish recording' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop guidance' }));
    expect(screen.getByRole('heading', { name: 'Stopped' })).toBeInTheDocument();
    expect(speech.stopSpy).toHaveBeenCalled();
    const countAtStop = speech.spoken.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(speech.spoken.length).toBe(countAtStop);
    expect(screen.getByRole('heading', { name: 'Stopped' })).toBeInTheDocument();
  });

  it('double tap starts but never stops', async () => {
    render(<App api={createMockApi(10)} speech={fakeSpeech()} />);
    await userEvent.dblClick(screen.getByRole('main'));
    expect(await screen.findByRole('heading', { name: 'Listening' })).toBeInTheDocument();
    await userEvent.dblClick(screen.getByRole('main'));
    expect(screen.getByRole('heading', { name: 'Listening' })).toBeInTheDocument();
  });
});
