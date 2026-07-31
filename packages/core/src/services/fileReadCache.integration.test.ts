/**
 * Integration tests for the FileReadCache short-circuit. Real
 * filesystem, real ReadFileTool, real microcompactHistory — verify
 * that the placeholder fast-path stays correct under history rewrites.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Content } from '@google/genai';

import { FileReadCache } from './fileReadCache.js';
import { ReadFileTool } from '../tools/read-file.js';
import { microcompactHistory } from './microcompaction/microcompact.js';
import { StandardFileSystemService } from './fileSystemService.js';

function makeConfig(targetDir: string, cache: FileReadCache, disabled = false) {
  const explicit: Record<string, unknown> = {
    getTargetDir: () => targetDir,
    getProjectRoot: () => targetDir,
    getWorkspaceContext: () => ({
      isPathWithinWorkspace: () => true,
    }),
    storage: {
      getProjectTempDir: () => path.join(targetDir, '.tmp'),
      getProjectDir: () => path.join(targetDir, '.proj'),
      getUserSkillsDirs: () => [],
    },
    getFileReadCache: () => cache,
    getFileReadCacheDisabled: () => disabled,
    getFileService: () => ({ shouldQwenIgnoreFile: () => false }),
    getFileFilteringOptions: () => ({}),
    getDebugMode: () => false,
    getFileSystemService: () => new StandardFileSystemService(),
    getContentGeneratorConfig: () => ({ modalities: {} }),
    getModel: () => 'test-model',
    getTruncateToolOutputLines: () => 2000,
    getTruncateToolOutputThreshold: () => 4_000_000,
    getUsageStatisticsEnabled: () => false,
  };
  return new Proxy(explicit, {
    get(target, prop) {
      if (prop in target)
        return (target as Record<string | symbol, unknown>)[prop];
      // Default: any unknown getter returns undefined-yielding fn.
      return () => undefined;
    },
  }) as never;
}

describe('FileReadCache integration: read after history rewrite', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-3805-'));
    filePath = path.join(tmpDir, 'foo.ts');
    fs.writeFileSync(
      filePath,
      'export function hello() {\n  return "world";\n}\n'.repeat(10),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the file_unchanged placeholder on a follow-up Read after microcompact, exposing why the cache must be cleared on history rewrite', async () => {
    const cache = new FileReadCache();
    const config = makeConfig(tmpDir, cache);
    const tool = new ReadFileTool(config);

    // STEP 1 — first real Read populates the cache.
    const r1 = await tool.buildAndExecute(
      { file_path: filePath },
      new AbortController().signal,
    );
    expect(typeof r1.llmContent).toBe('string');
    expect(r1.llmContent as string).toContain('export function hello');
    expect(cache.size()).toBe(1);

    // STEP 2 — build a conversation history mirroring real flow:
    // 6 prior read_file functionResponses with the foo.ts content.
    // microcompact's keepRecent=1 will clear the oldest 5.
    const history: Content[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'read_file',
              args: { file_path: filePath },
            },
          },
        ],
      });
      history.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: r1.llmContent as string },
            },
          },
        ],
      });
    }

    // STEP 3 — microcompact fires (>60min idle).
    const mcResult = microcompactHistory(history, Date.now() - 90 * 60_000, {
      toolResultsThresholdMinutes: 60,
      toolResultsNumToKeep: 1,
    });
    expect(mcResult.meta).toBeDefined();
    expect(mcResult.meta!.toolsCleared).toBe(5);

    // Confirm: most foo.ts content has been wiped from history.
    const fooContentEntries = mcResult.history.filter((c) =>
      c.parts?.some((p) => {
        const out = p.functionResponse?.response?.['output'];
        return typeof out === 'string' && out.includes('export function hello');
      }),
    );
    // Only 1 fresh entry remains; the other 5 are placeholders.
    expect(fooContentEntries).toHaveLength(1);

    // STEP 4 — pre-fix code path: cache is NOT cleared after microcompact.
    // User reads foo.ts again. File on disk is unchanged.
    const r2 = await tool.buildAndExecute(
      { file_path: filePath },
      new AbortController().signal,
    );

    // THE BUG: returned content is the placeholder, NOT the real file.
    expect(r2.llmContent as string).toContain(
      'unchanged since last read in this session',
    );
    expect(r2.llmContent as string).not.toContain('export function hello');

    // The model now has:
    //   - history: 5 entries are [Old tool result content cleared],
    //              1 entry has real content (the most-recent kept one)
    //   - fresh tool response: a placeholder pointing at "earlier in
    //     this conversation" — which is partly true (1 entry remains)
    //     but if the LLM trusted the placeholder and discarded the
    //     last surviving entry, the bytes are unrecoverable.
    //
    // In a longer chain (e.g. 20 reads, keep 1, microcompact clears
    // 19), the surviving entry might not even be foo.ts — it would be
    // whatever was read most recently. Then the placeholder points at
    // ZERO bytes the model can find.
  });

  it('after cache.clear(), a follow-up Read of the same unchanged file re-emits the real bytes', async () => {
    const cache = new FileReadCache();
    const config = makeConfig(tmpDir, cache);
    const tool = new ReadFileTool(config);

    const r1 = await tool.buildAndExecute(
      { file_path: filePath },
      new AbortController().signal,
    );
    expect(r1.llmContent as string).toContain('export function hello');

    // The fix.
    cache.clear();

    const r2 = await tool.buildAndExecute(
      { file_path: filePath },
      new AbortController().signal,
    );

    expect(r2.llmContent as string).toContain('export function hello');
    expect(r2.llmContent as string).not.toContain(
      'unchanged since last read in this session',
    );
  });

  it('worst case: when microcompact removes every prior read of a file, the placeholder leaves zero recoverable bytes for the model', async () => {
    // This is the worst-case version: many reads, microcompact clears
    // everything, the surviving entry is a different file. The placeholder
    // then points the model at content that no longer exists anywhere
    // in its reachable context.
    const cache = new FileReadCache();
    const config = makeConfig(tmpDir, cache);
    const tool = new ReadFileTool(config);

    const otherPath = path.join(tmpDir, 'other.ts');
    fs.writeFileSync(otherPath, 'unrelated\n');

    // Read foo.ts (target file).
    await tool.buildAndExecute(
      { file_path: filePath },
      new AbortController().signal,
    );

    // Build history: 1 foo.ts read, then 1 other.ts read (kept).
    const fooContent = fs.readFileSync(filePath, 'utf-8');
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'read_file',
              args: { file_path: filePath },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: fooContent },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'read_file',
              args: { file_path: otherPath },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'unrelated\n' },
            },
          },
        ],
      },
    ];

    const mc = microcompactHistory(history, Date.now() - 90 * 60_000, {
      toolResultsThresholdMinutes: 60,
      toolResultsNumToKeep: 1,
    });
    expect(mc.meta!.toolsCleared).toBe(1);

    // foo.ts content is gone from history; only other.ts remains.
    const surviving = mc.history
      .flatMap((c) => c.parts ?? [])
      .map((p) => p.functionResponse?.response?.['output'])
      .filter((o): o is string => typeof o === 'string');
    expect(surviving.some((o) => o.includes('export function hello'))).toBe(
      false,
    );

    // Now Read foo.ts again — pre-fix, cache returns placeholder.
    const r = await tool.buildAndExecute(
      { file_path: filePath },
      new AbortController().signal,
    );

    expect(r.llmContent as string).toContain(
      'unchanged since last read in this session',
    );
    // Total foo.ts content reachable to the model:
    //   history → 0 bytes
    //   fresh tool result → placeholder, 0 bytes
    // The model literally cannot recover the file contents.
  });
});
