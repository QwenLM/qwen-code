/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTwoFilesPatch } from 'diff';
import { describe, expect, it, vi } from 'vitest';
import { isStaticDocsNavDiff } from './docs-nav-profile.js';

const PATH = 'docs/developers/_meta.ts';
const BASE = `export default {
  architecture: 'Architecture',
  examples: {
    display: 'hidden',
  },
};
`;
const HEAD = `export default {
  architecture: 'Architecture',
  examples: 'Examples',
};
`;

function diff(base = BASE, head = HEAD, path = PATH): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, base, head);
  return `diff --git a/${path} b/${path}\nindex aaaaaaa..bbbbbbb 100644\n${patch.slice(patch.indexOf('---'))}`;
}

function classify(base = BASE, head = HEAD, patch = diff(base, head)): boolean {
  return isStaticDocsNavDiff(patch, (side) => (side === 'base' ? base : head));
}

describe('static documentation navigation profile', () => {
  it('accepts the complete #11426 visibility change', () => {
    expect(classify()).toBe(true);
    expect(classify(HEAD, BASE)).toBe(true);
  });

  it('accepts literal labels and titles with unchanged other metadata', () => {
    const base = `export default { examples: { title: 'Old', type: 'page' } };`;
    expect(classify(base, base.replace('Old', 'New'))).toBe(true);
    expect(classify(HEAD, HEAD.replace('Examples', '示例'))).toBe(true);
  });

  it.each(['\u2028', '\u2029'])(
    'rejects code after a Unicode line-comment terminator on either side',
    (separator) => {
      const source = HEAD + '// comment' + separator + 'dangerousCall();\n';
      expect(classify(BASE, source)).toBe(false);
      expect(classify(source, HEAD)).toBe(false);
    },
  );

  it.each([
    "export default { architecture: 'Architecture', examples: getTitle() };",
    "export default { architecture: 'Architecture', examples: title };",
    "export default { architecture: 'Architecture', examples: `Examples` };",
    "export default { ...defaults, examples: 'Examples' };",
    "export default { ['examples']: 'Examples' };",
    "export default { get examples() { return 'Examples'; } };",
    "import x from './x'; export default { examples: 'Examples' };",
    "export default { examples: 'Examples' }; launch();",
    "export default { examples: 'Example\\s' };",
    "export default { __proto__: { examples: 'Examples' } };",
  ])('keeps unsupported JavaScript on the full path: %s', (source) => {
    expect(classify(BASE, source)).toBe(false);
    expect(classify(source, HEAD)).toBe(false);
  });

  it.each([
    HEAD.replace(
      "examples: 'Examples'",
      "examples: { href: 'https://elsewhere.test' }",
    ),
    HEAD.replace("examples: 'Examples'", "examples: { display: 'children' }"),
    HEAD.replace("examples: 'Examples'", "examples: { type: 'menu' }"),
    HEAD.replace('examples:', 'newExamples:'),
  ])('retains full review for changes beyond labels/visibility', (source) => {
    expect(classify(BASE, source)).toBe(false);
  });

  it('checks the entire files, including unchanged executable content', () => {
    expect(
      classify(
        BASE.replace("'Architecture'", 'getTitle()'),
        HEAD.replace("'Architecture'", 'getTitle()'),
      ),
    ).toBe(false);
  });

  it('rejects a permission change and a mixed PR before reading contents', () => {
    const read = vi.fn(() => HEAD);
    const code = diff(
      'allow = false;\n',
      'allow = true;\n',
      'packages/core/src/auth.ts',
    );
    expect(isStaticDocsNavDiff(code, read)).toBe(false);
    expect(isStaticDocsNavDiff(diff() + code, read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    (patch: string) => patch.replace('100644', '120000'),
    (patch: string) =>
      patch.replace('index ', 'old mode 100644\nnew mode 100755\nindex '),
    (patch: string) =>
      patch.replace(
        'index ',
        'rename from docs/old.ts\nrename to docs/developers/_meta.ts\nindex ',
      ),
    (patch: string) => patch.replace('index ', 'new file mode 100644\nindex '),
    (patch: string) =>
      patch.replace(
        'index ',
        'copy from docs/old.ts\ncopy to docs/developers/_meta.ts\nindex ',
      ),
  ])('rejects file identity and mode changes', (change) => {
    expect(classify(BASE, HEAD, change(diff()))).toBe(false);
  });

  it('requires fewer than 25 changed lines', () => {
    const base = `export default {\n${Array.from({ length: 13 }, (_, i) => `  p${i}: 'old',`).join('\n')}\n};\n`;
    const head = base.replaceAll("'old'", "'new'");
    expect(classify(base, head)).toBe(false);
    const smaller = head.replace("p12: 'new'", "p12: 'old'");
    expect(classify(base, smaller)).toBe(true);
  });

  it('keeps unknown, malformed and oversized inputs on the full path', () => {
    expect(isStaticDocsNavDiff('', () => HEAD)).toBe(false);
    expect(
      isStaticDocsNavDiff(diff(), () => {
        throw new Error('missing blob');
      }),
    ).toBe(false);
    expect(classify(BASE, HEAD.replace('};', '} broken'))).toBe(false);
    expect(classify(BASE, `/*${'x'.repeat(32_768)}*/${HEAD}`)).toBe(false);
  });
});
