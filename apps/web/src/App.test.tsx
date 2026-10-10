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

describe('debug mode', () => {
  it('shows no cog unless VITE_DEBUG_MODE is true', () => {
    render(<App api={createMockApi(10)} speech={fakeSpeech()} capture={createFixtureCapture()} />);
    expect(screen.queryByRole('button', { name: 'Open debug panel' })).toBeNull();
  });

  it('shows the cog and a panel with camera, logs, motion and payloads when enabled', async () => {
    vi.stubEnv('VITE_DEBUG_MODE', 'true');
    render(<App api={createMockApi(10)} speech={fakeSpeech()} capture={createFixtureCapture()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open debug panel' }));
    expect(screen.getByRole('dialog', { name: 'Debug panel' })).toBeInTheDocument();
    for (const name of ['Camera', 'Logs', 'Motion', 'Payloads']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('button', { name: 'Pause frames' }));
    expect(screen.getByRole('button', { name: 'Resume frames' })).toBeInTheDocument();
    vi.unstubAllEnvs();
  });
});

describe('session log panel', () => {
  it('records the session from Start with tagged lines and can be filtered', async () => {
    vi.stubEnv('VITE_DEBUG_MODE', 'true');
    render(<App api={createMockApi(10)} speech={fakeSpeech()} capture={createFixtureCapture()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start guidance' }));
    await screen.findByRole('heading', { name: 'Listening' });
    await userEvent.click(screen.getByRole('button', { name: 'Open session log' }));
    const dialog = screen.getByRole('dialog', { name: 'Session log' });
    expect(dialog).toHaveTextContent('START tapped');
    expect(dialog).toHaveTextContent('client created');
    expect(dialog).toHaveTextContent('speaking: "Where would you like to go?"');
    await userEvent.click(screen.getByRole('button', { name: /^TTS/ }));
    expect(dialog).not.toHaveTextContent('speaking: "Where would you like to go?"');
    vi.unstubAllEnvs();
  });
});

describe('header', () => {
  it('shows the logo to the left of the name, as decoration', () => {
    render(<App api={createMockApi(10)} speech={fakeSpeech()} capture={createFixtureCapture()} />);
    const header = screen.getByRole('banner');
    const logo = header.querySelector('img');
    const name = screen.getByText('Orient');
    expect(logo).toHaveAttribute('src', '/icons/icon-192.png');
    expect(logo).toHaveAttribute('alt', '');
    expect(logo!.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name).toHaveClass('uppercase');
  });
});
