/**
 * The session timeline: one compact line per thing that happened, tagged with who did it.
 *
 *   FE    this phone: taps, permissions, recording, what it sent
 *   ORCH  the orchestrator: decisions and events it sent back
 *   STT   speech to text (ElevenLabs Scribe), as the orchestrator saw it
 *   JEV   Jev: the command choice and "is it worth saying"
 *   NAV   nav-api localize and route, with the GPU embedding time
 *   TTS   speech output on the phone (ElevenLabs audio or the browser voice)
 */
export type Source = 'FE' | 'ORCH' | 'STT' | 'JEV' | 'NAV' | 'TTS';
export const SOURCES: Source[] = ['FE', 'ORCH', 'STT', 'JEV', 'NAV', 'TTS'];

export const SOURCE_MEANING: Record<Source, string> = {
  FE: 'this phone',
  ORCH: 'orchestrator',
  STT: 'speech to text',
  JEV: 'Jev decisions',
  NAV: 'nav-api and GPU',
  TTS: 'speech output',
};

export interface Line {
  src: Source;
  level: 'info' | 'warn' | 'error';
  text: string;
  /** Per-frame chatter that is hidden unless asked for. */
  minor?: boolean;
}

const clip = (text: unknown, n: number) => {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const ms = (v: unknown) => (typeof v === 'number' ? `${Math.round(v)} ms` : null);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
const short = (id: unknown) => (typeof id === 'string' ? id.slice(0, 6) : '');
const num = (v: unknown, digits = 2) => (typeof v === 'number' ? v.toFixed(digits) : '?');

function browserName(userAgent: string): string {
  const os = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : 'other OS';
  const chrome = /Chrome\/(\d+)/.exec(userAgent);
  const safari = /Version\/(\d+).*Safari/.exec(userAgent);
  const name = chrome ? `Chrome ${chrome[1]}` : safari ? `Safari ${safari[1]}` : 'browser';
  return `${name} on ${os}`;
}

/** A line from something the phone itself did or received, as logged by useSession. */
export function describePhoneEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  detail = '',
): Line {
  const lv = level;
  switch (event) {
    case 'start': {
      const ua = /ua=(.*?) secure=/.exec(detail)?.[1] ?? '';
      const secure = /secure=(\w+)/.exec(detail)?.[1];
      return { src: 'FE', level: lv, text: `START tapped (${browserName(ua)}, secure=${secure ?? '?'})` };
    }
    case 'motion_access':
      return { src: 'FE', level: detail === 'granted' ? lv : 'warn', text: `motion sensors: ${detail}` };
    case 'client_created':
      return { src: 'FE', level: lv, text: `client created at the orchestrator (${detail})` };
    case 'recording_started':
      return { src: 'FE', level: lv, text: `recording started (max ${detail})` };
    case 'recording_stopped':
      return { src: 'FE', level: lv, text: `recording stopped (${detail})` };
    case 'voice_levels': {
      const f = /floor=(-?\d+)dB peak=(-?\d+)dB open=([\d.]+)/.exec(detail);
      return {
        src: 'FE',
        level: lv,
        text: f ? `mic levels: floor ${f[1]} dB, peak ${f[2]} dB, gate open ${f[3]}` : `mic levels: ${detail}`,
      };
    }
    case 'input_sent': {
      const f = /audio=(\d+)B ([^ ]+) frame=(\d+)B/.exec(detail);
      return {
        src: 'FE',
        level: lv,
        text: f
          ? `INPUT sent: audio ${kb(Number(f[1]))} ${f[2].split(';')[0]}, frame ${kb(Number(f[3]))}`
          : `INPUT sent: ${detail}`,
      };
    }
    case 'frame_sent':
      return { src: 'FE', level: lv, text: `frame ${detail}`, minor: true };
    case 'state':
      return { src: 'ORCH', level: lv, text: `→ phone: state ${detail}`, minor: false };
    case 'guidance':
      return { src: 'ORCH', level: lv, text: `→ phone: guidance ${detail}` };
    case 'needs_input':
      return { src: 'ORCH', level: lv, text: `→ phone: needs input (${detail})` };
    case 'stop':
      return { src: 'FE', level: lv, text: `STOP: ${detail}` };
    case 'tts_start':
      return { src: 'TTS', level: lv, text: `speaking: "${clip(detail, 80)}"` };
    case 'tts_end':
      return { src: 'TTS', level: detail === 'failed' ? 'warn' : lv, text: `speech ${detail}` };
    case 'speech_fallback':
      return { src: 'TTS', level: 'warn', text: `audio failed, browser voice used (${detail})` };
    default:
      return { src: 'FE', level: lv, text: `${event}${detail ? `: ${clip(detail, 100)}` : ''}` };
  }
}

type Entry = Record<string, unknown>;

/** Jev's answer from a trace entry: confidence and the two likeliest choices, or where the answer came from. */
function jevDetail(jev: unknown): string {
  if (!jev || typeof jev !== 'object') return '';
  const j = jev as Entry;
  if (j.error) return ` [jev error: ${clip(j.error, 50)}]`;
  if (j.source === 'keywords') return ' [keywords, no Jev]';
  const probs = j.probabilities && typeof j.probabilities === 'object' ? (j.probabilities as Record<string, unknown>) : {};
  const top = Object.entries(probs)
    .filter(([, p]) => typeof p === 'number')
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 2)
    .map(([k, p]) => `${k} ${num(p)}`)
    .join(', ');
  return `, conf ${num(j.confidence)}${top ? ` (${top})` : ''}`;
}

/** Lines for one trace entry the orchestrator streamed (a `log` event). */
export function describeServerEntry(entry: Entry): Line[] {
  const out: Line[] = [];
  const kind = String(entry.kind ?? '');
  const t = (entry.timingsMs ?? {}) as Record<string, unknown>;
  const err = entry.error ? String(entry.error) : null;
  const dropped = entry.dropped ? String(entry.dropped) : null;

  if (kind === 'client') {
    out.push({ src: 'ORCH', level: 'info', text: `client registered, phase ${entry.phase ?? '?'}` });
  } else if (kind === 'input') {
    const transcript = String(entry.transcript ?? '');
    const sttMs = ms(t.stt);
    if (err?.startsWith('stt')) {
      out.push({ src: 'STT', level: 'error', text: `failed: ${clip(err, 90)}` });
    } else {
      out.push({
        src: 'STT',
        level: 'info',
        text: transcript ? `heard "${clip(transcript, 90)}"${sttMs ? ` (${sttMs})` : ''}` : `heard nothing${sttMs ? ` (${sttMs})` : ''}`,
      });
    }
    if (dropped === 'echo') {
      out.push({ src: 'ORCH', level: 'warn', text: 'DROPPED as an echo of a sentence the app spoke' });
    } else if (dropped) {
      out.push({ src: 'ORCH', level: 'warn', text: `DROPPED: ${dropped}` });
    }
    const command = entry.command ? String(entry.command) : null;
    if (command && command !== 'empty' && !dropped) {
      const dest = entry.destinationId ? ` → ${entry.destinationId}` : '';
      out.push({
        src: 'JEV',
        level: 'info',
        text: `command: ${command}${dest}${jevDetail(entry.jev)}${t.command ? ` (${ms(t.command)})` : ''}`,
      });
    }
    if (command === 'start') {
      out.push({ src: 'ORCH', level: 'info', text: `session ${short(entry.sessionId)} → destination ${entry.destinationId ?? '?'}` });
    } else if (command === 'cancel') {
      out.push({ src: 'ORCH', level: 'info', text: 'voice cancel → stop' });
    } else if (command) {
      out.push({ src: 'ORCH', level: 'info', text: `asks again (${command})` });
    }
  } else if (kind === 'frame') {
    const loc = entry.localize as Entry | undefined;
    const rid = short(String(entry.requestId ?? '').replace(/-/g, '').slice(-6));
    if (loc && typeof loc === 'object') {
      const cands = (loc.candidates as Entry[] | undefined) ?? [];
      const best = cands[0];
      const took = (loc.took_ms ?? {}) as Record<string, unknown>;
      const parts = [
        `${loc.status ?? '?'}`,
        best ? `best ${best.node ?? '?'} ${clip(best.name, 24)} score ${num(best.score)}` : 'no candidate',
        loc.margin !== undefined ? `margin ${num(loc.margin)}` : null,
        loc.previous ? `from ${loc.previous}` : null,
        `${entry.framesSent ?? '?'} frames`,
        took.embed !== undefined ? `GPU embed ${ms(took.embed)}` : null,
        ms(t.localize) ? `round trip ${ms(t.localize)}` : null,
      ].filter(Boolean);
      out.push({ src: 'NAV', level: loc.status === 'confirmed' ? 'info' : 'warn', text: `localize ${parts.join(' · ')}` });
    } else if (entry.observation) {
      out.push({ src: 'NAV', level: 'info', text: `localize ${clip(entry.observation, 100)}` });
    }
    const route = entry.route as Entry | undefined;
    if (route && typeof route === 'object') {
      const hops = (route.hops as Entry[] | undefined) ?? [];
      const first = hops[0];
      out.push({
        src: 'NAV',
        level: route.found === false ? 'warn' : 'info',
        text: first
          ? `route ${first.source} → ${first.target}, ${hops.length} hop(s), ${num(route.length_m, 1)} m: "${clip(first.instruction, 70)}"`
          : `route: ${route.found === false ? 'none found' : 'empty'}`,
      });
    }
    if (t.jev !== undefined || entry.quietReason === 'not_worth_saying') {
      const no = entry.quietReason === 'not_worth_saying';
      const j = entry.jev as Entry | null | undefined;
      const answer = j && typeof j.choice === 'string' ? `, says ${j.choice}${jevDetail(j)}` : jevDetail(j);
      out.push({
        src: 'JEV',
        level: 'info',
        text: `worth saying? ${no ? 'no' : 'yes'}${answer}${ms(t.jev) ? ` (${ms(t.jev)})` : ''}`,
      });
    }
    if (dropped) {
      out.push({ src: 'ORCH', level: 'warn', text: `frame ${rid} dropped: ${dropped}` });
    } else if (err) {
      out.push({ src: 'ORCH', level: 'error', text: `frame ${rid} failed: ${clip(err, 100)}` });
    } else if (entry.spoke) {
      out.push({
        src: 'ORCH',
        level: 'info',
        text: `decision: SPEAK ${String(entry.action ?? '')} at ${entry.routeStepId ?? '?'}: "${clip(entry.text, 80)}"`,
      });
    } else {
      const why = entry.quietReason ? String(entry.quietReason) : 'unchanged';
      out.push({
        src: 'ORCH',
        level: 'info',
        text: `decision: quiet (${why}) ${String(entry.action ?? 'wait')} at ${entry.routeStepId ?? '?'}${ms(t.total) ? `, total ${ms(t.total)}` : ''}`,
        minor: why === 'unchanged',
      });
    }
  } else if (kind === 'stop') {
    out.push({ src: 'ORCH', level: 'info', text: `stop, generation ${entry.generation ?? '?'}` });
  } else if (kind === 'retry') {
    out.push({ src: 'ORCH', level: 'info', text: `retry, generation ${entry.generation ?? '?'}` });
  } else {
    out.push({ src: 'ORCH', level: err ? 'error' : 'info', text: `${kind || 'entry'}${err ? `: ${clip(err, 100)}` : ''}` });
  }
  return out;
}

export interface TimelineLine extends Line {
  id: number;
  /** Local epoch ms when it was recorded. */
  at: number;
}

/** "+12.40s FE  text", the plain form that the panel copies. */
export function formatLine(line: TimelineLine, startMs: number | null): string {
  const t = startMs == null ? 0 : (line.at - startMs) / 1000;
  const stamp = `${t < 0 ? '-' : '+'}${Math.abs(t).toFixed(2)}s`;
  const tag = line.level === 'error' ? `${line.src}!` : line.level === 'warn' ? `${line.src}?` : line.src;
  return `${stamp.padStart(9)} ${tag.padEnd(5)} ${line.text}`;
}
