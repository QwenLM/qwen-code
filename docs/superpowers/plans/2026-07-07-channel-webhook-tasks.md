# Channel Webhook Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated webhook-triggered channel tasks where Qwen processes an external event and proactively posts its final response to an authorized chat target.

**Architecture:** Add the unattended task primitive in `@qwen-code/channel-base`, reusing `SessionRouter`, per-session queueing, lifecycle events, and `pushProactive()`. Because daemon-managed channels run in a separate worker process, the `qwen serve` HTTP route validates requests and forwards accepted tasks to the channel worker over IPC; the worker owns the `ChannelBase` instances and executes the task.

**Tech Stack:** TypeScript, ESM, Express, Node child-process IPC, Vitest, existing `@qwen-code/channel-base` channel abstractions.

---

## File Structure

- Create `packages/channels/base/src/ChannelWebhookTask.ts`: webhook task types, task validation helpers, target resolution, prompt construction, payload truncation.
- Modify `packages/channels/base/src/index.ts`: export webhook task types and helpers.
- Modify `packages/channels/base/src/ChannelBase.ts`: add `runWebhookTask(task, options)` and small private helpers shared with loop prompt code where needed.
- Modify `packages/channels/base/src/ChannelBase.test.ts`: add focused tests for webhook task execution, unsupported proactive send, configured target refs, queueing, lifecycle, and truncation.
- Create `packages/cli/src/serve/channel-webhook-ipc.ts`: parent/worker IPC message types, request id generation, response parsing, timeout handling.
- Modify `packages/cli/src/serve/channel-worker-supervisor.ts`: expose `enqueueWebhookTask(task)` on the supervisor and send IPC requests to the child.
- Modify `packages/cli/src/serve/channel-worker-supervisor.test.ts`: cover IPC success, worker error, no running worker, and timeout.
- Modify `packages/cli/src/commands/channel/daemon-worker.ts`: listen for webhook IPC messages after startup and call the selected channel's `runWebhookTask()`.
- Modify `packages/cli/src/commands/channel/daemon-worker.test.ts`: cover worker-side dispatch to a fake channel map and error responses.
- Create `packages/cli/src/serve/routes/channel-webhooks.ts`: Express route for `POST /channels/:channelName/webhooks/:source`, body parsing from `safeBody`, secret validation, task creation, and supervisor delegation.
- Create `packages/cli/src/serve/routes/channel-webhooks.test.ts`: route tests for auth, unknown config, invalid target ref, oversized/malformed bodies, and `202 Accepted`.
- Modify `packages/cli/src/serve/server.ts`: mount channel webhook routes when channel worker supervision is available.
- Modify `packages/cli/src/serve/types.ts`: add the narrow dependency shape needed by the route if the existing `ServeAppDeps` cannot expose it cleanly.
- Modify `packages/cli/src/commands/channel/config-utils.ts`: parse and validate `webhooks` channel config into a typed structure.
- Modify `docs/users/features/channels/overview.md`: document the webhook task feature, config, and curl example.
- Modify `docs/developers/daemon/15-channel-adapters.md`: document how channel adapters inherit webhook task support through proactive send.

## Task 1: Base Webhook Task Helpers

**Files:**
- Create: `packages/channels/base/src/ChannelWebhookTask.ts`
- Modify: `packages/channels/base/src/index.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

- [ ] **Step 1: Add failing helper tests**

Append a new `describe('webhook task helpers', ...)` block near the existing loop prompt tests in `packages/channels/base/src/ChannelBase.test.ts`.

```ts
import {
  buildChannelWebhookPrompt,
  resolveChannelWebhookTarget,
} from './ChannelWebhookTask.js';
import type { ChannelWebhookConfig, ChannelWebhookTask } from './ChannelWebhookTask.js';

describe('webhook task helpers', () => {
  const config: ChannelWebhookConfig = {
    sources: {
      'github-ci': {
        secret: 'secret-value',
        targets: {
          default: {
            chatId: 'chat-1',
            senderId: 'webhook:github-ci',
            isGroup: true,
          },
        },
      },
    },
  };

  it('resolves only configured target refs', () => {
    expect(
      resolveChannelWebhookTarget('dingtalk-main', config, 'github-ci', 'default'),
    ).toEqual({
      channelName: 'dingtalk-main',
      chatId: 'chat-1',
      senderId: 'webhook:github-ci',
      isGroup: true,
    });

    expect(() =>
      resolveChannelWebhookTarget('dingtalk-main', config, 'github-ci', 'random'),
    ).toThrow('Unknown webhook target "random" for source "github-ci".');
  });

  it('builds a bounded unattended prompt', () => {
    const task: ChannelWebhookTask = {
      channelName: 'dingtalk-main',
      source: 'github-ci',
      eventType: 'ci_failed',
      targetRef: 'default',
      title: 'CI failed on main',
      summary: 'Unit tests failed',
      payload: { log: 'x'.repeat(20_000) },
    };

    const prompt = buildChannelWebhookPrompt(task, {
      channelName: 'dingtalk-main',
      chatId: 'chat-1',
      senderId: 'webhook:github-ci',
      isGroup: true,
    });

    expect(prompt).toContain('[External event "ci_failed" from github-ci]');
    expect(prompt).toContain('No human is present.');
    expect(prompt).toContain('CI failed on main');
    expect(prompt.length).toBeLessThanOrEqual(8_500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts --testNamePattern "webhook task helpers"
```

Expected: FAIL because `ChannelWebhookTask.js` does not exist.

- [ ] **Step 3: Create webhook task helper implementation**

Create `packages/channels/base/src/ChannelWebhookTask.ts`.

```ts
import type { SessionTarget } from './types.js';
import { sanitizePromptText, sanitizeQuotedText } from './sanitize.js';

const MAX_WEBHOOK_PROMPT_CHARS = 8_500;
const MAX_WEBHOOK_PAYLOAD_CHARS = 6_000;

export interface ChannelWebhookTargetConfig {
  chatId: string;
  senderId: string;
  threadId?: string;
  isGroup?: boolean;
}

export interface ChannelWebhookSourceConfig {
  secret?: string;
  secretEnv?: string;
  targets: Record<string, ChannelWebhookTargetConfig>;
}

export interface ChannelWebhookConfig {
  sources: Record<string, ChannelWebhookSourceConfig>;
}

export interface ChannelWebhookTask {
  channelName: string;
  source: string;
  eventType: string;
  targetRef: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
}

export interface ChannelWebhookRunOptions {
  timeoutMs?: number;
}

export function resolveChannelWebhookTarget(
  channelName: string,
  config: ChannelWebhookConfig | undefined,
  source: string,
  targetRef: string,
): SessionTarget {
  const sourceConfig = config?.sources[source];
  if (!sourceConfig) {
    throw new Error(`Unknown webhook source "${source}".`);
  }
  const target = sourceConfig.targets[targetRef];
  if (!target) {
    throw new Error(
      `Unknown webhook target "${targetRef}" for source "${source}".`,
    );
  }
  return {
    channelName,
    senderId: target.senderId,
    chatId: target.chatId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
    ...(target.isGroup === undefined ? {} : { isGroup: target.isGroup }),
  };
}

export function buildChannelWebhookPrompt(
  task: ChannelWebhookTask,
  target: SessionTarget,
): string {
  const source = sanitizeQuotedText(task.source, 80);
  const eventType = sanitizeQuotedText(task.eventType, 80);
  const title = sanitizePromptText(task.title).slice(0, 500);
  const summary = task.summary
    ? sanitizePromptText(task.summary).slice(0, 1_000)
    : '';
  const payload = truncateWebhookPayload(task.payload);
  const targetLines = [
    `- channel: ${sanitizeQuotedText(target.channelName, 128)}`,
    `- chatId: ${sanitizeQuotedText(target.chatId, 128)}`,
    `- senderId: ${sanitizeQuotedText(target.senderId, 128)}`,
    ...(target.threadId
      ? [`- threadId: ${sanitizeQuotedText(target.threadId, 128)}`]
      : []),
    `- isGroup: ${target.isGroup === true ? 'true' : 'false'}`,
  ];

  return [
    `[External event "${eventType}" from ${source}]`,
    'You are responding to an external webhook event. No human is present.',
    'Understand the event, decide what matters, and produce the message that should be sent to the chat.',
    'Do not ask follow-up questions. Do not try to send the message yourself; your final response will be delivered automatically.',
    '',
    'Target:',
    ...targetLines,
    '',
    'Title:',
    title,
    ...(summary ? ['', 'Summary:', summary] : []),
    '',
    'Event:',
    payload,
  ]
    .join('\n')
    .slice(0, MAX_WEBHOOK_PROMPT_CHARS);
}

function truncateWebhookPayload(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload, null, 2) ?? '{}';
  return sanitizePromptText(serialized).slice(0, MAX_WEBHOOK_PAYLOAD_CHARS);
}
```

- [ ] **Step 4: Export the new helpers**

Modify `packages/channels/base/src/index.ts`.

```ts
export {
  buildChannelWebhookPrompt,
  resolveChannelWebhookTarget,
} from './ChannelWebhookTask.js';
export type {
  ChannelWebhookConfig,
  ChannelWebhookRunOptions,
  ChannelWebhookSourceConfig,
  ChannelWebhookTargetConfig,
  ChannelWebhookTask,
} from './ChannelWebhookTask.js';
```

- [ ] **Step 5: Run helper tests**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts --testNamePattern "webhook task helpers"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channels/base/src/ChannelWebhookTask.ts packages/channels/base/src/index.ts packages/channels/base/src/ChannelBase.test.ts
git commit -m "feat(channels): add webhook task helpers"
```

## Task 2: ChannelBase `runWebhookTask`

**Files:**
- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/ChannelBase.test.ts`

- [ ] **Step 1: Add failing `runWebhookTask` tests**

Add tests near the existing `runLoopPrompt` tests in `packages/channels/base/src/ChannelBase.test.ts`. Reuse the existing test channel class if it already exposes `sent` messages and `taskEvents`; otherwise add a small test subclass in the test file.

```ts
describe('runWebhookTask', () => {
  it('runs an unattended prompt and proactively sends the final response', async () => {
    const bridge = createBridge();
    bridge.prompt.mockResolvedValue('CI failed because lint broke.');
    const channel = createWebhookCapableChannel(bridge, {
      webhooks: {
        sources: {
          'github-ci': {
            targets: {
              default: {
                chatId: 'group-1',
                senderId: 'webhook:github-ci',
                isGroup: true,
              },
            },
          },
        },
      },
    });

    await channel.runWebhookTask({
      channelName: 'feishu-main',
      source: 'github-ci',
      eventType: 'ci_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: { branch: 'main' },
    });

    expect(bridge.prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('[External event "ci_failed" from github-ci]'),
      expect.any(Object),
    );
    expect(channel.sent).toEqual([
      { chatId: 'group-1', text: 'CI failed because lint broke.' },
    ]);
    expect(channel.taskEvents.map((event) => event.type)).toEqual([
      'started',
      'completed',
    ]);
  });

  it('rejects channels without proactive send support', async () => {
    const channel = createChannelWithoutProactiveSend(createBridge(), {
      webhooks: {
        sources: {
          custom: {
            targets: {
              default: { chatId: 'group-1', senderId: 'webhook:custom' },
            },
          },
        },
      },
    });

    await expect(
      channel.runWebhookTask({
        channelName: 'plain',
        source: 'custom',
        eventType: 'event',
        targetRef: 'default',
        title: 'Event',
        payload: {},
      }),
    ).rejects.toThrow('Channel does not support proactive webhook messages.');
  });

  it('rejects interactive approval mode before prompting', async () => {
    const bridge = createBridge();
    const channel = createWebhookCapableChannel(bridge, {
      approvalMode: 'prompt',
      webhooks: {
        sources: {
          custom: {
            targets: {
              default: { chatId: 'group-1', senderId: 'webhook:custom' },
            },
          },
        },
      },
    });

    await expect(
      channel.runWebhookTask({
        channelName: 'channel',
        source: 'custom',
        eventType: 'event',
        targetRef: 'default',
        title: 'Event',
        payload: {},
      }),
    ).rejects.toThrow('Webhook tasks require unattended approval mode.');
    expect(bridge.prompt).not.toHaveBeenCalled();
  });

  it('serializes webhook tasks for the same target session', async () => {
    const bridge = createBridge();
    const releases: Array<() => void> = [];
    bridge.prompt.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          releases.push(() => resolve(`response-${releases.length}`));
        }),
    );
    const channel = createWebhookCapableChannel(bridge, {
      webhooks: {
        sources: {
          custom: {
            targets: {
              default: { chatId: 'group-1', senderId: 'webhook:custom' },
            },
          },
        },
      },
    });

    const first = channel.runWebhookTask({
      channelName: 'channel',
      source: 'custom',
      eventType: 'one',
      targetRef: 'default',
      title: 'One',
      payload: {},
    });
    const second = channel.runWebhookTask({
      channelName: 'channel',
      source: 'custom',
      eventType: 'two',
      targetRef: 'default',
      title: 'Two',
      payload: {},
    });

    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    releases[0]!();
    await first;
    expect(bridge.prompt).toHaveBeenCalledTimes(2);
    releases[1]!();
    await second;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts --testNamePattern "runWebhookTask"
```

Expected: FAIL because `runWebhookTask` is not implemented.

- [ ] **Step 3: Add webhook config to `ChannelConfig`**

Modify `packages/channels/base/src/types.ts`.

```ts
import type { ChannelWebhookConfig } from './ChannelWebhookTask.js';

export interface ChannelConfig {
  // existing fields remain unchanged
  webhooks?: ChannelWebhookConfig;
}
```

- [ ] **Step 4: Implement `runWebhookTask` minimally**

Modify `packages/channels/base/src/ChannelBase.ts`.

```ts
import {
  buildChannelWebhookPrompt,
  resolveChannelWebhookTarget,
} from './ChannelWebhookTask.js';
import type {
  ChannelWebhookRunOptions,
  ChannelWebhookTask,
} from './ChannelWebhookTask.js';
```

Add the method near `runLoopPrompt()`.

```ts
async runWebhookTask(
  task: ChannelWebhookTask,
  options: ChannelWebhookRunOptions = {},
): Promise<string | undefined> {
  if (!this.supportsProactiveSend()) {
    throw new Error('Channel does not support proactive webhook messages.');
  }
  if (task.channelName !== this.name) {
    throw new Error(
      `Webhook task belongs to ${task.channelName}, not ${this.name}.`,
    );
  }
  if (this.config.approvalMode === 'prompt') {
    throw new Error('Webhook tasks require unattended approval mode.');
  }
  const target = resolveChannelWebhookTarget(
    this.name,
    this.config.webhooks,
    task.source,
    task.targetRef,
  );
  if (!this.supportsProactiveTarget(target)) {
    throw new Error(
      'Channel does not support proactive webhook messages for this chat target.',
    );
  }

  const sessionId = await this.router.resolve(
    this.name,
    target.senderId,
    target.chatId,
    target.threadId,
    this.config.cwd,
    target.isGroup,
  );
  const promptText = buildChannelWebhookPrompt(task, target);
  const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
  const current = prev.then(async (): Promise<string | undefined> => {
    let doneResolve: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });
    const promptState: ActivePrompt = {
      cancelled: false,
      done,
      resolve: doneResolve,
      chatId: target.chatId,
      senderId: target.senderId,
      senderName: task.source,
    };
    this.activePrompts.set(sessionId, promptState);
    this.emitTaskLifecycle({
      ...this.lifecycleBase(target.chatId, sessionId),
      type: 'started',
    });
    try {
      const response = await this.runLoopBridgePrompt(
        this.bridge,
        sessionId,
        promptText,
        promptState,
        `webhook:${task.source}:${task.eventType}`,
        options.timeoutMs,
      );
      if (response) {
        promptState.deliveryStarted = true;
        await this.pushProactive(target, response);
      }
      this.emitTaskLifecycle({
        ...this.lifecycleBase(target.chatId, sessionId),
        type: 'completed',
      });
      return response;
    } catch (err) {
      this.emitTaskLifecycle({
        ...this.lifecycleBase(target.chatId, sessionId),
        type: 'failed',
        phase: 'agent',
        error: this.lifecycleError(err),
      });
      throw err;
    } finally {
      this.activePrompts.delete(sessionId);
      promptState.resolve();
    }
  });
  this.sessionQueues.set(
    sessionId,
    current.catch(() => undefined),
  );
  return await current;
}
```

- [ ] **Step 5: Run focused base tests**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts --testNamePattern "runWebhookTask|webhook task helpers"
```

Expected: PASS.

- [ ] **Step 6: Run full base package tests**

Run:

```bash
cd packages/channels/base && npx vitest run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/channels/base/src/types.ts packages/channels/base/src/ChannelBase.ts packages/channels/base/src/ChannelBase.test.ts
git commit -m "feat(channels): run webhook-triggered tasks"
```

## Task 3: Parse Channel Webhook Config

**Files:**
- Modify: `packages/cli/src/commands/channel/config-utils.ts`
- Modify: `packages/cli/src/commands/channel/config-utils.test.ts`

- [ ] **Step 1: Add failing config parser tests**

Add tests to `packages/cli/src/commands/channel/config-utils.test.ts`.

```ts
it('parses webhook source targets and resolves secret env refs', async () => {
  process.env['QWEN_TEST_WEBHOOK_SECRET'] = 'env-secret';
  const config = await parseChannelConfig('dingtalk-main', {
    type: 'mock',
    token: 'token',
    webhooks: {
      sources: {
        'github-ci': {
          secretEnv: 'QWEN_TEST_WEBHOOK_SECRET',
          targets: {
            default: {
              chatId: 'group-1',
              senderId: 'webhook:github-ci',
              isGroup: true,
            },
          },
        },
      },
    },
  });

  expect(config.webhooks).toEqual({
    sources: {
      'github-ci': {
        secret: 'env-secret',
        targets: {
          default: {
            chatId: 'group-1',
            senderId: 'webhook:github-ci',
            isGroup: true,
          },
        },
      },
    },
  });
});

it('rejects webhook targets without chatId or senderId', async () => {
  await expect(
    parseChannelConfig('dingtalk-main', {
      type: 'mock',
      token: 'token',
      webhooks: {
        sources: {
          custom: {
            targets: {
              default: { chatId: 'group-1' },
            },
          },
        },
      },
    }),
  ).rejects.toThrow(
    'Channel "dingtalk-main" field "webhooks.sources.custom.targets.default.senderId" must be a string.',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd packages/cli && npx vitest run src/commands/channel/config-utils.test.ts --testNamePattern "webhook"
```

Expected: FAIL because `webhooks` is not parsed and validated.

- [ ] **Step 3: Implement parser helpers**

Modify `packages/cli/src/commands/channel/config-utils.ts`.

```ts
import type {
  ChannelConfig,
  ChannelWebhookConfig,
  ChannelWebhookSourceConfig,
  ChannelWebhookTargetConfig,
} from '@qwen-code/channel-base';
```

Add helper functions before `parseChannelConfig()`.

```ts
function requireStringField(
  channelName: string,
  path: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Channel "${channelName}" field "${path}" must be a string.`);
  }
  return value;
}

function optionalBooleanField(
  channelName: string,
  path: string,
  value: unknown,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be a boolean.`,
    );
  }
  return value;
}

function parseWebhookTarget(
  channelName: string,
  path: string,
  raw: unknown,
): ChannelWebhookTargetConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Channel "${channelName}" field "${path}" must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  return {
    chatId: requireStringField(channelName, `${path}.chatId`, record['chatId']),
    senderId: requireStringField(
      channelName,
      `${path}.senderId`,
      record['senderId'],
    ),
    ...(record['threadId'] === undefined
      ? {}
      : {
          threadId: requireStringField(
            channelName,
            `${path}.threadId`,
            record['threadId'],
          ),
        }),
    ...(record['isGroup'] === undefined
      ? {}
      : {
          isGroup: optionalBooleanField(
            channelName,
            `${path}.isGroup`,
            record['isGroup'],
          ),
        }),
  };
}

function parseWebhookSource(
  channelName: string,
  path: string,
  raw: unknown,
): ChannelWebhookSourceConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Channel "${channelName}" field "${path}" must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const targetsRaw = record['targets'];
  if (
    typeof targetsRaw !== 'object' ||
    targetsRaw === null ||
    Array.isArray(targetsRaw)
  ) {
    throw new Error(
      `Channel "${channelName}" field "${path}.targets" must be an object.`,
    );
  }
  const targets: Record<string, ChannelWebhookTargetConfig> = {};
  for (const [targetRef, targetRaw] of Object.entries(
    targetsRaw as Record<string, unknown>,
  )) {
    targets[targetRef] = parseWebhookTarget(
      channelName,
      `${path}.targets.${targetRef}`,
      targetRaw,
    );
  }
  const secret = record['secret'];
  const secretEnv = record['secretEnv'];
  const resolvedSecret =
    typeof secret === 'string' && secret.length > 0
      ? resolveEnvVars(secret)
      : typeof secretEnv === 'string' && secretEnv.length > 0
        ? resolveEnvVars(`$${secretEnv}`)
        : undefined;
  return {
    ...(resolvedSecret ? { secret: resolvedSecret } : {}),
    targets,
  };
}

function parseWebhookConfig(
  channelName: string,
  rawConfig: Record<string, unknown>,
): ChannelWebhookConfig | undefined {
  const raw = rawConfig['webhooks'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Channel "${channelName}" field "webhooks" must be an object.`,
    );
  }
  const sourcesRaw = (raw as Record<string, unknown>)['sources'];
  if (
    typeof sourcesRaw !== 'object' ||
    sourcesRaw === null ||
    Array.isArray(sourcesRaw)
  ) {
    throw new Error(
      `Channel "${channelName}" field "webhooks.sources" must be an object.`,
    );
  }
  const sources: Record<string, ChannelWebhookSourceConfig> = {};
  for (const [source, sourceRaw] of Object.entries(
    sourcesRaw as Record<string, unknown>,
  )) {
    sources[source] = parseWebhookSource(
      channelName,
      `webhooks.sources.${source}`,
      sourceRaw,
    );
  }
  return { sources };
}
```

In the returned config object inside `parseChannelConfig()`, add:

```ts
webhooks: parseWebhookConfig(name, rawConfig),
```

- [ ] **Step 4: Run config parser tests**

Run:

```bash
cd packages/cli && npx vitest run src/commands/channel/config-utils.test.ts --testNamePattern "webhook"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/channel/config-utils.ts packages/cli/src/commands/channel/config-utils.test.ts
git commit -m "feat(channels): parse webhook configuration"
```

## Task 4: Channel Worker IPC

**Files:**
- Create: `packages/cli/src/serve/channel-webhook-ipc.ts`
- Modify: `packages/cli/src/serve/channel-worker-supervisor.ts`
- Modify: `packages/cli/src/serve/channel-worker-supervisor.test.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.test.ts`

- [ ] **Step 1: Add failing supervisor IPC tests**

Add tests to `packages/cli/src/serve/channel-worker-supervisor.test.ts`.

```ts
it('sends webhook task IPC to the running worker and resolves accepted result', async () => {
  const child = createFakeWorker();
  const supervisor = createChannelWorkerSupervisor({
    ...baseOptions(),
    spawnWorker: () => child,
  });
  await supervisor.start();
  child.emitMessage({ type: 'ready', pid: 123, channels: ['dingtalk-main'], requestedChannels: ['dingtalk-main'] });

  const accepted = supervisor.enqueueWebhookTask({
    channelName: 'dingtalk-main',
    source: 'github-ci',
    eventType: 'ci_failed',
    targetRef: 'default',
    title: 'CI failed',
    payload: {},
  });

  const sent = child.sentMessages[0] as { type: string; id: string };
  expect(sent.type).toBe('webhook_task');
  child.emitMessage({ type: 'webhook_task_result', id: sent.id, ok: true });
  await expect(accepted).resolves.toEqual({ accepted: true });
});

it('rejects webhook task when worker is not running', async () => {
  const supervisor = createChannelWorkerSupervisor(baseOptions());
  await expect(
    supervisor.enqueueWebhookTask({
      channelName: 'dingtalk-main',
      source: 'github-ci',
      eventType: 'ci_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: {},
    }),
  ).rejects.toThrow('Channel worker is not running.');
});
```

- [ ] **Step 2: Run supervisor tests to verify failure**

Run:

```bash
cd packages/cli && npx vitest run src/serve/channel-worker-supervisor.test.ts --testNamePattern "webhook task"
```

Expected: FAIL because `enqueueWebhookTask` does not exist.

- [ ] **Step 3: Add IPC types and request tracker**

Create `packages/cli/src/serve/channel-webhook-ipc.ts`.

```ts
import { randomUUID } from 'node:crypto';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';

export interface ChannelWebhookTaskRequestMessage {
  type: 'webhook_task';
  id: string;
  task: ChannelWebhookTask;
}

export interface ChannelWebhookTaskResultMessage {
  type: 'webhook_task_result';
  id: string;
  ok: boolean;
  error?: string;
}

export interface ChannelWebhookAccepted {
  accepted: true;
}

export function createChannelWebhookTaskMessage(
  task: ChannelWebhookTask,
): ChannelWebhookTaskRequestMessage {
  return {
    type: 'webhook_task',
    id: randomUUID(),
    task,
  };
}

export function isChannelWebhookTaskMessage(
  value: unknown,
): value is ChannelWebhookTaskRequestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'webhook_task' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { task?: unknown }).task === 'object' &&
    (value as { task?: unknown }).task !== null
  );
}

export function isChannelWebhookTaskResultMessage(
  value: unknown,
): value is ChannelWebhookTaskResultMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'webhook_task_result' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}
```

- [ ] **Step 4: Extend supervisor interface and implementation**

Modify `packages/cli/src/serve/channel-worker-supervisor.ts`.

```ts
import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import {
  createChannelWebhookTaskMessage,
  isChannelWebhookTaskResultMessage,
  type ChannelWebhookAccepted,
} from './channel-webhook-ipc.js';
```

Extend `ChannelWorkerSupervisor`.

```ts
enqueueWebhookTask(task: ChannelWebhookTask): Promise<ChannelWebhookAccepted>;
```

Inside `createChannelWorkerSupervisor`, add a `pendingWebhookTasks` map keyed by IPC id. In the child `message` listener, route result messages:

```ts
if (isChannelWebhookTaskResultMessage(message)) {
  const pending = pendingWebhookTasks.get(message.id);
  if (pending) {
    pendingWebhookTasks.delete(message.id);
    if (message.ok) {
      pending.resolve({ accepted: true });
    } else {
      pending.reject(new Error(message.error || 'Channel webhook task failed.'));
    }
  }
  return;
}
```

Return this method from the supervisor object:

```ts
enqueueWebhookTask(task: ChannelWebhookTask): Promise<ChannelWebhookAccepted> {
  if (!child || snapshot.state !== 'running') {
    return Promise.reject(new Error('Channel worker is not running.'));
  }
  const message = createChannelWebhookTaskMessage(task);
  return new Promise<ChannelWebhookAccepted>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWebhookTasks.delete(message.id);
      reject(new Error('Channel webhook task IPC timed out.'));
    }, 30_000);
    timer.unref?.();
    pendingWebhookTasks.set(message.id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    child.send?.(message);
  });
}
```

If the existing `ChannelWorkerChild` type does not include `send`, add:

```ts
send?(message: unknown): boolean;
```

- [ ] **Step 5: Add worker-side IPC dispatch**

Modify `packages/cli/src/commands/channel/daemon-worker.ts`.

```ts
import { isChannelWebhookTaskMessage } from '../../serve/channel-webhook-ipc.js';
```

After `runChannelDaemonWorker()` creates and connects channels, include a method on `ChannelDaemonWorkerHandle`:

```ts
runWebhookTask(task: ChannelWebhookTask): Promise<void>;
```

In the returned handle:

```ts
async runWebhookTask(task) {
  const channel = channels.get(task.channelName);
  if (!channel) {
    throw new Error(`Channel "${task.channelName}" is not running.`);
  }
  await channel.runWebhookTask(task);
}
```

After startup in the command handler, add:

```ts
const onMessage = (message: unknown) => {
  if (!isChannelWebhookTaskMessage(message)) return;
  if (!handle.channels.includes(message.task.channelName)) {
    process.send?.({
      type: 'webhook_task_result',
      id: message.id,
      ok: false,
      error: sanitizeLogText(
        `Channel "${message.task.channelName}" is not running.`,
        512,
      ),
    });
    return;
  }
  process.send?.({ type: 'webhook_task_result', id: message.id, ok: true });
  void handle.runWebhookTask(message.task).catch((err: unknown) => {
    writeStderrLine(
      `[Channel] webhook task failed: ${sanitizeLogText(
        err instanceof Error ? err.message : String(err),
        512,
      )}`,
    );
  });
};
process.on('message', onMessage);
```

This sends IPC success after the worker accepts ownership of the task, then runs the agent turn in the worker. Remove this listener during shutdown before `process.exit(exitCode)`.

- [ ] **Step 6: Run IPC tests**

Run:

```bash
cd packages/cli && npx vitest run src/serve/channel-worker-supervisor.test.ts src/commands/channel/daemon-worker.test.ts --testNamePattern "webhook"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/serve/channel-webhook-ipc.ts packages/cli/src/serve/channel-worker-supervisor.ts packages/cli/src/serve/channel-worker-supervisor.test.ts packages/cli/src/commands/channel/daemon-worker.ts packages/cli/src/commands/channel/daemon-worker.test.ts
git commit -m "feat(channels): forward webhook tasks to channel worker"
```

## Task 5: HTTP Webhook Route

**Files:**
- Create: `packages/cli/src/serve/routes/channel-webhooks.ts`
- Create: `packages/cli/src/serve/routes/channel-webhooks.test.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/types.ts`

- [ ] **Step 1: Add failing route tests**

Create `packages/cli/src/serve/routes/channel-webhooks.test.ts`.

```ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerChannelWebhookRoutes } from './channel-webhooks.js';

function appHarness() {
  const app = express();
  app.use(express.json());
  const enqueueWebhookTask = vi.fn(async () => ({ accepted: true as const }));
  registerChannelWebhookRoutes(app, {
    channelsConfig: {
      'dingtalk-main': {
        webhooks: {
          sources: {
            'github-ci': {
              secret: 'secret-value',
              targets: {
                default: {
                  chatId: 'group-1',
                  senderId: 'webhook:github-ci',
                  isGroup: true,
                },
              },
            },
          },
        },
      },
    },
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    enqueueWebhookTask,
  });
  return { app, enqueueWebhookTask };
}

describe('channel webhook routes', () => {
  it('accepts an authenticated webhook task', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: { branch: 'main' },
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(h.enqueueWebhookTask).toHaveBeenCalledWith({
      channelName: 'dingtalk-main',
      source: 'github-ci',
      eventType: 'ci_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: { branch: 'main' },
    });
  });

  it('rejects invalid secrets', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'wrong')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: {},
      });

    expect(res.status).toBe(401);
    expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied unconfigured target refs', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'other',
        title: 'CI failed',
        payload: {},
      });

    expect(res.status).toBe(404);
    expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run:

```bash
cd packages/cli && npx vitest run src/serve/routes/channel-webhooks.test.ts
```

Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Implement route module**

Create `packages/cli/src/serve/routes/channel-webhooks.ts`.

```ts
import type { Application, Request } from 'express';
import type {
  ChannelWebhookConfig,
  ChannelWebhookTask,
} from '@qwen-code/channel-base';
import type { ChannelWebhookAccepted } from '../channel-webhook-ipc.js';

const MAX_FIELD_LENGTH = 500;

export interface ChannelWebhookRouteDeps {
  channelsConfig: Record<string, { webhooks?: ChannelWebhookConfig }>;
  safeBody: (req: Request) => Record<string, unknown>;
  enqueueWebhookTask: (task: ChannelWebhookTask) => Promise<ChannelWebhookAccepted>;
}

export function registerChannelWebhookRoutes(
  app: Application,
  deps: ChannelWebhookRouteDeps,
): void {
  app.post('/channels/:channelName/webhooks/:source', async (req, res) => {
    const channelName = req.params['channelName'];
    const source = req.params['source'];
    if (!channelName || !source) {
      res.status(404).json({ error: 'Channel webhook route not found.' });
      return;
    }
    const channelConfig = deps.channelsConfig[channelName];
    const sourceConfig = channelConfig?.webhooks?.sources[source];
    if (!sourceConfig) {
      res.status(404).json({ error: 'Unknown channel webhook source.' });
      return;
    }
    const expectedSecret = sourceConfig.secret;
    if (!expectedSecret) {
      res.status(401).json({ error: 'Webhook source is missing a secret.' });
      return;
    }
    if (req.header('x-qwen-webhook-secret') !== expectedSecret) {
      res.status(401).json({ error: 'Invalid webhook secret.' });
      return;
    }

    const body = deps.safeBody(req);
    const eventType = readBodyString(body, 'eventType', res);
    const targetRef = readBodyString(body, 'targetRef', res);
    const title = readBodyString(body, 'title', res);
    if (!eventType || !targetRef || !title) return;
    if (!sourceConfig.targets[targetRef]) {
      res.status(404).json({ error: 'Unknown channel webhook target.' });
      return;
    }

    const summary =
      typeof body['summary'] === 'string'
        ? body['summary'].slice(0, MAX_FIELD_LENGTH)
        : undefined;
    const payload =
      body['payload'] && typeof body['payload'] === 'object'
        ? (body['payload'] as Record<string, unknown>)
        : {};
    await deps.enqueueWebhookTask({
      channelName,
      source,
      eventType,
      targetRef,
      title,
      ...(summary ? { summary } : {}),
      payload,
    });
    res.status(202).json({ accepted: true });
  });
}

function readBodyString(
  body: Record<string, unknown>,
  key: string,
  res: { status: (code: number) => { json: (body: unknown) => void } },
): string | undefined {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    res.status(400).json({ error: `Body field "${key}" must be a string.` });
    return undefined;
  }
  return value.slice(0, MAX_FIELD_LENGTH);
}
```

- [ ] **Step 4: Mount route in server**

Modify `packages/cli/src/serve/server.ts`.

```ts
import { registerChannelWebhookRoutes } from './routes/channel-webhooks.js';
```

Add a dependency to `ServeAppDeps` if one is not already available:

```ts
enqueueChannelWebhookTask?: ChannelWorkerSupervisor['enqueueWebhookTask'];
```

After `installJsonBodyParser(app)` and before the final error handler, mount:

```ts
if (deps.enqueueChannelWebhookTask) {
  registerChannelWebhookRoutes(app, {
    channelsConfig: loadChannelsConfig(boundWorkspace),
    safeBody,
    enqueueWebhookTask: deps.enqueueChannelWebhookTask,
  });
}
```

If importing `loadChannelsConfig` into `server.ts` creates an unwanted dependency on command code, move a small `readChannelsConfig(settings)` helper to a shared serve/channel config module and use it from both places.

- [ ] **Step 5: Run route tests**

Run:

```bash
cd packages/cli && npx vitest run src/serve/routes/channel-webhooks.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run server tests that cover route assembly**

Run:

```bash
cd packages/cli && npx vitest run src/serve/server.test.ts src/serve/routes/channel-webhooks.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/serve/routes/channel-webhooks.ts packages/cli/src/serve/routes/channel-webhooks.test.ts packages/cli/src/serve/server.ts packages/cli/src/serve/types.ts
git commit -m "feat(serve): accept channel webhook tasks"
```

## Task 6: Documentation

**Files:**
- Modify: `docs/users/features/channels/overview.md`
- Modify: `docs/developers/daemon/15-channel-adapters.md`

- [ ] **Step 1: Update user docs**

Add a "Webhook-triggered tasks" section to `docs/users/features/channels/overview.md`.

````md
## Webhook-triggered tasks

Daemon-managed channels can accept authenticated webhook events and ask Qwen to produce the group message. This is different from a raw notification relay: Qwen receives the event as context, summarizes what matters, and the final response is delivered to the configured chat target.

Example channel config:

```json
{
  "channels": {
    "dingtalk-main": {
      "type": "dingtalk",
      "token": "$DINGTALK_TOKEN",
      "cwd": "/repo",
      "senderPolicy": "allowlist",
      "allowedUsers": ["12345"],
      "sessionScope": "user",
      "webhooks": {
        "sources": {
          "github-ci": {
            "secretEnv": "QWEN_CHANNEL_GITHUB_CI_SECRET",
            "targets": {
              "default": {
                "chatId": "conversation-id",
                "senderId": "webhook:github-ci",
                "isGroup": true
              }
            }
          }
        }
      }
    }
  }
}
```

Example request:

```bash
curl -X POST http://127.0.0.1:4170/channels/dingtalk-main/webhooks/github-ci \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H "x-qwen-webhook-secret: $QWEN_CHANNEL_GITHUB_CI_SECRET" \
  -H "content-type: application/json" \
  -d '{"eventType":"ci_failed","targetRef":"default","title":"CI failed on main","payload":{"branch":"main","url":"https://ci.example/run/1"}}'
```
````

- [ ] **Step 2: Update developer docs**

Add a short subsection to `docs/developers/daemon/15-channel-adapters.md`.

```md
### Webhook-triggered channel tasks

Webhook-triggered tasks are hosted by `qwen serve` and executed inside the daemon-managed channel worker. The HTTP route validates the webhook source and forwards a `ChannelWebhookTask` to the worker over IPC. The worker calls `ChannelBase.runWebhookTask()`, so adapters do not implement webhook parsing.

Adapters participate only through proactive send support. If an adapter returns `true` from `supportsProactiveSend()` and its `pushProactive()` can address the configured target, webhook tasks can deliver final responses through that adapter.
```

- [ ] **Step 3: Verify docs changed as intended**

Run:

```bash
git diff -- docs/users/features/channels/overview.md docs/developers/daemon/15-channel-adapters.md
```

Expected: diff contains the user config example, curl example, and developer architecture note.

- [ ] **Step 4: Commit**

```bash
git add docs/users/features/channels/overview.md docs/developers/daemon/15-channel-adapters.md
git commit -m "docs(channels): document webhook-triggered tasks"
```

## Task 7: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI focused tests**

Run:

```bash
cd packages/cli && npx vitest run src/commands/channel/config-utils.test.ts src/commands/channel/daemon-worker.test.ts src/serve/channel-worker-supervisor.test.ts src/serve/routes/channel-webhooks.test.ts src/serve/server.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build and typecheck**

Run from repo root:

```bash
npm run build && npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: working tree is clean except for intentionally uncommitted local files, and recent commits include the webhook helper, base run method, config parser, IPC route, and docs commits.
