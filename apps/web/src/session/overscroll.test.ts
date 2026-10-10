import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('pull to refresh', () => {
  it('is switched off on the document, so an accidental drag cannot reload a session', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const rule = /html,\s*body\s*\{[^}]*overscroll-behavior-y:\s*none/;
    expect(css).toMatch(rule);
  });
});
