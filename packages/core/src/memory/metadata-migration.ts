/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { deriveConfig, type Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { runForkedAgent } from '../agents/forkedAgent.js';
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../utils/yaml-parser.js';
import {
  rebuildAutoMemoryIndexAtRoot,
  rebuildManagedAutoMemoryIndex,
  rebuildTeamAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  AUTO_MEMORY_PINNED_DIRNAME,
  getAutoMemoryRoot,
  getProjectAutoMemoryRoots,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
} from './paths.js';
import {
  listTrustedMemoryMarkdownFiles,
  resolveTrustedMemoryFile,
} from './trusted-memory-filesystem.js';
import {
  parseAutoMemoryTopicDocument,
  scanAllUserAutoMemoryTopicDocuments,
  scanAutoMemorySnapshot,
  validateStructuredAutoMemoryDocument,
  type StructuredAutoMemoryValidation,
} from './scan.js';
import {
  AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_TYPES,
  type AutoMemoryScope,
} from './types.js';
import { renderWriterKeywordVocabularySnapshot } from './writer-keyword-vocabulary.js';
import { MEMORY_METADATA_ITEM_BOUNDS } from './prompt.js';

const MAX_FILES_PER_RUN = 10;
const MAX_BODY_CHARS_PER_RUN = 40_000;

export type MetadataMigrationScope = AutoMemoryScope;

export interface MemoryMetadataMigrationCandidate {
  scope: AutoMemoryScope;
  root: string;
  filePath: string;
  relativePath: string;
  content: string;
  sourceHash: string;
  bodyChars: number;
}

export interface MemoryMetadataCorpusStatus {
  ready: boolean;
  revision: string;
  files: number;
  legacyFiles: number;
  legacyByScope: Record<AutoMemoryScope, number>;
}

export interface GeneratedMemoryMetadata {
  relativePath: string;
  sourceHash: string;
  name: string;
  description: string;
  type: string;
  category: string;
  keywords: string[];
  usage_scenarios: string[];
}

interface MemoryMetadataMigrationResult {
  filesScanned: number;
  legacyFiles: number;
  remainingLegacyFiles: number;
  attempted: number;
  committed: number;
  conflicts: number;
  failed: number;
  agentDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface GeneratedMemoryMetadataWithUsage {
  metadata: GeneratedMemoryMetadata;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

type GenerateMetadata = (
  config: Config,
  candidate: MemoryMetadataMigrationCandidate,
  vocabulary: string,
  abortSignal?: AbortSignal,
  /** Frontmatter fields whose previous generated values failed validation. */
  validationFeedback?: readonly string[],
) => Promise<GeneratedMemoryMetadata | GeneratedMemoryMetadataWithUsage>;

interface FrontmatterParts {
  frontmatter: string;
  suffix: string;
  lineEnding: '\n' | '\r\n';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function splitFrontmatter(filePath: string, content: string): FrontmatterParts {
  const match = content.match(/^---(\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);
  const document = match ? parseDocument(match[2], { schema: 'core' }) : null;
  if (
    match &&
    (parseAutoMemoryTopicDocument(filePath, content) !== null ||
      (document?.errors.length === 0 &&
        Object.keys(parseYaml(match[2])).length > 0))
  ) {
    return {
      frontmatter: match[2],
      suffix: match[4],
      lineEnding: match[1] === '\r\n' ? '\r\n' : '\n',
    };
  }
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  return {
    frontmatter: '',
    suffix: `${lineEnding}${content}`,
    lineEnding,
  };
}

async function listMemoryFiles(root: string) {
  return (
    await listTrustedMemoryMarkdownFiles(
      root,
      getMemoryRootTrustedAnchor(root),
      AUTO_MEMORY_INDEX_FILENAME,
    )
  ).filter(
    ({ relativePath }) =>
      relativePath.split('/')[0]?.toLowerCase() !==
      AUTO_MEMORY_PINNED_DIRNAME.toLowerCase(),
  );
}

export async function scanMemoryMetadataMigrationCandidates(
  root: string,
  scope: AutoMemoryScope,
): Promise<MemoryMetadataMigrationCandidate[]> {
  const candidates: MemoryMetadataMigrationCandidate[] = [];
  for (const {
    relativePath,
    resolvedPath: trustedFile,
  } of await listMemoryFiles(root)) {
    const filePath = path.join(root, relativePath);
    let content: string;
    try {
      content = await fs.readFile(trustedFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const validation = validateStructuredAutoMemoryDocument(content);
    if (
      validation.valid ||
      validation.missingOrInvalidFields.includes('frontmatter-malformed')
    ) {
      continue;
    }
    const parts = splitFrontmatter(filePath, content);
    candidates.push({
      scope,
      root,
      filePath,
      relativePath,
      content,
      sourceHash: hash(content),
      bodyChars: parts.suffix.length,
    });
  }
  return candidates;
}

export function getProjectMetadataMigrationRoots(
  projectRoot: string,
  trustedProject = true,
): string[] {
  return getProjectAutoMemoryRoots(projectRoot, trustedProject);
}

export async function scanMemoryMetadataCorpusStatus(params: {
  projectRoot: string;
  teamMemoryEnabled: boolean;
  trustedProject: boolean;
}): Promise<MemoryMetadataCorpusStatus> {
  const roots: Array<{ root: string; scope: AutoMemoryScope }> = [
    ...getProjectMetadataMigrationRoots(
      params.projectRoot,
      params.trustedProject,
    ).map((root) => ({ root, scope: 'project' as const })),
    { root: getUserAutoMemoryRoot(), scope: 'user' },
  ];
  if (params.teamMemoryEnabled && params.trustedProject) {
    roots.push({
      root: getTeamAutoMemoryRoot(params.projectRoot),
      scope: 'team',
    });
  }
  const scannedRoots = await Promise.all(
    roots.map(async ({ root, scope }) => {
      const files = [];
      for (const { relativePath, resolvedPath } of await listMemoryFiles(
        root,
      )) {
        let content: string;
        try {
          content = await fs.readFile(resolvedPath, 'utf-8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const validation = validateStructuredAutoMemoryDocument(content);
        files.push({
          scope,
          root,
          sourceHash: hash(`${relativePath}\0${content}`),
          // A frontmatter-malformed file is unmigratable (the candidate scan
          // excludes it) and invisible to recall either way; counting it as
          // legacy would pin the corpus to legacy mode forever.
          legacy:
            !validation.valid &&
            !validation.missingOrInvalidFields.includes(
              'frontmatter-malformed',
            ),
        });
      }
      return files;
    }),
  );
  const allFiles = scannedRoots.flat();
  const allCandidates = allFiles.filter((file) => file.legacy);
  const legacyByScope: Record<AutoMemoryScope, number> = {
    project: 0,
    user: 0,
    team: 0,
  };
  for (const candidate of allCandidates) {
    legacyByScope[candidate.scope] += 1;
  }
  const revision = hash(
    allFiles
      .map((file) => `${file.scope}\0${file.root}\0${file.sourceHash}`)
      .sort()
      .join('\0'),
  );
  return {
    ready: allCandidates.length === 0,
    revision,
    files: allFiles.length,
    legacyFiles: allCandidates.length,
    legacyByScope,
  };
}

const OWNED_FRONTMATTER_KEYS = [
  'name',
  'description',
  'type',
  'category',
  'keywords',
  'usage_scenarios',
] as const;

interface MergedMetadata {
  content: string;
  validation: StructuredAutoMemoryValidation;
}

function mergeMetadata(
  candidate: MemoryMetadataMigrationCandidate,
  metadata: GeneratedMemoryMetadata,
): MergedMetadata | null {
  if (
    metadata.relativePath !== candidate.relativePath ||
    metadata.sourceHash !== candidate.sourceHash
  ) {
    return null;
  }
  const parts = splitFrontmatter(candidate.filePath, candidate.content);
  let renderedYaml: string | undefined;
  if (parts.frontmatter.trim()) {
    // Splice the owned keys through the YAML CST so hand-maintained comments,
    // anchors, quoting, key order, and unknown fields survive untouched;
    // a parse -> stringify round-trip would rewrite the whole document.
    const document = parseDocument(parts.frontmatter, { schema: 'core' });
    if (document.errors.length === 0) {
      try {
        for (const key of OWNED_FRONTMATTER_KEYS) {
          document.set(key, metadata[key]);
        }
        renderedYaml = document.toString();
      } catch {
        renderedYaml = undefined;
      }
    }
  }
  if (renderedYaml === undefined) {
    // No pre-existing frontmatter, or frontmatter only the lenient parser
    // accepts (e.g. tab indentation): round-trip through it instead.
    const frontmatter = parts.frontmatter.trim()
      ? parseYaml(parts.frontmatter)
      : {};
    for (const key of OWNED_FRONTMATTER_KEYS) {
      frontmatter[key] = metadata[key];
    }
    renderedYaml = stringifyYaml(frontmatter);
  }
  const normalizedYaml = renderedYaml
    .trimEnd()
    .replaceAll('\n', parts.lineEnding);
  const merged = `---${parts.lineEnding}${normalizedYaml}${parts.lineEnding}---${parts.suffix}`;
  return {
    content: merged,
    validation: validateStructuredAutoMemoryDocument(merged),
  };
}

class MigrationConflictError extends Error {}

export async function commitMigratedMemoryMetadata(
  candidate: MemoryMetadataMigrationCandidate,
  metadata: GeneratedMemoryMetadata,
  canCommit: () => boolean = () => true,
): Promise<'committed' | 'conflict' | 'invalid'> {
  const merged = mergeMetadata(candidate, metadata);
  if (!merged || !merged.validation.valid) return 'invalid';
  if (!canCommit()) return 'conflict';
  const trustedFile = await resolveTrustedMemoryFile(
    candidate.root,
    getMemoryRootTrustedAnchor(candidate.root),
    candidate.relativePath,
  );
  if (
    !trustedFile ||
    (await fs.realpath(candidate.filePath).catch(() => undefined)) !==
      trustedFile
  ) {
    return 'conflict';
  }
  const current = await fs.readFile(trustedFile, 'utf-8').catch(() => null);
  if (current === null || hash(current) !== candidate.sourceHash) {
    return 'conflict';
  }
  try {
    await atomicWriteFile(trustedFile, merged.content, {
      encoding: 'utf-8',
      noFollow: true,
      assertCanCommit: () => {
        if (!canCommit()) throw new MigrationConflictError();
        let latest: string;
        try {
          latest = fsSync.readFileSync(trustedFile, 'utf-8');
        } catch {
          throw new MigrationConflictError();
        }
        if (hash(latest) !== candidate.sourceHash) {
          throw new MigrationConflictError();
        }
      },
    });
  } catch (error) {
    if (error instanceof MigrationConflictError) return 'conflict';
    throw error;
  }
  return 'committed';
}

function parseAgentMetadata(text: string | undefined): GeneratedMemoryMetadata {
  const trimmed = text?.trim() ?? '';
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  return JSON.parse(json) as GeneratedMemoryMetadata;
}

async function generateMemoryMetadataWithAgent(
  config: Config,
  candidate: MemoryMetadataMigrationCandidate,
  vocabulary: string,
  abortSignal?: AbortSignal,
  validationFeedback?: readonly string[],
): Promise<GeneratedMemoryMetadataWithUsage> {
  const startedAt = Date.now();
  const agentConfig = deriveConfig(config, {
    getAutoMemoryPrompt: () => '',
    getUserMemory: () => '',
  });
  const result = await runForkedAgent({
    name: 'managed-memory-metadata-migrator',
    config: agentConfig,
    systemPrompt: [
      'Generate complete retrieval metadata for exactly one managed memory file.',
      'Return one JSON object only. Do not call tools or rewrite the body.',
      `type must be one of: ${AUTO_MEMORY_TYPES.join(', ')}`,
      `category must be one of: ${AUTO_MEMORY_TREE_CATEGORIES.join(', ')}`,
      'Use 2-6 discriminative keywords or short phrases and 1-3 usage_scenarios.',
      MEMORY_METADATA_ITEM_BOUNDS,
    ].join('\n'),
    taskPrompt: [
      `relativePath: ${candidate.relativePath}`,
      `sourceHash: ${candidate.sourceHash}`,
      '',
      vocabulary,
      '',
      ...(validationFeedback?.length
        ? [
            `The previous metadata was rejected; fix these fields: ${validationFeedback.join(', ')}. ${MEMORY_METADATA_ITEM_BOUNDS}`,
            '',
          ]
        : []),
      'Return: {"relativePath","sourceHash","name","description","type","category","keywords","usage_scenarios"}',
      '',
      '<memory-file>',
      candidate.content,
      '</memory-file>',
    ].join('\n'),
    maxTurns: 1,
    maxTimeMinutes: config.getMemoryAgentTimeoutMinutes() ?? 10,
    tools: [],
    abortSignal,
    suppressChatRecording: true,
  });
  if (result.status !== 'completed') {
    throw new Error(
      result.terminateReason || 'Metadata migration agent failed',
    );
  }
  return {
    metadata: parseAgentMetadata(result.finalText),
    durationMs: Date.now() - startedAt,
    usage: result.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

export async function runMemoryMetadataMigration(params: {
  config: Config;
  projectRoot: string;
  root?: string;
  roots?: readonly string[];
  scope: MetadataMigrationScope;
  abortSignal?: AbortSignal;
  generateMetadata?: GenerateMetadata;
}): Promise<MemoryMetadataMigrationResult> {
  const generateMetadata =
    params.generateMetadata ?? generateMemoryMetadataWithAgent;
  const result: MemoryMetadataMigrationResult = {
    filesScanned: 0,
    legacyFiles: 0,
    remainingLegacyFiles: 0,
    attempted: 0,
    committed: 0,
    conflicts: 0,
    failed: 0,
    agentDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let bodyChars = 0;
  const roots = params.roots ?? (params.root ? [params.root] : []);
  result.filesScanned = (
    await Promise.all(roots.map((root) => listMemoryFiles(root)))
  ).reduce((count, files) => count + files.length, 0);
  const initialCandidates = (
    await Promise.all(
      roots.map((root) =>
        scanMemoryMetadataMigrationCandidates(root, params.scope),
      ),
    )
  ).flat();
  result.legacyFiles = initialCandidates.length;
  result.remainingLegacyFiles = result.legacyFiles;
  const candidates = initialCandidates;
  const docs =
    params.scope === 'project'
      ? (
          await scanAutoMemorySnapshot(params.projectRoot, {
            scopes: ['project'],
            trustedProject: params.config.isTrustedFolder?.() ?? false,
            uncapped: true,
          })
        ).docs
      : params.scope === 'user'
        ? await scanAllUserAutoMemoryTopicDocuments()
        : (
            await scanAutoMemorySnapshot(params.projectRoot, {
              scopes: ['team'],
              teamMemoryEnabled: true,
              trustedProject: true,
              uncapped: true,
            })
          ).docs;
  const committedRoots = new Set<string>();
  const trustMustRemain =
    params.scope !== 'user' && (params.config.isTrustedFolder?.() ?? true);
  const canCommit = () =>
    !trustMustRemain || (params.config.isTrustedFolder?.() ?? true);
  const rebuildCommittedIndexes = async (): Promise<void> => {
    if (params.scope === 'project') {
      await Promise.all(
        [...committedRoots].map((root) =>
          root === getAutoMemoryRoot(params.projectRoot)
            ? rebuildManagedAutoMemoryIndex(params.projectRoot)
            : rebuildAutoMemoryIndexAtRoot(root, 'project'),
        ),
      );
    } else if (params.scope === 'user' && committedRoots.size > 0) {
      await rebuildUserAutoMemoryIndex();
    } else if (params.scope === 'team' && committedRoots.size > 0) {
      await rebuildTeamAutoMemoryIndex(params.projectRoot);
    }
  };

  for (const candidate of candidates) {
    if (result.attempted >= MAX_FILES_PER_RUN) break;
    if (params.abortSignal?.aborted) {
      await rebuildCommittedIndexes();
      throw new DOMException('Metadata migration aborted.', 'AbortError');
    }
    if (
      result.attempted > 0 &&
      bodyChars + candidate.bodyChars > MAX_BODY_CHARS_PER_RUN
    ) {
      continue;
    }
    result.attempted += 1;
    const remainingBodyChars = MAX_BODY_CHARS_PER_RUN - bodyChars;
    bodyChars += Math.min(candidate.bodyChars, remainingBodyChars);

    try {
      const vocabulary = renderWriterKeywordVocabularySnapshot(docs, {
        scopes: [params.scope],
      });
      const agentCandidate =
        candidate.bodyChars > remainingBodyChars
          ? {
              ...candidate,
              content: candidate.content.slice(0, remainingBodyChars),
              bodyChars: remainingBodyChars,
            }
          : candidate;
      const generate = async (
        validationFeedback?: readonly string[],
      ): Promise<GeneratedMemoryMetadata> => {
        const generated = await generateMetadata(
          params.config,
          agentCandidate,
          vocabulary,
          params.abortSignal,
          validationFeedback,
        );
        const generatedMetadata =
          'metadata' in generated ? generated.metadata : generated;
        if ('metadata' in generated) {
          result.agentDurationMs += generated.durationMs;
          result.inputTokens += generated.usage.inputTokens;
          result.outputTokens += generated.usage.outputTokens;
          result.totalTokens += generated.usage.totalTokens;
        }
        return generatedMetadata;
      };
      let metadata = await generate();
      const merged = mergeMetadata(candidate, metadata);
      if (merged && !merged.validation.valid) {
        // Tell the writer which fields failed instead of silently counting the
        // file as failed; one informed retry fixes bound violations the prompt
        // contract could not prevent.
        metadata = await generate(merged.validation.missingOrInvalidFields);
      }
      const status = await commitMigratedMemoryMetadata(
        candidate,
        metadata,
        canCommit,
      );
      if (status === 'committed') {
        result.committed += 1;
        committedRoots.add(candidate.root);
        const content = await fs.readFile(candidate.filePath, 'utf-8');
        const migratedDoc = parseAutoMemoryTopicDocument(
          candidate.filePath,
          content,
          0,
          candidate.relativePath,
          params.scope,
        );
        if (migratedDoc) {
          const existingIndex = docs.findIndex(
            (doc) => doc.filePath === candidate.filePath,
          );
          if (existingIndex >= 0) {
            docs[existingIndex] = migratedDoc;
          } else {
            docs.push(migratedDoc);
          }
        }
      } else if (status === 'conflict') {
        result.conflicts += 1;
      } else {
        result.failed += 1;
      }
    } catch (error) {
      if (params.abortSignal?.aborted) {
        await rebuildCommittedIndexes();
        throw error;
      }
      result.failed += 1;
    }
  }
  await rebuildCommittedIndexes();
  result.remainingLegacyFiles = (
    await Promise.all(
      roots.map((root) =>
        scanMemoryMetadataMigrationCandidates(root, params.scope),
      ),
    )
  ).reduce((count, candidates) => count + candidates.length, 0);
  return result;
}
