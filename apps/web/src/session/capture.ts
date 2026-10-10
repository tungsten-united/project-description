import { audioConstraints, createVoiceChain, voiceIsolationEnabled, type VoiceChain } from '../audio/voiceIsolation';
import { CaptureError, type Capture } from './types';

const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

/** First recorder MIME type the browser supports. Chrome records webm, Safari mp4. */
export function pickAudioMime(isSupported: (type: string) => boolean): string | undefined {
  return AUDIO_TYPES.find((t) => isSupported(t));
}

/** Size that fits the longest edge into `maxEdge`, never enlarging. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

interface Options {
  maxEdge?: number;
  quality?: number;
}

/** Best-effort permission states, so a blocked site can be told apart from a dismissed prompt. */
async function permissionStates(): Promise<string> {
  const read = async (name: string) => {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return status.state;
    } catch {
      return 'unknown';
    }
  };
  return `microphone=${await read('microphone')}, camera=${await read('camera')}`;
}

/** Real microphone and rear camera. Released completely on release(). */
export function createBrowserCapture({ maxEdge = 1280, quality = 0.7 }: Options = {}): Capture {
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let chain: VoiceChain | null = null;
  let lastStats: ReturnType<VoiceChain['stats']> | null = null;

  async function open(): Promise<MediaStream> {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new CaptureError('unavailable', 'Media capture is not available in this browser.');
    try {
      const supported = (md.getSupportedConstraints?.() ?? {}) as Record<string, boolean | undefined>;
      return await md.getUserMedia({
        audio: audioConstraints(voiceIsolationEnabled(), supported) as MediaTrackConstraints,
        video: { facingMode: { ideal: 'environment' } },
      });
    } catch (e) {
      const err = e as DOMException;
      const detail = `${err.name}: ${err.message} (${await permissionStates()}, secure=${String(window.isSecureContext)})`;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        throw new CaptureError('permission_denied', 'Camera or microphone permission was denied.', detail);
      }
      throw new CaptureError('unavailable', 'Camera or microphone is not available.', detail);
    }
  }

  return {
    async acquire() {
      stream = await open();
      if (voiceIsolationEnabled()) {
        try {
          chain = createVoiceChain(new MediaStream(stream.getAudioTracks()));
        } catch {
          chain = null; // fall back to the raw microphone
        }
      }
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
    },

    previewStream: () => stream,

    startRecording() {
      if (!stream) return;
      const audioOnly = chain?.output ?? new MediaStream(stream.getAudioTracks());
      const mimeType = pickAudioMime((t) => MediaRecorder.isTypeSupported(t));
      chunks = [];
      recorder = new MediaRecorder(audioOnly, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.start();
    },

    voiceStats: () => lastStats,

    stopRecording() {
      lastStats = chain ? chain.stats() : null;
      const r = recorder;
      recorder = null;
      if (!r || r.state === 'inactive') return Promise.resolve(null);
      return new Promise<Blob | null>((resolve) => {
        r.onstop = () => {
          const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
          chunks = [];
          resolve(blob.size > 0 ? blob : null);
        };
        r.stop();
      });
    },

    grabFrame() {
      if (!video || video.videoWidth === 0) return Promise.resolve(null);
      const { width, height } = fitWithin(video.videoWidth, video.videoHeight, maxEdge);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
      return new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
    },

    release() {
      chain?.dispose();
      chain = null;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      recorder = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (video) video.srcObject = null;
      video = null;
    },
  };
}

/** Stand-in for demo mode and tests: no permissions, a tiny fixed clip and frame. */
export function createFixtureCapture(): Capture {
  const blob = (type: string) => new Blob([new Uint8Array([0])], { type });
  return {
    async acquire() {},
    previewStream: () => null,
    startRecording() {},
    stopRecording: () => Promise.resolve(blob('audio/webm')),
    grabFrame: () => Promise.resolve(blob('image/jpeg')),
    release() {},
  };
}
