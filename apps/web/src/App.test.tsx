import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createFixtureCapture } from './session/capture';
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
    render(<App api={createMockApi(10)} speech={speech} capture={createFixtureCapture()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    expect(await screen.findByRole('heading', { name: 'Listening' })).toBeInTheDocument();
    expect(speech.spoken[0]).toMatch(/Where would you like to go/);
    expect(screen.getByRole('button', { name: 'Stop guidance' })).toBeInTheDocument();
  });

  it('runs the scripted route to arrival', async () => {
    const speech = fakeSpeech();
    render(<App api={createMockApi(5)} speech={speech} capture={createFixtureCapture()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Arrived' })).toBeInTheDocument());
    expect(speech.spoken.at(-1)).toBe('You have arrived at the coffee counter.');
  });

  it('Stop silences speech and ignores late guidance', async () => {
    const speech = fakeSpeech();
    render(<App api={createMockApi(30)} speech={speech} capture={createFixtureCapture()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
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
    render(<App api={createMockApi(10)} speech={fakeSpeech()} capture={createFixtureCapture()} />);
    await userEvent.dblClick(screen.getByRole('main'));
    expect(await screen.findByRole('heading', { name: 'Listening' })).toBeInTheDocument();
    await userEvent.dblClick(screen.getByRole('main'));
    expect(screen.getByRole('heading', { name: 'Listening' })).toBeInTheDocument();
  });
});

describe('speech modes', () => {
  it('keeps the status region quiet while a session runs and announces the outcome after Stop', async () => {
    render(<App api={createMockApi(30)} speech={fakeSpeech()} capture={createFixtureCapture()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    await screen.findByRole('heading', { name: 'Listening' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await userEvent.click(screen.getByRole('button', { name: 'Stop guidance' }));
    expect(screen.getByRole('status')).toHaveTextContent('Stopped');
    expect(screen.getByRole('button', { name: 'Start guidance' })).toHaveFocus();
  });

  it('opt-in mode puts guidance text in a live region and plays no app audio', async () => {
    const speech = fakeSpeech();
    render(<App api={createMockApi(5)} speech={speech} capture={createFixtureCapture()} />);
    await userEvent.click(screen.getByRole('switch', { name: /screen reader/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Done' }, { timeout: 9000 }));
    await waitFor(() => expect(document.querySelector('[aria-live="assertive"]')).toHaveTextContent(/\S/), {
      timeout: 5000,
    });
    expect(speech.spoken).toEqual([]);
  }, 20000);
});
