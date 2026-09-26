/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRelevantAutoMemoryPrompt,
  MAX_FAST_RECALL_DOCS,
  resolveRelevantAutoMemoryPromptForQuery,
  selectRelevantAutoMemoryDocuments,
} from './recall.js';
import type { ScannedAutoMemoryDocument } from './scan.js';
import type { Config } from '../config/config.js';
import { scanAllAutoMemoryTopicDocuments } from './scan.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAllAutoMemoryTopicDocuments: vi.fn(),
    // Explicit mock — recall now unions user-level docs into the pool, so
    // leaving this on the real implementation would silently fall through
    // to the filesystem (only "works" because the path doesn't exist and
    // listMarkdownFiles swallows ENOENT). Defaults to an empty pool.
    scanAllUserAutoMemoryTopicDocuments: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./relevanceSelector.js', () => ({
  selectRelevantAutoMemoryDocumentsByModel: vi.fn(),
}));

const selectByModel = vi.mocked(selectRelevantAutoMemoryDocumentsByModel);

function memoryDoc(
  filename: string,
  type: ScannedAutoMemoryDocument['type'],
  title: string,
  description = '',
  body = '',
  mtimeMs = 1,
): ScannedAutoMemoryDocument {
  return {
    type,
    filePath: `/tmp/${filename}`,
    relativePath: filename,
    filename,
    title,
    description,
    body,
    mtimeMs,
  };
}

const pad = (index: number, width: number) =>
  String(index).padStart(width, '0');
const select = selectRelevantAutoMemoryDocuments;
const filenames = (docs: ScannedAutoMemoryDocument[]) =>
  docs.map((doc) => doc.filename);
const filePaths = (docs: ScannedAutoMemoryDocument[]) =>
  docs.map((doc) => doc.filePath);
const topFile = (query: string, pool: ScannedAutoMemoryDocument[]) =>
  select(query, pool)[0]?.filename;

const docs = [
  memoryDoc(
    'reference.md',
    'reference',
    'Reference Memory',
    'Dashboards and external docs',
    '# Reference Memory\n\n- Grafana dashboard: grafana.internal/d/api-latency',
    3,
  ),
  memoryDoc(
    'project.md',
    'project',
    'Project Memory',
    'Project constraints and release context',
    '# Project Memory\n\n- Release freeze starts Friday.',
    2,
  ),
  memoryDoc(
    'user.md',
    'user',
    'User Memory',
    'User preferences',
    '# User Memory\n\n- User prefers terse responses.',
    1,
  ),
];

const activeToolDocs = [
  memoryDoc(
    'ata-tool.md',
    'reference',
    'ATA tool schema notes',
    'article-list-query parameter schema and failed tool-call attempts',
    '# ATA tool schema notes\n\n- ata::article-list-query failed with guessed field mappings.',
    4,
  ),
  memoryDoc(
    'ata-gotcha.md',
    'reference',
    'ATA tool gotcha',
    'article-list-query known workaround for transient failures',
    '# ATA tool gotcha\n\n- mcp__ata__article-list-query can return systemError during index rotation; retry after checking the ATA oncall note.',
    6,
  ),
  memoryDoc(
    'ata-owner.md',
    'reference',
    'ATA escalation',
    'ATA service owner and escalation path',
    '# ATA escalation\n\n- Ask the ATA oncall when the service returns systemError.',
    5,
  ),
];

const multilingualDocs = [
  memoryDoc(
    'zh-deploy.md',
    'project',
    '生产部署流程',
    '发布检查清单',
    '上线前确认监控和回滚开关。',
  ),
  memoryDoc(
    'zh-api.md',
    'reference',
    '接口延迟排查',
    'API 性能看板',
    '记录服务响应时间和告警入口。',
  ),
  memoryDoc(
    'ja-auth.md',
    'project',
    '認証設定ガイド',
    'ユーザーログイン構成',
    'セッション設定の確認手順。',
  ),
  memoryDoc(
    'ja-deploy.md',
    'reference',
    'デプロイ手順',
    'リリース運用',
    '本番反映前の確認事項。',
  ),
  memoryDoc(
    'ko-deploy.md',
    'project',
    '배포 절차',
    '릴리스 체크리스트',
    '운영 반영 전에 모니터링을 확인한다.',
  ),
  memoryDoc(
    'ko-auth.md',
    'reference',
    '인증 설정',
    '로그인 문제 해결',
    '세션 만료와 권한 구성을 확인한다.',
  ),
  memoryDoc(
    'en-release.md',
    'project',
    'Release process',
    'Production deployment checklist',
    'Verify monitoring before shipping.',
  ),
  memoryDoc(
    'en-style.md',
    'user',
    'Response preferences',
    'Concise answer style',
    'Keep explanations direct.',
  ),
  memoryDoc(
    'mixed-api.md',
    'reference',
    'Qwen API 限流',
    'Rate limit dashboard',
    '检查 quota 和请求速率。',
  ),
  memoryDoc(
    'body-only.md',
    'feedback',
    'Operational notes',
    'Miscellaneous guidance',
    'Emergency rollback procedures require owner approval.',
  ),
  memoryDoc(
    'ja-hiragana.md',
    'user',
    'よくあるしつもん',
    'ひらがなだけでかいたあんない',
    'ひらがなのとうこにそなえたきろく。',
  ),
];

const multilingualRecallCases: Array<
  [name: string, query: string, expectedFilename: string | null]
> = [
  ['Chinese title', '生产部署', 'zh-deploy.md'],
  ['Chinese description', '发布检查', 'zh-deploy.md'],
  ['Chinese API title', '接口延迟', 'zh-api.md'],
  ['Chinese troubleshooting', '延迟排查', 'zh-api.md'],
  ['Chinese mixed ASCII', 'API 延迟', 'zh-api.md'],
  ['Japanese Han title', '認証設定', 'ja-auth.md'],
  ['Japanese Katakana description', 'ログイン構成', 'ja-auth.md'],
  ['Japanese prolonged sound mark', 'ユーザー', 'ja-auth.md'],
  ['Japanese Katakana title', 'デプロイ手順', 'ja-deploy.md'],
  ['Japanese release description', 'リリース運用', 'ja-deploy.md'],
  ['Japanese Hiragana-only query', 'よくあるしつもん', 'ja-hiragana.md'],
  ['Korean title', '배포 절차', 'ko-deploy.md'],
  ['Korean description', '릴리스 체크', 'ko-deploy.md'],
  ['Korean auth title', '인증 설정', 'ko-auth.md'],
  ['Korean login description', '로그인 문제', 'ko-auth.md'],
  ['English title', 'release process', 'en-release.md'],
  ['English description', 'production deployment', 'en-release.md'],
  ['English style description', 'concise answer', 'en-style.md'],
  ['English preference title', 'response preferences', 'en-style.md'],
  ['Mixed-language title', 'qwen api 限流', 'mixed-api.md'],
  ['Mixed-language description', 'rate limit', 'mixed-api.md'],
  ['Mixed ASCII and Han', 'API 限流', 'mixed-api.md'],
  ['Body-only English', 'rollback procedures', 'body-only.md'],
  ['Body-only phrase', 'emergency rollback', 'body-only.md'],
  ['NFKC full-width API', 'ＱＷＥＮ ＡＰＩ', 'mixed-api.md'],
  [
    'NFKC full-width English',
    'ＰＲＯＤＵＣＴＩＯＮ deployment',
    'en-release.md',
  ],
  ['No lexical match', 'vector database', null],
  ['Single Han character', '部', null],
  ['Single Japanese character', '認', null],
  ['Single Hangul character', '배', null],
  ['Short ASCII token', 'go', null],
  ['Unrelated English terms', 'empty mismatch', null],
];

/** Scans `pool` as the project docs and resolves `query` with a config. */
function resolveFor(
  pool: ScannedAutoMemoryDocument[],
  query: string,
  options: Parameters<typeof resolveRelevantAutoMemoryPromptForQuery>[2] = {},
) {
  vi.mocked(scanAllAutoMemoryTopicDocuments).mockResolvedValue(pool);
  return resolveRelevantAutoMemoryPromptForQuery('/tmp/project', query, {
    config: {} as Config,
    ...options,
  });
}

const firstModelCandidates = () => selectByModel.mock.calls[0]![2];

describe('auto-memory relevant recall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects the most relevant documents for a query', () => {
    const selected = select('check the dashboard reference for latency', docs);
    expect(selected[0]?.type).toBe('reference');
    expect(selected.map((doc) => doc.type)).toContain('reference');
  });

  it('returns an empty list for an empty query', () => {
    expect(select('   ', docs)).toEqual([]);
  });

  it.each(multilingualRecallCases)('%s', (_name, query, expectedFilename) => {
    const selected = select(query, multilingualDocs);
    if (expectedFilename === null) {
      expect(selected).toEqual([]);
    } else {
      expect(selected[0]?.filename).toBe(expectedFilename);
    }
  });

  it('normalizes document text before matching', () => {
    expect(
      topFile('API', [memoryDoc('fw-api.md', 'reference', 'ＡＰＩ')]),
    ).toBe('fw-api.md');
  });

  it('weights each title and description match above a body match', () => {
    const bodyMatch = memoryDoc(
      'body.md',
      'reference',
      'General notes',
      'Miscellaneous',
      'Latency dashboard troubleshooting.',
    );
    const titleMatch = memoryDoc(
      'title.md',
      'reference',
      'Latency dashboard',
      'Troubleshooting reference',
      'General notes.',
    );
    expect(topFile('latency dashboard', [bodyMatch, titleMatch])).toBe(
      'title.md',
    );
    expect(
      topFile('user preferences background role', [
        memoryDoc('body.md', 'user', '', '', 'Background'),
        memoryDoc('title.md', 'project', 'Background'),
      ]),
    ).toBe('title.md');
  });

  it('applies type boosts only after a lexical match', () => {
    const userDoc = memoryDoc('user-cadence.md', 'user', 'Cadence summary');
    const projectDoc = memoryDoc(
      'project-cadence.md',
      'project',
      'Cadence summary',
    );
    // Both docs tie on lexical score for 'cadence'; the 'preference' token
    // boosts only the user-typed doc, so it must win. Without the boost they
    // would also tie on mtime and input order would surface the project doc.
    expect(topFile('cadence preference', [projectDoc, userDoc])).toBe(
      'user-cadence.md',
    );
    // Type keywords alone never surface a doc without a lexical match.
    expect(select('preference', [userDoc])).toEqual([]);
  });

  it('tokenizes alphabetic scripts outside ASCII and CJK', () => {
    // `[a-z0-9]{3,}` produced no tokens at all for these, so the
    // deterministic path was unconditionally silent — no fast result, and a
    // silent selector-failure fallback.
    const docs = [
      memoryDoc('ru.md', 'project', 'Процесс развёртывания'),
      memoryDoc('el.md', 'reference', 'Ρύθμιση σύνδεσης'),
      memoryDoc('fr.md', 'project', 'Démarrage à froid'),
    ];
    expect(topFile('развёртывания', docs)).toBe('ru.md');
    expect(topFile('σύνδεσης', docs)).toBe('el.md');
    expect(topFile('démarrage', docs)).toBe('fr.md');
  });

  it('does not let a Latin run swallow the CJK that follows it', () => {
    // `\p{L}` also matches Han, so a naive alphabetic class would tokenize
    // `abc漢字` as one run and stop matching either half on its own.
    const latin = memoryDoc('latin.md', 'reference', 'abc');
    const han = memoryDoc('han.md', 'reference', '漢字');
    expect(filenames(select('abc漢字', [latin, han]))).toEqual([
      'latin.md',
      'han.md',
    ]);
  });

  it('still ignores runs shorter than three characters', () => {
    const doc = memoryDoc('go.md', 'reference', 'go go go');
    expect(select('go', [doc])).toEqual([]);
    // Two Cyrillic letters are below the threshold for the same reason.
    expect(
      select('до', [memoryDoc('ru.md', 'reference', 'до свидания')]),
    ).toEqual([]);
  });

  it('breaks score ties by recency, not by document type', () => {
    // Every type carries the same title, so only the tie-break separates
    // them. An alphabetical type comparison orders them feedback < project <
    // reference < user, pushing user memory out of the two-document fast
    // result entirely.
    const docs = [
      memoryDoc('fb.md', 'feedback', 'Deploy notes', '', '', 10),
      memoryDoc('pr.md', 'project', 'Deploy notes', '', '', 20),
      memoryDoc('rf.md', 'reference', 'Deploy notes', '', '', 30),
      memoryDoc('us.md', 'user', 'Deploy notes', '', '', 40),
    ];
    expect(filenames(select('deploy', docs))).toEqual([
      'us.md',
      'rf.md',
      'pr.md',
      'fb.md',
    ]);
    // The fast path takes only the first MAX_FAST_RECALL_DOCS, so the
    // tie-break decides whether user memory reaches the model at all.
    expect(
      select('deploy', docs)
        .slice(0, MAX_FAST_RECALL_DOCS)
        .map((doc) => doc.type),
    ).toContain('user');
  });

  it('falls back to input order when score and recency both tie', () => {
    // Project-level documents are concatenated ahead of user-level ones in
    // `resolveRelevantAutoMemoryPromptForQuery`; the stable sort is what
    // preserves that precedence once every ranking key has tied.
    const projectDoc = memoryDoc('p.md', 'project', 'Deploy notes');
    const userDoc = memoryDoc('u.md', 'user', 'Deploy notes');
    expect(topFile('deploy', [projectDoc, userDoc])).toBe('p.md');
  });

  it('bounds long mixed queries while retaining their actual text edges', () => {
    const codePoints = Array.from({ length: 100 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index),
    );
    const asciiTokens = Array.from(
      { length: 100 },
      (_, index) => `token${pad(index, 3)}`,
    );
    const selected = select(`${codePoints.join('')} ${asciiTokens.join(' ')}`, [
      memoryDoc('query-start.md', 'reference', codePoints.slice(0, 2).join('')),
      memoryDoc(
        'query-middle.md',
        'reference',
        codePoints.slice(49, 51).join(''),
      ),
      memoryDoc('query-end.md', 'reference', asciiTokens.at(-1)!),
    ]);
    expect(filenames(selected)).toEqual(['query-start.md', 'query-end.md']);
  });

  it('refreshes repeated tokens near the query tail', () => {
    const tokens = Array.from(
      { length: 65 },
      (_, index) => `token${pad(index, 3)}`,
    );
    const selected = filenames(
      select([...tokens.slice(0, 64), tokens[32], tokens[64]].join(' '), [
        memoryDoc('repeated.md', 'reference', tokens[32]),
        memoryDoc('stale.md', 'reference', tokens[33]),
        memoryDoc('last.md', 'reference', tokens[64]),
      ]),
    );
    expect(selected).toContain('repeated.md');
    expect(selected).toContain('last.md');
    expect(selected).not.toContain('stale.md');
  });

  it('does not score body text outside the surfaced prompt window', () => {
    const doc = memoryDoc(
      'late-body.md',
      'reference',
      'General notes',
      '',
      `${'x'.repeat(1_200)}late marker`,
    );
    expect(select('late marker', [doc])).toEqual([]);
  });

  it('formats selected documents as a prompt block', () => {
    const prompt = buildRelevantAutoMemoryPrompt([docs[0], docs[2]]);
    expect(prompt).toContain('## Relevant memory');
    expect(prompt).toContain('Reference Memory (reference.md)');
    expect(prompt).toContain('User Memory (user.md)');
  });

  it('uses model-driven selection when config is provided', async () => {
    selectByModel.mockResolvedValue([docs[0]]);
    const result = await resolveFor(
      docs,
      'check the dashboard reference for latency',
    );
    expect(result.strategy).toBe('model');
    expect(result.selectedDocs).toEqual([docs[0]]);
    expect(result.prompt).toContain('Reference Memory (reference.md)');
  });

  it('bounds model candidates while retaining lexical and recent documents', async () => {
    const lexicalDocs = Array.from({ length: 200 }, (_, index) =>
      memoryDoc(
        `lexical-${pad(index, 3)}.md`,
        'reference',
        `Overflow memory ${index}`,
        'Matching historical context',
        '',
        0,
      ),
    );
    const recentDocs = Array.from({ length: 20 }, (_, index) =>
      memoryDoc(
        `recent-${pad(index, 2)}.md`,
        'reference',
        `General memory ${index}`,
        'Unrelated recent context',
        '',
        20 - index,
      ),
    );
    const lexicalTarget = memoryDoc(
      'overflow-target.md',
      'reference',
      'Overflow Zephyr Marker',
      'Unique semantic target',
      '',
      0,
    );
    selectByModel.mockImplementation(async (_config, _query, candidates) =>
      candidates.includes(lexicalTarget) ? [lexicalTarget] : [],
    );

    const result = await resolveFor(
      [...lexicalDocs, ...recentDocs, lexicalTarget],
      'find the overflow zephyr marker',
    );

    const modelCandidates = firstModelCandidates();
    expect(modelCandidates).toHaveLength(200);
    expect(modelCandidates[0]).toBe(lexicalTarget);
    expect(modelCandidates.filter((doc) => recentDocs.includes(doc))).toEqual(
      recentDocs,
    );
    expect(modelCandidates[1]).toBe(recentDocs[0]);
    expect(result.selectedDocs).toEqual([lexicalTarget]);
  });

  it('fills sparse lexical candidates to the model limit with recent docs', async () => {
    const lexicalDocs = Array.from({ length: 3 }, (_, index) =>
      memoryDoc(`lexical-${index}.md`, 'reference', `Sparse target ${index}`),
    );
    const recentDocs = Array.from({ length: 250 }, (_, index) =>
      memoryDoc(
        `recent-${pad(index, 3)}.md`,
        'reference',
        `General memory ${index}`,
        '',
        '',
        250 - index,
      ),
    );
    selectByModel.mockResolvedValue([]);

    await resolveFor([...lexicalDocs, ...recentDocs], 'find the sparse target');

    const modelCandidates = firstModelCandidates();
    expect(modelCandidates).toHaveLength(200);
    expect(modelCandidates.filter((doc) => lexicalDocs.includes(doc))).toEqual(
      lexicalDocs,
    );
    expect(modelCandidates).toContain(recentDocs[100]);
  });

  it('falls back to heuristic selection when model-driven selection fails', async () => {
    selectByModel.mockRejectedValue(new Error('selector failed'));
    const result = await resolveFor(
      docs,
      'check the dashboard reference for latency',
      { excludedFilePaths: ['/tmp/user.md'] },
    );
    expect(result.strategy).toBe('heuristic');
    expect(filePaths(result.selectedDocs)).toContain('/tmp/reference.md');
    expect(filePaths(result.selectedDocs)).not.toContain('/tmp/user.md');
  });

  it('keeps active tool schemas out of heuristic fallback', async () => {
    let modelCandidates: ScannedAutoMemoryDocument[] = [];
    selectByModel.mockImplementation(async (_config, _query, candidates) => {
      modelCandidates = candidates;
      throw new Error('selector failed');
    });

    const result = await resolveFor(
      activeToolDocs,
      'read the ATA article with article-list-query',
      { recentTools: ['mcp__ata__article-list-query'] },
    );

    expect(filePaths(modelCandidates)).not.toContain('/tmp/ata-tool.md');
    expect(filePaths(modelCandidates)).toContain('/tmp/ata-gotcha.md');
    expect(result.strategy).toBe('heuristic');
    const selected = filePaths(result.selectedDocs);
    expect(selected).not.toContain('/tmp/ata-tool.md');
    expect(selected).toContain('/tmp/ata-gotcha.md');
    expect(selected).toContain('/tmp/ata-owner.md');
  });
});
