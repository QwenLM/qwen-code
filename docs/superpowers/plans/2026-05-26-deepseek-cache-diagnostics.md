# DeepSeek Cache Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-preserving OpenAI-compatible tool cache-stability diagnostics so DeepSeek users can identify tool set, order, schema, and serialization drift.

**Architecture:** Extend the existing disabled-by-default `runtimeDiagnostics` collector with pure hashing helpers and an optional `cacheStability` summary on OpenAI wire request diagnostics. Pass provider context from the OpenAI pipeline using hostname-based DeepSeek detection, then document how to interpret the hashes.

**Tech Stack:** TypeScript, Vitest, Node `crypto`, Qwen Code core/cli workspaces, Markdown docs.

---

## File Structure

- Modify `packages/core/src/utils/runtimeDiagnostics.ts`
  - Owns privacy-preserving summaries for runtime profiling.
  - Add `OpenAICacheStabilityDiagnostics`, `OpenAIWireRequestDiagnosticsOptions`, and pure hashing/canonicalization helpers.
  - Keep request bodies unchanged and diagnostics disabled unless `QWEN_CODE_PROFILE_RUNTIME=1`.

- Modify `packages/core/src/utils/runtimeDiagnostics.test.ts`
  - Unit coverage for ordered names, set hash, exact schema hash, canonical manifest hash, and privacy boundaries.

- Modify `packages/core/src/core/openaiContentGenerator/pipeline.ts`
  - Pass provider context into `runtimeDiagnostics.recordOpenAIWireRequest`.

- Modify `packages/core/src/core/openaiContentGenerator/pipeline.test.ts`
  - Verify DeepSeek hostnames are labeled as DeepSeek and non-DeepSeek hostnames are not.

- Modify `packages/cli/src/config/config.test.ts`
  - Add a regression test for `deepseek-v4-pro` ToolSearch auto-deny.

- Modify `docs/users/configuration/model-providers.md`
  - Add a short DeepSeek cache diagnostics subsection.

---

### Task 1: Runtime Diagnostics Failing Tests

**Files:**

- Modify: `packages/core/src/utils/runtimeDiagnostics.test.ts`

- [ ] **Step 1: Add failing tests for OpenAI tool cache-stability summaries**

Append these tests inside the existing `describe('RuntimeDiagnosticsCollector', () => { ... })` block, before the closing `});`.

```ts
it('summarizes OpenAI tool cache stability without retaining schema bodies', () => {
  const summary = summarizeOpenAIWireRequest(
    {
      model: 'wire-model',
      stream: false,
      messages: [{ role: 'user', content: 'secret user prompt' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'secret tool description',
            parameters: {
              type: 'object',
              properties: {
                secretPathProperty: { type: 'string' },
              },
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'run_shell_command',
            description: 'another secret description',
            parameters: {
              type: 'object',
              properties: {
                secretCommandProperty: { type: 'string' },
              },
            },
          },
        },
      ],
    },
    { provider: 'deepseek' },
  );

  expect(summary.cacheStability).toMatchObject({
    provider: 'deepseek',
    toolNames: ['read_file', 'run_shell_command'],
    toolNameSequenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    toolNameSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    toolSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    canonicalToolManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(summary)).not.toContain('secret user prompt');
  expect(JSON.stringify(summary)).not.toContain('secret tool description');
  expect(JSON.stringify(summary)).not.toContain('secretPathProperty');
  expect(JSON.stringify(summary)).not.toContain('secretCommandProperty');
});

it('distinguishes OpenAI tool order drift from tool set drift', () => {
  const alphaFirst = summarizeOpenAIWireRequest({
    model: 'wire-model',
    stream: false,
    messages: [],
    tools: [
      {
        type: 'function',
        function: { name: 'alpha', description: 'A', parameters: {} },
      },
      {
        type: 'function',
        function: { name: 'bravo', description: 'B', parameters: {} },
      },
    ],
  });
  const bravoFirst = summarizeOpenAIWireRequest({
    model: 'wire-model',
    stream: false,
    messages: [],
    tools: [
      {
        type: 'function',
        function: { name: 'bravo', description: 'B', parameters: {} },
      },
      {
        type: 'function',
        function: { name: 'alpha', description: 'A', parameters: {} },
      },
    ],
  });

  expect(alphaFirst.cacheStability?.toolNames).toEqual(['alpha', 'bravo']);
  expect(bravoFirst.cacheStability?.toolNames).toEqual(['bravo', 'alpha']);
  expect(alphaFirst.cacheStability?.toolNameSetHash).toBe(
    bravoFirst.cacheStability?.toolNameSetHash,
  );
  expect(alphaFirst.cacheStability?.toolNameSequenceHash).not.toBe(
    bravoFirst.cacheStability?.toolNameSequenceHash,
  );
});

it('uses canonical manifest hashes for equivalent schema key order', () => {
  const first = summarizeOpenAIWireRequest({
    model: 'wire-model',
    stream: false,
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'inspect',
          description: 'Inspect',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path' },
              limit: { type: 'number', description: 'Limit' },
            },
          },
        },
      },
    ],
  });
  const second = summarizeOpenAIWireRequest({
    model: 'wire-model',
    stream: false,
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          parameters: {
            properties: {
              limit: { description: 'Limit', type: 'number' },
              path: { description: 'Path', type: 'string' },
            },
            type: 'object',
          },
          description: 'Inspect',
          name: 'inspect',
        },
      },
    ],
  });

  expect(first.cacheStability?.canonicalToolManifestHash).toBe(
    second.cacheStability?.canonicalToolManifestHash,
  );
  expect(first.cacheStability?.toolSchemaHash).not.toBe(
    second.cacheStability?.toolSchemaHash,
  );
});

it('changes canonical manifest hash when schema content changes', () => {
  const before = summarizeOpenAIWireRequest({
    model: 'wire-model',
    stream: false,
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'inspect',
          description: 'Inspect',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  });
  const after = summarizeOpenAIWireRequest({
    model: 'wire-model',
    stream: false,
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'inspect',
          description: 'Inspect',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      },
    ],
  });

  expect(before.cacheStability?.canonicalToolManifestHash).not.toBe(
    after.cacheStability?.canonicalToolManifestHash,
  );
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```powershell
npm test --workspace=packages/core -- src/utils/runtimeDiagnostics.test.ts
```

Expected: FAIL with TypeScript or assertion errors mentioning missing `cacheStability` / missing second argument support on `summarizeOpenAIWireRequest`.

---

### Task 2: Implement Runtime Tool Cache-Stability Helpers

**Files:**

- Modify: `packages/core/src/utils/runtimeDiagnostics.ts`
- Test: `packages/core/src/utils/runtimeDiagnostics.test.ts`

- [ ] **Step 1: Add the crypto import and public diagnostics types**

At the top of `packages/core/src/utils/runtimeDiagnostics.ts`, add the import before existing type imports.

```ts
import { createHash } from 'node:crypto';
```

Add these interfaces near `OpenAIWireRequestDiagnostics`.

```ts
export type OpenAICacheStabilityProvider = 'deepseek' | 'openai-compatible';

export interface OpenAICacheStabilityDiagnostics {
  provider?: OpenAICacheStabilityProvider;
  toolNames: string[];
  toolNameSequenceHash: string;
  toolNameSetHash: string;
  toolSchemaHash: string;
  canonicalToolManifestHash: string;
}

export interface OpenAIWireRequestDiagnosticsOptions {
  provider?: OpenAICacheStabilityProvider;
}
```

Add the optional field to `OpenAIWireRequestDiagnostics`.

```ts
  cacheStability?: OpenAICacheStabilityDiagnostics;
```

- [ ] **Step 2: Thread options through collector recording**

Change `recordOpenAIWireRequest` to accept options and pass them into the summarizer.

```ts
  recordOpenAIWireRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    options: OpenAIWireRequestDiagnosticsOptions = {},
  ): void {
    if (!this.enabled) {
      return;
    }

    this.openAIWireRequestIndex += 1;
    this.openaiWireRequests.push({
      index: this.openAIWireRequestIndex,
      timestamp: this.now(),
      ...summarizeOpenAIWireRequest(request, options),
    });
  }
```

- [ ] **Step 3: Add cache stability to OpenAI request summaries**

Change the function signature and add `cacheStability` to the return object.

```ts
export function summarizeOpenAIWireRequest(
  request: OpenAI.Chat.ChatCompletionCreateParams,
  options: OpenAIWireRequestDiagnosticsOptions = {},
): OpenAIWireRequestDiagnostics {
  const requestRecord = asRecord(request);
  const messages = Array.isArray(requestRecord['messages'])
    ? requestRecord['messages']
    : [];
  const tools = Array.isArray(requestRecord['tools'])
    ? requestRecord['tools']
    : [];
  const messageBytesByRole: Record<string, number> = {};
  for (const message of messages) {
    const messageRecord = asRecord(message);
    const role =
      typeof messageRecord['role'] === 'string'
        ? messageRecord['role']
        : 'unknown';
    messageBytesByRole[role] =
      (messageBytesByRole[role] ?? 0) + utf8Bytes(messageRecord['content']);
  }

  return {
    model:
      typeof requestRecord['model'] === 'string'
        ? requestRecord['model']
        : 'unknown',
    stream: requestRecord['stream'] === true,
    bodyBytes: utf8Bytes(request),
    messageCount: messages.length,
    messageBytesByRole,
    toolsCount: tools.length,
    toolSchemaBytes: utf8Bytes(tools),
    topLevelKeys: Object.keys(requestRecord).sort(),
    cacheStability: summarizeOpenAIToolCacheStability(tools, options),
  };
}
```

- [ ] **Step 4: Add pure helper functions near `safeStringify`**

Place these helpers near the existing private JSON/record helpers at the bottom of the file.

```ts
function summarizeOpenAIToolCacheStability(
  tools: unknown[],
  options: OpenAIWireRequestDiagnosticsOptions,
): OpenAICacheStabilityDiagnostics {
  const toolNames = extractOpenAIToolNames(tools);
  return {
    provider: options.provider,
    toolNames,
    toolNameSequenceHash: hashStableJson(toolNames),
    toolNameSetHash: hashStableJson([...toolNames].sort()),
    toolSchemaHash: hashString(safeStringify(tools)),
    canonicalToolManifestHash: hashStableJson(
      buildCanonicalOpenAIToolManifest(tools),
    ),
  };
}

function extractOpenAIToolNames(tools: unknown[]): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    const toolRecord = asRecord(tool);
    const fn = asOptionalRecord(toolRecord['function']);
    const name = fn && typeof fn['name'] === 'string' ? fn['name'] : undefined;
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function buildCanonicalOpenAIToolManifest(tools: unknown[]): Array<{
  name: string;
  descriptionHash: string;
  parametersHash: string;
}> {
  const manifest: Array<{
    name: string;
    descriptionHash: string;
    parametersHash: string;
  }> = [];
  for (const tool of tools) {
    const toolRecord = asRecord(tool);
    const fn = asOptionalRecord(toolRecord['function']);
    if (!fn || typeof fn['name'] !== 'string') {
      continue;
    }
    manifest.push({
      name: fn['name'],
      descriptionHash: hashString(
        typeof fn['description'] === 'string' ? fn['description'] : '',
      ),
      parametersHash: hashStableJson(fn['parameters']),
    });
  }
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  return manifest;
}

function hashStableJson(value: unknown): string {
  return hashString(stableStringify(value));
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value)) ?? '';
}

function toStableJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonValue(item, seen));
  }
  const record = value as Record<string, unknown>;
  const stableRecord: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    stableRecord[key] = toStableJsonValue(record[key], seen);
  }
  return stableRecord;
}
```

- [ ] **Step 5: Run the runtime diagnostics test**

Run:

```powershell
npm test --workspace=packages/core -- src/utils/runtimeDiagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit runtime diagnostics implementation**

Run:

```powershell
git add packages/core/src/utils/runtimeDiagnostics.ts packages/core/src/utils/runtimeDiagnostics.test.ts
git commit -m "feat(core): add OpenAI tool cache diagnostics"
```

Expected: commit succeeds.

---

### Task 3: Pass DeepSeek Provider Context From Pipeline

**Files:**

- Modify: `packages/core/src/core/openaiContentGenerator/pipeline.test.ts`
- Modify: `packages/core/src/core/openaiContentGenerator/pipeline.ts`

- [ ] **Step 1: Add failing pipeline tests**

Add this import near the other imports in `pipeline.test.ts`.

```ts
import { runtimeDiagnostics } from '../../utils/runtimeDiagnostics.js';
```

Add these tests inside `describe('execute', () => { ... })` after the existing successful execution test.

```ts
it('labels runtime OpenAI diagnostics as deepseek for DeepSeek hostnames', async () => {
  const diagnosticsSpy = vi
    .spyOn(runtimeDiagnostics, 'recordOpenAIWireRequest')
    .mockImplementation(() => undefined);
  mockContentGeneratorConfig.baseUrl = 'https://api.deepseek.com';
  const request: GenerateContentParameters = {
    model: 'deepseek-v4-pro',
    contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
  };
  const mockMessages = [
    { role: 'user', content: 'Hello' },
  ] as OpenAI.Chat.ChatCompletionMessageParam[];
  const mockOpenAIResponse = {
    id: 'response-id',
    choices: [
      { message: { content: 'Hello response' }, finish_reason: 'stop' },
    ],
    created: Date.now(),
    model: 'deepseek-v4-pro',
  } as OpenAI.Chat.ChatCompletion;
  const mockGeminiResponse = new GenerateContentResponse();

  (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
    mockMessages,
  );
  (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
    mockGeminiResponse,
  );
  (mockClient.chat.completions.create as Mock).mockResolvedValue(
    mockOpenAIResponse,
  );

  await pipeline.execute(request, 'test-prompt-id');

  expect(diagnosticsSpy).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'deepseek-v4-pro' }),
    { provider: 'deepseek' },
  );
});

it('labels runtime OpenAI diagnostics as openai-compatible for non-DeepSeek hostnames', async () => {
  const diagnosticsSpy = vi
    .spyOn(runtimeDiagnostics, 'recordOpenAIWireRequest')
    .mockImplementation(() => undefined);
  mockContentGeneratorConfig.baseUrl = 'https://example.test/v1';
  const request: GenerateContentParameters = {
    model: 'deepseek-v4-pro',
    contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
  };
  const mockMessages = [
    { role: 'user', content: 'Hello' },
  ] as OpenAI.Chat.ChatCompletionMessageParam[];
  const mockOpenAIResponse = {
    id: 'response-id',
    choices: [
      { message: { content: 'Hello response' }, finish_reason: 'stop' },
    ],
    created: Date.now(),
    model: 'deepseek-v4-pro',
  } as OpenAI.Chat.ChatCompletion;
  const mockGeminiResponse = new GenerateContentResponse();

  (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
    mockMessages,
  );
  (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
    mockGeminiResponse,
  );
  (mockClient.chat.completions.create as Mock).mockResolvedValue(
    mockOpenAIResponse,
  );

  await pipeline.execute(request, 'test-prompt-id');

  expect(diagnosticsSpy).toHaveBeenCalledWith(expect.any(Object), {
    provider: 'openai-compatible',
  });
});
```

- [ ] **Step 2: Run the pipeline test and verify failure**

Run:

```powershell
npm test --workspace=packages/core -- src/core/openaiContentGenerator/pipeline.test.ts
```

Expected: FAIL because `recordOpenAIWireRequest` is still called with one argument.

- [ ] **Step 3: Update the pipeline diagnostics call**

In `packages/core/src/core/openaiContentGenerator/pipeline.ts`, replace:

```ts
runtimeDiagnostics.recordOpenAIWireRequest(openaiRequest);
```

with:

```ts
runtimeDiagnostics.recordOpenAIWireRequest(openaiRequest, {
  provider: isDeepSeekHostname(this.contentGeneratorConfig)
    ? 'deepseek'
    : 'openai-compatible',
});
```

- [ ] **Step 4: Run the pipeline test**

Run:

```powershell
npm test --workspace=packages/core -- src/core/openaiContentGenerator/pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit pipeline provider context**

Run:

```powershell
git add packages/core/src/core/openaiContentGenerator/pipeline.ts packages/core/src/core/openaiContentGenerator/pipeline.test.ts
git commit -m "feat(core): label DeepSeek cache diagnostics"
```

Expected: commit succeeds.

---

### Task 4: CLI DeepSeek Model Regression

**Files:**

- Modify: `packages/cli/src/config/config.test.ts`

- [ ] **Step 1: Add the failing or passing regression test first**

Add this test near the existing ToolSearch DeepSeek auto-disable tests.

```ts
it('should auto-disable tool_search for deepseek-v4-pro models', async () => {
  process.argv = ['node', 'script.js', '--model', 'deepseek-v4-pro'];
  const argv = await parseArguments();
  const settings: Settings = {};
  const config = await loadCliConfig(settings, argv, undefined, []);
  expect(config.getPermissionsDeny()).toContain('tool_search');
});
```

- [ ] **Step 2: Run the targeted CLI config test**

Run:

```powershell
npm run test --workspace=packages/cli -- src/config/config.test.ts
```

Expected: PASS. If it fails because the regex does not match `deepseek-v4-pro`, update the model regex in `packages/cli/src/config/config.ts` so `deepseek-v4-pro` remains denied by default.

- [ ] **Step 3: Commit the regression test**

Run:

```powershell
git add packages/cli/src/config/config.test.ts
git commit -m "test(cli): cover deepseek v4 pro tool search default"
```

Expected: commit succeeds.

---

### Task 5: Documentation And Full Validation

**Files:**

- Modify: `docs/users/configuration/model-providers.md`

- [ ] **Step 1: Add DeepSeek cache diagnostics docs**

In `docs/users/configuration/model-providers.md`, add this subsection after the existing DeepSeek reasoning configuration notes.

```md
### DeepSeek cache-stability diagnostics

DeepSeek-hosted OpenAI-compatible requests rely heavily on exact prefix reuse.
When `QWEN_CODE_PROFILE_RUNTIME=1` is enabled, Qwen Code records
privacy-preserving OpenAI wire diagnostics that help identify tool-prefix drift
without storing prompts, tool descriptions, schema bodies, arguments, or tool
outputs.

For OpenAI-compatible requests, the runtime diagnostics snapshot includes a
`cacheStability` object:

- `provider`: `deepseek` for `api.deepseek.com` hostnames, otherwise
  `openai-compatible`.
- `toolNames`: function names in the exact wire order sent to the provider.
- `toolNameSequenceHash`: changes when the ordered tool sequence changes.
- `toolNameSetHash`: remains stable when the same tools are only reordered.
- `toolSchemaHash`: hashes the exact `tools` JSON shape sent on the wire.
- `canonicalToolManifestHash`: hashes a name-sorted manifest with recursively
  sorted schema keys, so it stays stable across equivalent JSON key ordering.

Useful comparisons:

- Same `toolNameSetHash`, different `toolNameSequenceHash`: tool order drift.
- Same `toolNameSequenceHash`, different `canonicalToolManifestHash`: schema
  content drift.
- Same `canonicalToolManifestHash`, different `toolSchemaHash`: JSON
  serialization or key-order drift.
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm test --workspace=packages/core -- src/utils/runtimeDiagnostics.test.ts
npm test --workspace=packages/core -- src/core/openaiContentGenerator/pipeline.test.ts
npm run test --workspace=packages/cli -- src/config/config.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run typechecks**

Run:

```powershell
npm run typecheck --workspace=packages/core
npm run typecheck --workspace=packages/cli
```

Expected: both PASS.

- [ ] **Step 4: Run formatting/check guards**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 5: Commit docs**

Run:

```powershell
git add docs/users/configuration/model-providers.md
git commit -m "docs: explain DeepSeek cache diagnostics"
```

Expected: commit succeeds.

- [ ] **Step 6: Final status**

Run:

```powershell
git status --short
git log --oneline -5
```

Expected: clean worktree and recent commits for the spec, runtime diagnostics, pipeline provider labeling, CLI regression, and docs.

---

## Self-Review Checklist

- The plan covers every acceptance criterion from `docs/superpowers/specs/2026-05-26-deepseek-cache-diagnostics-design.md`.
- Each implementation task starts with tests before production code.
- Diagnostics retain tool names and hashes only, not prompts, descriptions, schemas, args, or outputs.
- Provider labeling uses `isDeepSeekHostname`, not model-name fallback.
- The rollout remains behind existing runtime diagnostics gating.
- No task changes ToolSearch behavior or reorders tools.
