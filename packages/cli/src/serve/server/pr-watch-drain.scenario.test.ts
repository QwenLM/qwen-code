/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-scenario coverage for the drain: a real `gh` child process (a PATH
 * stub, the GitHub boundary), the real observation tick, real PR sidecars and
 * transcripts read by the real bindings scan, the real watch store under a
 * real PathMutexRegistry, and the real `admitSessionPrompt` with its
 * idempotency ring and key cap. Only the agent bridge (the model boundary)
 * and the restore handler the enablement increment extracts are substituted.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeSessionSummary } from '@qwen-code/acp-bridge/bridgeTypes';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { upsertSessionPr } from '@qwen-code/qwen-code-core/services/session-pr-service.js';
import {
  autofixPrPaths,
  readState,
  sameRepository,
  vouchedScanRoots,
  writeState,
  type AutofixPrState,
} from '../../commands/autofix-pr/state.js';
import { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import { cloneWorktreesOf } from '../routes/autofix-pr-watches.js';
import {
  scanWorkspaceBindings,
  type SessionPrBindingSummary,
} from '../routes/session-pr-bindings.js';
import { admitSessionPrompt } from '../routes/session-prompt-admission.js';
import {
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { SessionArchiveCoordinator } from './session-archive.js';
import {
  createPrWatchDrainState,
  runPrWatchDrainTick,
  type PrWatchDrainDeps,
  type PrWatchDrainState,
  type PrWatchRecipient,
} from './pr-watch-drain.js';
import {
  prWatchIdentityFromUrl,
  runPrWatchObservationTick,
} from './pr-watch-observation.js';
import {
  prWatchFilePath,
  readPrWatchStateSync,
  writePrWatchStateSync,
} from './pr-watch-store.js';

const REPO = 'acme/widgets';
const PR = 42;
const PR_URL = `https://github.com/${REPO}/pull/${PR}`;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);

interface Admission {
  sessionId: string;
  key: string;
  text: string;
  deduplicated: boolean;
}

let root: string;
let runtimeDir: string;
let ws: string;
let watchDir: string;
let viewsDir: string;
let binDir: string;
let ghLog: string;
let locks: PathMutexRegistry;
let drainState: PrWatchDrainState;
let sweepOffsets: Map<string, number>;
let live: Map<string, BridgeSessionSummary>;
let admissions: Admission[];
let enqueued: Array<{ sessionId: string; text: string }>;
let logs: string[];
let runtime: WorkspaceRuntime;
let extraRuntimes: WorkspaceRuntime[];
let drainDeps: PrWatchDrainDeps;
/** Runs just before each real admission: the fault-injection point. */
let beforeAdmit: (() => void) | undefined;
/**
 * The admission entry point the harness calls. A real-restart scenario
 * replaces it with a freshly imported module, whose process-global
 * idempotency ring is empty — what a new process actually starts with.
 */
let admitImpl: typeof admitSessionPrompt;

function allRuntimes(): WorkspaceRuntime[] {
  return [runtime, ...extraRuntimes];
}

function chatsDir(cwd: string = ws): string {
  return path.join(new Storage(cwd).getProjectDir(), 'chats');
}

function ghCalls(): string[] {
  if (!existsSync(ghLog)) return [];
  return readFileSync(ghLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

/** The `gh pr view --json` payload GitHub returns for the scenario's PR. */
function writeView(
  head: string,
  opts: {
    checks?: 'passing' | 'failing';
    state?: 'OPEN' | 'MERGED' | 'CLOSED';
    mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    url?: string;
  } = {},
): void {
  const conclusion = opts.checks === 'failing' ? 'FAILURE' : 'SUCCESS';
  writeFileSync(
    path.join(viewsDir, `${PR}.json`),
    JSON.stringify({
      url: opts.url ?? PR_URL,
      title: 'Scenario PR',
      headRefOid: head,
      mergeable: opts.mergeable ?? 'MERGEABLE',
      state: opts.state ?? 'OPEN',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'unit',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion,
        },
      ],
    }),
    'utf8',
  );
}

async function seedSession(
  opts: {
    role?: 'review' | 'verify' | 'fix';
    mtime?: Date;
    live?: boolean;
    cwd?: string;
    url?: string;
    number?: number;
  } = {},
): Promise<string> {
  const cwd = opts.cwd ?? ws;
  const sessionId = randomUUID();
  mkdirSync(chatsDir(cwd), { recursive: true });
  const transcript = path.join(chatsDir(cwd), `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    JSON.stringify({
      uuid: `${sessionId}-user-1`,
      parentUuid: null,
      sessionId,
      timestamp: '2026-11-01T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hello' }] },
      cwd,
    }) + '\n',
    'utf8',
  );
  if (opts.mtime) utimesSync(transcript, opts.mtime, opts.mtime);
  await upsertSessionPr(path.join(chatsDir(cwd), `${sessionId}.pr.json`), {
    number: opts.number ?? PR,
    url: opts.url ?? PR_URL,
    state: 'open',
    ...(opts.role !== undefined ? { role: opts.role } : {}),
  });
  if (opts.live !== false) {
    live.set(sessionId, {
      sessionId,
      workspaceCwd: cwd,
      createdAt: '2026-11-01T00:00:00.000Z',
      clientCount: 1,
      hasActivePrompt: false,
    });
  }
  return sessionId;
}

/** Observed unbind: the sidecar tombstone the metadata route writes. */
function unbind(sessionId: string, cwd: string = ws): void {
  writeFileSync(
    path.join(chatsDir(cwd), `${sessionId}.pr.json`),
    JSON.stringify({ prs: [] }),
    'utf8',
  );
}

function observe(): Promise<{ claimed: boolean; observed: number }> {
  return runPrWatchObservationTick(
    allRuntimes(),
    {
      watchDir,
      locks,
      allowedHosts: new Set(['github.com']),
      log: (message) => logs.push(message),
    },
    { intervalMs: 60_000, sweepOffsets },
  );
}

function drain(): ReturnType<typeof runPrWatchDrainTick> {
  return runPrWatchDrainTick(allRuntimes(), drainDeps, drainState);
}

/**
 * The discriminated read: absence assertions must branch on `kind`, or a
 * corrupt/unreadable file would satisfy "the file was deleted" too.
 */
function storedRead() {
  return readPrWatchStateSync(watchDir, {
    host: 'github.com',
    repo: REPO,
    number: PR,
  });
}

function stored() {
  const read = storedRead();
  return read.kind === 'state' ? read.state : undefined;
}

/**
 * The self-push ledger composition the enablement increment provisions:
 * real worktree discovery, real vouching, real state reads. Kept here so the
 * scenario exercises the ledger format the drain's suppression relies on.
 */
async function ledgerHeads(
  recipient: PrWatchRecipient,
): Promise<ReadonlySet<string> | undefined> {
  const identity = prWatchIdentityFromUrl(recipient.url);
  if (!identity) return undefined;
  const [owner, repo] = identity.repo.split('/');
  const roots = vouchedScanRoots(
    await cloneWorktreesOf(recipient.workspaceCwd),
  );
  for (const scanRoot of roots) {
    let state: AutofixPrState | null;
    try {
      state = readState(autofixPrPaths(scanRoot, identity.number).statePath);
    } catch {
      continue;
    }
    if (!state || state.sessionId !== recipient.sessionId) continue;
    if (
      !sameRepository(
        { host: state.host, owner: state.owner, repo: state.repo },
        { host: identity.host, owner: owner!, repo: repo! },
      )
    ) {
      continue;
    }
    return new Set(state.pushedShas);
  }
  return undefined;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

/** A real workspace runtime; only the agent bridge is substituted. */
function makeRuntime(
  cwd: string,
  overrides: { trusted?: boolean; primary?: boolean } = {},
): WorkspaceRuntime {
  return {
    workspaceId: cwd,
    workspaceCwd: cwd,
    sessionRuntimeBaseDir: runtimeDir,
    trusted: overrides.trusted ?? true,
    primary: overrides.primary ?? false,
    env: {
      mode: 'parent-process',
      overlayKeys: [],
      effectiveEnv: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      },
    },
    generationGuard: createWorkspaceGenerationGuard(),
    bridge: {
      listWorkspaceSessions: (workspaceCwd: string) =>
        [...live.values()].filter((s) => s.workspaceCwd === workspaceCwd),
      sendPrompt: (
        sessionId: string,
        request: { prompt?: Array<{ type: string; text?: string }> },
        _signal: unknown,
        context: { onPromptAdmitted?: () => void },
      ) => {
        const text =
          request.prompt?.find((block) => block.type === 'text')?.text ?? '';
        enqueued.push({ sessionId, text });
        context.onPromptAdmitted?.();
        return Promise.resolve();
      },
      getSessionLastEventId: () => 0,
      getSessionEventEpoch: () => 'scenario-epoch',
    },
  } as unknown as WorkspaceRuntime;
}

/** A second covered workspace, scanned and drained by the same daemon. */
function addWorkspace(
  overrides: { trusted?: boolean; primary?: boolean } = {},
): string {
  const cwd = mkdtempSync(path.join(root, 'work-'));
  extraRuntimes.push(makeRuntime(cwd, overrides));
  return cwd;
}

beforeEach(() => {
  // Canonicalise at the source: the gh child reports its physical cwd, and on
  // macOS os.tmpdir() (/var/folders/…) is a symlink to /private/var/folders/…
  root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'pr-watch-scenario-')),
  );
  runtimeDir = path.join(root, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
  ws = mkdtempSync(path.join(root, 'work-'));
  watchDir = path.join(root, 'watch');
  viewsDir = path.join(root, 'views');
  mkdirSync(viewsDir, { recursive: true });
  ghLog = path.join(root, 'gh-calls.log');
  // A real executable on the child's PATH: `gh pr view <url> --json …`
  // answered from the scenario's view file, every invocation logged.
  binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, 'gh'),
    [
      '#!/bin/sh',
      `printf '%s|%s\\n' "$*" "$(pwd)" >> '${ghLog}'`,
      'url="$3"',
      'n="${url##*/}"',
      `cat '${viewsDir}/'"$n"'.json'`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  locks = new PathMutexRegistry();
  drainState = createPrWatchDrainState();
  sweepOffsets = new Map();
  live = new Map();
  admissions = [];
  enqueued = [];
  logs = [];
  beforeAdmit = undefined;
  admitImpl = admitSessionPrompt;
  extraRuntimes = [];
  runtime = makeRuntime(ws);
  drainDeps = {
    watchDir,
    locks,
    scanBindings: async (scanned) => {
      const bindings: SessionPrBindingSummary[] = [];
      const partial = await scanWorkspaceBindings(scanned, bindings);
      return { bindings, partial };
    },
    resolveRuntime: (cwd) =>
      allRuntimes().find((candidate) => candidate.workspaceCwd === cwd),
    isSessionLive: (_runtime, sessionId) => live.has(sessionId),
    wakeSession: async () => ({ kind: 'unavailable' }),
    admitPrompt: async (target, sessionId, promptText, idempotencyKey) => {
      beforeAdmit?.();
      const admission = admitImpl(
        { archiveCoordinator: {} as SessionArchiveCoordinator },
        {
          runtime: target,
          sessionId,
          prompt: [{ type: 'text', text: promptText }],
          request: {},
          classification: {
            channelPrompt: false,
            requestedChannelPrompt: false,
          },
          idempotencyKey,
        },
      );
      admissions.push({
        sessionId,
        key: idempotencyKey,
        text: promptText,
        deduplicated: admission.deduplicated,
      });
      return { deduplicated: admission.deduplicated };
    },
    readPushedHeads: async () => undefined,
    log: (message) => logs.push(message),
  };
});

afterEach(() => {
  // A fault-injection scenario leaves the directory read-only; restore it so
  // the recursive cleanup can unlink its entries.
  if (existsSync(watchDir)) chmodSync(watchDir, 0o700);
  delete process.env['QWEN_RUNTIME_DIR'];
  rmSync(root, { recursive: true, force: true });
});

// The gh PATH stub is a /bin/sh script and the crash-window fault injection
// relies on POSIX permission bits, so the scenarios run on POSIX only.
describe.skipIf(process.platform === 'win32')(
  'PR watch drain real scenarios',
  () => {
    it('delivers detected transitions through the real admission path exactly once', async () => {
      const sessionId = await seedSession();
      writeView(HEAD_A, { checks: 'passing' });
      expect((await observe()).observed).toBe(1);
      expect((await drain()).delivered).toBe(0);
      expect(stored()?.pending).toBeUndefined();

      writeView(HEAD_B, { checks: 'failing' });
      expect((await observe()).observed).toBe(1);
      const result = await drain();
      expect(result.delivered).toBe(2);
      expect(admissions).toHaveLength(2);
      expect(enqueued).toHaveLength(2);
      expect(admissions.every((a) => a.sessionId === sessionId)).toBe(true);
      expect(admissions.every((a) => !a.deduplicated)).toBe(true);
      // The real admission enforces the 200-character idempotency cap.
      expect(admissions.every((a) => a.key.length <= 200)).toBe(true);
      const headChange = admissions.find((a) =>
        a.text.includes('head changed'),
      );
      const ciFailure = admissions.find((a) => a.text.includes('CI failing'));
      expect(headChange?.text).toContain(`${HEAD_A} → ${HEAD_B}`);
      expect(ciFailure?.text).toContain('CI failing: CI / unit');
      expect(ciFailure?.text).toContain(REPO);
      expect(ciFailure?.text).toContain(`#${PR}`);
      expect(stored()?.pending).toBeUndefined();
      expect(stored()?.delivered).toHaveLength(2);
      // A real gh child ran, in the private watch directory, by URL.
      expect(ghCalls().length).toBeGreaterThanOrEqual(2);
      expect(ghCalls()[0]).toContain(`pr view ${PR_URL} --json`);
      expect(ghCalls()[0]?.endsWith(`|${watchDir}`)).toBe(true);

      // Neither a re-drain nor a fresh observation of the same head re-delivers.
      expect((await drain()).delivered).toBe(0);
      expect((await observe()).observed).toBe(1);
      expect((await drain()).delivered).toBe(0);
      expect(enqueued).toHaveLength(2);
    });

    it('fans out to real role bindings under group-suffixed keys', async () => {
      const reviewer = await seedSession({ role: 'review' });
      const fixer = await seedSession({ role: 'fix' });
      drainDeps.actionsForEvent = () =>
        new Map([
          ['review:ci_failure', 'Review %repo% #%pr%'],
          ['fix:ci_failure', 'Fix %repo% #%pr%'],
        ]);
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_A, { checks: 'failing' });
      await observe();
      expect((await drain()).delivered).toBe(2);
      expect(admissions).toHaveLength(2);
      const bySession = new Map(admissions.map((a) => [a.sessionId, a]));
      expect(bySession.get(reviewer)?.text).toContain(`Review ${REPO} #${PR}`);
      expect(bySession.get(fixer)?.text).toContain(`Fix ${REPO} #${PR}`);
      expect(bySession.get(reviewer)?.key.endsWith(':review')).toBe(true);
      expect(bySession.get(fixer)?.key.endsWith(':fix')).toBe(true);
      expect(stored()?.pending).toBeUndefined();
      expect(stored()?.delivered).toHaveLength(2);
    });

    it('follows the real transcript recency when the winning binder changes', async () => {
      const older = await seedSession({
        mtime: new Date('2026-11-08T00:00:00.000Z'),
      });
      const newer = await seedSession({
        mtime: new Date('2026-11-08T01:00:00.000Z'),
      });
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'passing' });
      await observe();
      await drain();
      expect(admissions).toHaveLength(1);
      expect(admissions[0]?.sessionId).toBe(newer);

      // The idle follower becomes the most recently active session (a fixed
      // timestamp after the leader's, so the order never depends on the clock).
      const now = new Date('2026-11-08T03:00:00.000Z');
      utimesSync(path.join(chatsDir(), `${older}.jsonl`), now, now);
      writeView(HEAD_C, { checks: 'passing' });
      await observe();
      await drain();
      expect(admissions).toHaveLength(2);
      expect(admissions[1]?.sessionId).toBe(older);
    });

    it('keeps the watch file while a real corrupt sidecar makes the scan partial', async () => {
      const bound = await seedSession();
      const corrupt = await seedSession();
      writeFileSync(
        path.join(chatsDir(), `${corrupt}.pr.json`),
        '{not json',
        'utf8',
      );
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      expect(stored()?.lastBoundAt).toBeDefined();

      // The only binder unbinds, but the corrupt sidecar keeps the scan partial:
      // absence is unknown, so the file must survive.
      unbind(bound);
      const partial = await drain();
      expect(partial.deleted).toBe(0);
      expect(storedRead().kind).toBe('state');
      expect(admissions).toHaveLength(0);

      // Once the corrupt sidecar is a readable tombstone the scan is complete
      // and the unbound file is deleted.
      unbind(corrupt);
      const complete = await drain();
      expect(complete.deleted).toBe(1);
      expect(storedRead().kind).toBe('absent');
    });

    it('retries only the recording write after a real EACCES at the crash window', async () => {
      await seedSession();
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'failing' });
      await observe();
      expect(stored()?.pending).toHaveLength(2);

      // The disk becomes unwritable between the admission and the recording
      // write: a real EACCES, not a mocked store.
      beforeAdmit = () => chmodSync(watchDir, 0o500);
      const failed = await drain();
      beforeAdmit = undefined;
      expect(failed.delivered).toBe(2);
      expect(enqueued).toHaveLength(2);
      expect(logs.some((line) => line.includes('recording write failed'))).toBe(
        true,
      );
      expect(stored()?.pending).toHaveLength(2);
      expect(stored()?.delivered ?? []).toHaveLength(0);
      expect([...drainState.inFlight.values()].every((m) => m.admitted)).toBe(
        true,
      );

      chmodSync(watchDir, 0o700);
      const retried = await drain();
      expect(retried.delivered).toBe(0);
      expect(enqueued).toHaveLength(2);
      expect(admissions).toHaveLength(2);
      expect(drainState.inFlight.size).toBe(0);
      expect(stored()?.pending).toBeUndefined();
      expect(stored()?.delivered).toHaveLength(2);
    });

    it('suppresses a self-pushed head against a real autofix-pr ledger', async () => {
      git(ws, 'init', '--quiet');
      git(ws, 'config', 'user.email', 'scenario@example.com');
      git(ws, 'config', 'user.name', 'Scenario');
      writeFileSync(path.join(ws, 'README.md'), 'scenario\n', 'utf8');
      git(ws, 'add', 'README.md');
      git(ws, 'commit', '--quiet', '-m', 'seed');
      const worktree = path.join(root, 'watch-worktree');
      git(
        ws,
        'worktree',
        'add',
        '--quiet',
        '-b',
        `qwen-autofix/pr-${PR}`,
        worktree,
      );

      const pusher = await seedSession({
        mtime: new Date('2026-11-08T02:00:00.000Z'),
      });
      const other = await seedSession({
        mtime: new Date('2026-11-08T00:00:00.000Z'),
      });
      const statePath = autofixPrPaths(worktree, PR).statePath;
      mkdirSync(path.dirname(statePath), { recursive: true });
      writeState(statePath, {
        version: 1,
        sessionId: pusher,
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        prNumber: PR,
        remote: 'origin',
        pushTarget: 'origin',
        headRefName: 'feature',
        baseRefName: 'main',
        branch: `qwen-autofix/pr-${PR}`,
        worktreePath: worktree,
        viewer: 'pusher',
        prAuthor: 'author',
        lastKnownHeadSha: HEAD_A,
        pushedShas: [HEAD_B],
        handledCommentIds: [],
        postedCommentIds: [],
      });
      drainDeps.readPushedHeads = ledgerHeads;

      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'failing' });
      await observe();
      expect((await drain()).delivered).toBe(2);
      expect(admissions).toHaveLength(2);
      const headChange = admissions.find((a) =>
        a.text.includes('head changed'),
      );
      const ciFailure = admissions.find((a) => a.text.includes('CI failing'));
      // The pusher's own head change goes to the next binder; the CI failure
      // is never suppressed by authorship.
      expect(headChange?.sessionId).toBe(other);
      expect(ciFailure?.sessionId).toBe(pusher);
      expect(
        logs.some((line) => line.includes('self-pushed head suppressed')),
      ).toBe(true);
    });

    it('stops viewing a merged PR once its state change is delivered', async () => {
      await seedSession();
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_A, { state: 'MERGED' });
      await observe();
      expect((await drain()).delivered).toBe(1);
      expect(admissions[0]?.text).toContain('PR merged');
      const calls = ghCalls().length;
      expect((await observe()).observed).toBe(0);
      expect(ghCalls()).toHaveLength(calls);
      expect((await drain()).delivered).toBe(0);
    });

    it('restores a dormant recipient off-tick and admits through the real path', async () => {
      const sessionId = await seedSession({ live: false });
      let released = 0;
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      drainDeps.wakeSession = () =>
        gate.then(() => ({
          kind: 'restored' as const,
          release: async () => {
            released += 1;
          },
        }));
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'passing' });
      await observe();
      // A restore still in flight never lengthens the tick: it returns with the
      // entry pending and nothing admitted.
      const tick = await drain();
      expect(tick.delivered).toBe(0);
      expect(admissions).toHaveLength(0);
      expect(drainState.restoring.size).toBe(1);
      expect(stored()?.pending).toHaveLength(1);
      openGate();
      await vi.waitFor(() => {
        expect(drainState.restoring.size).toBe(0);
        expect(enqueued).toHaveLength(1);
      });
      expect(released).toBe(1);
      expect(admissions).toHaveLength(1);
      expect(admissions[0]?.sessionId).toBe(sessionId);
      expect(admissions[0]?.text).toContain('head changed');
      expect(stored()?.pending).toBeUndefined();
      expect(stored()?.delivered).toHaveLength(1);
    });

    it('resolves one recipient across two real workspaces, not one per workspace', async () => {
      const second = addWorkspace();
      const older = await seedSession({
        mtime: new Date('2026-11-08T00:00:00.000Z'),
      });
      const newer = await seedSession({
        cwd: second,
        mtime: new Date('2026-11-08T02:00:00.000Z'),
      });
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      // One view per PR per tick even though two workspaces bind it.
      expect(ghCalls()).toHaveLength(1);
      writeView(HEAD_B, { checks: 'failing' });
      await observe();
      expect((await drain()).delivered).toBe(2);
      expect(enqueued).toHaveLength(2);
      // Both transitions go to the single most-recent binder across the daemon.
      expect(admissions.every((a) => a.sessionId === newer)).toBe(true);
      expect(admissions.some((a) => a.sessionId === older)).toBe(false);
      expect(ghCalls()).toHaveLength(2);
    });

    it('deduplicates a re-admission after an in-process drain-state reset', async () => {
      await seedSession();
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'failing' });
      await observe();
      beforeAdmit = () => chmodSync(watchDir, 0o500);
      await drain();
      beforeAdmit = undefined;
      expect(enqueued).toHaveLength(2);
      expect(stored()?.pending).toHaveLength(2);
      chmodSync(watchDir, 0o700);

      // Losing only the drain state (the ring stays warm, as within one
      // process): the still-pending entries are admitted again and the real
      // idempotency ring turns each into a dedupe instead of a second turn.
      drainState = createPrWatchDrainState();
      const retried = await drain();
      expect(retried.delivered).toBe(2);
      expect(enqueued).toHaveLength(2);
      expect(admissions).toHaveLength(4);
      expect(admissions.slice(2).every((a) => a.deduplicated)).toBe(true);
      expect(stored()?.pending).toBeUndefined();
      expect(stored()?.delivered).toHaveLength(2);
    });

    it('re-admits as a fresh turn after a restart clears the admission ring', async () => {
      await seedSession();
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'failing' });
      await observe();
      beforeAdmit = () => chmodSync(watchDir, 0o500);
      await drain();
      beforeAdmit = undefined;
      expect(enqueued).toHaveLength(2);
      expect(stored()?.pending).toHaveLength(2);
      chmodSync(watchDir, 0o700);

      // A real restart loses BOTH the drain state and the process-global
      // idempotency ring (never persisted). Re-importing the admission module
      // gives the empty ring a new process starts with, so the crash window
      // re-admits as a fresh turn — the design's at-least-once guarantee.
      vi.resetModules();
      admitImpl = (await import('../routes/session-prompt-admission.js'))
        .admitSessionPrompt;
      drainState = createPrWatchDrainState();
      const retried = await drain();
      expect(retried.delivered).toBe(2);
      expect(admissions).toHaveLength(4);
      expect(admissions.slice(2).every((a) => !a.deduplicated)).toBe(true);
      expect(enqueued).toHaveLength(4);
      expect(storedRead().kind).toBe('state');
      expect(stored()?.pending).toBeUndefined();
      expect(stored()?.delivered).toHaveLength(2);
    });

    it('skips a non-regular watch entry and still drains the healthy PR', async () => {
      await seedSession();
      // A directory planted under another PR's watch-file name: a real
      // non-regular entry the enumeration must skip without reading it.
      mkdirSync(
        prWatchFilePath(watchDir, {
          host: 'github.com',
          repo: REPO,
          number: PR + 1,
        }),
        { recursive: true },
      );
      writeView(HEAD_A, { checks: 'passing' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'failing' });
      await observe();
      expect((await drain()).delivered).toBe(2);
      expect(enqueued).toHaveLength(2);
      expect(logs.some((line) => line.includes('is not a regular file'))).toBe(
        true,
      );
    });

    it('admits a hashed transition key for a long repository name', async () => {
      // GitHub's longest owner (39) plus a long repository name pushes the raw
      // head-change key past the cap, so the observation hashes it; the real
      // admission must still accept the group-suffixed key.
      const longRepo = `${'a'.repeat(39)}/${'b'.repeat(60)}`;
      const longUrl = `https://github.com/${longRepo}/pull/${PR}`;
      await seedSession({ url: longUrl });
      drainDeps.actionsForEvent = () =>
        new Map([['default', 'Handle %repo% #%pr%']]);
      writeView(HEAD_A, { checks: 'passing', url: longUrl });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'passing', url: longUrl });
      await observe();
      expect((await drain()).delivered).toBe(1);
      expect(admissions).toHaveLength(1);
      expect(admissions[0]?.key.startsWith('pr-state:h:')).toBe(true);
      expect(admissions[0]?.key.length).toBeLessThanOrEqual(200);
      expect(admissions[0]?.text).toContain(longRepo);
      expect(enqueued).toHaveLength(1);
    });

    it('never suppresses a merge conflict by authorship', async () => {
      await seedSession();
      // The ledger names the new head: only head_change may be suppressed.
      drainDeps.readPushedHeads = async () => new Set([HEAD_B]);
      writeView(HEAD_A, { checks: 'passing', mergeable: 'MERGEABLE' });
      await observe();
      await drain();
      writeView(HEAD_B, { checks: 'passing', mergeable: 'CONFLICTING' });
      await observe();
      expect(stored()?.pending).toHaveLength(2);
      await drain();
      // The conflict reaches the binder. The self-pushed head change has no
      // eligible candidate left, so a complete scan drops it with a log line
      // instead of rewriting it every tick for the whole age horizon.
      expect(admissions).toHaveLength(1);
      expect(admissions[0]?.text).toContain('merge conflict detected');
      expect(enqueued).toHaveLength(1);
      expect(storedRead().kind).toBe('state');
      expect(stored()?.pending).toBeUndefined();
      expect(
        logs.some((line) => line.includes('dropping on complete scan')),
      ).toBe(true);
    });

    it('delivers to a recipient in an untrusted primary workspace', async () => {
      const primaryWs = addWorkspace({ trusted: false, primary: true });
      const sessionId = await seedSession({ cwd: primaryWs });
      // Seed through the real store: the drain itself runs no gh, so the
      // untrusted primary's credential-free view path is not exercised here.
      writePrWatchStateSync(
        watchDir,
        { host: 'github.com', repo: REPO, number: PR },
        {
          pr: { host: 'github.com', repo: REPO, number: PR },
          observedAt: new Date().toISOString(),
          state: 'open',
          headSha: HEAD_A,
          checks: 'passing',
          pending: [
            {
              type: 'ci_failure',
              key: 'pr-state:untrusted-primary:ci_failure',
              summary: 'CI failing',
              detectedAt: new Date().toISOString(),
            },
          ],
        },
      );
      expect((await drain()).delivered).toBe(1);
      expect(admissions).toHaveLength(1);
      expect(admissions[0]?.sessionId).toBe(sessionId);
      expect(enqueued).toHaveLength(1);
      expect(stored()?.pending).toBeUndefined();
    });
  },
);
