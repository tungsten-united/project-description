import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DebugStore } from './store';
import { formatLine, SOURCE_MEANING, SOURCES, type Source } from './timeline';

interface Props {
  store: DebugStore;
}

/** Compact, tagged timeline of the whole session: phone, orchestrator, speech to text, Jev, nav-api and GPU. */
export function SessionLogPanel({ store }: Props) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<Source>>(new Set());
  const [showMinor, setShowMinor] = useState(false);
  const [copyNote, setCopyNote] = useState('');
  const [plain, setPlain] = useState<string | null>(null);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const listRef = useRef<HTMLUListElement>(null);
  const pinned = useRef(true);

  const lines = useMemo(
    () => state.timeline.filter((l) => !hidden.has(l.src) && (showMinor || !l.minor)),
    [state.timeline, hidden, showMinor],
  );
  const counts = useMemo(() => {
    const c = new Map<Source, number>();
    for (const l of state.timeline) c.set(l.src, (c.get(l.src) ?? 0) + 1);
    return c;
  }, [state.timeline]);

  // Follow the newest line unless the reader scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (open && el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [open, lines]);

  const toggle = (src: Source) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src);
      else next.add(src);
      return next;
    });

  const asText = () => lines.map((l) => formatLine(l, state.sessionStart)).join('\n');

  async function copy() {
    const text = asText();
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote(`Copied ${lines.length} lines.`);
      setPlain(null);
    } catch {
      // Some browsers refuse clipboard access: show the text so it can be selected by hand.
      setCopyNote('Copy was blocked. Select the text below.');
      setPlain(text);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open session log"
        className="fixed top-3 right-[4.5rem] z-40 flex size-12 items-center justify-center rounded-full border-[1.5px] border-line bg-sand font-mono text-base font-bold"
      >
        <span aria-hidden="true">≣</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Session log" className="fixed inset-0 z-50 flex flex-col gap-2 overflow-hidden bg-ivory p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-bold">Session log</h2>
            <div className="flex gap-2">
              <button type="button" onClick={() => void copy()} className="min-h-11 rounded-xl border-2 border-slate px-3 font-bold">
                Copy
              </button>
              <button type="button" onClick={() => store.clearTimeline()} className="min-h-11 rounded-xl border-2 border-slate px-3 font-bold">
                Clear
              </button>
              <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-xl border-2 border-slate bg-slate px-3 font-bold text-ivory">
                Close
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1" role="group" aria-label="Show sources">
            {SOURCES.map((src) => (
              <button
                key={src}
                type="button"
                aria-pressed={!hidden.has(src)}
                title={SOURCE_MEANING[src]}
                onClick={() => toggle(src)}
                className={`min-h-9 rounded-lg border-[1.5px] px-2 font-mono text-xs font-bold ${hidden.has(src) ? 'border-line bg-ivory text-ink-faint line-through' : 'border-slate bg-sand'}`}
              >
                {src} {counts.get(src) ?? 0}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={showMinor}
              onClick={() => setShowMinor((v) => !v)}
              className={`min-h-9 rounded-lg border-[1.5px] px-2 text-xs font-bold ${showMinor ? 'border-slate bg-sand' : 'border-line bg-ivory'}`}
            >
              {showMinor ? 'All lines' : 'Key lines'}
            </button>
          </div>

          <p className="text-xs text-ink-soft">
            {SOURCES.map((s) => `${s} ${SOURCE_MEANING[s]}`).join(' · ')}
            {'. '}
            Server trace: {state.serverTrace === 'streaming' ? 'streaming' : 'not seen yet (the orchestrator only streams it in debug mode)'}.
            {copyNote ? ` ${copyNote}` : ''}
          </p>

          {plain && (
            <textarea readOnly value={plain} className="h-24 w-full rounded-lg border border-line bg-sand p-2 font-mono text-xs" aria-label="Session log as text" />
          )}

          <ul
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="min-h-0 grow overflow-y-auto rounded-lg border border-line bg-sand p-2 font-mono text-[11px] leading-snug"
          >
            {lines.length === 0 && <li className="text-ink-soft">Nothing yet. Press Start on the main screen.</li>}
            {lines.map((l) => (
              <li
                key={l.id}
                className={`flex gap-2 py-0.5 ${l.level === 'error' ? 'font-bold text-clay-line' : l.level === 'warn' ? 'font-bold' : ''}`}
              >
                <span className="shrink-0 text-ink-faint">
                  {(((l.at - (state.sessionStart ?? l.at)) / 1000) >= 0 ? '+' : '') + ((l.at - (state.sessionStart ?? l.at)) / 1000).toFixed(1)}s
                </span>
                <span className="w-9 shrink-0">{l.level === 'error' ? `${l.src}!` : l.level === 'warn' ? `${l.src}?` : l.src}</span>
                <span className="min-w-0 break-words">{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
