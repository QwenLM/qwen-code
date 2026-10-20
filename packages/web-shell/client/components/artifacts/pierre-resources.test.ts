import { expect, it } from 'vitest';
import { createHighlighter } from './pierre-highlighter';
import { bundledLanguages, bundledThemes } from './pierre-resources';
import { getPreviewLanguage } from './PierreFilePreview';
import { getSharedHighlighter } from '@pierre/diffs';

it('pins both preview themes and the supported language count', () => {
  expect(Object.keys(bundledThemes).sort()).toEqual([
    'github-dark',
    'github-light',
  ]);
  expect(Object.keys(bundledLanguages)).toHaveLength(33);
});

it('uses the curated resources in the real Pierre test graph', async () => {
  const highlighter = await getSharedHighlighter({
    themes: ['github-dark', 'github-light'],
    langs: ['typescript'],
  });
  expect(highlighter.getLoadedThemes()).toEqual(
    expect.arrayContaining(['github-dark', 'github-light']),
  );
  await expect(
    getSharedHighlighter({ themes: ['github-dark'], langs: ['haskell'] }),
  ).rejects.toThrow('not found in bundled or custom languages');
});

it('keeps common aliases highlighted and unsupported names readable as text', () => {
  for (const [path, language] of Object.entries({
    'app.ts': 'typescript',
    'component.tsx': 'tsx',
    'data.json': 'json',
    'README.md': 'markdown',
    'README.MD': 'markdown',
    'config.yml': 'yaml',
    'config.YML': 'yaml',
    'build.kts': 'kotlin',
    // Whole-name detector keys are case-sensitive and must survive the
    // extension-only fold: Gemfile is ruby, gemfile is not.
    Gemfile: 'ruby',
    gemfile: 'text',
    'run.sh': 'zsh',
    Dockerfile: 'dockerfile',
    'proof.lean': 'text',
    'unknown.extension': 'text',
    toString: 'text',
  }))
    expect(getPreviewLanguage(path)).toBe(language);
  const supported = getPreviewLanguage('app.ts');
  if (supported !== 'text')
    expect(typeof bundledLanguages[supported]).toBe('function');
});

it('loads every selected grammar and both themes with the JavaScript engine', async () => {
  const highlighter = await createHighlighter({
    themes: Object.keys(bundledThemes),
    langs: [],
  });
  try {
    for (const [name, load] of Object.entries(bundledLanguages)) {
      await highlighter.loadLanguage(await load());
      for (const theme of Object.keys(bundledThemes)) {
        const { tokens } = highlighter.codeToTokens('const answer = 42;', {
          lang: name,
          theme,
        });
        expect(
          tokens
            .flat()
            .map((token) => token.content)
            .join(''),
        ).toBe('const answer = 42;');
        expect(tokens.flat().every((token) => token.color)).toBe(true);
      }
    }
    expect(
      highlighter
        .codeToTokens('def unsupported := 42', {
          lang: 'text',
          theme: 'github-dark',
        })
        .tokens.flat()
        .map((token) => token.content)
        .join(''),
    ).toBe('def unsupported := 42');
    // Pins the theme name -> module mapping: shiki assigns the theme fg to
    // every token when a theme has no rules, so every(color) cannot tell a
    // real theme from an empty or swapped one.
    const { tokens } = highlighter.codeToTokens('const answer = 42;', {
      lang: 'typescript',
      theme: 'github-dark',
    });
    expect([...new Set(tokens.flat().map((token) => token.color))]).toEqual([
      '#F97583',
      '#E1E4E8',
      '#79B8FF',
    ]);
  } finally {
    highlighter.dispose();
  }
}, 30_000);
