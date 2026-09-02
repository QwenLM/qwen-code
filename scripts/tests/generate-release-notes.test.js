/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  appendDegradedStepSummary,
  buildPullRequestQuery,
  classifyChange,
  createOpenAiCompleter,
  enrichEntries,
  extractImages,
  generateAiContent,
  generateReleaseNotes,
  isAllowedImageUrl,
  normalizeAppendixTitle,
  parseGeneratedEntries,
  renderReleaseNotes,
  renderReleaseNotesV2,
  tryAppendDegradedStepSummary,
} from '../generate-release-notes.js';
import { escapeWorkflowCommand } from '../release-script-utils.js';

const PR = (number) => `https://github.com/QwenLM/qwen-code/pull/${number}`;

const entry = (number, title, labels = []) => ({
  number,
  title,
  url: PR(number),
  author: 'alice',
  labels,
  body: '',
});

describe('parseGeneratedEntries', () => {
  it('extracts the authoritative PR list from GitHub generated notes', () => {
    const body = [
      "## What's Changed",
      `* feat(cli): add session search by @alice in ${PR(12)}`,
      `* fix(core): preserve tool results by @bob in ${PR(8)}`,
      `* fix(ci): retry publishing by @carol with @Copilot in ${PR(6574)}`,
      '',
      '**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v1...v2',
    ].join('\n');

    expect(parseGeneratedEntries(body)).toEqual([
      {
        number: 12,
        title: 'feat(cli): add session search',
        url: PR(12),
        author: 'alice',
      },
      {
        number: 8,
        title: 'fix(core): preserve tool results',
        url: PR(8),
        author: 'bob',
      },
      {
        number: 6574,
        title: 'fix(ci): retry publishing',
        url: PR(6574),
        author: 'carol',
        coAuthors: ['Copilot'],
      },
    ]);
  });

  it('rejects a partially parsed GitHub PR list', () => {
    const body = [
      `* feat(cli): parsed by @alice in ${PR(1)}`,
      `* fix(core): changed format by @bob and @carol in ${PR(2)}`,
    ].join('\n');

    expect(() => parseGeneratedEntries(body)).toThrow(
      /Could not parse every pull request entry/,
    );
  });

  it('does not drop a PR bullet when GitHub omits the author phrase', () => {
    const body = [
      "## What's Changed",
      `* feat(cli): parsed by @alice in ${PR(1)}`,
      `* fix(core): changed format in ${PR(2)}`,
      '',
      '## New Contributors',
      `* @newbie made their first contribution in ${PR(2)}`,
    ].join('\n');

    expect(parseGeneratedEntries(body)).toEqual([
      {
        number: 1,
        title: 'feat(cli): parsed',
        url: PR(1),
        author: 'alice',
      },
      {
        number: 2,
        title: 'fix(core): changed format',
        url: PR(2),
        author: null,
      },
    ]);
  });
});

describe('classifyChange', () => {
  it.each([
    ['feat(cli): add x', [], 'Features'],
    ['fix(core): repair x', [], 'Bug Fixes'],
    ['perf: speed up x', [], 'Performance'],
    ['docs: explain x', [], 'Documentation'],
    ['test(core): cover x', [], 'Internal Changes'],
    // Object.prototype members must fall back like any unknown type instead
    // of resolving to their inherited truthy value.
    ['constructor: rebuild session flow', [], 'Internal Changes'],
    ['__proto__: rebuild session flow', [], 'Internal Changes'],
  ])('classifies %s deterministically', (title, labels, expected) => {
    expect(classifyChange(entry(1, title, labels))).toBe(expected);
  });

  it('lets an explicit breaking-change label override the title category', () => {
    expect(
      classifyChange(
        entry(1, 'refactor(core): replace x', ['breaking-change']),
      ),
    ).toBe('Breaking Changes');
  });

  it.each([
    ['type/feature-request', 'Features'],
    ['type/bug', 'Bug Fixes'],
    ['category/performance', 'Performance'],
    ['type/documentation', 'Documentation'],
    ['scope/documentation', 'Documentation'],
  ])('uses an explicit %s label for prefixless titles', (label, expected) => {
    expect(classifyChange(entry(1, 'A clearer change title', [label]))).toBe(
      expected,
    );
  });
});

describe('renderReleaseNotes', () => {
  it('renders highlights and every PR exactly once in the complete list', () => {
    const entries = [
      {
        ...entry(1, 'feat(cli): add session search'),
        coAuthors: ['Copilot'],
      },
      entry(2, 'fix(core): preserve tool results'),
      entry(3, 'docs: explain session search'),
      entry(4, 'refactor(core): remove legacy path', ['breaking-change']),
    ];
    const summaries = new Map([
      [1, 'Adds session search to the CLI.'],
      [2, 'Preserves tool results when history is repaired.'],
      [3, 'Documents session search.'],
      [4, 'Removes a legacy compatibility path.'],
    ]);

    const markdown = renderReleaseNotes({
      entries,
      summaries,
      highlights: [
        {
          text: 'Session workflows are easier to find and recover.',
          prs: [1, 2],
        },
      ],
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(markdown).toContain('<!-- qwen-release-notes:v1 -->');
    expect(markdown).toContain('## Highlights');
    expect(markdown).toContain(
      'Session workflows are easier to find and recover. ([#1]',
    );
    expect(markdown).toContain('## Complete Change List');
    expect(markdown).toContain('### Features');
    expect(markdown).toContain('### Bug Fixes');
    expect(markdown).toContain('### Documentation');
    expect(markdown).toContain(
      `Adds session search to the CLI. ([#1](${PR(1)})) by @alice with @Copilot`,
    );
    for (const number of [1, 2, 3, 4]) {
      expect(markdown.match(new RegExp(`\\[#${number}\\]`, 'g'))).toHaveLength(
        number < 3 ? 2 : 1,
      );
    }
    expect(markdown).toContain(
      '**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v1.0.0...v1.1.0',
    );
  });
});

describe('isAllowedImageUrl', () => {
  it.each([
    'https://github.com/user-attachments/assets/abc-123',
    'https://user-images.githubusercontent.com/1/x.png',
    'https://private-user-images.githubusercontent.com/1/x.png',
    'https://raw.githubusercontent.com/QwenLM/qwen-code/0123456789abcdef0123456789abcdef01234567/docs/x.png',
  ])('accepts %s', (url) => {
    expect(isAllowedImageUrl(url)).toBe(true);
  });

  it.each([
    // camo signs arbitrary external URLs with a deployment-wide key, so it
    // would re-admit every host the allowlist exists to exclude.
    'https://camo.githubusercontent.com/dead/beef',
    // Branch refs are mutable: the repo owner can swap the image in an
    // already-published release.
    'https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/x.png',
    // GitHub's fetchers normalize before serving: empty path segments and
    // %2F shift the validated position, dot segments resolve away, and
    // CommonMark strips backslash escapes at render time.
    'https://raw.githubusercontent.com/attacker//0123456789abcdef0123456789abcdef01234567/main/payload.png',
    'https://raw.githubusercontent.com/attacker/repo%2Fsub/0123456789abcdef0123456789abcdef01234567/main/payload.png',
    'https://raw.githubusercontent.com/QwenLM/qwen-code/0123456789abcdef0123456789abcdef01234567/../../other/repo/main/payload.png',
    'https://raw.githubusercontent.com/QwenLM/qwen-code/%2e%2e/main/payload.png',
    'https://github.com/user-attachments/../../attacker/repo/raw/main/payload.png',
    'https://github.com/user-attachments/assets/..\\..\\attacker/payload.png',
    'http://github.com/user-attachments/assets/abc',
    'https://evil.example.com/github.com/user-attachments/assets/abc',
    'https://evil.example.com/x.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
  ])('rejects %s', (url) => {
    expect(isAllowedImageUrl(url)).toBe(false);
  });
});

describe('extractImages', () => {
  const ATTACHMENT = 'https://github.com/user-attachments/assets/abc-123';
  const ATTACHMENT_2 = 'https://github.com/user-attachments/assets/def-456';

  it('collects markdown images, img tags, and bare image URLs in order', () => {
    const body = [
      '### Evidence (Before & After)',
      `![Before](${ATTACHMENT})`,
      '<img src="https://user-images.githubusercontent.com/9/shot.png" width="400">',
      `Bare link: https://raw.githubusercontent.com/QwenLM/qwen-code/0123456789abcdef0123456789abcdef01234567/docs/after.png`,
    ].join('\n');

    expect(extractImages(body, { maxPerEntry: 3 })).toEqual([
      { url: ATTACHMENT, alt: 'Before' },
      {
        url: 'https://user-images.githubusercontent.com/9/shot.png',
        alt: '',
      },
      {
        url: 'https://raw.githubusercontent.com/QwenLM/qwen-code/0123456789abcdef0123456789abcdef01234567/docs/after.png',
        alt: '',
      },
    ]);
  });

  it('applies the per-entry cap in body order across syntaxes', () => {
    const body = [
      '<img src="https://user-images.githubusercontent.com/9/before.png" width="400">',
      `![After 1](${ATTACHMENT})`,
      `![After 2](${ATTACHMENT_2})`,
    ].join('\n');

    expect(extractImages(body)).toEqual([
      {
        url: 'https://user-images.githubusercontent.com/9/before.png',
        alt: '',
      },
      { url: ATTACHMENT, alt: 'After 1' },
    ]);
  });

  it('drops images hosted outside the allowlist', () => {
    const body =
      '![x](https://evil.example.com/shot.png)\n' + `<img src="${ATTACHMENT}">`;

    expect(extractImages(body)).toEqual([{ url: ATTACHMENT, alt: '' }]);
  });

  it('drops img src values that would break out of the image syntax', () => {
    const breakout = `<img src="${ATTACHMENT})![t](https://evil.example/pixel.png)">`;
    const spaced = `<img src="${ATTACHMENT} with space.png">`;

    expect(extractImages(breakout)).toEqual([]);
    expect(extractImages(spaced)).toEqual([]);
  });

  it('drops markdown image URLs carrying Markdown-active characters', () => {
    const unbalanced = `![x](${ATTACHMENT}(extra)`;
    const backticked = '![x](' + ATTACHMENT + '`suffix)';

    expect(extractImages(unbalanced)).toEqual([]);
    expect(extractImages(backticked)).toEqual([]);
  });

  it('drops bare image URLs whose extension is split by a backtick', () => {
    expect(
      extractImages('see https://github.com/user-attachments/abc`.png'),
    ).toEqual([]);
  });

  it('captures the src attribute, not a data-src stand-in', () => {
    const real = 'https://user-images.githubusercontent.com/9/shot.png';
    for (const tag of [
      `<img src="${real}" data-src="${ATTACHMENT_2}">`,
      `<img data-src="${ATTACHMENT_2}" src="${real}">`,
    ]) {
      expect(extractImages(tag)).toEqual([{ url: real, alt: '' }]);
    }
    expect(extractImages(`<img data-src="${ATTACHMENT_2}">`)).toEqual([]);
  });

  it('neutralizes alt text that would break the interpolated image', () => {
    expect(extractImages(`![before\\](${ATTACHMENT})`)).toEqual([
      { url: ATTACHMENT, alt: 'before' },
    ]);
    expect(extractImages(`![a[b](${ATTACHMENT})`)).toEqual([
      { url: ATTACHMENT, alt: 'ab' },
    ]);
    // Stripping the bracket exposes a trailing backslash that must go too.
    expect(extractImages(`![a\\[](${ATTACHMENT})`)).toEqual([
      { url: ATTACHMENT, alt: 'a' },
    ]);
  });

  it('does not treat ordinary links as images', () => {
    const body =
      '[design doc](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/design.md)\n' +
      'see https://example.com/page.html';

    expect(extractImages(body)).toEqual([]);
  });

  it('caps the images per entry and dedupes repeats', () => {
    const body = `![a](${ATTACHMENT}) ![a2](${ATTACHMENT}) ![b](${ATTACHMENT_2}) ![c](https://user-images.githubusercontent.com/9/3.png)`;

    expect(extractImages(body)).toEqual([
      { url: ATTACHMENT, alt: 'a' },
      { url: ATTACHMENT_2, alt: 'b' },
    ]);
  });

  it('normalizes multiline alt text to one line', () => {
    const body = `![before\nafter](${ATTACHMENT})`;

    expect(extractImages(body)).toEqual([
      { url: ATTACHMENT, alt: 'before after' },
    ]);
  });

  it('returns nothing for an empty body', () => {
    expect(extractImages('')).toEqual([]);
    expect(extractImages(null)).toEqual([]);
  });
});

describe('normalizeAppendixTitle', () => {
  it.each([
    [
      'feat(web-shell): improve compact tool activity',
      'web-shell: improve compact tool activity',
    ],
    [
      'fix: keep workspace picker suggestions closed',
      'keep workspace picker suggestions closed',
    ],
    ['feat(core)!: drop legacy flag', 'core: drop legacy flag'],
    [
      'refactor(core): rework session storage',
      'refactor(core): rework session storage',
    ],
    ['docs: explain session search', 'explain session search'],
    [
      'fix: see [docs](https://attacker.example/q)',
      'see docs(https://attacker.example/q)',
    ],
    ['Update README', 'Update README'],
    // Types that classifyChange routes to Internal Changes keep their
    // prefix: the Internal Changes heading alone does not name them.
    [
      'revert: fix crash when opening settings',
      'revert: fix crash when opening settings',
    ],
    ['ci: bump action cache', 'ci: bump action cache'],
    ['security: patch CVE-2026-1234', 'security: patch CVE-2026-1234'],
    ['test: cover retry paths', 'test: cover retry paths'],
    ['chore(deps): bump @google/genai', 'chore(deps): bump @google/genai'],
  ])('normalizes %j to %j', (title, expected) => {
    expect(normalizeAppendixTitle(title)).toBe(expected);
  });
});

describe('renderReleaseNotesV2', () => {
  const entries = [
    entry(1, 'feat(web-shell): upload files'),
    entry(2, 'fix(desktop): icon safe area'),
    entry(3, 'chore(ci): tidy runners', ['scope/ci-cd']),
    entry(4, 'feat(api)!: drop v1 endpoint', ['breaking-change']),
  ];
  const summaries = new Map([
    [1, 'Upload workspace files from the composer.'],
    [2, 'Fixes the macOS icon safe area.'],
    [3, 'Tidies CI runner setup.'],
    [4, 'Removes the legacy v1 API endpoint.'],
  ]);
  const summariesZh = new Map([
    [1, '支持从输入框上传工作区文件。'],
    [2, '修复 macOS 图标安全区。'],
    [3, '整理 CI runner 配置。'],
    [4, '移除旧版 v1 API 端点。'],
  ]);
  const themes = [
    {
      title: 'Web Shell',
      titleZh: 'Web Shell',
      intro: 'Composer uploads landed this release.',
      introZh: '本次发布支持了输入框上传。',
      items: [1],
    },
    {
      title: 'Desktop',
      titleZh: '桌面应用',
      intro: '',
      introZh: '',
      items: [2],
    },
  ];
  const base = {
    entries,
    summaries,
    summariesZh,
    themes,
    highlights: [
      {
        text: 'Upload files straight into the Web Shell composer.',
        textZh: '直接向 Web Shell 输入框上传文件。',
        prs: [1],
      },
    ],
    previousTag: 'v1.0.0',
    tag: 'v1.1.0',
    repo: 'QwenLM/qwen-code',
  };

  it('renders PR titles in the appendix without live links', () => {
    const markdown = renderReleaseNotesV2({
      entries: [entry(5, 'fix: see [docs](https://attacker.example/q)')],
      summaries: new Map(),
      themes: [],
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(markdown).not.toContain('[docs]');
    expect(markdown).toContain(
      `see docs(https://attacker.example/q) ([#5](${PR(5)}))`,
    );
  });

  it('lists prototype-key titles instead of dropping them from the appendix', () => {
    const markdown = renderReleaseNotesV2({
      ...base,
      entries: [
        entry(1, 'constructor: rebuild session flow'),
        entry(2, 'feat(web-shell): upload files'),
      ],
      summaries: new Map(),
      summariesZh: new Map(),
      highlights: [],
      themes: [],
    });

    expect(markdown).toContain(
      '<summary>Complete Change List (2 pull requests)</summary>',
    );
    // Once in the catch-all digest and once in the Internal Changes appendix;
    // an inherited prototype member used to classify as a non-string that
    // matched no section, silently dropping the appendix occurrence.
    expect(markdown.match(/\[#1\]/g)).toHaveLength(2);
  });

  it('renders the bilingual digest, catch-all, and collapsed appendix', () => {
    const markdown = renderReleaseNotesV2(base);

    expect(markdown).toContain('<!-- qwen-release-notes:v2 -->');
    expect(markdown).toContain('## Highlights');
    expect(markdown).toContain(
      `Upload files straight into the Web Shell composer. ([#1](${PR(1)}))`,
    );
    // Breaking changes are bilingual and stay out of the appendix.
    expect(markdown).toContain(
      `Removes the legacy v1 API endpoint. ([#4](${PR(4)})) by @alice`,
    );
    expect(markdown).toContain('  - 移除旧版 v1 API 端点。');
    // Themes with intro, then the catch-all for the unassigned PR.
    expect(markdown.indexOf('## Web Shell')).toBeGreaterThan(0);
    expect(markdown).toContain('Composer uploads landed this release.');
    expect(markdown).toContain('## Desktop');
    expect(markdown).toContain('## Other Changes');
    expect(markdown).toContain(`Tidies CI runner setup. ([#3](${PR(3)}))`);
    // Chinese block mirrors highlights and themes.
    expect(markdown).toContain('---\n\n## 中文摘要');
    expect(markdown).toContain('### 亮点');
    expect(markdown).toContain(
      `直接向 Web Shell 输入框上传文件。 ([#1](${PR(1)}))`,
    );
    expect(markdown).toContain('### Web Shell');
    expect(markdown).toContain('本次发布支持了输入框上传。');
    expect(markdown).toContain('### 桌面应用');
    expect(markdown).toContain('### 其他变更');
    // Appendix: collapsed, normalized titles, authors kept, no breaking PR.
    expect(markdown).toContain('<details>');
    expect(markdown).toContain(
      '<summary>Complete Change List (3 pull requests)</summary>',
    );
    expect(markdown).toContain(
      `web-shell: upload files ([#1](${PR(1)})) by @alice`,
    );
    expect(markdown).toContain('### Internal Changes');
    expect(markdown).not.toContain('v1 endpoint ([#4]');
    expect(markdown).toContain('</details>');
    expect(markdown).toContain(
      '**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v1.0.0...v1.1.0',
    );
  });

  it('attaches entry screenshots under digest items only', () => {
    const shot = 'https://github.com/user-attachments/assets/abc-123';
    const markdown = renderReleaseNotesV2({
      ...base,
      images: new Map([[2, [{ url: shot, alt: 'Icon preview' }]]]),
    });

    const digestIndex = markdown.indexOf(
      `Fixes the macOS icon safe area. ([#2](${PR(2)}))`,
    );
    const imageIndex = markdown.indexOf(`![Icon preview](${shot})`);
    expect(imageIndex).toBeGreaterThan(digestIndex);
    expect(markdown.match(new RegExp(`!\\[Icon preview\\]`, 'g'))).toHaveLength(
      1,
    );
    // The Chinese digest and the appendix carry no images.
    expect(markdown.indexOf('## 中文摘要')).toBeLessThan(
      markdown.indexOf('</details>'),
    );
    expect(imageIndex).toBeLessThan(markdown.indexOf('---'));
  });

  it('caps the total number of rendered images per release', () => {
    const images = new Map();
    for (const number of [1, 2, 3, 4, 5]) {
      images.set(number, [
        {
          url: `https://github.com/user-attachments/assets/a${number}`,
          alt: '',
        },
        {
          url: `https://github.com/user-attachments/assets/b${number}`,
          alt: '',
        },
      ]);
    }
    const wideTheme = {
      title: 'Everything',
      titleZh: '全部',
      intro: '',
      introZh: '',
      items: [1, 2, 3, 4, 5],
    };
    const manyEntries = [1, 2, 3, 4, 5].map((number) =>
      entry(number, `feat: change ${number}`),
    );
    const manySummaries = new Map(
      [1, 2, 3, 4, 5].map((number) => [number, `Change ${number}.`]),
    );

    const markdown = renderReleaseNotesV2({
      ...base,
      entries: manyEntries,
      summaries: manySummaries,
      summariesZh: new Map(),
      themes: [wideTheme],
      highlights: [],
      images,
    });

    expect(markdown.match(/^ {2}!\[/gm)).toHaveLength(8);
    // The degraded-release shape keeps its user-visible placeholders.
    expect(markdown).toContain('_See the complete change list below._');
    expect(markdown).toContain('No known breaking changes.');
    expect(markdown).toContain(
      '![Screenshot from pull request 1](https://github.com/user-attachments/assets/a1)',
    );
    expect(markdown).not.toContain('assets/b5');
  });

  it('falls back to English text in the Chinese digest when a translation is missing', () => {
    const partialZh = new Map([[1, '支持上传。']]);

    const markdown = renderReleaseNotesV2({ ...base, summariesZh: partialZh });

    expect(markdown).toContain(`支持上传。 ([#1](${PR(1)}))`);
    // Entry 2 has no Chinese summary, so its English one is shown instead.
    const zhSection = markdown.slice(markdown.indexOf('## 中文摘要'));
    expect(zhSection).toContain(
      `Fixes the macOS icon safe area. ([#2](${PR(2)}))`,
    );
  });

  it('omits the Chinese block and bilingual sub-lines without translations', () => {
    const englishOnlyThemes = themes.map((theme) => ({
      ...theme,
      titleZh: theme.title,
      introZh: '',
    }));
    const englishOnlyHighlights = base.highlights.map((highlight) => ({
      ...highlight,
      textZh: highlight.text,
    }));

    const markdown = renderReleaseNotesV2({
      ...base,
      summariesZh: new Map(),
      themes: englishOnlyThemes,
      highlights: englishOnlyHighlights,
    });

    expect(markdown).not.toContain('## 中文摘要');
    expect(markdown).not.toContain('\n---\n');
    expect(markdown).not.toContain('  - Removes the legacy v1 API endpoint.');
  });

  it('omits the Chinese block when Chinese summaries only echo English', () => {
    const markdown = renderReleaseNotesV2({
      ...base,
      summariesZh: new Map([[1, 'Upload workspace files from the composer.']]),
      highlights: base.highlights.map((highlight) => ({
        ...highlight,
        textZh: highlight.text,
      })),
      themes: themes.map((theme) => ({
        ...theme,
        titleZh: theme.title,
        introZh: '',
      })),
    });

    expect(markdown).not.toContain('## 中文摘要');
  });

  it('omits the breaking sub-line when the Chinese summary echoes English', () => {
    const markdown = renderReleaseNotesV2({
      ...base,
      summariesZh: new Map([[4, 'Removes the legacy v1 API endpoint.']]),
      highlights: [],
      themes: [],
    });

    expect(markdown).toContain(
      `Removes the legacy v1 API endpoint. ([#4](${PR(4)})) by @alice`,
    );
    expect(markdown).not.toContain('  - Removes the legacy v1 API endpoint.');
    expect(markdown).not.toContain('## 中文摘要');
  });

  it('normalizes fallback titles in digest items like the appendix does', () => {
    const markdown = renderReleaseNotesV2({
      ...base,
      summaries: new Map(),
      summariesZh: new Map(),
      highlights: [],
      themes: [
        {
          title: 'Web Shell',
          titleZh: 'Web Shell',
          intro: '',
          introZh: '',
          items: [1],
        },
      ],
    });

    expect(markdown).toContain(`web-shell: upload files ([#1](${PR(1)}))`);
    expect(markdown).not.toContain('feat(web-shell): upload files');
    expect(markdown).toContain('api: drop v1 endpoint');
  });

  it('renders breaking entries only in the Breaking Changes section', () => {
    const markdown = renderReleaseNotesV2({
      ...base,
      themes: [
        { title: 'API', titleZh: 'API', intro: '', introZh: '', items: [4, 1] },
        {
          title: 'Only breaking',
          titleZh: '仅破坏性',
          intro: '',
          introZh: '',
          items: [4],
        },
      ],
    });

    // Entry 4 appears exactly once: in the bilingual breaking section.
    expect(markdown.match(/\[#4\]/g)).toHaveLength(1);
    expect(markdown).toContain('## API');
    // A theme whose only item is breaking collapses away entirely.
    expect(markdown).not.toContain('Only breaking');
    expect(markdown).not.toContain('仅破坏性');
  });

  it('omits the Chinese block when translations exist only on breaking entries', () => {
    const markdown = renderReleaseNotesV2({
      ...base,
      summariesZh: new Map([[4, '移除旧版 v1 API 端点。']]),
      highlights: [],
      themes: [],
    });

    // The breaking section keeps its bilingual sub-line...
    expect(markdown).toContain('  - 移除旧版 v1 API 端点。');
    // ...but nothing translated renders inside the block, so it stays omitted.
    expect(markdown).not.toContain('## 中文摘要');
  });

  it('omits the Chinese block for an all-breaking release', () => {
    const markdown = renderReleaseNotesV2({
      entries: [entry(4, 'feat(api)!: drop v1 endpoint', ['breaking-change'])],
      summaries: new Map([[4, 'Removes the legacy v1 API endpoint.']]),
      summariesZh: new Map([[4, '移除旧版 v1 API 端点。']]),
      highlights: [],
      themes: [
        { title: 'API', titleZh: '接口', intro: '', introZh: '', items: [4] },
      ],
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(markdown).toContain('  - 移除旧版 v1 API 端点。');
    expect(markdown).not.toContain('## 中文摘要');
  });

  it('counts only listed entries and pluralizes the appendix header', () => {
    const single = renderReleaseNotesV2({
      ...base,
      entries: [entries[0]],
      themes: [],
    });

    expect(single).toContain(
      '<summary>Complete Change List (1 pull request)</summary>',
    );

    // Entry 4 is breaking and is listed only under Breaking Changes.
    expect(renderReleaseNotesV2(base)).toContain(
      '<summary>Complete Change List (3 pull requests)</summary>',
    );
  });
});

describe('generateAiContent themes', () => {
  const themeComplete = (themes) => async (request) => {
    if (request.kind === 'summaries') {
      return JSON.stringify({
        summaries: request.entries.map((item) => ({
          pr: item.number,
          summary: `Summary ${item.number}.`,
          summaryZh: `摘要 ${item.number}。`,
        })),
      });
    }
    if (request.kind === 'highlights') {
      return JSON.stringify({ highlights: [] });
    }
    return JSON.stringify({ themes });
  };

  it('rejects themes that reference unknown or duplicated pull requests', async () => {
    const entries = [entry(1, 'feat: one'), entry(2, 'feat: two')];

    const unknown = await generateAiContent(
      entries,
      themeComplete([
        { title: 'A', titleZh: '甲', intro: '', introZh: '', items: [1, 99] },
      ]),
    );
    expect(unknown.themes).toBeNull();
    expect(unknown.warnings[0]).toMatch(
      /Themes fallback:.*Unknown pull request in theme: 99/,
    );

    const duplicated = await generateAiContent(
      entries,
      themeComplete([
        { title: 'A', titleZh: '甲', intro: '', introZh: '', items: [1] },
        { title: 'B', titleZh: '乙', intro: '', introZh: '', items: [1, 2] },
      ]),
    );
    expect(duplicated.themes).toBeNull();
    expect(duplicated.warnings[0]).toMatch(
      /Themes fallback:.*assigned to two themes: 1/,
    );
  });

  it('dedupes a pull request repeated inside one theme', async () => {
    const entries = [entry(1, 'feat: one'), entry(2, 'feat: two')];

    const result = await generateAiContent(
      entries,
      themeComplete([
        {
          title: 'A',
          titleZh: '甲',
          intro: '',
          introZh: '',
          items: [1, 1, 2],
        },
      ]),
    );

    expect(result.themes).toEqual([
      { title: 'A', titleZh: '甲', intro: '', introZh: '', items: [1, 2] },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects more than eight themes', async () => {
    const entries = [entry(1, 'feat: one')];
    const themes = Array.from({ length: 9 }, (_, index) => ({
      title: `Theme ${index}`,
      titleZh: `主题 ${index}`,
      intro: '',
      introZh: '',
      items: index === 0 ? [1] : [],
    }));

    const result = await generateAiContent(entries, themeComplete(themes));

    expect(result.themes).toBeNull();
    expect(result.warnings[0]).toMatch(/Themes fallback:.*too many themes/);
  });

  it('falls back to the English title when a Chinese theme title is invalid', async () => {
    const entries = [entry(1, 'feat: one')];

    const result = await generateAiContent(
      entries,
      themeComplete([
        {
          title: 'Sessions',
          titleZh: 'See https://example.com for sessions.',
          intro: 'Overview.',
          introZh: '',
          items: [1],
        },
      ]),
    );

    expect(result.themes).toEqual([
      {
        title: 'Sessions',
        titleZh: 'Sessions',
        intro: 'Overview.',
        introZh: '',
        items: [1],
      },
    ]);
    expect(result.warnings).toEqual([
      'Chinese theme fallback for 1 theme field(s); English text is shown instead.',
    ]);
  });

  it('warns when an invalid English theme intro is dropped', async () => {
    const entries = [entry(1, 'feat: one')];

    const result = await generateAiContent(
      entries,
      themeComplete([
        {
          title: 'Sessions',
          titleZh: '会话',
          intro: 'See https://example.com for details.',
          introZh: '',
          items: [1],
        },
      ]),
    );

    expect(result.themes).toEqual([
      {
        title: 'Sessions',
        titleZh: '会话',
        intro: '',
        introZh: '',
        items: [1],
      },
    ]);
    expect(result.warnings).toEqual([
      'Theme intro fallback for 1 theme field(s); the intro was dropped.',
    ]);
  });

  it('drops intros that would inject Markdown structure', async () => {
    const entries = [1, 2, 3, 4, 5, 6].map((number) =>
      entry(number, `feat: change ${number}`),
    );

    const result = await generateAiContent(
      entries,
      themeComplete([
        {
          title: 'A',
          titleZh: '甲',
          intro: '# Known issues',
          introZh: '',
          items: [1],
        },
        {
          title: 'B',
          titleZh: '乙',
          intro: '---',
          introZh: '',
          items: [2],
        },
        {
          title: 'C',
          titleZh: '丙',
          // A reference definition arms shortcut links in sibling fields.
          intro: '[click]: //evil.example/phish',
          introZh: '',
          items: [3],
        },
        {
          title: 'D',
          titleZh: '丁',
          intro: '- - -',
          introZh: '',
          items: [4],
        },
        {
          title: 'E',
          titleZh: '戊',
          intro: '- nested list item',
          introZh: '',
          items: [5],
        },
        {
          title: 'F',
          titleZh: '己',
          intro: '1. numbered list item',
          introZh: '',
          items: [6],
        },
      ]),
    );

    expect(result.themes.map((theme) => theme.intro)).toEqual([
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(result.warnings).toEqual([
      'Theme intro fallback for 6 theme field(s); the intro was dropped.',
    ]);
  });

  it('drops intros built on escapes, long list markers, and tilde fences', async () => {
    const entries = [1, 2, 3].map((number) =>
      entry(number, `feat: change ${number}`),
    );

    const result = await generateAiContent(
      entries,
      themeComplete([
        {
          title: 'A',
          titleZh: '甲',
          // Escaped brackets hide "]" from the label checks.
          intro: '[a\\]]: //evil.example/phish',
          introZh: '',
          items: [1],
        },
        {
          title: 'B',
          titleZh: '乙',
          intro: '2025. This release ships improvements.',
          introZh: '',
          items: [2],
        },
        {
          title: 'C',
          titleZh: '丙',
          intro: '~~~',
          introZh: '',
          items: [3],
        },
      ]),
    );

    expect(result.themes.map((theme) => theme.intro)).toEqual(['', '', '']);
    expect(result.warnings).toEqual([
      'Theme intro fallback for 3 theme field(s); the intro was dropped.',
    ]);
  });

  it('drops bare list markers and single-underscore emphasis intros', async () => {
    const entries = [1, 2, 3, 4, 5].map((number) =>
      entry(number, `feat: change ${number}`),
    );

    const result = await generateAiContent(
      entries,
      themeComplete([
        { title: 'A', titleZh: '甲', intro: '-', introZh: '', items: [1] },
        { title: 'B', titleZh: '乙', intro: '+', introZh: '', items: [2] },
        { title: 'C', titleZh: '丙', intro: '1.', introZh: '', items: [3] },
        { title: 'D', titleZh: '丁', intro: '2)', introZh: '', items: [4] },
        {
          title: 'E',
          titleZh: '戊',
          // CommonMark accepts list markers at end of line, and _em_ formats.
          intro: '_Known issues_ coming soon',
          introZh: '',
          items: [5],
        },
      ]),
    );

    expect(result.themes.map((theme) => theme.intro)).toEqual([
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(result.warnings).toEqual([
      'Theme intro fallback for 5 theme field(s); the intro was dropped.',
    ]);
  });

  it('does not count an invisible Chinese intro fallback', async () => {
    const entries = [entry(1, 'feat: one')];

    const result = await generateAiContent(
      entries,
      themeComplete([
        {
          title: 'A',
          titleZh: '甲',
          intro: '',
          introZh: 'See https://example.com for details.',
          items: [1],
        },
      ]),
    );

    expect(result.themes).toEqual([
      { title: 'A', titleZh: '甲', intro: '', introZh: '', items: [1] },
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe('generateAiContent', () => {
  it('summarizes bounded batches and then generates highlights', async () => {
    const entries = [
      entry(1, 'feat(cli): add session search'),
      entry(2, 'fix(core): preserve tool results'),
      entry(3, 'docs: explain session search'),
    ];
    const calls = [];
    const complete = async (request) => {
      calls.push(request);
      if (request.kind === 'summaries') {
        return `\`\`\`json\n${JSON.stringify({
          summaries: request.entries.map((item) => ({
            pr: item.number,
            summary: `User-facing summary for ${item.number}.`,
            summaryZh: `面向用户的摘要 ${item.number}。`,
          })),
        })}\n\`\`\``;
      }
      if (request.kind === 'highlights') {
        return `\`\`\`json\n${JSON.stringify({
          highlights: [
            {
              text: 'Session workflows are clearer.',
              textZh: '会话工作流更清晰。',
              prs: [1, 2],
            },
          ],
        })}\n\`\`\``;
      }
      return `\`\`\`json\n${JSON.stringify({
        themes: [
          {
            title: 'Sessions',
            titleZh: '会话',
            intro: '',
            introZh: '',
            items: [1, 2, 3],
          },
        ],
      })}\n\`\`\``;
    };

    const result = await generateAiContent(entries, complete, { batchSize: 2 });

    expect(calls.map((call) => call.kind)).toEqual([
      'summaries',
      'summaries',
      'highlights',
      'themes',
    ]);
    expect(result.summaries.get(3)).toBe('User-facing summary for 3.');
    expect(result.summariesZh.get(3)).toBe('面向用户的摘要 3。');
    expect(result.highlights).toEqual([
      {
        text: 'Session workflows are clearer.',
        textZh: '会话工作流更清晰。',
        prs: [1, 2],
      },
    ]);
    expect(result.themes).toEqual([
      {
        title: 'Sessions',
        titleZh: '会话',
        intro: '',
        introZh: '',
        items: [1, 2, 3],
      },
    ]);
  });

  it('sends only title, a bounded body excerpt, and category to the model', async () => {
    const long = { ...entry(1, 'feat: long body'), body: 'x'.repeat(5000) };
    const calls = [];
    const complete = async (request) => {
      calls.push(request);
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: request.entries.map((item) => ({
            pr: item.number,
            summary: 'Summary.',
          })),
        });
      }
      return JSON.stringify({ highlights: [] });
    };

    await generateAiContent([long], complete);

    const [payload] = calls[0].entries;
    expect(Object.keys(payload).sort()).toEqual([
      'body',
      'category',
      'number',
      'title',
    ]);
    expect(payload.body).toHaveLength(700);
  });

  it('falls back to original titles for an invalid summary batch', async () => {
    const entries = [entry(1, 'feat: original'), entry(2, 'fix: original')];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return '{not-json';
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'feat: original'],
        [2, 'fix: original'],
      ]),
    );
    expect(result.warnings).toHaveLength(1);
  });

  it('falls back to original titles when the model omits a PR summary', async () => {
    const entries = [entry(1, 'feat: original'), entry(2, 'fix: original')];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({ summaries: [{ pr: 1, summary: 'Only one.' }] });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'feat: original'],
        [2, 'fix: original'],
      ]),
    );
    expect(result.warnings[0]).toMatch(/missing pull request summaries/);
  });

  it('falls back only the summary whose text is unsafe', async () => {
    const entries = [entry(1, 'feat: original'), entry(2, 'fix: original')];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            { pr: 1, summary: 'A safe summary.', summaryZh: '安全的摘要。' },
            {
              pr: 2,
              summary: '@QwenLM/security should review this.',
              summaryZh: '安全审查。',
            },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'A safe summary.'],
        [2, 'fix: original'],
      ]),
    );
    expect(result.warnings).toEqual([
      'Summary fallback for #2: Summary for pull request 2 must be plain text without links or HTML.',
    ]);
  });

  it('rejects GFM autolinks and encoded mentions from model text', async () => {
    const entries = [
      entry(1, 'feat: original one'),
      entry(2, 'fix: original two'),
      entry(3, 'docs: original three'),
    ];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            {
              pr: 1,
              summary: 'Visit www.example.com for details.',
              summaryZh: '摘要一。',
            },
            {
              pr: 2,
              summary: 'Contact security@example.com.',
              summaryZh: '摘要二。',
            },
            {
              pr: 3,
              summary: 'Ping &#x40;octocat for details.',
              summaryZh: '摘要三。',
            },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'feat: original one'],
        [2, 'fix: original two'],
        [3, 'docs: original three'],
      ]),
    );
    expect(result.warnings).toHaveLength(3);
  });

  it('rejects escaped-bracket links and formatting markers in summaries', async () => {
    const entries = [
      entry(1, 'feat: original one'),
      entry(2, 'fix: original two'),
      entry(3, 'docs: original three'),
    ];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            {
              pr: 1,
              summary: 'Click [a\\]](//evil.example) now',
              summaryZh: '摘要一。',
            },
            { pr: 2, summary: 'See [a\\]] here', summaryZh: '摘要二。' },
            {
              pr: 3,
              summary: 'Ship the *fast* path for ~~legacy~~ parsing',
              summaryZh: '摘要三。',
            },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries).toEqual(
      new Map([
        [1, 'feat: original one'],
        [2, 'fix: original two'],
        [3, 'docs: original three'],
      ]),
    );
    expect(result.warnings).toEqual([
      'Summary fallback for #1: Summary for pull request 1 must be plain text without links or HTML.',
      'Summary fallback for #2: Summary for pull request 2 must be plain text without links or HTML.',
      'Summary fallback for #3: Summary for pull request 3 must be plain text without links or HTML.',
    ]);
  });

  it('drops invalid highlights without losing the complete list', async () => {
    const entries = [entry(1, 'feat: original')];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [{ pr: 1, summary: 'Readable.', summaryZh: '可读。' }],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({
          highlights: [{ text: 'Invented.', textZh: '虚构。', prs: [99] }],
        });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries.get(1)).toBe('Readable.');
    expect(result.highlights).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('falls back to the English summary when a Chinese summary is missing', async () => {
    const entries = [entry(1, 'feat: one'), entry(2, 'feat: two')];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            { pr: 1, summary: 'First change.', summaryZh: '第一项变更。' },
            { pr: 2, summary: 'Second change.' },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.summaries.get(2)).toBe('Second change.');
    expect(result.summariesZh.has(2)).toBe(false);
    expect(result.warnings).toEqual([
      'Chinese summary fallback for 1 pull request(s); the Chinese digest shows their English summaries.',
    ]);
  });

  it('falls back to the English highlight text when the translation is missing', async () => {
    const entries = [entry(1, 'feat: one')];
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            { pr: 1, summary: 'First change.', summaryZh: '第一项变更。' },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({
          highlights: [{ text: 'First change.', prs: [1] }],
        });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateAiContent(entries, complete);

    expect(result.highlights).toEqual([
      { text: 'First change.', textZh: 'First change.', prs: [1] },
    ]);
    expect(result.warnings).toEqual([
      'Chinese highlight fallback for 1 highlight(s); English text is shown instead.',
    ]);
  });
});

describe('enrichEntries', () => {
  it('keeps authoritative order and fills metadata returned by GitHub', () => {
    const base = parseGeneratedEntries(
      `* feat: a by @alice in ${PR(2)}\n* fix: b by @bob in ${PR(1)}`,
    );
    const enriched = enrichEntries(base, [
      {
        number: 1,
        body: 'Why it matters.',
        labels: [{ name: 'type/bug' }],
      },
    ]);

    expect(enriched.map((item) => item.number)).toEqual([2, 1]);
    expect(enriched[0].body).toBe('');
    expect(enriched[1].body).toBe('Why it matters.');
    expect(enriched[1].labels).toEqual([{ name: 'type/bug' }]);
  });
});

describe('buildPullRequestQuery', () => {
  it('builds one aliased metadata lookup per authoritative PR number', () => {
    const query = buildPullRequestQuery([12, 8]);

    expect(query).toContain('pr0: pullRequest(number: 12)');
    expect(query).toContain('pr1: pullRequest(number: 8)');
    expect(query).toContain('labels(first: 20)');
    expect(query).not.toContain('files(first: 40)');
    expect(query).not.toContain('pullRequest(number: undefined)');
  });
});

describe('createOpenAiCompleter', () => {
  it('uses a tool-free JSON completion request', async () => {
    const requests = [];
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"summaries":[]}' } }],
          }),
        };
      },
    });

    await complete({ kind: 'summaries', entries: [] });

    expect(requests[0].url).toBe('https://model.example/v1/chat/completions');
    expect(requests[0].init.headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(requests[0].init.body);
    expect(body.model).toBe('qwen-test');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(4096);
    expect(body.tools).toBeUndefined();
    expect(requests[0].init.signal).toBeDefined();
  });

  it('scales the themes token budget with the PR count and caps it', async () => {
    const requests = [];
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"themes":[]}' } }],
          }),
        };
      },
    });
    const stubEntries = (count) =>
      Array.from({ length: count }, (_, index) => ({ number: index + 1 }));

    await complete({ kind: 'themes', entries: stubEntries(50) });
    await complete({ kind: 'themes', entries: stubEntries(150) });

    expect(JSON.parse(requests[0].init.body).max_tokens).toBe(5824);
    expect(JSON.parse(requests[1].init.body).max_tokens).toBe(8192);
  });
});

describe('generateReleaseNotes', () => {
  it('returns GitHub notes unchanged when there are no PR entries', async () => {
    const generatedBody =
      '**Full Changelog**: https://example.com/compare/a...b';
    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete: async () => {
        throw new Error('must not be called');
      },
      previousTag: 'v1.0.0',
      tag: 'v1.0.1',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toBe(generatedBody);
    expect(result.usedAi).toBe(false);
  });

  it('renders the complete fallback list and new contributor credits', async () => {
    const generatedBody = [
      "## What's Changed",
      `* feat(cli): add search by @alice in ${PR(1)}`,
      '',
      '## New Contributors',
      `* @newbie made their first contribution in ${PR(1)}`,
    ].join('\n');

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete: null,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('### Features');
    expect(result.markdown).toContain(
      `feat(cli): add search ([#1](${PR(1)})) by @alice`,
    );
    expect(result.markdown).toContain('## New Contributors');
    expect(result.markdown).toContain(
      `- @newbie made their first contribution in [#1](${PR(1)})`,
    );
    expect(result.usedAi).toBe(false);
    expect(result.warnings).toEqual(['Model configuration is unavailable.']);
  });

  it('renders the v2 bilingual digest when the model supplies themes', async () => {
    const shot = 'https://github.com/user-attachments/assets/abc-123';
    const generatedBody = [
      "## What's Changed",
      `* feat(web-shell): upload files by @alice in ${PR(1)}`,
      `* fix(core): preserve tool results by @bob in ${PR(2)}`,
    ].join('\n');
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: request.entries.map((item) => ({
            pr: item.number,
            summary: `Summary for ${item.number}.`,
            summaryZh: `摘要 ${item.number}。`,
          })),
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({
          highlights: [{ text: 'Big news.', textZh: '重大消息。', prs: [1] }],
        });
      }
      return JSON.stringify({
        themes: [
          {
            title: 'Web Shell',
            titleZh: 'Web Shell',
            intro: '',
            introZh: '',
            items: [1, 2],
          },
        ],
      });
    };

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [
        {
          number: 1,
          body: `### Evidence\n![before](${shot})`,
          labels: { nodes: [{ name: 'type/feature' }] },
        },
        { number: 2, body: '', labels: { nodes: [{ name: 'type/bug' }] } },
      ],
      complete,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('<!-- qwen-release-notes:v2 -->');
    expect(result.markdown).toContain('## Web Shell');
    expect(result.markdown).toContain('## 中文摘要');
    expect(result.markdown).toContain(`![before](${shot})`);
    expect(result.markdown).toContain(
      '<summary>Complete Change List (2 pull requests)</summary>',
    );
    expect(result.markdown).toContain(
      `web-shell: upload files ([#1](${PR(1)})) by @alice`,
    );
    expect(result.usedAi).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('does not report AI output when no model text renders', async () => {
    const generatedBody = [
      "## What's Changed",
      `* feat(cli): add search by @alice in ${PR(1)}`,
    ].join('\n');
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return '{not-json';
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('<!-- qwen-release-notes:v2 -->');
    expect(result.usedAi).toBe(false);
    expect(result.warnings[0]).toMatch(/Summary batch fallback/);
  });

  it('reports AI output when only the Chinese summaries are model-written', async () => {
    const generatedBody = [
      "## What's Changed",
      `* feat(cli): add search by @alice in ${PR(1)}`,
    ].join('\n');
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            {
              pr: 1,
              summary: 'See https://example.com for details.',
              summaryZh: '新增搜索。',
            },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('## 中文摘要');
    expect(result.markdown).toContain(`新增搜索。 ([#1](${PR(1)}))`);
    expect(result.usedAi).toBe(true);
  });

  it('does not count Chinese summaries that the v1 layout never renders', async () => {
    const generatedBody = [
      "## What's Changed",
      `* feat(cli): add search by @alice in ${PR(1)}`,
    ].join('\n');
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            {
              pr: 1,
              summary: 'See https://example.com for details.',
              summaryZh: '新增搜索。',
            },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return '{not-json';
    };

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('<!-- qwen-release-notes:v1 -->');
    expect(result.usedAi).toBe(false);
  });

  it('normalizes fallback titles in the v2 digest like the appendix', async () => {
    const generatedBody = [
      "## What's Changed",
      `* feat(web-shell): upload files by @alice in ${PR(1)}`,
      `* fix(core): preserve tool results by @bob in ${PR(2)}`,
    ].join('\n');
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            { pr: 1, summary: 'Upload files.', summaryZh: '上传文件。' },
            {
              pr: 2,
              summary: 'See https://example.com/design for details.',
            },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({
        themes: [
          {
            title: 'Work',
            titleZh: '工作',
            intro: '',
            introZh: '',
            items: [1, 2],
          },
        ],
      });
    };

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain(
      `core: preserve tool results ([#2](${PR(2)}))`,
    );
    expect(result.markdown).not.toContain('fix(core): preserve tool results');
  });

  it('falls back to the v1 layout when the themes call fails', async () => {
    const generatedBody = [
      "## What's Changed",
      `* feat(cli): add search by @alice in ${PR(1)}`,
    ].join('\n');
    const complete = async (request) => {
      if (request.kind === 'summaries') {
        return JSON.stringify({
          summaries: [
            { pr: 1, summary: 'Adds search.', summaryZh: '新增搜索。' },
          ],
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({
          highlights: [{ text: 'Search.', textZh: '搜索。', prs: [1] }],
        });
      }
      return '{not-json';
    };

    const result = await generateReleaseNotes({
      generatedBody,
      metadata: [],
      complete,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      repo: 'QwenLM/qwen-code',
    });

    expect(result.markdown).toContain('<!-- qwen-release-notes:v1 -->');
    expect(result.markdown).toContain('## Complete Change List');
    expect(result.markdown).not.toContain('## 中文摘要');
    expect(result.usedAi).toBe(true);
    expect(result.warnings[0]).toMatch(/Themes fallback/);
  });

  it.skipIf(process.platform === 'win32')(
    'runs the CLI path with fake gh data and writes fallback notes',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-notes-cli-'));
      try {
        const gh = join(dir, 'gh');
        const output = join(dir, 'notes.md');
        const summaryPath = join(dir, 'summary.md');
        writeFileSync(
          gh,
          [
            '#!/usr/bin/env node',
            'const args = process.argv.slice(2);',
            "if (args[0] === 'api' && args.includes('repos/QwenLM/qwen-code/releases/generate-notes')) {",
            "  process.stdout.write([\"## What's Changed\", '* feat: add cli path by @alice in https://github.com/QwenLM/qwen-code/pull/1'].join('\\n'));",
            '  process.exit(0);',
            '}',
            "if (args[0] === 'api' && args[1] === 'graphql') {",
            "  process.stdout.write(JSON.stringify({ data: { repository: { pr0: { number: 1, body: 'Body.', labels: { nodes: [] } } } } }));",
            '  process.exit(0);',
            '}',
            'process.exit(1);',
          ].join('\n'),
        );
        chmodSync(gh, 0o755);

        const cli = spawnSync(
          process.execPath,
          [
            'scripts/generate-release-notes.js',
            '--tag=v1.0.1',
            '--previous-tag=v1.0.0',
            `--output=${output}`,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              GITHUB_STEP_SUMMARY: summaryPath,
              GITHUB_REPOSITORY: 'QwenLM/qwen-code',
              OPENAI_API_KEY: '',
              OPENAI_BASE_URL: '',
              OPENAI_MODEL: '',
            },
          },
        );

        expect(cli.status).toBe(0);
        expect(cli.stderr).toContain(
          '::warning::Model configuration is unavailable.',
        );
        expect(readFileSync(summaryPath, 'utf8')).toContain(
          'Release notes: AI generation degraded',
        );
        const markdown = readFileSync(output, 'utf8');
        expect(markdown).toContain('### Features');
        expect(markdown).toContain(
          `feat: add cli path ([#1](${PR(1)})) by @alice`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('does not duplicate ERROR prefixes for argument failures', () => {
    try {
      execFileSync(
        process.execPath,
        [
          'scripts/generate-release-notes.js',
          '--repo=bad repo',
          '--tag=v1.0.1',
          '--previous-tag=v1.0.0',
          '--dry-run',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      throw new Error('expected command to fail');
    } catch (error) {
      expect(error.stderr).toContain(
        'ERROR: Invalid repository "bad repo"; expected "owner/name".',
      );
      expect(error.stderr).not.toContain('ERROR: ERROR:');
    }
  });
});

describe('createOpenAiCompleter retries', () => {
  const okResponse = {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"summaries":[]}' } }],
    }),
  };

  it('retries a 500 once and then succeeds', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? { ok: false, status: 500 } : okResponse;
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).resolves.toBe(
      '{"summaries":[]}',
    );
    expect(calls).toBe(2);
  });

  it('retries a timeout before giving up after maxRetries', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      'timed out',
    );
    expect(calls).toBe(3);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 400 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      'HTTP 400',
    );
    expect(calls).toBe(1);
  });

  it('retries HTTP 429 (rate limiting)', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? { ok: false, status: 429 } : okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    expect(calls).toBe(2);
  });

  it('retries network errors without HTTP status', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('fetch failed: ECONNRESET');
        }
        return okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    expect(calls).toBe(2);
  });

  it('does not retry content-validation errors', async () => {
    let calls = 0;
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        // Returns 200 OK but empty content — triggers content-validation error
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '' } }] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      'Model response did not contain message content.',
    );
    expect(calls).toBe(1);
  });

  it('preserves original error in deadline-expired message', async () => {
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        return { ok: false, status: 503 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      /budget exhausted.*HTTP 503/,
    );
  });

  it('preserves the original error as the deadline error cause', async () => {
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        return { ok: false, status: 503 };
      },
    });

    const error = await complete({ kind: 'summaries', entries: [] }).catch(
      (err) => err,
    );
    expect(error.message).toMatch(/budget exhausted.*HTTP 503/);
    expect(error.cause?.message).toBe('Model request failed with HTTP 503.');
  });

  it('preserves original error when the deadline expires after backoff', async () => {
    let now = 0;
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const timeout = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback) => {
        now = 1001;
        callback();
        return 0;
      });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 500 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      /budget exhausted.*HTTP 500/,
    );
    expect(calls).toBe(1);
    clock.mockRestore();
    random.mockRestore();
    timeout.mockRestore();
    errSpy.mockRestore();
  });

  it('logs a retry line when backing off', async () => {
    let calls = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response('\n::error::forged', { status: 200 })
          : okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    const retryLine = errSpy.mock.calls
      .map((args) => args[0])
      .find((line) => String(line).startsWith('Model request retry '));
    expect(retryLine).toBeDefined();
    expect(retryLine).not.toContain('\n');
    expect(retryLine).toContain('%0A::error::forged');
    errSpy.mockRestore();
  });

  it('stops retrying before the shared time budget expires', async () => {
    let calls = 0;
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      baseDelayMs: 100,
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 500 };
      },
    });

    await expect(complete({ kind: 'summaries', entries: [] })).rejects.toThrow(
      /budget exhausted.*HTTP 500/,
    );
    expect(calls).toBe(1);
    expect(timeout).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it('caps each request at the remaining shared time budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      timeoutMs: 10_000,
      totalTimeoutMs: 1_000,
      fetchImpl: async () => okResponse,
    });

    await complete({ kind: 'summaries', entries: [] });
    expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(1_000);
    timeout.mockRestore();
  });

  it('shares the time budget across calls', async () => {
    let now = 0;
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const complete = createOpenAiCompleter({
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1/',
      model: 'qwen-test',
      totalTimeoutMs: 50,
      fetchImpl: async () => {
        calls += 1;
        return okResponse;
      },
    });

    await complete({ kind: 'summaries', entries: [] });
    now = 51;
    await expect(complete({ kind: 'highlights', entries: [] })).rejects.toThrow(
      'Model generation time budget exhausted: unknown error',
    );
    expect(calls).toBe(1);
    clock.mockRestore();
  });
});

describe('generateAiContent circuit breaker', () => {
  it('stops calling the model after consecutive batch failures', async () => {
    const calls = [];
    const failing = async (request) => {
      calls.push(request.kind);
      throw new Error('model down');
    };
    const entries = [
      entry(1, 'one'),
      entry(2, 'two'),
      entry(3, 'three'),
      entry(4, 'four'),
      entry(5, 'five'),
    ];

    const result = await generateAiContent(entries, failing, { batchSize: 1 });

    // 3 batch attempts, then the breaker opens: no more batch calls and no
    // highlights call at all.
    expect(calls).toEqual(['summaries', 'summaries', 'summaries']);
    expect([...result.summaries.values()]).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
    expect(
      result.warnings.some((warning) =>
        warning.includes('stopped after 3 consecutive failures'),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.includes('Highlights fallback: skipped'),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.includes('Themes fallback: skipped'),
      ),
    ).toBe(true);
  });

  it('recovers without the breaker when a later batch succeeds', async () => {
    const calls = [];
    let summaryCalls = 0;
    const flaky = async (request) => {
      calls.push(request.kind);
      if (request.kind === 'summaries') {
        summaryCalls += 1;
        if (summaryCalls !== 3) throw new Error('transient');
        return JSON.stringify({
          summaries: request.entries.map((entry) => ({
            pr: entry.number,
            summary: `${entry.title} summary`,
            summaryZh: `${entry.title} 摘要`,
          })),
        });
      }
      if (request.kind === 'highlights') {
        return JSON.stringify({ highlights: [] });
      }
      return JSON.stringify({ themes: [] });
    };
    const entries = [1, 2, 3, 4, 5].map((number) =>
      entry(number, String(number)),
    );

    const result = await generateAiContent(entries, flaky, { batchSize: 1 });

    expect(calls).toEqual([
      'summaries',
      'summaries',
      'summaries',
      'summaries',
      'summaries',
      'highlights',
      'themes',
    ]);
    expect(
      result.warnings.some((warning) => warning.includes('stopped after')),
    ).toBe(false);
    expect(result.summaries.get(3)).toBe('3 summary');
  });
});

describe('appendDegradedStepSummary', () => {
  it('appends a degraded note when warnings exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-rn-summary-'));
    const summaryPath = join(dir, 'summary.md');
    // test-setup mocks appendFileSync, so assert on the call instead of the file.
    vi.mocked(appendFileSync).mockClear();
    appendDegradedStepSummary(
      { usedAi: false, warnings: ['Summary batch fallback: HTTP 500'] },
      summaryPath,
    );

    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    const [writtenPath, written] = vi.mocked(appendFileSync).mock.calls[0];
    expect(writtenPath).toBe(summaryPath);
    expect(written).toContain('AI generation degraded');
    expect(written).toContain('Summary batch fallback: HTTP 500');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing without warnings', async () => {
    const fs = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'qwen-rn-summary-'));
    const summaryPath = join(dir, 'summary.md');
    vi.mocked(appendFileSync).mockClear();
    appendDegradedStepSummary({ usedAi: true, warnings: [] }, summaryPath);
    expect(vi.mocked(appendFileSync)).not.toHaveBeenCalled();
    expect(fs.existsSync(summaryPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not propagate summary write failures (tryAppend)', () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      tryAppendDegradedStepSummary(
        { usedAi: false, warnings: ['Summary batch fallback: HTTP 500'] },
        join(tmpdir(), 'summary.md'),
      ),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to write the degraded step summary'),
    );
    errSpy.mockRestore();
  });
});

describe('escapeWorkflowCommand', () => {
  it('percent-encodes newlines so model text cannot forge a runner command', () => {
    const malicious = 'batch failed\n::error::forged annotation';
    const escaped = escapeWorkflowCommand(malicious);
    expect(escaped).not.toContain('\n');
    expect(escaped).not.toContain('\r');
    expect(escaped).toBe('batch failed%0A::error::forged annotation');
  });

  it('encodes percent signs so encoded sequences are not double-decoded', () => {
    expect(escapeWorkflowCommand('100% done')).toBe('100%25 done');
  });

  it('encodes carriage returns', () => {
    expect(escapeWorkflowCommand('a\rb')).toBe('a%0Db');
  });
});

describe('appendDegradedStepSummary markdown hardening', () => {
  it('renders warnings as escaped single-line code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-rn-summary-'));
    const summaryPath = join(dir, 'summary.md');
    vi.mocked(appendFileSync).mockClear();
    appendDegradedStepSummary(
      {
        usedAi: true,
        warnings: ['line1\n![x](https://evil.example/x.png) ```tick``` <b>&'],
      },
      summaryPath,
    );
    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    const [, written] = vi.mocked(appendFileSync).mock.calls[0];
    expect(written).toContain(
      'AI generation was partially degraded; see the warnings on this run.',
    );
    expect(written).toContain(
      '- ```` line1 ![x](https://evil.example/x.png) ```tick``` <b>& ````',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('escapes the failed-summary warning through tryAppend', () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tryAppendDegradedStepSummary(
      { usedAi: false, warnings: ['degraded'] },
      join(tmpdir(), 'summary.md'),
    );
    const emitted = errSpy.mock.calls[0][0];
    expect(emitted).toMatch(/^::warning::/);
    expect(emitted).not.toContain('\n');
    errSpy.mockRestore();
  });
});
