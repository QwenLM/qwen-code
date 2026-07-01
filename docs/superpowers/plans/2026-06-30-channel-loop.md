# Channel Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add channel `/loop` support for recurring chat-bound agent work, replacing the closed `/schedule` PR stack with loop terminology and lifecycle inspection.

**Architecture:** Channel loops are stored by the channel gateway in a JSON file under Qwen home, scanned by a small channel-owned cron scheduler, and executed through `ChannelBase` using the existing `SessionRouter` and per-session queue. This iteration shares core cron parsing but does not reuse core `CronScheduler`; the channel layer needs chat target scoping, proactive-send capability checks, and lifecycle fields.

**Tech Stack:** TypeScript ESM, Vitest, `@qwen-code/qwen-code-core` cron utilities, channel packages, CLI channel start command.

**Issue:** https://github.com/QwenLM/qwen-code/issues/6068

---

## File Structure

- Create `packages/channels/base/src/ChannelLoopStore.ts`: JSON persistence for loop definitions and lifecycle fields.
- Create `packages/channels/base/src/ChannelLoopScheduler.ts`: tick loop that finds due channel loops, runs them once, and records lifecycle results.
- Modify `packages/channels/base/src/ChannelBase.ts`: add `/loop add/list/inspect/cancel`, proactive loop execution, adapter capability hooks, and target authorization checks.
- Modify `packages/channels/base/src/index.ts`: export channel loop store/scheduler/types.
- Modify `packages/channels/base/src/paths.ts`: add `channelLoopPath()`.
- Modify `packages/channels/base/src/types.ts`: ensure `SessionTarget` carries channel/chat/thread/group target fields used by persisted loops.
- Modify `packages/channels/feishu/src/FeishuAdapter.ts`: opt in to proactive loop messages where direct chat send is supported.
- Modify `packages/channels/telegram/src/TelegramAdapter.ts`: opt in to proactive loop messages.
- Modify `packages/cli/src/commands/channel/start.ts`: create loop store/scheduler and tie lifecycle to channel startup, crash recovery, and shutdown.
- Modify `packages/core/src/index.ts`: export `parseCron` and `nextFireTime`.
- Add tests next to touched source files.

## Task 1: Core Exports And Store

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/channels/base/src/paths.ts`
- Create: `packages/channels/base/src/ChannelLoopStore.ts`
- Create: `packages/channels/base/src/ChannelLoopStore.test.ts`
- Modify: `packages/channels/base/src/index.ts`

- [ ] **Step 1: Write failing store tests**

Add `packages/channels/base/src/ChannelLoopStore.test.ts` with tests for:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ChannelLoopStore } from './ChannelLoopStore.js';

const target = {
  channelName: 'telegram-main',
  senderId: 'user-1',
  chatId: 'chat-1',
  isGroup: false,
};

describe('ChannelLoopStore', () => {
  it('creates enabled channel loops with lifecycle defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-loop-store-'));
    const store = new ChannelLoopStore({
      filePath: join(dir, 'loops.json'),
      now: () => new Date('2026-06-30T09:00:00.000Z'),
      idFactory: () => 'loop-1',
    });

    const loop = await store.create({
      channelName: 'telegram-main',
      target,
      cwd: '/repo',
      cron: '0 9 * * *',
      prompt: 'post summary',
      label: 'post summary',
      recurring: true,
      createdBy: 'Alice',
    });

    expect(loop).toMatchObject({
      id: 'loop-1',
      enabled: true,
      consecutiveFailures: 0,
      runCount: 0,
      createdAt: '2026-06-30T09:00:00.000Z',
    });
    await expect(store.listForTarget('telegram-main', target)).resolves.toHaveLength(1);
  });

  it('enforces target quotas atomically through createForTarget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-loop-quota-'));
    let next = 0;
    const store = new ChannelLoopStore({
      filePath: join(dir, 'loops.json'),
      idFactory: () => `loop-${++next}`,
    });
    const input = {
      channelName: 'telegram-main',
      target,
      cwd: '/repo',
      cron: '0 9 * * *',
      prompt: 'post summary',
      recurring: true,
      createdBy: 'Alice',
    };

    await expect(store.createForTarget(input, 1)).resolves.toMatchObject({ id: 'loop-1' });
    await expect(store.createForTarget(input, 1)).resolves.toBeUndefined();
  });

  it('loads pre-lifecycle loop JSON with runCount defaulted to 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-loop-legacy-'));
    const filePath = join(dir, 'loops.json');
    await writeFile(filePath, JSON.stringify([
      {
        id: 'loop-legacy',
        channelName: 'telegram-main',
        target,
        cwd: '/repo',
        cron: '0 9 * * *',
        prompt: 'post summary',
        recurring: true,
        enabled: true,
        createdBy: 'Alice',
        createdAt: '2026-06-30T09:00:00.000Z',
        consecutiveFailures: 0,
      },
    ]));

    await expect(new ChannelLoopStore({ filePath }).list()).resolves.toMatchObject([
      { id: 'loop-legacy', runCount: 0 },
    ]);
  });

  it('refuses corrupt JSON instead of treating it as empty state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-loop-corrupt-'));
    const filePath = join(dir, 'loops.json');
    await writeFile(filePath, '{nope');

    await expect(new ChannelLoopStore({ filePath }).list()).rejects.toThrow(
      'Malformed JSON',
    );
  });
});
```

- [ ] **Step 2: Run store tests and verify RED**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelLoopStore.test.ts
```

Expected: fails because `ChannelLoopStore` does not exist.

- [ ] **Step 3: Implement store and path**

Create `ChannelLoopStore.ts` with:

```ts
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionTarget } from './types.js';

export type ChannelLoopStatus = 'ok' | 'error';

export interface ChannelLoop {
  id: string;
  channelName: string;
  target: SessionTarget;
  cwd: string;
  cron: string;
  prompt: string;
  label?: string;
  recurring: boolean;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastFiredAt?: string;
  lastFinishedAt?: string;
  lastResultPreview?: string;
  lastStatus?: ChannelLoopStatus;
  lastError?: string;
  consecutiveFailures: number;
  runningSince?: string;
  runCount: number;
}

export type ChannelLoopInput = Omit<
  ChannelLoop,
  | 'id'
  | 'enabled'
  | 'createdAt'
  | 'lastFiredAt'
  | 'lastFinishedAt'
  | 'lastResultPreview'
  | 'lastStatus'
  | 'lastError'
  | 'consecutiveFailures'
  | 'runningSince'
  | 'runCount'
>;

export type ChannelLoopPatch = Partial<
  Pick<
    ChannelLoop,
    | 'enabled'
    | 'lastFiredAt'
    | 'lastFinishedAt'
    | 'lastResultPreview'
    | 'lastStatus'
    | 'lastError'
    | 'consecutiveFailures'
    | 'runningSince'
    | 'runCount'
  >
>;

export interface ChannelLoopStoreOptions {
  filePath: string;
  now?: () => Date;
  idFactory?: () => string;
}

export class ChannelLoopStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(options: ChannelLoopStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async list(): Promise<ChannelLoop[]> {
    return this.readLoops();
  }

  async listForTarget(
    channelName: string,
    target: SessionTarget,
  ): Promise<ChannelLoop[]> {
    const loops = await this.readLoops();
    return loops.filter(
      (loop) =>
        loop.channelName === channelName && sameTarget(loop.target, target),
    );
  }

  async create(input: ChannelLoopInput): Promise<ChannelLoop> {
    const loop = this.buildLoop(input);
    await this.updateLoops((loops) => [...loops, loop]);
    return loop;
  }

  async createForTarget(
    input: ChannelLoopInput,
    maxEnabledLoops: number,
  ): Promise<ChannelLoop | undefined> {
    let created: ChannelLoop | undefined;
    await this.updateLoops((loops) => {
      const enabledForTarget = loops.filter(
        (loop) =>
          loop.enabled &&
          loop.channelName === input.channelName &&
          sameTarget(loop.target, input.target),
      ).length;
      if (enabledForTarget >= maxEnabledLoops) return loops;
      created = this.buildLoop(input);
      return [...loops, created];
    });
    return created;
  }

  async update(id: string, patch: ChannelLoopPatch): Promise<boolean> {
    let found = false;
    await this.updateLoops((loops) =>
      loops.map((loop) => {
        if (loop.id !== id) return loop;
        found = true;
        return { ...loop, ...patch };
      }),
    );
    return found;
  }

  async disable(id: string): Promise<boolean> {
    return this.update(id, { enabled: false });
  }

  private buildLoop(input: ChannelLoopInput): ChannelLoop {
    return {
      ...input,
      id: this.idFactory(),
      enabled: true,
      createdAt: this.now().toISOString(),
      consecutiveFailures: 0,
      runCount: 0,
    };
  }

  private async updateLoops(
    mutate: (loops: ChannelLoop[]) => ChannelLoop[],
  ): Promise<void> {
    const nextUpdate = this.pendingUpdate.then(async () => {
      const loops = await this.readLoops();
      await this.writeLoops(mutate(loops));
    });
    this.pendingUpdate = nextUpdate.catch(() => {});
    await nextUpdate;
  }

  private async readLoops(): Promise<ChannelLoop[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Malformed JSON in ${this.filePath}; fix or delete the file.`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Expected a JSON array in ${this.filePath}; fix or delete the file.`,
      );
    }
    for (const [index, value] of parsed.entries()) {
      if (!isChannelLoop(value)) {
        throw new Error(`Invalid channel loop at index ${index} in ${this.filePath}.`);
      }
    }
    return parsed.map(normalizeLoop);
  }

  private async writeLoops(loops: ChannelLoop[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(loops, null, 2), 'utf8');
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }
}

function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
  const sameGroupChat = a.isGroup === true && b.isGroup === true;
  return (
    a.channelName === b.channelName &&
    (sameGroupChat || a.senderId === b.senderId) &&
    a.chatId === b.chatId &&
    a.threadId === b.threadId &&
    a.isGroup === b.isGroup
  );
}

function isSessionTarget(value: unknown): value is SessionTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target['channelName'] === 'string' &&
    typeof target['senderId'] === 'string' &&
    typeof target['chatId'] === 'string' &&
    (target['threadId'] === undefined ||
      typeof target['threadId'] === 'string') &&
    (target['isGroup'] === undefined || typeof target['isGroup'] === 'boolean')
  );
}

function isChannelLoop(value: unknown): value is ChannelLoop {
  if (typeof value !== 'object' || value === null) return false;
  const loop = value as Record<string, unknown>;
  return (
    typeof loop['id'] === 'string' &&
    typeof loop['channelName'] === 'string' &&
    isSessionTarget(loop['target']) &&
    typeof loop['cwd'] === 'string' &&
    typeof loop['cron'] === 'string' &&
    typeof loop['prompt'] === 'string' &&
    (loop['label'] === undefined || typeof loop['label'] === 'string') &&
    typeof loop['recurring'] === 'boolean' &&
    typeof loop['enabled'] === 'boolean' &&
    typeof loop['createdBy'] === 'string' &&
    typeof loop['createdAt'] === 'string' &&
    (loop['lastFiredAt'] === undefined ||
      typeof loop['lastFiredAt'] === 'string') &&
    (loop['lastFinishedAt'] === undefined ||
      typeof loop['lastFinishedAt'] === 'string') &&
    (loop['lastResultPreview'] === undefined ||
      typeof loop['lastResultPreview'] === 'string') &&
    (loop['lastStatus'] === undefined ||
      loop['lastStatus'] === 'ok' ||
      loop['lastStatus'] === 'error') &&
    (loop['lastError'] === undefined || typeof loop['lastError'] === 'string') &&
    typeof loop['consecutiveFailures'] === 'number' &&
    (loop['runningSince'] === undefined ||
      typeof loop['runningSince'] === 'string') &&
    (loop['runCount'] === undefined || typeof loop['runCount'] === 'number')
  );
}

function normalizeLoop(loop: ChannelLoop): ChannelLoop {
  return { ...loop, runCount: loop.runCount ?? 0 };
}
```

Add to `paths.ts`:

```ts
export function channelLoopPath(): string {
  return path.join(getGlobalQwenDir(), 'channels', 'cron.json');
}
```

The persisted filename stays `cron.json` for compatibility with the closed PR
stack's local data, even though the user-facing command and code API use loop
terminology.

Export from `index.ts` and export cron helpers from `packages/core/src/index.ts`:

```ts
export { ChannelLoopStore } from './ChannelLoopStore.js';
export type { ChannelLoop, ChannelLoopInput, ChannelLoopPatch } from './ChannelLoopStore.js';
export { channelLoopPath } from './paths.js';
export { nextFireTime, parseCron } from './utils/cronParser.js';
```

- [ ] **Step 4: Run store tests and verify GREEN**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelLoopStore.test.ts
```

Expected: all tests pass.

## Task 2: Channel Loop Scheduler

**Files:**
- Create: `packages/channels/base/src/ChannelLoopScheduler.ts`
- Create: `packages/channels/base/src/ChannelLoopScheduler.test.ts`
- Modify: `packages/channels/base/src/index.ts`

- [ ] **Step 1: Write failing scheduler tests**

Add tests proving due loops fire once, lifecycle state records success/failure, `stop()` clears in-flight state, and invalid cron does not fire.

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelLoopScheduler.test.ts
```

Expected: fails because scheduler does not exist.

- [ ] **Step 2: Implement scheduler**

Create a scheduler with this public shape:

```ts
export interface ChannelLoopRunner {
  runLoopPrompt(
    loop: ChannelLoop,
    options?: { timeoutMs?: number },
  ): Promise<string | undefined>;
}

export interface ChannelLoopSchedulerOptions {
  store: Pick<ChannelLoopStore, 'list' | 'update' | 'disable'>;
  channels: ReadonlyMap<string, ChannelLoopRunner>;
  nextFireTime: (cron: string, after: Date) => Date;
  now?: () => Date;
  maxConsecutiveFailures?: number;
  intervalMs?: number;
  loopTimeoutMs?: number;
}
```

Core behavior:

- `start()` schedules ticks and unrefs the timer.
- `stop()` clears timer, `runningTick`, and `inFlightLoops`.
- `tick()` avoids overlapping ticks.
- `runTick()` loads enabled due loops for connected channels.
- `fire()` records `runningSince`, calls `channel.runLoopPrompt`, records success/failure lifecycle, disables one-shot loops, and disables recurring loops after `maxConsecutiveFailures`.
- Store result preview capped to 500 chars and error capped to 1000 chars.

- [ ] **Step 3: Run scheduler tests and verify GREEN**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelLoopScheduler.test.ts
```

Expected: all tests pass.

## Task 3: ChannelBase `/loop` Command Surface

**Files:**
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/ChannelBase.test.ts`

- [ ] **Step 1: Write failing command tests**

Add tests under the existing `slash commands` describe block for:

- `/loop add "0 9 * * *" post summary` creates a loop for the current channel target.
- `/loop list` returns enriched loop lines.
- `/loop inspect <id>` returns lifecycle details and prompt.
- `/loop cancel <id>` only disables loops owned by the current target.
- Missing controller says `Loops are not available.`
- Unsupported proactive adapter rejects `/loop add`.
- Threaded targets reject unless the adapter supports them.
- Quota limit rejects with loop terminology.
- `/schedule ...` is not a local command and falls through as normal text.

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: new `/loop` tests fail.

- [ ] **Step 2: Implement command surface**

Add:

```ts
export interface ChannelLoopController {
  create(input: ChannelLoopInput): Promise<ChannelLoop>;
  createForTarget?(input: ChannelLoopInput, maxEnabledLoops: number): Promise<ChannelLoop | undefined>;
  listForTarget(channelName: string, target: SessionTarget): Promise<ChannelLoop[]>;
  disable(id: string): Promise<boolean>;
  validateCron(cron: string): void;
  nextFireTime?(loop: ChannelLoop): Date;
}

export interface ChannelLoopPromptOptions {
  timeoutMs?: number;
}
```

Add `loopController?: ChannelLoopController` to `ChannelBaseOptions`, register command name `loop`, and implement:

```ts
private async handleLoopCommand(envelope: Envelope, args: string): Promise<boolean>
private async handleLoopAdd(envelope: Envelope, args: string): Promise<boolean>
private async handleLoopList(envelope: Envelope): Promise<boolean>
private async handleLoopInspect(envelope: Envelope, id: string | undefined): Promise<boolean>
private async handleLoopCancel(envelope: Envelope, id: string | undefined): Promise<boolean>
```

Use these user-facing messages:

```text
Loops are not available.
Only authorized members can use loops in this shared session.
Usage: /loop add "<cron>" <prompt> | /loop list | /loop inspect <id> | /loop cancel <id>
This channel does not support proactive loop messages.
This channel does not support proactive loop messages for this chat target.
Loop prompt is too long; keep it under 4000 characters.
Too many loops for this chat. Cancel an existing loop before adding another.
Loop <id>: <cron>
No loops.
No loop <id>.
Cancelled loop <id>.
```

Add:

```ts
supportsProactiveSend(): boolean {
  return false;
}

protected supportsProactiveTarget(target: SessionTarget): boolean {
  return target.threadId === undefined;
}

protected async pushProactive(target: SessionTarget, text: string): Promise<void> {
  if (target.threadId) {
    throw new Error('Channel does not support proactive loop messages for threaded targets.');
  }
  await this.sendMessage(target.chatId, text);
}
```

- [ ] **Step 3: Run ChannelBase command tests**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: all ChannelBase tests pass.

## Task 4: Loop Prompt Execution

**Files:**
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/ChannelBase.test.ts`

- [ ] **Step 1: Write failing execution tests**

Add tests under a `loop prompts` describe block:

- `runLoopPrompt` resolves a target session, prefixes prompt with `[Loop "<label>" created by <createdBy>]`, runs bridge prompt, and pushes proactive response.
- It queues behind an in-flight normal turn and starts timeout only after the queued turn begins.
- It cancels and evicts the bridge session on timeout.
- It disables a loop whose persisted target is no longer authorized.
- It does not push a late response after cancellation.
- It drains collected messages after the loop turn completes.

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: new execution tests fail.

- [ ] **Step 2: Implement `runLoopPrompt`**

Implement:

```ts
async runLoopPrompt(
  loop: ChannelLoop,
  options: ChannelLoopPromptOptions = {},
): Promise<string | undefined>
```

Reuse the existing per-session queue, active prompt state, `onPromptStart`, `onResponseChunk`, `onPromptEnd`, generation guard, and collect-mode buffering behavior used by normal inbound messages. The prompt prefix must use loop terminology:

```text
[Loop "<label>" created by <createdBy>]

<prompt>
```

Timeout errors should use:

```text
loop timed out
```

- [ ] **Step 3: Run ChannelBase execution tests**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: all ChannelBase tests pass.

## Task 5: Adapter Opt-In

**Files:**
- Modify: `packages/channels/telegram/src/TelegramAdapter.ts`
- Modify: `packages/channels/telegram/src/TelegramAdapter.test.ts`
- Modify: `packages/channels/feishu/src/FeishuAdapter.ts`
- Modify: `packages/channels/feishu/src/adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Tests should prove Telegram and Feishu return `true` from `supportsProactiveSend()` and can push proactive loop output to direct chat targets.

Run:

```bash
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
cd packages/channels/feishu && npx vitest run src/adapter.test.ts
```

Expected: new tests fail.

- [ ] **Step 2: Implement adapter opt-in**

In both adapters:

```ts
override supportsProactiveSend(): boolean {
  return true;
}
```

For Feishu threaded targets, override `supportsProactiveTarget`/`pushProactive` only for targets the adapter can address safely. Keep unsupported targets fail-closed.

- [ ] **Step 3: Run adapter tests**

Run:

```bash
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
cd packages/channels/feishu && npx vitest run src/adapter.test.ts
```

Expected: all adapter tests pass.

## Task 6: CLI Startup Wiring

**Files:**
- Modify: `packages/cli/src/commands/channel/start.ts`
- Modify: `packages/cli/src/commands/channel/start.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Update the mocked `@qwen-code/channel-base` module to include `ChannelLoopStore` and `ChannelLoopScheduler`, then assert:

- `startSingle` creates one store and scheduler.
- `createChannel` receives `{ loopController }`.
- Scheduler starts after bridge/channel setup.
- Scheduler stops on shutdown and bridge crash recovery.
- Scheduler restarts after bridge recovery.
- `startAll` wires the same controller/scheduler across all channels.

Run:

```bash
cd packages/cli && npx vitest run src/commands/channel/start.test.ts
```

Expected: new tests fail.

- [ ] **Step 2: Implement CLI wiring**

Import:

```ts
import {
  AcpBridge,
  channelLoopPath,
  ChannelLoopScheduler,
  ChannelLoopStore,
  SessionRouter,
} from '@qwen-code/channel-base';
import { nextFireTime, parseCron } from '@qwen-code/qwen-code-core';
```

Create a controller:

```ts
function createLoopController(loopStore: ChannelLoopStore) {
  return {
    create: (input) => loopStore.create(input),
    createForTarget: (input, maxEnabledLoops) =>
      loopStore.createForTarget(input, maxEnabledLoops),
    listForTarget: (channelName, target) =>
      loopStore.listForTarget(channelName, target),
    disable: (id) => loopStore.disable(id),
    validateCron: (cron) => {
      parseCron(cron);
    },
    nextFireTime: (loop) =>
      nextFireTime(loop.cron, new Date(loop.lastFiredAt ?? loop.createdAt)),
  };
}
```

Pass `{ router, proxy, loopController }` to channels. Start `ChannelLoopScheduler` after channels are connected. Stop it before replacing bridge on crash recovery and during shutdown.

- [ ] **Step 3: Run CLI tests**

Run:

```bash
cd packages/cli && npx vitest run src/commands/channel/start.test.ts
```

Expected: all CLI start tests pass.

## Task 7: Verification And PR

**Files:**
- Modify: `.qwen/pr-drafts/channel-loop.md`

- [ ] **Step 1: Run focused verification**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelLoopStore.test.ts src/ChannelLoopScheduler.test.ts src/ChannelBase.test.ts src/SessionRouter.test.ts
cd packages/cli && npx vitest run src/commands/channel/start.test.ts
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
cd packages/channels/feishu && npx vitest run src/adapter.test.ts
npm run build
npm run typecheck
git diff --check
```

Expected: all tests pass, build/typecheck pass, diff check clean.

- [ ] **Step 2: Dispatch 8 review agents**

Dispatch eight independent review agents against the final diff:

1. Command semantics reviewer: verify no `/schedule` user-facing surface remains.
2. Scheduler correctness reviewer: due calculation, in-flight dedupe, timeout, lifecycle updates.
3. Store correctness reviewer: persistence validation, target scoping, quota atomicity.
4. Channel concurrency reviewer: session queue, `/clear`, cancellation, collect-mode buffering.
5. Adapter capability reviewer: Feishu/Telegram proactive send, unsupported target failure.
6. CLI lifecycle reviewer: start, shutdown, crash recovery, shared bridge.
7. Security/privacy reviewer: prompt/result sanitization, stored previews, authorization.
8. Test quality reviewer: tests fail for real behavior and avoid mock-only assertions where possible.

Each reviewer returns Critical/Important/Minor findings. Fix Critical and Important findings before opening the PR.

- [ ] **Step 3: Create PR draft**

Create `.qwen/pr-drafts/channel-loop.md` using the repository PR template. Include:

- Motivation: channel recurring work should be `/loop`, not `/schedule`.
- Changes: channel loop store, scheduler, command surface, lifecycle inspectability, Feishu/Telegram opt-in.
- How to verify: behaviors, not only commands.
- Link: `Fixes #6068`.

- [ ] **Step 4: Commit, push, and open PR**

Run:

```bash
git add packages/channels/base packages/channels/telegram packages/channels/feishu packages/cli packages/core .qwen/pr-drafts docs/superpowers/plans/2026-06-30-channel-loop.md
git commit -m "feat(channel): add channel loop support"
git push -u origin feat/channel-loop
gh pr create --repo QwenLM/qwen-code --draft --title "feat(channel): add channel loop support" --body-file .qwen/pr-drafts/channel-loop.md
```

Expected: draft PR opened against `QwenLM/qwen-code:main`.

## Self-Review

- Spec coverage: The plan covers issue #6068: `/loop` commands, persistence, scheduler execution, proactive send gating, lifecycle inspectability, tests, and replacement PR flow.
- Placeholder scan: No `TBD`, `TODO`, or vague implementation placeholders remain.
- Type consistency: The public names are `ChannelLoop`, `ChannelLoopStore`, `ChannelLoopScheduler`, `ChannelLoopController`, and `runLoopPrompt`; no `/schedule` names are part of the new API.
