import { expect, it } from 'vitest';
import { createHighlighter } from './pierre-highlighter';
import { bundledLanguages, bundledThemes } from './pierre-resources';
import { getPreviewLanguage } from './PierreFilePreview';

it('keeps common aliases highlighted and unsupported names readable as text', () => {
  for (const [path, language] of Object.entries({
    'app.ts': 'typescript',
    'component.tsx': 'tsx',
    'data.json': 'json',
    'README.md': 'markdown',
    'config.yml': 'yaml',
    'build.kts': 'kotlin',
    'run.sh': 'zsh',
    Dockerfile: 'dockerfile',
    'proof.lean': 'text',
    'unknown.extension': 'text',
    toString: 'text',
  }))
    expect(getPreviewLanguage(path)).toBe(language);
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
  } finally {
    highlighter.dispose();
  }
}, 30_000);
