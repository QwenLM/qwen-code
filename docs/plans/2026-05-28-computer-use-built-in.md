# Computer Use Built-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `open-computer-use` a zero-config built-in capability in qwen-code. 9 computer-use tools appear in the deferred tool list as `computer_use__click`, `computer_use__type_text`, etc. First invocation transparently installs the upstream npm binary, walks the user through macOS Accessibility / Screen Recording permissions if needed, and forwards the call to the upstream MCP server.

**Architecture:** Thin shell over upstream `npx -y open-computer-use mcp`. We do NOT bundle the binary; upstream's `npx` cache + `.app` bundle handles distribution and macOS TCC. 9 tools are registered as parameterized `ComputerUseTool` instances (one per tool name) backed by a singleton `ComputerUseClient` that owns a long-running MCP stdio child process. Bootstrap state machine layers on top: standard qwen-code tool permission (existing) → first-time install confirm → optional macOS permission guide.

**Tech Stack:** TypeScript, vitest, `@modelcontextprotocol/sdk` (already a qwen-code dep), `node:child_process`, `node:fs/promises`.

---

## File Structure

**New files:**

```
packages/core/src/tools/computer-use/
  index.ts                          # registerComputerUseTools(registry, config); barrel export
  schemas.ts                        # hardcoded 9 schemas + descriptions (synced from upstream)
  tool.ts                           # ComputerUseTool — parameterized BaseDeclarativeTool
  client.ts                         # ComputerUseClient — singleton MCP stdio process manager
  bootstrap.ts                      # state machine: probe → install confirm → install → perm guide
  install-state.ts                  # ~/.qwen/computer-use/installed.json read/write
  permission-detector.ts            # parse upstream error strings to detect missing perms
  schemas.test.ts                   # all 9 schemas parse, names match contract
  tool.test.ts                      # parameterized tool wiring
  client.test.ts                    # client lifecycle (mocked spawn)
  bootstrap.test.ts                 # state machine transitions
  install-state.test.ts             # state file round-trip
  permission-detector.test.ts       # error pattern matching
scripts/
  sync-computer-use-schemas.ts      # release-time script: dump upstream tools/list → schemas.ts
```

**Modified files:**

```
packages/core/src/tools/tool-names.ts                  # add 9 COMPUTER_USE_* constants
packages/core/src/config/config.ts                     # add computerUseEnabled field + isComputerUseEnabled() + register call in createToolRegistry()
packages/cli/src/config/config.ts                      # map settings.tools.computerUse.enabled → ConfigParameters.computerUseEnabled
packages/cli/src/config/settingsSchema.ts              # add tools.computerUse.enabled boolean (default true)
```

**Decomposition rationale:** Each file has one responsibility. `client.ts` knows MCP protocol but not UX; `bootstrap.ts` knows UX but doesn't touch MCP details; `tool.ts` is pure plumbing that wires them via `execute()`. Tests live next to code. Schemas are isolated so the sync script can rewrite the file without churning logic.

---

## Phase 1 — Foundation (tool surface visible, no execution)

### Task 1: Add ToolNames + ToolDisplayNames entries for 9 computer-use tools

**Files:**

- Modify: `packages/core/src/tools/tool-names.ts`

- [ ] **Step 1: Add the 9 name constants**

Edit `packages/core/src/tools/tool-names.ts` — inside the `ToolNames` object, after `EXIT_WORKTREE: 'exit_worktree',`:

```ts
  // Computer Use tools — built-in but backed by an upstream MCP server.
  // All deferred; revealed only when the user-initiated request triggers
  // a computer-use action. See packages/core/src/tools/computer-use/.
  COMPUTER_USE_LIST_APPS: 'computer_use__list_apps',
  COMPUTER_USE_GET_APP_STATE: 'computer_use__get_app_state',
  COMPUTER_USE_CLICK: 'computer_use__click',
  COMPUTER_USE_PERFORM_SECONDARY_ACTION: 'computer_use__perform_secondary_action',
  COMPUTER_USE_SCROLL: 'computer_use__scroll',
  COMPUTER_USE_DRAG: 'computer_use__drag',
  COMPUTER_USE_TYPE_TEXT: 'computer_use__type_text',
  COMPUTER_USE_PRESS_KEY: 'computer_use__press_key',
  COMPUTER_USE_SET_VALUE: 'computer_use__set_value',
```

Mirror in `ToolDisplayNames`:

```ts
  COMPUTER_USE_LIST_APPS: 'computer_use__list_apps',
  COMPUTER_USE_GET_APP_STATE: 'computer_use__get_app_state',
  COMPUTER_USE_CLICK: 'computer_use__click',
  COMPUTER_USE_PERFORM_SECONDARY_ACTION: 'computer_use__perform_secondary_action',
  COMPUTER_USE_SCROLL: 'computer_use__scroll',
  COMPUTER_USE_DRAG: 'computer_use__drag',
  COMPUTER_USE_TYPE_TEXT: 'computer_use__type_text',
  COMPUTER_USE_PRESS_KEY: 'computer_use__press_key',
  COMPUTER_USE_SET_VALUE: 'computer_use__set_value',
```

(displayName == name on purpose; we don't want capitalized display names like `Click` showing in the permission dialog when the tool name is `computer_use__click`.)

- [ ] **Step 2: Verify the existing tool-names test still passes**

Run: `npm test -- packages/core/src/tools/tool-names`
Expected: PASS (if there's no test file, run `npm run build -- --filter @qwen-code/qwen-code-core` to typecheck)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/tools/tool-names.ts
git commit -m "feat(computer-use): add tool name constants"
```

---

### Task 2: Hardcoded schemas module

**Files:**

- Create: `packages/core/src/tools/computer-use/schemas.ts`
- Create: `packages/core/src/tools/computer-use/schemas.test.ts`

The 9 schemas mirror upstream `open-computer-use mcp` `tools/list` output. These are pinned to upstream version `^0.x.y` (TODO: fill in the actual pin at the top of `schemas.ts` when implementing — run `npx -y open-computer-use@latest --version` to capture the current latest).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/computer-use/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { COMPUTER_USE_SCHEMAS, COMPUTER_USE_TOOL_NAMES } from './schemas.js';

describe('computer-use schemas', () => {
  it('exports exactly 9 schemas', () => {
    expect(Object.keys(COMPUTER_USE_SCHEMAS)).toHaveLength(9);
  });

  it('each tool name matches the upstream convention (no computer_use__ prefix)', () => {
    // schemas.ts uses upstream names verbatim ("click", "type_text").
    // The computer_use__ prefix lives on the qwen-code-facing wrapper.
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(name).not.toContain('computer_use__');
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });

  it('every schema has the standard object structure', () => {
    for (const [name, schema] of Object.entries(COMPUTER_USE_SCHEMAS)) {
      expect(schema.description, `${name} missing description`).toBeTruthy();
      expect(
        schema.parameterSchema,
        `${name} missing parameterSchema`,
      ).toBeTruthy();
      expect((schema.parameterSchema as { type: string }).type).toBe('object');
    }
  });

  it('list_apps takes no parameters', () => {
    expect(COMPUTER_USE_SCHEMAS.list_apps.parameterSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('click requires app and either element_index or x/y', () => {
    const schema = COMPUTER_USE_SCHEMAS.click.parameterSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty('app');
    expect(schema.properties).toHaveProperty('element_index');
    expect(schema.properties).toHaveProperty('x');
    expect(schema.properties).toHaveProperty('y');
    expect(schema.required).toContain('app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/core/src/tools/computer-use/schemas.test.ts`
Expected: FAIL with "Cannot find module './schemas.js'"

- [ ] **Step 3: Write the schemas module**

Create `packages/core/src/tools/computer-use/schemas.ts`. The schemas below are MVP — they reflect upstream's tool surface and parameter naming. The `sync-computer-use-schemas.ts` script (Task 13) will regenerate this file from a live upstream snapshot in CI before each qwen-code release.

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardcoded schemas for the 9 upstream open-computer-use tools.
 *
 * Pinned to upstream version: <PIN_VERSION_DURING_IMPL>
 *
 * Regenerated by `scripts/sync-computer-use-schemas.ts` — do not hand-edit.
 * The upstream tool names ("click", "type_text") appear verbatim here;
 * the `computer_use__` prefix is added by the qwen-code-facing wrapper in
 * `tool.ts` so the model sees `computer_use__click` without any MCP
 * concept leaking through.
 */

export interface ComputerUseToolSchema {
  description: string;
  parameterSchema: Record<string, unknown>;
}

export const COMPUTER_USE_TOOL_NAMES = [
  'list_apps',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'scroll',
  'drag',
  'type_text',
  'press_key',
  'set_value',
] as const;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];

export const COMPUTER_USE_SCHEMAS: Record<
  ComputerUseToolName,
  ComputerUseToolSchema
> = {
  list_apps: {
    description:
      'List running and recently-used desktop applications on the current machine. Returns each app with a bundle identifier and display name. Use this before get_app_state to discover what is available to interact with.',
    parameterSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  get_app_state: {
    description:
      'Capture the current accessibility tree and a screenshot of the given application. Returns element_index values that subsequent actions (click, set_value, etc.) can target. Always call this before any element-targeted action; element_index values are valid only within the current snapshot.',
    parameterSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description:
            'Application bundle identifier or display name (e.g. "TextEdit", "com.apple.Safari").',
        },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
  click: {
    description:
      'Left-click a target. Prefer element_index from a recent get_app_state result. Fall back to x/y screenshot pixel coordinates only when no AX element matches the target.',
    parameterSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Target application.' },
        element_index: {
          type: 'integer',
          description: 'Index into the latest get_app_state element list.',
        },
        x: {
          type: 'integer',
          description: 'X coordinate in screenshot pixels.',
        },
        y: {
          type: 'integer',
          description: 'Y coordinate in screenshot pixels.',
        },
        click_count: {
          type: 'integer',
          description: 'Number of clicks (1 = single, 2 = double).',
          default: 1,
        },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
  perform_secondary_action: {
    description:
      'Perform a non-click semantic action exposed by the target AX element (e.g. "Raise", "ShowMenu"). Returns an error if the action is not valid for the element.',
    parameterSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'integer' },
        action: {
          type: 'string',
          description: 'AX action name to perform.',
        },
      },
      required: ['app', 'element_index', 'action'],
      additionalProperties: false,
    },
  },
  scroll: {
    description:
      'Scroll inside the target element or at the given coordinates. `pages` is a fractional page count (positive = down, negative = up).',
    parameterSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'integer' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        pages: {
          type: 'number',
          description: 'Fractional page count to scroll (negative = up).',
        },
      },
      required: ['app', 'pages'],
      additionalProperties: false,
    },
  },
  drag: {
    description:
      'Drag from one coordinate pair to another inside the target application window. Coordinates are in screenshot pixels.',
    parameterSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        from_x: { type: 'integer' },
        from_y: { type: 'integer' },
        to_x: { type: 'integer' },
        to_y: { type: 'integer' },
      },
      required: ['app', 'from_x', 'from_y', 'to_x', 'to_y'],
      additionalProperties: false,
    },
  },
  type_text: {
    description:
      'Type text into the currently-focused text input of the target application. Click the input area first if it is not focused. For unfocused text fields, prefer set_value instead.',
    parameterSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        text: {
          type: 'string',
          description: 'Text to type. Supports Unicode.',
        },
      },
      required: ['app', 'text'],
      additionalProperties: false,
    },
  },
  press_key: {
    description:
      'Press a keyboard key or combo against the target application. Key names follow xdotool conventions (e.g. "Return", "BackSpace", "cmd+c", "Page_Up").',
    parameterSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['app', 'key'],
      additionalProperties: false,
    },
  },
  set_value: {
    description:
      'Directly set the value of a settable AX element (text fields, sliders, etc.). Returns an error if the target is not settable.',
    parameterSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'integer' },
        value: { type: 'string' },
      },
      required: ['app', 'element_index', 'value'],
      additionalProperties: false,
    },
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/core/src/tools/computer-use/schemas.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/computer-use/schemas.ts packages/core/src/tools/computer-use/schemas.test.ts
git commit -m "feat(computer-use): hardcode upstream tool schemas"
```

---

### Task 3: Settings schema + Config wiring for enableComputerUse

**Files:**

- Modify: `packages/cli/src/config/settingsSchema.ts`
- Modify: `packages/cli/src/config/config.ts`
- Modify: `packages/core/src/config/config.ts`

- [ ] **Step 1: Add settings entry**

Edit `packages/cli/src/config/settingsSchema.ts`. The existing schema groups things by category. Computer Use is a tool capability, not experimental — add a new `tools` subgroup IF it doesn't exist, or add to the existing one. Use grep:

```bash
grep -n "tools:" packages/cli/src/config/settingsSchema.ts | head -5
```

If a `tools:` key exists, add a new property under it. If not, add a top-level group. Pattern (add near where the `experimental.cron` entry lives, line ~2298):

```ts
  tools: {
    type: 'object',
    label: 'Tools',
    category: 'Tools',
    requiresRestart: true,
    default: {},
    description: 'Tool capability toggles.',
    showInDialog: false,
    properties: {
      computerUse: {
        type: 'object',
        label: 'Computer Use',
        category: 'Tools',
        requiresRestart: true,
        default: {},
        description: 'Cross-platform desktop automation via the upstream open-computer-use MCP server. Tools: list_apps, get_app_state, click, type_text, scroll, drag, press_key, perform_secondary_action, set_value. On first invocation, the upstream binary is fetched via npx and the user is walked through macOS Accessibility / Screen Recording permissions if needed.',
        showInDialog: false,
        properties: {
          enabled: {
            type: 'boolean',
            label: 'Enable Computer Use',
            category: 'Tools',
            requiresRestart: true,
            default: true,
            description: 'When enabled (default), the 9 computer_use__* tools are registered as deferred built-ins.',
            showInDialog: true,
          },
        },
      },
    },
  },
```

If a `tools:` group already exists, just add the `computerUse:` property under its `properties`.

- [ ] **Step 2: Wire settings → ConfigParameters**

Edit `packages/cli/src/config/config.ts`. Find the existing line `cronEnabled: settings.experimental?.cron ?? false,` (around line 1833). Add directly below:

```ts
    computerUseEnabled: settings.tools?.computerUse?.enabled ?? true,
```

- [ ] **Step 3: Add Config field + getter**

Edit `packages/core/src/config/config.ts`:

(a) In `ConfigParameters` interface (search for `cronEnabled?: boolean;`), add directly below:

```ts
  computerUseEnabled?: boolean;
```

(b) In the `Config` class fields (search for `private readonly cronEnabled: boolean = false;`), add directly below:

```ts
  private readonly computerUseEnabled: boolean = true;
```

(c) In the `Config` constructor (search for `this.cronEnabled = params.cronEnabled ?? false;`), add directly below:

```ts
this.computerUseEnabled = params.computerUseEnabled ?? true;
```

(d) Near `isCronEnabled()` (search for `isCronEnabled(): boolean {`), add a sibling getter:

```ts
  isComputerUseEnabled(): boolean {
    return this.computerUseEnabled;
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run build -- --filter @qwen-code/qwen-code-core --filter @qwen-code/qwen-code`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config/settingsSchema.ts packages/cli/src/config/config.ts packages/core/src/config/config.ts
git commit -m "feat(computer-use): add enableComputerUse setting (default true)"
```

---

## Phase 2 — Transport (MCP client over npx stdio)

### Task 4: ComputerUseClient — singleton MCP stdio process manager

**Files:**

- Create: `packages/core/src/tools/computer-use/client.ts`
- Create: `packages/core/src/tools/computer-use/client.test.ts`

Note: The client uses `@modelcontextprotocol/sdk` (already a dep, see `packages/core/src/tools/mcp-client.ts`). We use `StdioClientTransport` to spawn `npx -y open-computer-use mcp`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/computer-use/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComputerUseClient } from './client.js';

describe('ComputerUseClient', () => {
  let client: ComputerUseClient;

  beforeEach(() => {
    client = new ComputerUseClient({
      packageSpec: 'open-computer-use@latest',
      onProgress: vi.fn(),
    });
  });

  it('is constructible', () => {
    expect(client).toBeDefined();
  });

  it('reports not-started before start() is called', () => {
    expect(client.isStarted()).toBe(false);
  });

  it('returns the same instance for repeated callers via singleton', () => {
    const a = ComputerUseClient.shared();
    const b = ComputerUseClient.shared();
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/core/src/tools/computer-use/client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the client**

Create `packages/core/src/tools/computer-use/client.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Singleton stdio MCP client for the upstream open-computer-use binary.
 *
 * Spawned via `npx -y <packageSpec> mcp`. First spawn pays the npx
 * download cost (up to ~60s for a fresh cache); subsequent spawns reuse
 * the npx cache and are sub-second.
 *
 * Lifecycle: lazy spawn on first `callTool` invocation. The process
 * stays alive until `stop()` or qwen-code exits. State (element_index
 * map per app) lives in the process — if the process restarts, the
 * model must call `get_app_state` again before any element-targeted
 * action.
 */
export interface ComputerUseClientOptions {
  /** npm package spec to npx. Example: "open-computer-use@^0.3.0". */
  packageSpec: string;
  /** Streaming hook for progress messages during slow operations. */
  onProgress?: (message: string) => void;
}

export class ComputerUseClient {
  private static singleton: ComputerUseClient | undefined;

  private readonly packageSpec: string;
  private readonly onProgress: (message: string) => void;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(options: ComputerUseClientOptions) {
    this.packageSpec = options.packageSpec;
    this.onProgress = options.onProgress ?? (() => {});
  }

  /**
   * Shared singleton instance, created with default options on first
   * access. Tests can replace it via `setSharedForTest()`.
   */
  static shared(): ComputerUseClient {
    if (!ComputerUseClient.singleton) {
      ComputerUseClient.singleton = new ComputerUseClient({
        packageSpec:
          process.env['QWEN_COMPUTER_USE_PACKAGE'] ??
          'open-computer-use@latest',
      });
    }
    return ComputerUseClient.singleton;
  }

  /** Test-only: replace the singleton. */
  static setSharedForTest(replacement: ComputerUseClient | undefined): void {
    ComputerUseClient.singleton = replacement;
  }

  isStarted(): boolean {
    return this.client !== undefined;
  }

  /**
   * Start the upstream MCP server. Idempotent: concurrent callers share
   * the same in-flight start promise.
   *
   * Throws on spawn failure (network down, npx missing, etc.). The
   * caller (bootstrap state machine) is responsible for mapping the
   * throw into user-facing UX.
   */
  async start(): Promise<void> {
    if (this.client) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.onProgress('Starting Computer Use...');

    // After ~3s, surface a hint that the slow path is download.
    const downloadHintTimer = setTimeout(() => {
      this.onProgress(
        'Downloading Computer Use binary (this can take ~60s on first use)...',
      );
    }, 3000);

    try {
      const transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', this.packageSpec, 'mcp'],
        // Inherit env so HTTPS_PROXY etc. flow through to npx
        env: { ...process.env } as Record<string, string>,
      });
      const client = new Client(
        { name: 'qwen-code-computer-use', version: '1.0.0' },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.transport = transport;
      this.client = client;
    } finally {
      clearTimeout(downloadHintTimer);
    }
  }

  /**
   * List the tools exposed by the upstream server. Used by the schema
   * sync script and bootstrap diagnostics.
   */
  async listTools(): Promise<ListToolsResult> {
    if (!this.client) throw new Error('ComputerUseClient not started');
    return this.client.listTools();
  }

  /**
   * Call a tool by upstream name (NOT the qwen-code-facing
   * `computer_use__` prefixed name). Returns the raw MCP result so the
   * caller can inspect `isError` and parse text content.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (!this.client) throw new Error('ComputerUseClient not started');
    return this.client.callTool({
      name,
      arguments: args,
    }) as Promise<CallToolResult>;
  }

  /** Tear down the child process. Safe to call multiple times. */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/core/src/tools/computer-use/client.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/computer-use/client.ts packages/core/src/tools/computer-use/client.test.ts
git commit -m "feat(computer-use): MCP stdio client for upstream binary"
```

---

### Task 5: ComputerUseTool — parameterized BaseDeclarativeTool wrapper

**Files:**

- Create: `packages/core/src/tools/computer-use/tool.ts`
- Create: `packages/core/src/tools/computer-use/tool.test.ts`

For this task, the tool just forwards to `ComputerUseClient` assuming it's already started. The bootstrap state machine wraps this in Phase 3.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/computer-use/tool.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComputerUseTool } from './tool.js';
import { ComputerUseClient } from './client.js';
import { COMPUTER_USE_SCHEMAS } from './schemas.js';

function makeFakeClient(
  callToolImpl: (name: string, args: unknown) => Promise<unknown>,
) {
  const fake = {
    isStarted: () => true,
    start: vi.fn(async () => {}),
    callTool: vi.fn(callToolImpl),
    stop: vi.fn(async () => {}),
  };
  return fake as unknown as ComputerUseClient;
}

describe('ComputerUseTool', () => {
  beforeEach(() => {
    ComputerUseClient.setSharedForTest(undefined);
  });

  it('exposes qwen-facing name with computer_use__ prefix', () => {
    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    expect(tool.name).toBe('computer_use__click');
    expect(tool.displayName).toBe('computer_use__click');
  });

  it('marks itself as deferred', () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    expect(tool.shouldDefer).toBe(true);
    expect(tool.alwaysLoad).toBe(false);
  });

  it('forwards execute() to the shared client with the upstream name', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: '[]' }],
      isError: false,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(fake.callTool).toHaveBeenCalledWith('list_apps', {});
  });

  it('returns an error result when client returns isError=true', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    const invocation = tool.build({ app: 'TextEdit' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('something went wrong');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/core/src/tools/computer-use/tool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the tool**

Create `packages/core/src/tools/computer-use/tool.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from '../tools.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ComputerUseClient } from './client.js';
import type { ComputerUseToolName, ComputerUseToolSchema } from './schemas.js';
import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import { runBootstrap } from './bootstrap.js';

type ComputerUseParams = Record<string, unknown>;

class ComputerUseInvocation extends BaseToolInvocation<
  ComputerUseParams,
  ToolResult
> {
  constructor(
    private readonly upstreamName: ComputerUseToolName,
    params: ComputerUseParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return safeJsonStringify(this.params);
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const client = ComputerUseClient.shared();

    // Phase 3 wires the bootstrap state machine here. Until then, this
    // shells out directly which is fine when the binary is already
    // installed and permissions granted.
    await runBootstrap(client, { signal, updateOutput });

    let mcpResult: CallToolResult;
    try {
      mcpResult = await client.callTool(this.upstreamName, this.params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Computer Use tool '${this.upstreamName}' failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message },
      };
    }

    const text = mcpResult.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n');

    if (mcpResult.isError) {
      return {
        llmContent: text || `Tool '${this.upstreamName}' returned isError=true`,
        returnDisplay: text || 'Error',
        error: { message: text || 'tool returned error' },
      };
    }

    return {
      llmContent: text,
      returnDisplay: text,
    };
  }
}

export class ComputerUseTool extends BaseDeclarativeTool<
  ComputerUseParams,
  ToolResult
> {
  constructor(
    private readonly upstreamName: ComputerUseToolName,
    schema: ComputerUseToolSchema,
  ) {
    const qwenName = `computer_use__${upstreamName}`;
    super(
      qwenName,
      qwenName, // displayName == name; no MCP branding in UI
      schema.description,
      Kind.Other,
      schema.parameterSchema,
      true, // isOutputMarkdown — many results are JSON-ish text or screenshots
      true, // canUpdateOutput — bootstrap streams progress
      true, // shouldDefer — surface only via ToolSearch
      false, // alwaysLoad
      `computer use desktop click type screenshot mouse keyboard scroll drag automation gui app native`,
    );
  }

  protected createInvocation(
    params: ComputerUseParams,
  ): ToolInvocation<ComputerUseParams, ToolResult> {
    return new ComputerUseInvocation(this.upstreamName, params);
  }
}
```

Note: the test references `runBootstrap` which is implemented in Phase 3. For now, create a stub `bootstrap.ts` so the test passes:

Create `packages/core/src/tools/computer-use/bootstrap.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComputerUseClient } from './client.js';

export interface BootstrapContext {
  signal: AbortSignal;
  updateOutput?: (output: string) => void;
}

/**
 * STUB: Phase 3 replaces this with the full state machine
 * (install confirm → install → permission probe → guide → poll).
 * For now: assumes binary is installed and permissions granted;
 * just starts the client if needed.
 */
export async function runBootstrap(
  client: ComputerUseClient,
  _ctx: BootstrapContext,
): Promise<void> {
  if (!client.isStarted()) {
    await client.start();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/core/src/tools/computer-use/tool.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/computer-use/tool.ts packages/core/src/tools/computer-use/tool.test.ts packages/core/src/tools/computer-use/bootstrap.ts
git commit -m "feat(computer-use): ComputerUseTool wrapper + bootstrap stub"
```

---

### Task 6: Register tools in ToolRegistry

**Files:**

- Create: `packages/core/src/tools/computer-use/index.ts`
- Modify: `packages/core/src/config/config.ts`

- [ ] **Step 1: Create the registration helper**

Create `packages/core/src/tools/computer-use/index.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { ComputerUseTool } from './tool.js';
export { ComputerUseClient } from './client.js';
export type { ComputerUseToolName, ComputerUseToolSchema } from './schemas.js';
export { COMPUTER_USE_TOOL_NAMES, COMPUTER_USE_SCHEMAS } from './schemas.js';

import { ComputerUseTool } from './tool.js';
import { COMPUTER_USE_SCHEMAS, COMPUTER_USE_TOOL_NAMES } from './schemas.js';
import type { ToolRegistry } from '../tool-registry.js';

/**
 * Register all 9 computer-use tools as lazy factories on the registry.
 * Each tool is deferred (`shouldDefer=true`), so they surface only via
 * ToolSearch keyword match. The first invocation triggers the
 * bootstrap state machine (install confirm → install → permission flow)
 * before forwarding to the upstream MCP server.
 *
 * Should only be called when `Config.isComputerUseEnabled()` is true.
 */
export function registerComputerUseTools(registry: ToolRegistry): void {
  for (const upstreamName of COMPUTER_USE_TOOL_NAMES) {
    const schema = COMPUTER_USE_SCHEMAS[upstreamName];
    const qwenName = `computer_use__${upstreamName}`;
    registry.registerFactory(
      qwenName,
      async () => new ComputerUseTool(upstreamName, schema),
    );
  }
}
```

- [ ] **Step 2: Wire into Config.createToolRegistry**

Edit `packages/core/src/config/config.ts`. Find the existing block that registers cron tools conditionally (around line 3952):

```ts
    if (this.isCronEnabled()) {
      await registerLazy(ToolNames.CRON_CREATE, async () => { ... });
      ...
    }
```

Directly below the cron block (and before the monitor block), add:

```ts
// Register computer-use tools unless disabled.
// All 9 are deferred — they surface only via ToolSearch keyword
// match (see packages/core/src/tools/computer-use/).
if (this.isComputerUseEnabled()) {
  const { registerComputerUseTools } = await import(
    '../tools/computer-use/index.js'
  );
  registerComputerUseTools(registry);
}
```

- [ ] **Step 3: Add a registration test**

Append to the existing tool-registry tests OR create `packages/core/src/tools/computer-use/registration.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerComputerUseTools } from './index.js';
import { COMPUTER_USE_TOOL_NAMES } from './schemas.js';

describe('registerComputerUseTools', () => {
  it('registers a factory for each of the 9 upstream tools, prefixed with computer_use__', () => {
    const registered = new Set<string>();
    const fakeRegistry = {
      registerFactory: vi.fn((name: string) => {
        registered.add(name);
      }),
    } as never;

    registerComputerUseTools(fakeRegistry);

    expect(registered.size).toBe(9);
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(registered.has(`computer_use__${name}`)).toBe(true);
    }
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

Run:

```bash
npm test -- packages/core/src/tools/computer-use/
npm run build -- --filter @qwen-code/qwen-code-core
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/computer-use/index.ts packages/core/src/tools/computer-use/registration.test.ts packages/core/src/config/config.ts
git commit -m "feat(computer-use): register 9 deferred tools when enabled"
```

---

### Task 7: Manual smoke — tools appear and a happy-path call works

This is a non-coding gate. Verifies the foundation works before piling on the bootstrap UX.

- [ ] **Step 1: Pre-install upstream binary (one-time, manual)**

Run in a terminal:

```bash
npx -y open-computer-use@latest --version
```

On macOS: also run `npx -y open-computer-use@latest doctor` and grant any prompted permissions. This bypasses our bootstrap so we can verify the transport layer in isolation.

- [ ] **Step 2: Build qwen-code**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Launch qwen-code and test discovery**

Start qwen-code, then ask the model: _"Use the ToolSearch tool with query 'click computer use' to find any desktop automation tools available."_

Expected: ToolSearch returns 9 `computer_use__*` schemas.

- [ ] **Step 4: Test a no-permission tool**

Ask: _"List the desktop apps currently running using the computer_use\_\_list_apps tool."_

Expected: First call has a few seconds of "Starting Computer Use..." (or longer if npx cache is cold), then returns a list of running apps. Subsequent calls in the same session are fast.

- [ ] **Step 5: No commit needed; this is a smoke gate**

If anything fails here, STOP and debug before moving to Phase 3.

---

## Phase 3 — Bootstrap UX (install confirm + permission guide)

This phase replaces the `runBootstrap` stub from Task 5 with the full state machine.

### Task 8: Install state persistence

**Files:**

- Create: `packages/core/src/tools/computer-use/install-state.ts`
- Create: `packages/core/src/tools/computer-use/install-state.test.ts`

Persisted at `~/.qwen/computer-use/installed.json`:

```json
{
  "approvedPackageSpec": "open-computer-use@^0.3.0",
  "approvedAtIso": "2026-05-28T10:00:00Z"
}
```

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/computer-use/install-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadInstallState,
  saveInstallState,
  isPackageSpecApproved,
  installStatePathFor,
} from './install-state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('install-state', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'qwen-cu-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns undefined when no state file exists', async () => {
    expect(await loadInstallState(tmpHome)).toBeUndefined();
  });

  it('round-trips state', async () => {
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    const loaded = await loadInstallState(tmpHome);
    expect(loaded).toEqual({
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
  });

  it('isPackageSpecApproved returns false when no state', async () => {
    expect(
      await isPackageSpecApproved(tmpHome, 'open-computer-use@^0.3.0'),
    ).toBe(false);
  });

  it('isPackageSpecApproved returns true on exact match', async () => {
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    expect(
      await isPackageSpecApproved(tmpHome, 'open-computer-use@^0.3.0'),
    ).toBe(true);
  });

  it('isPackageSpecApproved returns false when version differs', async () => {
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    expect(
      await isPackageSpecApproved(tmpHome, 'open-computer-use@^0.4.0'),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/core/src/tools/computer-use/install-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the module**

Create `packages/core/src/tools/computer-use/install-state.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface InstallState {
  /** The package spec the user approved (e.g. "open-computer-use@^0.3.0"). */
  approvedPackageSpec: string;
  /** ISO 8601 UTC timestamp of approval. */
  approvedAtIso: string;
}

/**
 * Path to the install-state file. Exported for tests so they can
 * point at a temp directory.
 */
export function installStatePathFor(home: string = homedir()): string {
  return join(home, '.qwen', 'computer-use', 'installed.json');
}

export async function loadInstallState(
  home: string = homedir(),
): Promise<InstallState | undefined> {
  try {
    const text = await readFile(installStatePathFor(home), 'utf8');
    const parsed = JSON.parse(text) as InstallState;
    // Minimal shape check — older or malformed files act as "not approved".
    if (typeof parsed?.approvedPackageSpec !== 'string') return undefined;
    if (typeof parsed?.approvedAtIso !== 'string') return undefined;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    // Treat unreadable / malformed state as "not approved" — re-prompt
    // is safe; treating a bad file as approved would silently install.
    return undefined;
  }
}

export async function saveInstallState(
  home: string = homedir(),
  state: InstallState,
): Promise<void> {
  const path = installStatePathFor(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * True iff the persisted state's package spec exactly matches the one
 * we're about to install. Different specs (version pin bumps) require
 * re-approval, since the user may have approved an older / smaller /
 * different-license version.
 */
export async function isPackageSpecApproved(
  home: string = homedir(),
  packageSpec: string,
): Promise<boolean> {
  const state = await loadInstallState(home);
  return state?.approvedPackageSpec === packageSpec;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/core/src/tools/computer-use/install-state.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/computer-use/install-state.ts packages/core/src/tools/computer-use/install-state.test.ts
git commit -m "feat(computer-use): persist install approval state under ~/.qwen"
```

---

### Task 9: Permission error detector

**Files:**

- Create: `packages/core/src/tools/computer-use/permission-detector.ts`
- Create: `packages/core/src/tools/computer-use/permission-detector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/computer-use/permission-detector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectPermissionError } from './permission-detector.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function textErrorResult(text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

describe('detectPermissionError', () => {
  it('returns "none" when isError is false', () => {
    expect(
      detectPermissionError({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    ).toBe('none');
  });

  it('detects accessibility permission missing (upstream phrasing)', () => {
    // From AccessibilitySnapshot.swift:104
    const result = textErrorResult(
      'Accessibility permission is required. Run `open-computer-use doctor` and grant access to Open Computer Use.',
    );
    expect(detectPermissionError(result)).toBe('accessibility');
  });

  it('detects screen recording permission missing', () => {
    const result = textErrorResult(
      'Screen Recording permission is required to capture this window.',
    );
    expect(detectPermissionError(result)).toBe('screenRecording');
  });

  it('detects via the generic doctor marker as fallback', () => {
    const result = textErrorResult(
      'Some unfamiliar error. Run `open-computer-use doctor` for help.',
    );
    expect(detectPermissionError(result)).toBe('unknown_permission');
  });

  it('returns "other" for unrelated errors', () => {
    expect(
      detectPermissionError(textErrorResult('appNotFound("ImaginaryApp")')),
    ).toBe('other');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/core/src/tools/computer-use/permission-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the detector**

Create `packages/core/src/tools/computer-use/permission-detector.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * What kind of permission issue, if any, the upstream MCP result
 * indicates. We classify based on message strings because upstream
 * doesn't expose typed error codes through MCP (see
 * `packages/OpenComputerUseKit/Sources/OpenComputerUseKit/Errors.swift`
 * in the open-codex-computer-use repo).
 *
 * Long-term fix is to PR upstream for a typed errorKind; for now this
 * string detection is the contract.
 */
export type PermissionErrorKind =
  | 'none' // success, or non-error result
  | 'other' // error, but not a permission issue
  | 'accessibility' // AX missing
  | 'screenRecording' // Screen Recording missing
  | 'unknown_permission'; // matches the doctor marker but doesn't pinpoint which

/**
 * Upstream-known error patterns. Order matters — more specific
 * patterns first.
 */
const PATTERNS: Array<{ kind: PermissionErrorKind; regex: RegExp }> = [
  { kind: 'accessibility', regex: /accessibility permission is required/i },
  { kind: 'screenRecording', regex: /screen recording permission/i },
  // Fallback: any error mentioning the doctor command is likely permission-related.
  // Listed last so it doesn't preempt the specific patterns.
  { kind: 'unknown_permission', regex: /open-computer-use\s+doctor/i },
];

export function detectPermissionError(
  result: CallToolResult,
): PermissionErrorKind {
  if (!result.isError) return 'none';
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
  for (const { kind, regex } of PATTERNS) {
    if (regex.test(text)) return kind;
  }
  return 'other';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/core/src/tools/computer-use/permission-detector.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/computer-use/permission-detector.ts packages/core/src/tools/computer-use/permission-detector.test.ts
git commit -m "feat(computer-use): detect upstream permission errors"
```

---

### Task 10: Bootstrap state machine — full UX flow

**Files:**

- Modify: `packages/core/src/tools/computer-use/bootstrap.ts` (replace stub from Task 5)
- Create: `packages/core/src/tools/computer-use/bootstrap.test.ts`

The state machine has three sub-flows:

1. **First-time install**: if `isPackageSpecApproved` is false, prompt the user, install, persist approval.
2. **Spawn**: ensure the client is started.
3. **Permission probe + guide** (macOS only): if a permission error surfaces, spawn `open-computer-use doctor`, poll for grant up to 10 min, retry.

Note: the actual "ask user a question mid-execution" mechanic in qwen-code uses the existing tool-confirmation framework. **IMPLEMENTER**: before writing this task's implementation, grep for `shouldConfirmExecute` in `packages/core/src/tools/` to see how `shell.ts` / similar do confirmation. This task assumes that mechanic is available; if it isn't, swap in `process.stderr.write` + read from `process.stdin` for the install confirm (acceptable v0 UX).

- [ ] **Step 1: Investigate confirmation patterns**

Run:

```bash
grep -rn "shouldConfirmExecute\|ToolConfirmation" packages/core/src/tools --include="*.ts" | grep -v ".test." | head -20
```

Read at least one tool that uses the confirmation pattern (likely `shell.ts`). Decide: does `ToolInvocation` have a `shouldConfirmExecute()` method or similar?

If YES: use it for the install confirm.
If NO: use the v0 fallback (stderr + `ask_user_question` tool if exposed, else throw a specific error code the model can re-issue after user grant).

Document your choice in a code comment at the top of `bootstrap.ts`.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/tools/computer-use/bootstrap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBootstrap, type BootstrapDeps } from './bootstrap.js';

function makeFakeClient(opts: { startThrows?: Error } = {}) {
  const start = vi.fn(async () => {
    if (opts.startThrows) throw opts.startThrows;
  });
  return {
    isStarted: vi.fn(() => start.mock.calls.length > 0),
    start,
    callTool: vi.fn(),
    stop: vi.fn(),
  };
}

describe('runBootstrap', () => {
  let tmpHome: string;
  let deps: BootstrapDeps;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'qwen-cu-bs-'));
    deps = {
      homeDir: tmpHome,
      packageSpec: 'open-computer-use@^0.3.0',
      platform: 'darwin',
      promptInstallApproval: vi.fn(async () => true),
      spawnDoctor: vi.fn(),
      probePermissions: vi.fn(async () => 'ok' as const),
    };
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('starts the client when binary is approved + permissions ok', async () => {
    // Pre-seed install state to skip the prompt
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(client.start).toHaveBeenCalledOnce();
    expect(deps.promptInstallApproval).not.toHaveBeenCalled();
  });

  it('prompts for install approval on first call', async () => {
    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(deps.promptInstallApproval).toHaveBeenCalledOnce();
    expect(client.start).toHaveBeenCalledOnce();
  });

  it('throws when user declines install', async () => {
    deps.promptInstallApproval = vi.fn(async () => false);
    const client = makeFakeClient();

    await expect(
      runBootstrap(
        client as never,
        { signal: new AbortController().signal },
        deps,
      ),
    ).rejects.toThrow(/declined/i);
    expect(client.start).not.toHaveBeenCalled();
  });

  it('persists approval on success', async () => {
    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    const { loadInstallState } = await import('./install-state.js');
    const state = await loadInstallState(tmpHome);
    expect(state?.approvedPackageSpec).toBe('open-computer-use@^0.3.0');
  });

  it('spawns doctor and polls when permissions are missing', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    let probeCount = 0;
    deps.probePermissions = vi.fn(async () => {
      probeCount++;
      return probeCount < 3 ? 'accessibility' : 'ok';
    });
    deps.pollIntervalMs = 1; // speed up test
    deps.pollTimeoutMs = 1000;

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(deps.spawnDoctor).toHaveBeenCalledOnce();
    expect(probeCount).toBeGreaterThanOrEqual(3);
  });

  it('throws after pollTimeoutMs when permissions never grant', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    deps.probePermissions = vi.fn(async () => 'accessibility' as const);
    deps.pollIntervalMs = 1;
    deps.pollTimeoutMs = 50;

    const client = makeFakeClient();
    await expect(
      runBootstrap(
        client as never,
        { signal: new AbortController().signal },
        deps,
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it('skips permission flow on non-darwin platforms', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    deps.platform = 'linux';

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(deps.spawnDoctor).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- packages/core/src/tools/computer-use/bootstrap.test.ts`
Expected: FAIL — many errors

- [ ] **Step 4: Implement the state machine**

Replace `packages/core/src/tools/computer-use/bootstrap.ts` with:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Computer Use bootstrap state machine.
 *
 * On first invocation of any computer_use__* tool:
 *   1. If not yet approved: prompt the user to install (one-time).
 *   2. Start the client (lazy npx spawn, may take ~60s first time).
 *   3. On macOS only: probe permissions by calling get_app_state on
 *      Finder. If a permission error surfaces, spawn the upstream
 *      doctor (which opens the system settings + onboarding window),
 *      then poll until permissions grant or 10 min timeout.
 *
 * IMPLEMENTER: pre-step 1 (Task 10 step 1) — verify whether
 * qwen-code's BaseDeclarativeTool exposes a `shouldConfirmExecute()`
 * pathway from inside `execute()`. If not, `promptInstallApproval`
 * defaults to a `process.stderr.write` + readline fallback. The
 * dependency-injection design here keeps that decision swappable
 * without touching the state machine logic.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { ComputerUseClient } from './client.js';
import { isPackageSpecApproved, saveInstallState } from './install-state.js';
import {
  detectPermissionError,
  type PermissionErrorKind,
} from './permission-detector.js';

export interface BootstrapContext {
  signal: AbortSignal;
  updateOutput?: (output: string) => void;
}

/** Result of a permission probe. */
export type PermissionProbeResult = 'ok' | PermissionErrorKind;

export interface BootstrapDeps {
  homeDir: string;
  packageSpec: string;
  platform: NodeJS.Platform;
  /**
   * Prompt the user to approve installing the upstream binary. Returns
   * true if approved. Implementation may use the qwen-code confirm
   * tool path or a stdin fallback.
   */
  promptInstallApproval: (packageSpec: string) => Promise<boolean>;
  /**
   * Spawn `open-computer-use doctor` (detached). The binary handles
   * opening the system settings window itself.
   */
  spawnDoctor: () => void;
  /**
   * Probe the upstream MCP server for permission state by issuing a
   * lightweight tool call. Returns 'ok' on success or the kind of
   * permission error on failure.
   */
  probePermissions: (
    client: ComputerUseClient,
  ) => Promise<PermissionProbeResult>;
  /** Poll interval for the permission watcher. Default 2000ms. */
  pollIntervalMs?: number;
  /** Total poll timeout. Default 10 min. */
  pollTimeoutMs?: number;
}

/** Production defaults — instantiated lazily so tests can override per call. */
function defaultDeps(): BootstrapDeps {
  return {
    homeDir: homedir(),
    packageSpec:
      process.env['QWEN_COMPUTER_USE_PACKAGE'] ?? 'open-computer-use@latest',
    platform: process.platform,
    promptInstallApproval: async (spec) => {
      // v0 fallback: stderr prompt + stdin read. Replace with
      // qwen-code's standard confirm pathway when wired in.
      process.stderr.write(
        `\n[Computer Use] First-time install\n` +
          `  Package: ${spec}\n` +
          `  This will fetch ~50MB from the npm registry the first time.\n` +
          `  Computer Use can click, type, and read your desktop apps.\n` +
          `  On macOS you'll be guided through Accessibility and Screen Recording permissions next.\n` +
          `Proceed? [y/N] `,
      );
      // IMPLEMENTER: in real interactive sessions, replace with the
      // qwen-code confirm system. For headless / SDK contexts the
      // default is to refuse — explicit user opt-in required.
      return process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'] === '1';
    },
    spawnDoctor: () => {
      const child = spawn('npx', ['-y', defaultDeps().packageSpec, 'doctor'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    },
    probePermissions: async (client) => {
      // Use Finder as a known-running, always-installed macOS app.
      // get_app_state hits AccessibilitySnapshot which is the first
      // path that throws permissionDenied.
      const result = await client.callTool('get_app_state', { app: 'Finder' });
      return detectPermissionError(result) === 'none'
        ? 'ok'
        : detectPermissionError(result);
    },
  };
}

export async function runBootstrap(
  client: ComputerUseClient,
  ctx: BootstrapContext,
  depsOverride?: Partial<BootstrapDeps>,
): Promise<void> {
  const deps: BootstrapDeps = { ...defaultDeps(), ...depsOverride };
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 10 * 60_000;

  // Step 1: install approval gate.
  const approved = await isPackageSpecApproved(deps.homeDir, deps.packageSpec);
  if (!approved) {
    ctx.updateOutput?.('Computer Use needs to be installed (first use).');
    const ok = await deps.promptInstallApproval(deps.packageSpec);
    if (!ok) {
      throw new Error(
        `Computer Use install declined by user. Re-invoke the tool to be prompted again.`,
      );
    }
    await saveInstallState(deps.homeDir, {
      approvedPackageSpec: deps.packageSpec,
      approvedAtIso: new Date().toISOString(),
    });
  }

  // Step 2: spawn (idempotent).
  if (!client.isStarted()) {
    ctx.updateOutput?.('Starting Computer Use...');
    await client.start();
  }

  // Step 3: macOS permission probe + guide.
  if (deps.platform !== 'darwin') return;

  const probe = await deps.probePermissions(client);
  if (probe === 'ok' || probe === 'other') {
    // 'other' means an error happened that isn't permission-related.
    // We don't block bootstrap on that — let the actual tool call surface it.
    return;
  }

  ctx.updateOutput?.(
    `Computer Use needs macOS permissions (${probe}). ` +
      `An onboarding window will open — please grant Accessibility and Screen Recording, then this will continue automatically.`,
  );
  deps.spawnDoctor();

  const startedAt = Date.now();
  for (;;) {
    if (ctx.signal.aborted) {
      throw new Error('Computer Use bootstrap aborted.');
    }
    if (Date.now() - startedAt > pollTimeoutMs) {
      throw new Error(
        `Computer Use permission grant timed out after ${Math.round(pollTimeoutMs / 1000)}s. Re-invoke the tool to retry.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const next = await deps.probePermissions(client);
    if (next === 'ok' || next === 'other') return;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    ctx.updateOutput?.(`Waiting for permissions... (${elapsedSec}s)`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- packages/core/src/tools/computer-use/bootstrap.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/computer-use/bootstrap.ts packages/core/src/tools/computer-use/bootstrap.test.ts
git commit -m "feat(computer-use): bootstrap state machine (install + permissions)"
```

---

### Task 11: Wire the real `promptInstallApproval` to qwen-code's confirm system

**Files:**

- Modify: `packages/core/src/tools/computer-use/bootstrap.ts`
- Possibly: `packages/core/src/tools/computer-use/tool.ts`

This is the task with the most variable scope. **IMPLEMENTER**: read the investigation result from Task 10 step 1 and wire accordingly. Two scenarios:

**Scenario A** — `BaseToolInvocation` supports `shouldConfirmExecute()`:

- Override `shouldConfirmExecute()` in `ComputerUseInvocation` to return the install-confirm payload when the package isn't yet approved.
- The framework will surface the confirm UI; on approval, `execute()` proceeds.
- `bootstrap.ts` then only handles the post-confirm path (write state, start, permission probe).

**Scenario B** — no in-execute confirm pathway:

- Keep the stderr+stdin v0 from Task 10. Document loudly in the README and SKILL.md.
- File a follow-up task to add a proper confirm pathway (separate PR).

- [ ] **Step 1: Implement chosen scenario**

(Concrete code depends on the investigation; defer detail to implementer.)

- [ ] **Step 2: Manual smoke**

Wipe install state:

```bash
rm -rf ~/.qwen/computer-use
```

Launch qwen-code and ask a computer-use question. Confirm the install prompt appears in the chosen UX (confirm dialog or stderr) and that approving it persists state correctly.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(computer-use): wire install approval to qwen-code confirm UX"
```

---

### Task 12: Manual smoke — end-to-end first-time flow

This is a non-coding gate.

- [ ] **Step 1: Clear caches**

```bash
rm -rf ~/.qwen/computer-use
rm -rf ~/.npm/_npx
# macOS: revoke permissions
# System Settings → Privacy & Security → Accessibility / Screen Recording
# remove "Open Computer Use.app"
```

- [ ] **Step 2: Build + run**

```bash
npm run build
# launch qwen-code, ask a computer-use question
```

- [ ] **Step 3: Verify the full flow**

Expected sequence:

1. Install prompt appears.
2. After approval, download progress streams via `updateOutput`.
3. Permission warning appears, doctor window opens.
4. After granting permissions in System Settings, the tool call resumes automatically.
5. Result returns.

If any step fails, capture the error and stop. Iterate.

- [ ] **Step 4: No commit; this is a gate**

---

## Phase 4 — Tooling / Maintenance

### Task 13: Schema sync script

**Files:**

- Create: `scripts/sync-computer-use-schemas.ts`

Runs as part of qwen-code release prep. Spawns `npx -y open-computer-use@<pin> mcp`, sends `tools/list`, regenerates `schemas.ts`.

- [ ] **Step 1: Create the script**

Create `scripts/sync-computer-use-schemas.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Regenerate packages/core/src/tools/computer-use/schemas.ts from a
 * live upstream open-computer-use MCP server.
 *
 * Usage:
 *   npx tsx scripts/sync-computer-use-schemas.ts [packageSpec]
 *
 * Defaults packageSpec to `open-computer-use@latest`. The pin written
 * into the generated file is whatever spec was used — pass an explicit
 * pin (e.g. `open-computer-use@0.3.5`) for release builds.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const packageSpec = process.argv[2] ?? 'open-computer-use@latest';

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', packageSpec, 'mcp'],
  });
  const client = new Client(
    { name: 'qwen-code-schema-sync', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const result = await client.listTools();
  await client.close();

  if (result.tools.length !== 9) {
    process.stderr.write(
      `WARNING: upstream returned ${result.tools.length} tools, expected 9. Continuing anyway.\n`,
    );
  }

  const schemas: Record<
    string,
    { description: string; parameterSchema: unknown }
  > = {};
  for (const tool of result.tools) {
    schemas[tool.name] = {
      description: tool.description ?? '',
      parameterSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    };
  }

  const out = `/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardcoded schemas for the upstream open-computer-use tools.
 *
 * Pinned to upstream: ${packageSpec}
 * Regenerated by scripts/sync-computer-use-schemas.ts — do not hand-edit.
 */

export interface ComputerUseToolSchema {
  description: string;
  parameterSchema: Record<string, unknown>;
}

export const COMPUTER_USE_TOOL_NAMES = ${JSON.stringify(
    result.tools.map((t) => t.name),
    null,
    2,
  )} as const;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];

export const COMPUTER_USE_SCHEMAS: Record<ComputerUseToolName, ComputerUseToolSchema> = ${JSON.stringify(
    schemas,
    null,
    2,
  )};
`;

  const target = resolve('packages/core/src/tools/computer-use/schemas.ts');
  await writeFile(target, out, 'utf8');
  process.stdout.write(`Wrote ${result.tools.length} schemas to ${target}\n`);
}

main().catch((err) => {
  process.stderr.write(`Schema sync failed: ${err}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run it once manually to verify**

```bash
npx tsx scripts/sync-computer-use-schemas.ts open-computer-use@latest
```

Expected: schemas.ts is rewritten; `npm test -- packages/core/src/tools/computer-use/schemas.test.ts` still passes (or fails only on tests that asserted specific hand-written content — adjust those tests if upstream descriptions changed).

- [ ] **Step 3: Commit**

```bash
git add scripts/sync-computer-use-schemas.ts packages/core/src/tools/computer-use/schemas.ts
git commit -m "chore(computer-use): script to sync schemas from upstream"
```

---

## Self-Review Checklist (after writing all tasks)

- [ ] Every step has either: a code block, an exact command, or a clearly-deferrable IMPLEMENTER note with rationale.
- [ ] All 9 tool names use the `computer_use__` prefix consistently across schemas, tool wrapper, and registration.
- [ ] No reference to MCP / mcp\_\_/ DiscoveredMCPTool leaks into user-facing strings.
- [ ] Bootstrap state machine has explicit timeouts (no infinite polls).
- [ ] `enableComputerUse` defaults to `true` per the user's decision.
- [ ] Tests cover: schema integrity, name prefixing, deferral, client lifecycle, install state persistence, permission detection, all bootstrap state transitions.
- [ ] Manual smoke gates (Task 7, Task 12) are explicit — no silent claims of "it works".

---

## Out of Scope (deferred to follow-up PRs)

- Idle timeout for the MCP server process (resource savings; v0 keeps it alive until qwen-code exits).
- Telemetry on bootstrap failures (network failure vs gatekeeper vs permission timeout breakdowns).
- Offline install path / cached tarball support.
- Capability probe before reveal (currently failure surfaces at first-call time).
- Upstream PR for typed errorKind on permissionDenied (user deferred).
- Restart MCP server after permission grant (user wants real-world test first to decide if needed).
- Per-tool granular permission gating (e.g. allow read-only `list_apps` / `get_app_state` without confirming every call).

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-28-computer-use-built-in.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
