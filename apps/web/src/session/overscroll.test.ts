import { describe, expect, it } from 'vitest';
import css from '../index.css?raw';

describe('pull to refresh', () => {
  it('is switched off on the document, so an accidental drag cannot reload a session', () => {
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overscroll-behavior-y:\s*none/);
  });
});
