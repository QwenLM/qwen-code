import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(
  readFileSync(
    fileURLToPath(
      new URL('./EnhancedMarkdownTable.module.css', import.meta.url),
    ),
    'utf8',
  ),
);

function declarations(selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => {
      result[decl.prop] = decl.value;
    });
  });
  return result;
}

describe('frozen table shadow direction', () => {
  it('keeps the overlay width in sync with its measured offset', () => {
    expect(declarations('.frozenColumnShadow').width).toBe('14px');
  });

  it('mirrors the seam overlap and fade in RTL', () => {
    expect(declarations('.frozenColumnShadow')).toMatchObject({
      transform: 'translateX(-1px)',
      background: 'linear-gradient(90deg, rgb(0 0 0 / 8%), rgb(0 0 0 / 0))',
    });
    expect(
      declarations(":global([dir='rtl']) .frozenColumnShadow"),
    ).toMatchObject({
      transform: 'translateX(1px)',
      background: 'linear-gradient(270deg, rgb(0 0 0 / 8%), rgb(0 0 0 / 0))',
    });
  });
});
