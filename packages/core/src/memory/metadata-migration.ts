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
  AUTO_MEMORY_DIRNAME,
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
} from './paths.js';
import {
  listTrustedMemoryMarkdownFiles,
  resolveTrustedMemoryFile,
} from './trusted-memory-filesystem.js';
import { QWEN_DIR } from '../utils/paths.js';
import {
  parseAutoMemoryTopicDocument,
  scanAllUserAutoMemoryTopicDocuments,
  scanAutoMemorySnapshot,
  validateStructuredAutoMemoryDocument,
} from './scan.js';
import {
  AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_TYPES,
  type AutoMemoryScope,
} from './types.js';
import { renderWriterKeywordVocabularySnapshot } from './writer-keyword-vocabulary.js';

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
) => Promise<GeneratedMemoryMetadata | GeneratedMemoryMetadataWithUsage>;

interface FrontmatterParts {
  frontmatter: string;
  suffix: string;
  lineEnding: '\n' | '\r\n';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isYamlObject(content: string): boolean {
  try {
    const document = parseDocument(content, { schema: 'core' });
    if (document.errors.length > 0) return false;
    const value = document.toJS() as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function splitFrontmatter(content: string): FrontmatterParts {
  const match = content.match(/^---(\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);
  if (match && isYamlObject(match[2])) {
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
  return listTrustedMemoryMarkdownFiles(
    root,
    getMemoryRootTrustedAnchor(root),
    AUTO_MEMORY_INDEX_FILENAME,
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
    if (validateStructuredAutoMemoryDocument(content).valid) continue;
    const parts = splitFrontmatter(content);
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
): string[] {
  return [
    ...new Set([
      getAutoMemoryRoot(projectRoot),
      path.join(projectRoot, QWEN_DIR, AUTO_MEMORY_DIRNAME),
    ]),
  ];
}

export async function scanMemoryMetadataCorpusStatus(params: {
  projectRoot: string;
  teamMemoryEnabled: boolean;
  trustedProject: boolean;
}): Promise<MemoryMetadataCorpusStatus> {
  const roots: Array<{ root: string; scope: AutoMemoryScope }> = [
    ...getProjectMetadataMigrationRoots(params.projectRoot).map((root) => ({
      root,
      scope: 'project' as const,
    })),
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
        files.push({
          scope,
          root,
          sourceHash: hash(`${relativePath}\0${content}`),
          legacy: !validateStructuredAutoMemoryDocument(content).valid,
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

function mergeMetadata(
  candidate: MemoryMetadataMigrationCandidate,
  metadata: GeneratedMemoryMetadata,
): string | null {
  if (
    metadata.relativePath !== candidate.relativePath ||
    metadata.sourceHash !== candidate.sourceHash
  ) {
    return null;
  }
  const parts = splitFrontmatter(candidate.content);
  const frontmatter = parts.frontmatter.trim()
    ? parseYaml(parts.frontmatter)
    : {};
  Object.assign(frontmatter, {
    name: metadata.name,
    description: metadata.description,
    type: metadata.type,
    category: metadata.category,
    keywords: metadata.keywords,
    usage_scenarios: metadata.usage_scenarios,
  });
  const renderedYaml = stringifyYaml(frontmatter)
    .trimEnd()
    .replaceAll('\n', parts.lineEnding);
  const merged = `---${parts.lineEnding}${renderedYaml}${parts.lineEnding}---${parts.suffix}`;
  return validateStructuredAutoMemoryDocument(merged).valid ? merged : null;
}

class MigrationConflictError extends Error {}

export async function commitMigratedMemoryMetadata(
  candidate: MemoryMetadataMigrationCandidate,
  metadata: GeneratedMemoryMetadata,
): Promise<'committed' | 'conflict' | 'invalid'> {
  const merged = mergeMetadata(candidate, metadata);
  if (!merged) return 'invalid';
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
    await atomicWriteFile(trustedFile, merged, {
      encoding: 'utf-8',
      noFollow: true,
      assertCanCommit: () => {
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
    ].join('\n'),
    taskPrompt: [
      `relativePath: ${candidate.relativePath}`,
      `sourceHash: ${candidate.sourceHash}`,
      '',
      vocabulary,
      '',
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
      const generated = await generateMetadata(
        params.config,
        agentCandidate,
        vocabulary,
        params.abortSignal,
      );
      const metadata = 'metadata' in generated ? generated.metadata : generated;
      if ('metadata' in generated) {
        result.agentDurationMs += generated.durationMs;
        result.inputTokens += generated.usage.inputTokens;
        result.outputTokens += generated.usage.outputTokens;
        result.totalTokens += generated.usage.totalTokens;
      }
      const status = await commitMigratedMemoryMetadata(candidate, metadata);
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
