/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  categorize,
  isNoiseEntry,
  parseReleaseEntries,
  formatEntry,
  formatRelease,
  buildChangelog,
  toReleaseModel,
  selectStableReleases,
  parseJsonl,
} from '../generate-changelog.js';

const PR = (n) => `https://github.com/QwenLM/qwen-code/pull/${n}`;

describe('categorize', () => {
  it('splits type, scope, and description', () => {
    expect(categorize('feat(cli): add x')).toEqual({
      type: 'feat',
      scope: 'cli',
      description: 'add x',
      breaking: false,
    });
  });

  it('handles a missing scope', () => {
    expect(categorize('fix: bar')).toEqual({
      type: 'fix',
      scope: null,
      description: 'bar',
      breaking: false,
    });
  });

  it('captures the breaking-change "!" marker', () => {
    expect(categorize('feat(core)!: breaking')).toEqual({
      type: 'feat',
      scope: 'core',
      description: 'breaking',
      breaking: true,
    });
  });

  it('captures "!" even without a scope', () => {
    expect(categorize('feat!: drop legacy flag')).toEqual({
      type: 'feat',
      scope: null,
      description: 'drop legacy flag',
      breaking: true,
    });
  });

  it('treats a prefix-less subject as untyped', () => {
    expect(categorize('Improve hooks matcher display')).toEqual({
      type: null,
      scope: null,
      description: 'Improve hooks matcher display',
      breaking: false,
    });
  });
});

describe('isNoiseEntry', () => {
  it('drops the release bot version bump', () => {
    expect(isNoiseEntry('chore(release): v0.17.0')).toBe(true);
  });

  it('keeps other chores (e.g. dependency bumps)', () => {
    expect(isNoiseEntry('chore(deps): update @google/genai')).toBe(false);
  });

  it('keeps real changes', () => {
    expect(isNoiseEntry('feat(cli): add x')).toBe(false);
  });
});

describe('parseReleaseEntries', () => {
  it('extracts only "What\'s Changed" bullets', () => {
    const body = [
      "## What's Changed",
      '* feat(cli): add x by @alice in ' + PR(42),
      '- fix(core): do y by @bob-1 in ' + PR(7),
      '',
      '## New Contributors',
      '* @newbie made their first contribution in ' + PR(99),
      '',
      '**Full Changelog**: https://github.com/QwenLM/qwen-code/compare/v1...v2',
    ].join('\n');

    expect(parseReleaseEntries(body)).toEqual([
      {
        title: 'feat(cli): add x',
        author: 'alice',
        prUrl: PR(42),
        prNumber: '42',
      },
      {
        title: 'fix(core): do y',
        author: 'bob-1',
        prUrl: PR(7),
        prNumber: '7',
      },
    ]);
  });

  it('parses GitHub App authors with a [bot] suffix', () => {
    const body = '* chore(deps): bump foo by @dependabot[bot] in ' + PR(33);
    expect(parseReleaseEntries(body)).toEqual([
      {
        title: 'chore(deps): bump foo',
        author: 'dependabot[bot]',
        prUrl: PR(33),
        prNumber: '33',
      },
    ]);
  });

  it('binds the trailing " by @… in …" to the last occurrence', () => {
    const body = '* fix: stop saying "done" by @carol in ' + PR(5);
    expect(parseReleaseEntries(body)).toEqual([
      {
        title: 'fix: stop saying "done"',
        author: 'carol',
        prUrl: PR(5),
        prNumber: '5',
      },
    ]);
  });

  it('returns an empty list for an empty or link-only body', () => {
    expect(parseReleaseEntries('')).toEqual([]);
    expect(
      parseReleaseEntries(
        '**Full Changelog**: https://github.com/o/r/compare/a...b',
      ),
    ).toEqual([]);
  });
});

describe('formatEntry', () => {
  it('strips a recognised type prefix but keeps the scope', () => {
    expect(
      formatEntry({ title: 'feat(cli): add x', prNumber: '42', prUrl: PR(42) }),
    ).toBe(`- cli: add x ([#42](${PR(42)}))`);
  });

  it('drops the prefix entirely when there is no scope', () => {
    expect(
      formatEntry({ title: 'fix: bar', prNumber: '7', prUrl: PR(7) }),
    ).toBe(`- bar ([#7](${PR(7)}))`);
  });

  it('keeps an untyped title verbatim', () => {
    expect(
      formatEntry({ title: 'Support openrouter', prNumber: '9', prUrl: PR(9) }),
    ).toBe(`- Support openrouter ([#9](${PR(9)}))`);
  });

  it('flags a breaking change with a BREAKING prefix', () => {
    expect(
      formatEntry({
        title: 'refactor(core)!: replace X',
        prNumber: '8',
        prUrl: PR(8),
      }),
    ).toBe(`- **BREAKING** core: replace X ([#8](${PR(8)}))`);
  });
});

describe('formatRelease', () => {
  it('groups entries into ordered sections and drops noise', () => {
    const block = formatRelease({
      version: '1.2.3',
      date: '2026-01-02',
      htmlUrl: 'https://example.com/v1.2.3',
      entries: [
        { title: 'fix(core): a', prNumber: '1', prUrl: PR(1) },
        { title: 'feat(cli): b', prNumber: '2', prUrl: PR(2) },
        { title: 'chore(release): v1.2.3', prNumber: '3', prUrl: PR(3) },
        { title: 'docs: c', prNumber: '4', prUrl: PR(4) },
      ],
    });

    expect(block).toContain(
      '## [1.2.3](https://example.com/v1.2.3) - 2026-01-02',
    );
    // Added before Fixed before Documentation.
    expect(block.indexOf('### Added')).toBeLessThan(block.indexOf('### Fixed'));
    expect(block.indexOf('### Fixed')).toBeLessThan(
      block.indexOf('### Documentation'),
    );
    // The release bot bump is excluded.
    expect(block).not.toContain('v1.2.3 (');
    expect(block).not.toContain('### Other');
  });

  it('falls back to a release link when nothing parses', () => {
    const block = formatRelease({
      version: '0.0.2',
      date: '2025-08-01',
      htmlUrl: 'https://example.com/v0.0.2',
      entries: [],
    });
    expect(block).toContain(
      '_See [GitHub release](https://example.com/v0.0.2) for details._',
    );
    expect(block).not.toContain('###');
  });
});

describe('selectStableReleases', () => {
  it('keeps only stable semver releases, newest first', () => {
    const raw = [
      {
        tag: 'v1.2.0',
        prerelease: false,
        draft: false,
        published_at: '',
        body: '',
      },
      {
        tag: 'v1.10.0',
        prerelease: false,
        draft: false,
        published_at: '',
        body: '',
      },
      {
        tag: 'v1.2.0-preview.1',
        prerelease: true,
        draft: false,
        published_at: '',
        body: '',
      },
      {
        tag: 'v1.3.0-nightly.20260101.abc',
        prerelease: true,
        draft: false,
        published_at: '',
        body: '',
      },
      {
        tag: 'some-random-tag',
        prerelease: false,
        draft: false,
        published_at: '',
        body: '',
      },
      {
        tag: 'v1.0.0',
        prerelease: false,
        draft: true,
        published_at: '',
        body: '',
      },
    ].map((r) => ({
      tag: r.tag,
      prerelease: r.prerelease,
      draft: r.draft,
      date: r.published_at,
      url: '',
      body: r.body,
    }));

    // selectStableReleases consumes the gh-shaped objects directly.
    const releases = selectStableReleases(
      raw.map((r) => ({
        tag: r.tag,
        prerelease: r.prerelease,
        draft: r.draft,
        url: r.url,
        body: r.body,
        date: r.date,
      })),
    );

    expect(releases.map((r) => r.version)).toEqual(['1.10.0', '1.2.0']);
  });
});

describe('toReleaseModel', () => {
  it('derives version and trims the date', () => {
    const model = toReleaseModel({
      tag: 'v0.17.1',
      date: '2026-06-03T11:58:14Z',
      url: 'https://example.com/v0.17.1',
      body: '* feat: x by @a in ' + PR(1),
    });
    expect(model.version).toBe('0.17.1');
    expect(model.date).toBe('2026-06-03');
    expect(model.entries).toHaveLength(1);
  });

  it('marks a non-semver tag as unversioned', () => {
    expect(
      toReleaseModel({ tag: 'nightly-build', body: '' }).version,
    ).toBeNull();
  });
});

describe('parseJsonl', () => {
  it('parses one object per line and skips blanks', () => {
    const jsonl = '{"tag":"v1.0.0"}\n\n{"tag":"v1.1.0"}\n';
    expect(parseJsonl(jsonl)).toEqual([{ tag: 'v1.0.0' }, { tag: 'v1.1.0' }]);
  });
});

describe('buildChangelog', () => {
  it('renders the header and each release once', () => {
    const out = buildChangelog([
      {
        version: '1.0.0',
        date: '2026-01-01',
        htmlUrl: 'https://example.com/v1.0.0',
        entries: [{ title: 'feat: launch', prNumber: '1', prUrl: PR(1) }],
      },
    ]);
    expect(out.startsWith('# Changelog')).toBe(true);
    expect(out).toContain('Keep a Changelog');
    expect(out).toContain(
      '## [1.0.0](https://example.com/v1.0.0) - 2026-01-01',
    );
    expect(out.endsWith('\n')).toBe(true);
    expect(out).not.toMatch(/\n{3,}/);
  });
});
