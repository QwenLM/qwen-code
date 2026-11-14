/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { EditTool, type EditToolParams } from './edit.js';
import {
  clearEditReferences,
  syncEditReferenceDelivery,
} from './edit-references.js';
import { ReadFileTool } from './read-file.js';
import type { ToolResult } from './tools.js';

interface CorpusCase {
  id: string;
  kind: 'no-match' | 'stale';
  coverage: 'full' | 'excerpt';
  evidence: 'read' | 'reconstructed-write';
  recoveryEligible: boolean;
  content: string;
  oldString: string;
  newString: string;
  expectedCandidate: string | null;
  repairedNewString?: string;
  expectedContent?: string;
  previousContent?: string;
  currentContent?: string;
}

const corpusJson = readFileSync(
  new URL('./fixtures/edit-recovery-cases.json', import.meta.url),
  'utf8',
);
const cases = JSON.parse(corpusJson) as CorpusCase[];
const oracleCases = cases.filter((sample) => sample.recoveryEligible);
const baselineResults: Array<Record<string, unknown>> = [];
const recoveryResults: Array<Record<string, unknown>> = [];
const controller = new AbortController();
const referenceId = (text: string, kind: 'read' | 'recovery') =>
  text.match(new RegExp(`${kind}_id: "([^"]+)"`))?.[1];

describe('production-derived edit recovery corpus', () => {
  let workspace: string;
  let config: Config;

  afterEach(async () => {
    if (config) clearEditReferences(config);
    vi.restoreAllMocks();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  afterAll(async () => {
    const report = process.env['QWEN_EDIT_RECOVERY_REPORT'];
    if (report)
      await writeFile(
        report,
        JSON.stringify(
          {
            fixtureSha256: createHash('sha256')
              .update(corpusJson)
              .digest('hex'),
            baseline: baselineResults,
            recovery: recoveryResults,
            scope:
              '50 real sanitized episodes; recovery correctness has independent oracles only for seven. Direct real-filesystem tool replay, not a model-efficiency experiment.',
          },
          null,
          2,
        ),
      );
  });

  async function setup(sample: CorpusCase) {
    workspace = await mkdtemp(join(tmpdir(), `edit-recovery-${sample.id}-`));
    config = new Config({
      targetDir: workspace,
      cwd: workspace,
      debugMode: false,
      telemetry: { enabled: false },
      deferTelemetryInitialization: true,
      usageStatisticsEnabled: false,
      chatRecording: false,
    });
    vi.spyOn(config.getFileHistoryService(), 'trackEdit').mockResolvedValue();
    const file = join(workspace, 'document.txt');
    const previous =
      sample.kind === 'stale' ? sample.previousContent! : sample.content;
    await writeFile(file, previous);
    await new ReadFileTool(config)
      .build({ file_path: file })
      .execute(controller.signal);
    if (sample.kind === 'stale') {
      const before = await stat(file);
      await writeFile(file, sample.currentContent!);
      await utimes(file, before.atime, new Date(before.mtimeMs + 2_000));
    }
    const run = (args: Record<string, unknown>) =>
      new EditTool(config)
        .build(args as unknown as EditToolParams)
        .execute(controller.signal);
    const failure = await run({
      file_path: file,
      old_string: sample.oldString,
      new_string: sample.newString,
    });
    expect(failure.error?.type).toBe(
      sample.kind === 'no-match'
        ? 'edit_no_occurrence_found'
        : 'file_changed_since_read',
    );
    const current =
      sample.kind === 'stale' ? sample.currentContent! : sample.content;
    expect(await readFile(file, 'utf8')).toBe(current);
    return { file, run, failure, current };
  }

  it('keeps the independently documented corpus and oracle populations explicit', () => {
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((sample) => sample.id)).size).toBe(50);
    expect(cases.filter((sample) => sample.kind === 'no-match')).toHaveLength(
      39,
    );
    expect(cases.filter((sample) => sample.kind === 'stale')).toHaveLength(11);
    expect(oracleCases.map((sample) => sample.id)).toEqual([
      'case-001',
      'case-002',
      'case-003',
      'case-004',
      'case-005',
      'case-006',
      'case-007',
    ]);
    expect(
      cases
        .filter((sample) => !sample.recoveryEligible)
        .every((sample) => sample.expectedCandidate === null),
    ).toBe(true);
  });

  it.each(cases)(
    '$id reproduces $kind and refuses to write',
    async (sample) => {
      const { failure } = await setup(sample);
      baselineResults.push({
        id: sample.id,
        kind: sample.kind,
        coverage: sample.coverage,
        evidence: sample.evidence,
        error: failure.error?.type,
        unchanged: true,
        recoveryReferenceOffered: Boolean(
          referenceId(String(failure.llmContent), 'recovery'),
        ),
        correctnessOracleAvailable: sample.recoveryEligible,
      });
    },
  );

  it.each(oracleCases)(
    '$id completes only its independently verified target',
    async (sample) => {
      const { file, run, failure, current } = await setup(sample);
      const candidate = sample.expectedCandidate!;
      const repairedNew = sample.repairedNewString!;
      expect(candidate.length).toBeGreaterThan(0);
      const offset = current.indexOf(candidate);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(current.indexOf(candidate, offset + 1)).toBe(-1);
      expect(sample.expectedContent).toBe(
        current.slice(0, offset) +
          repairedNew +
          current.slice(offset + candidate.length),
      );
      const failureText = String(failure.llmContent);
      const recoveryId = referenceId(failureText, 'recovery');
      const deliveredCandidate = failureText.match(
        /<current_edit_target>\n([\s\S]*?)\n<\/current_edit_target>/,
      )?.[1];
      const p1MatchesOracle =
        Boolean(recoveryId) && deliveredCandidate === candidate;
      let route: 'P1' | 'P2' | 'safe-fallback' = 'safe-fallback';
      let result: ToolResult | undefined;
      if (p1MatchesOracle) {
        syncEditReferenceDelivery(config, [failureText]);
        result = await run({
          file_path: file,
          recovery_id: recoveryId,
          ...(repairedNew === sample.newString
            ? {}
            : { new_string: repairedNew }),
        });
        route = 'P1';
      } else {
        const startLine = current.slice(0, offset).split('\n').length;
        const endLine = current
          .slice(0, offset + candidate.length - 1)
          .split('\n').length;
        const lineStart =
          offset === 0 ? 0 : current.lastIndexOf('\n', offset - 1) + 1;
        const nextNewline = current.indexOf(
          '\n',
          offset + candidate.length - 1,
        );
        const lineEnd = nextNewline < 0 ? current.length : nextNewline + 1;
        const rangeNew =
          current.slice(lineStart, offset) +
          repairedNew +
          current.slice(offset + candidate.length, lineEnd);
        const read = await new ReadFileTool(config)
          .build({
            file_path: file,
            offset: startLine - 1,
            limit: endLine - startLine + 1,
          })
          .execute(controller.signal);
        const readText = String(read.llmContent);
        const readId = referenceId(readText, 'read');
        if (
          readId &&
          (!current.slice(lineStart, lineEnd).endsWith('\n') ||
            !rangeNew ||
            rangeNew.endsWith('\n'))
        ) {
          syncEditReferenceDelivery(config, [readText]);
          result = await run({
            file_path: file,
            read_id: readId,
            start_line: startLine,
            end_line: endLine,
            new_string: rangeNew,
          });
          route = 'P2';
        }
      }
      if (route === 'safe-fallback') {
        expect(await readFile(file, 'utf8')).toBe(current);
      } else {
        expect(result?.error).toBeUndefined();
        expect(await readFile(file, 'utf8')).toBe(sample.expectedContent);
      }
      recoveryResults.push({
        id: sample.id,
        route,
        p1ReferenceOffered: Boolean(recoveryId),
        p1CandidateMatchesIndependentOracle: p1MatchesOracle,
        reusedFailedReplacement:
          route === 'P1' && repairedNew === sample.newString,
        strictExpectedContentMatched: route !== 'safe-fallback',
        coverage: sample.coverage,
        evidence: sample.evidence,
      });
    },
  );
});
