import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('./DiffView.module.css', import.meta.url),
  'utf8',
);
const contentRule = css.match(/\.content\s*\{([^}]*)\}/s)?.[1] ?? '';

describe('DiffView text wrapping styles', () => {
  it('preserves diff whitespace while allowing long lines to wrap', () => {
    expect(contentRule).toMatch(/white-space:\s*pre-wrap\s*;/);
  });

  it('wraps unbroken paths and tokens at the available width', () => {
    expect(contentRule).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });

  it('allows the content flex item to shrink inside a diff row', () => {
    expect(contentRule).toMatch(/min-width:\s*0\s*;/);
  });
});
