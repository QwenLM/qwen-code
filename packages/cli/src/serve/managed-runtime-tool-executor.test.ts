/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  ManagedMcpToolUnknownError,
  ManagedToolExecutor,
  type ManagedToolReference,
} from './managed-runtime-tool-executor.js';
import {
  ManagedRuntimeLedger,
  processGroupLiveness,
  queryProcessTable,
} from './managed-runtime-ledger.js';

// A long-running foreground command the Shell tool admits: a bare
// `sleep N` trips its standalone-sleep refusal long before the budget.
const LONG_RUN = `"${process.execPath}" -e 'setInterval(()=>{},1000)'`;

// The evidence contract of a cancelled Shell is a POSIX process-group one.
describe.skipIf(process.platform === 'win32')(
  'ManagedToolExecutor physical stop',
  () => {
    let workspace: string;
    let ledgerFile: string;
    let ledger: ManagedRuntimeLedger;
    const strayGroups = new Set<number>();

    beforeEach(async () => {
      workspace = await mkdtemp(path.join(tmpdir(), 'qwen-m5c-exec-'));
      ledgerFile = path.join(workspace, 'runtime', 'ledger.json');
      ledger = ManagedRuntimeLedger.create({
        workFile: ledgerFile,
        worker: {
          pid: process.pid,
          pgid: process.pid,
          incarnation: 'inc-1',
          startedAt: Date.now(),
        },
      });
    });

    afterEach(async () => {
      for (const pgid of strayGroups) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // gone already
        }
      }
      strayGroups.clear();
      await rm(workspace, { recursive: true, force: true });
    });

    function reference(callId: string, input: unknown): ManagedToolReference {
      return {
        sessionId: 'session-b',
        promptId: 'prompt-1',
        callId,
        argsDigest: `sha256:${managedToolDigest(
          input as Record<string, unknown>,
        )}`,
      };
    }

    function executor(groupEvidenceTimeoutMs = 1_000): ManagedToolExecutor {
      return ManagedToolExecutor.forWorkspace(workspace, 'session-b', {
        ledger,
        groupEvidenceTimeoutMs,
      });
    }

    async function recordedGroup(): Promise<number> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const outstanding = ledger.outstandingGroups();
        if (outstanding.length > 0) return outstanding[0]!.pgid;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('No Shell process group reached the ledger.');
    }

    it('records a Shell group on disk before the call can settle', async () => {
      const exec = executor();
      const input = {
        command: `sleep 0.2`,
        description: 'short sleeper',
      };
      const running = exec.execute(
        reference('call-1', input),
        'run_shell_command',
        input,
      );
      const pgid = await recordedGroup();
      strayGroups.add(pgid);
      // Durable for a crash sweep while the call is still running.
      const onDisk = JSON.parse(readFileSync(ledgerFile, 'utf8')) as {
        groups: Array<{ pgid: number }>;
      };
      expect(onDisk.groups.map((group) => group.pgid)).toContain(pgid);

      const result = await running;
      expect(result.executionStatus).toBe('success');
      strayGroups.delete(pgid);
    });

    it('settles a cancel only once the whole process group is gone', async () => {
      const exec = executor();
      const input = {
        command: LONG_RUN,
        description: 'long-running foreground process',
      };
      const ref = reference('call-2', input);
      const running = exec.execute(ref, 'run_shell_command', input);
      const pgid = await recordedGroup();
      strayGroups.add(pgid);

      exec.cancel(ref);
      const result = await running;
      expect(result.executionStatus).toBe('cancelled');
      // The settlement carried the evidence: no member of the group answers.
      expect(processGroupLiveness(pgid)).toBe('gone');
      await exec.close();
      strayGroups.delete(pgid);
    });

    it('makes the call unknown when the group outlives the evidence budget', async () => {
      // The exit-evidence answer is doubled: a real group that outlives the
      // escalation window needs a coordination the test host cannot always
      // provide, and what the executor must map is the outcome, not the
      // weather. The ledger double answers 'denied', as an unkillable group
      // would.
      const waitForGroupExit = vi.fn(async () => 'denied' as const);
      const doubled = {
        addGroup: ledger.addGroup.bind(ledger),
        outstandingGroups: ledger.outstandingGroups.bind(ledger),
        waitForGroupExit,
        killOutstanding: ledger.killOutstanding.bind(ledger),
        complete: ledger.complete.bind(ledger),
        prune: ledger.prune.bind(ledger),
        watch: ledger.watch.bind(ledger),
      } as unknown as ManagedRuntimeLedger;
      const exec = ManagedToolExecutor.forWorkspace(workspace, 'session-b', {
        ledger: doubled,
        groupEvidenceTimeoutMs: 800,
      });
      const input = {
        command: LONG_RUN,
        description: 'long-running foreground process',
      };
      const ref = reference('call-3', input);
      const running = exec.execute(ref, 'run_shell_command', input);
      const pgid = await recordedGroup();
      strayGroups.add(pgid);

      exec.cancel(ref);
      await expect(running).rejects.toBeInstanceOf(ManagedMcpToolUnknownError);
      expect(exec.status(ref)).toMatchObject({ state: 'unknown' });
      // The call is not journaled settled anywhere: status reports unknown
      // and the ledger keeps naming the group.
      expect(waitForGroupExit).toHaveBeenCalledWith(pgid, 800);
      expect(ledger.outstandingGroups().map((group) => group.pgid)).toContain(
        pgid,
      );
      await exec.close();
      strayGroups.delete(pgid);
    });

    it('fails the call and kills the group when the ledger cannot record it', async () => {
      // A group that never reached the ledger must not outlive the failure:
      // the pid callback stops it first, then the call fails loudly.
      const realWait = ledger.waitForGroupExit.bind(ledger);
      const seen: number[] = [];
      const doubled = {
        addGroup: () => {
          throw new Error('ledger disk full');
        },
        outstandingGroups: ledger.outstandingGroups.bind(ledger),
        waitForGroupExit: (pgid: number, budgetMs: number) => {
          seen.push(pgid);
          return realWait(pgid, budgetMs);
        },
        killOutstanding: ledger.killOutstanding.bind(ledger),
        complete: ledger.complete.bind(ledger),
        prune: ledger.prune.bind(ledger),
        watch: ledger.watch.bind(ledger),
      } as unknown as ManagedRuntimeLedger;
      const exec = ManagedToolExecutor.forWorkspace(workspace, 'session-b', {
        ledger: doubled,
        groupEvidenceTimeoutMs: 800,
      });
      const input = {
        command: LONG_RUN,
        description: 'long-running foreground process',
      };
      const result = await exec.execute(
        reference('call-3a', input),
        'run_shell_command',
        input,
      );
      expect(result.executionStatus).toBe('error');
      expect(result.error?.message).toContain('ledger disk full');
      expect(seen).toHaveLength(1);
      // The callback killed the group it could not record.
      expect(processGroupLiveness(seen[0]!)).toBe('gone');
      await exec.close();
    });

    it('maps a throwing group-exit proof to an unknown outcome', async () => {
      // The settle-evidence read is itself a filesystem move: its failure is
      // contained as 'denied', which makes the outcome unknown — never a
      // settled cancel over a group that may still run.
      const waitForGroupExit = vi.fn(async () => {
        throw new Error('ledger unreadable');
      });
      const doubled = {
        addGroup: ledger.addGroup.bind(ledger),
        outstandingGroups: ledger.outstandingGroups.bind(ledger),
        waitForGroupExit,
        killOutstanding: ledger.killOutstanding.bind(ledger),
        complete: ledger.complete.bind(ledger),
        prune: ledger.prune.bind(ledger),
        watch: ledger.watch.bind(ledger),
      } as unknown as ManagedRuntimeLedger;
      const exec = ManagedToolExecutor.forWorkspace(workspace, 'session-b', {
        ledger: doubled,
        groupEvidenceTimeoutMs: 800,
      });
      const input = {
        command: LONG_RUN,
        description: 'long-running foreground process',
      };
      const ref = reference('call-3b', input);
      const running = exec.execute(ref, 'run_shell_command', input);
      const pgid = await recordedGroup();
      strayGroups.add(pgid);

      exec.cancel(ref);
      await expect(running).rejects.toBeInstanceOf(ManagedMcpToolUnknownError);
      expect(exec.status(ref)).toMatchObject({ state: 'unknown' });
      await exec.close();
      strayGroups.delete(pgid);
    });

    it('close() leaves an unproven survivor named in the ledger on disk', async () => {
      // A group that could not be proven stopped keeps the ledger truth for
      // the host's sweeps; close() itself still completes.
      const survivor = { pgid: 42424242, callId: 'c-x', startedAt: 1 };
      const complete = vi.fn(() => true);
      const doubled = {
        addGroup: ledger.addGroup.bind(ledger),
        outstandingGroups: ledger.outstandingGroups.bind(ledger),
        waitForGroupExit: ledger.waitForGroupExit.bind(ledger),
        killOutstanding: vi.fn(async () => [survivor]),
        complete,
        prune: ledger.prune.bind(ledger),
        watch: ledger.watch.bind(ledger),
      } as unknown as ManagedRuntimeLedger;
      const exec = ManagedToolExecutor.forWorkspace(workspace, 'session-b', {
        ledger: doubled,
      });
      await expect(exec.close()).resolves.toBeUndefined();
      expect(complete).not.toHaveBeenCalled();
      expect(existsSync(ledgerFile)).toBe(true);
    });

    it('close() contains a failing ledger sweep instead of rejecting', async () => {
      // A bookkeeping filesystem failure at close keeps the ledger and never
      // turns into a shutdown rejection.
      const doubled = {
        addGroup: ledger.addGroup.bind(ledger),
        outstandingGroups: ledger.outstandingGroups.bind(ledger),
        waitForGroupExit: ledger.waitForGroupExit.bind(ledger),
        killOutstanding: vi.fn(async () => {
          throw new Error('ledger directory vanished');
        }),
        complete: ledger.complete.bind(ledger),
        prune: ledger.prune.bind(ledger),
        watch: ledger.watch.bind(ledger),
      } as unknown as ManagedRuntimeLedger;
      const exec = ManagedToolExecutor.forWorkspace(workspace, 'session-b', {
        ledger: doubled,
      });
      await expect(exec.close()).resolves.toBeUndefined();
      expect(existsSync(ledgerFile)).toBe(true);
    });

    it('close() kills what is still running and removes a proven ledger', async () => {
      const exec = executor();
      const input = {
        command: LONG_RUN,
        description: 'long-running foreground process',
      };
      const running = exec.execute(
        reference('call-4', input),
        'run_shell_command',
        input,
      );
      void running.catch(() => undefined);
      const pgid = await recordedGroup();
      strayGroups.add(pgid);

      await exec.close();
      expect(processGroupLiveness(pgid)).toBe('gone');
      expect(existsSync(ledgerFile)).toBe(false);
      strayGroups.delete(pgid);
    });

    it('leaves a Write outside the ledger and settles without evidence', async () => {
      const exec = executor();
      const input = {
        file_path: path.join(workspace, 'a.txt'),
        content: 'hello',
      };
      const result = await exec.execute(
        reference('call-5', input),
        'write_file',
        input,
      );
      expect(result.executionStatus).toBe('success');
      expect(ledger.outstandingGroups()).toEqual([]);
      await exec.close();
      expect(existsSync(ledgerFile)).toBe(false);
    });

    it('settles a cancel without evidence when no ledger is present', async () => {
      // A worker never given a ledger keeps the M5a behavior: the cancel is
      // the invocation's word, with no group bookkeeping anywhere.
      const bare = ManagedToolExecutor.forWorkspace(workspace, 'session-b');
      const input = {
        command: `"${process.execPath}" -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)' & echo $!; wait`,
        description: 'group with a SIGTERM-ignoring member',
      };
      const ref = reference('call-6', input);
      const running = bare.execute(ref, 'run_shell_command', input);
      const deadline = Date.now() + 5_000;
      while (bare.status(ref)?.state !== 'executing') {
        if (Date.now() > deadline) throw new Error('call never started');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      bare.cancel(ref);
      const result = await running;
      expect(result.executionStatus).toBe('cancelled');
      // The member it printed kept running past the leader's exit: the M5a
      // witness, cleaned up here by bare hands.
      const printed = JSON.stringify(result.responseParts);
      const member = Number(/\b(\d{2,6})\b/u.exec(printed)?.[1]);
      if (Number.isSafeInteger(member) && member > 1) {
        try {
          process.kill(member, 'SIGKILL');
        } catch {
          // gone already
        }
      }
      // Fallback: the runaway member advertises its -e body in ps.
      for (const row of queryProcessTable().values()) {
        if (row.args.includes('setInterval(()=>{},100)')) {
          try {
            process.kill(row.pid, 'SIGKILL');
          } catch {
            // gone already
          }
        }
      }
      await bare.close();
    });
  },
);
