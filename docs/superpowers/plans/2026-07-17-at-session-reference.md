# `@` Session Reference + Tabbed Completion UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user reference a prior chat session via `@`, injecting a deterministically-slimmed copy of its history as read-only context, and redesign the `@` completion dropdown into a tab-switched layout.

**Architecture:** Backend is a pure, unit-testable core service (`SessionReferenceService`) plus a ref parser (`sessionMentionRef`); it loads a session via the existing `SessionService`, slims records to user/assistant text + one-line tool summaries, and tail-trims to a fixed token budget. `atCommandProcessor` gains a `@session:` routing branch that injects the slimmed block as a scoped-mention part. Frontend adds a `category` field to `Suggestion`, a session-suggestion producer in `useAtCompletion`, and a tab bar in `SuggestionsDisplay` driven by a new tab-switch keybinding.

**Tech Stack:** TypeScript, React + Ink (TUI), Vitest, existing qwen-code `SessionService` / `atCommandProcessor` / completion hooks.

## Global Constraints

- Referenceable scope: **current project only** — rely on `SessionService.loadSession` / `listSessions`, which already enforce `sessionBelongsToCurrentProject`. Never scan other projects' chat dirs.
- Slimming is **deterministic, no LLM/model call**. Do not import `runSideQuery` or `ChatCompressionService`.
- Slimming keeps **user + assistant visible text** and a **one-line summary per tool call** (`[tool: <name> — <status>]`); never include tool result bodies.
- Injected size cap: **fixed token budget with tail-retention** — drop oldest turns first, prepend `[earlier turns omitted]`, set `truncated: true`.
- Unresolved / not-found / cross-project refs: **fall back to literal text with a surfaced note**, never silently drop.
- No AI-authorship trailers in any commit message (`QwenLM/qwen-code` house rule).
- Follow existing patterns: mirror `extension-mention-ref.ts` for the ref parser and producer; mirror `StatsDialog.tsx` tab trio for the tab UI.
- Commit style: Conventional Commits (`feat:`, `test:`, `refactor:`).

---

### Task 1: `sessionMentionRef` — parse/build/validate `@session:` refs

**Files:**

- Create: `packages/cli/src/ui/hooks/sessionMentionRef.ts`
- Test: `packages/cli/src/ui/hooks/sessionMentionRef.test.ts`

**Interfaces:**

- Consumes: nothing (pure string module).
- Produces:
  - `const SESSION_MENTION_PREFIX = 'session:'`
  - `interface SessionRef { id?: string; title?: string }`
  - `function parseSessionRef(pathName: string): SessionRef | null` — returns `null` when `pathName` does not start with `session:`; otherwise `{ id }` if the remainder is a valid UUID, else `{ title }`.
  - `function buildSessionRef(idOrTitle: string): string` — returns `@session:<idOrTitle>` (no leading `@`? see below).
  - `function isSessionId(value: string): boolean` — UUID v4 shape check.

Note on `@`: mirror `extension-mention-ref.ts` — `buildExtensionRef` returns the value WITHOUT leading `@` (the `@` is already in the buffer). Match that: `buildSessionRef('abc')` → `'session:abc'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/ui/hooks/sessionMentionRef.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseSessionRef,
  buildSessionRef,
  isSessionId,
  SESSION_MENTION_PREFIX,
} from './sessionMentionRef.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('sessionMentionRef', () => {
  it('returns null for non-session tokens', () => {
    expect(parseSessionRef('file.txt')).toBeNull();
    expect(parseSessionRef('ext:foo')).toBeNull();
  });

  it('parses a UUID remainder as an id', () => {
    expect(parseSessionRef(`${SESSION_MENTION_PREFIX}${UUID}`)).toEqual({
      id: UUID,
    });
  });

  it('parses a non-UUID remainder as a title', () => {
    expect(parseSessionRef('session:Fix auth bug')).toEqual({
      title: 'Fix auth bug',
    });
  });

  it('treats an empty remainder as null (lone prefix)', () => {
    expect(parseSessionRef('session:')).toBeNull();
  });

  it('builds a ref without a leading @', () => {
    expect(buildSessionRef(UUID)).toBe(`session:${UUID}`);
  });

  it('recognizes UUIDs', () => {
    expect(isSessionId(UUID)).toBe(true);
    expect(isSessionId('not-a-uuid')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/ui/hooks/sessionMentionRef.test.ts`
Expected: FAIL — `Cannot find module './sessionMentionRef.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/ui/hooks/sessionMentionRef.ts
export const SESSION_MENTION_PREFIX = 'session:';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionRef {
  id?: string;
  title?: string;
}

export function isSessionId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function parseSessionRef(pathName: string): SessionRef | null {
  if (!pathName.startsWith(SESSION_MENTION_PREFIX)) return null;
  const remainder = pathName.slice(SESSION_MENTION_PREFIX.length).trim();
  if (remainder.length === 0) return null;
  return isSessionId(remainder) ? { id: remainder } : { title: remainder };
}

export function buildSessionRef(idOrTitle: string): string {
  return `${SESSION_MENTION_PREFIX}${idOrTitle}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/ui/hooks/sessionMentionRef.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/hooks/sessionMentionRef.ts packages/cli/src/ui/hooks/sessionMentionRef.test.ts
git commit -m "feat(cli): add @session: mention ref parser"
```

---

### Task 2: `SessionReferenceService` — load + slim + budget-trim

**Files:**

- Create: `packages/core/src/services/sessionReferenceService.ts`
- Test: `packages/core/src/services/sessionReferenceService.test.ts`
- Modify (export barrel): `packages/core/src/index.ts` (add `export * from './services/sessionReferenceService.js';` alongside existing service exports)

**Interfaces:**

- Consumes: `SessionService.loadSession(id): Promise<ResumedSessionData | undefined>` (existing); `ResumedSessionData.conversation.messages: ChatRecord[]`; `ChatRecord` fields `type`, `message?: Content`, `toolCallResult?`; `estimateContentTokens(contents: Content[]): number` from `./tokenEstimation.js`.
- Produces:
  - `const SESSION_REF_TOKEN_BUDGET = 8000`
  - `interface SlimmedSessionReference { text: string; meta: { sessionId: string; title: string; messageCount: number; approxTokens: number }; truncated: boolean }`
  - `class SessionReferenceService { constructor(cwd: string); resolve(ref: { id?: string; title?: string }, opts?: { budgetTokens?: number }): Promise<SlimmedSessionReference | { notFound: true } | { ambiguous: true; count: number }> }`

Design notes for the implementer:

- Do NOT reuse `filterToDialog` (it is private in `sessionTitle.ts` AND drops tool calls, which we need to summarize). Walk `messages` directly.
- Per record: `type === 'user'` → collect text parts prefixed `User: `; `type === 'assistant'` → collect text parts prefixed `Assistant: ` (skip `thought` parts); records that are tool calls (record has `toolCallResult`, or `message.parts` contains a `functionCall`/`functionResponse`) → emit one line `[tool: <displayName || name> — <status || 'ok'>]`. Ignore `system` records.
- Title resolution for the `{ title }` case is done by the CALLER (atCommandProcessor) via `SessionService.findSessionsByTitle` before calling `resolve`; `resolve` itself takes an `{ id }`. Keep `resolve` id-only to stay pure/testable. (Update the Produces signature accordingly: `resolve(id: string, opts?)`.) The ambiguous/not-found title handling lives in Task 3.
- Budget trim: build an array of per-turn strings, estimate tokens of the joined text via `estimateContentTokens([{ role: 'user', parts: [{ text }] }])`; while over budget, drop the OLDEST line and re-check; if any dropped, prepend `[earlier turns omitted]\n` and set `truncated: true`.

Revised Produces (authoritative):

```ts
resolve(sessionId: string, opts?: { budgetTokens?: number }):
  Promise<SlimmedSessionReference | { notFound: true }>
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/services/sessionReferenceService.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SessionReferenceService } from './sessionReferenceService.js';
import type { ResumedSessionData } from './sessionService.js';

function fakeResumed(messages: unknown[]): ResumedSessionData {
  return {
    conversation: {
      sessionId: 's1',
      projectHash: 'h',
      startTime: '',
      lastUpdated: '',
      messages: messages as never,
    },
    filePath: '/tmp/s1.jsonl',
    lastCompletedUuid: null,
  } as ResumedSessionData;
}

function makeSvc(resumed: ResumedSessionData | undefined) {
  const svc = new SessionReferenceService('/proj');
  // Inject a stub SessionService.loadSession
  (svc as unknown as { loadSession: () => Promise<unknown> }).loadSession = vi
    .fn()
    .mockResolvedValue(resumed);
  return svc;
}

describe('SessionReferenceService', () => {
  it('returns notFound when session is missing', async () => {
    const svc = makeSvc(undefined);
    expect(await svc.resolve('missing')).toEqual({ notFound: true });
  });

  it('keeps user + assistant text and drops thoughts', async () => {
    const svc = makeSvc(
      fakeResumed([
        { type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } },
        {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [{ thought: true, text: 'reason' }, { text: 'hello' }],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.text).toContain('User: hi');
    expect(res.text).toContain('Assistant: hello');
    expect(res.text).not.toContain('reason');
  });

  it('collapses tool calls to one-line summaries without result bodies', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'tool_result',
          toolCallResult: { displayName: 'Read File', status: 'success' },
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: { name: 'read', response: { huge: 'BODY' } },
              },
            ],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.text).toContain('[tool: Read File — success]');
    expect(res.text).not.toContain('BODY');
  });

  it('tail-trims to budget and marks truncated', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      type: 'user',
      message: {
        role: 'user',
        parts: [{ text: `turn ${i} ` + 'x'.repeat(400) }],
      },
    }));
    const svc = makeSvc(fakeResumed(many));
    const res = await svc.resolve('s1', { budgetTokens: 200 });
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('[earlier turns omitted]');
    expect(res.text).toContain('turn 49'); // newest retained
    expect(res.text).not.toContain('turn 0'); // oldest dropped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/services/sessionReferenceService.test.ts`
Expected: FAIL — `Cannot find module './sessionReferenceService.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/services/sessionReferenceService.ts
import type { Content, Part } from '@google/genai';
import { SessionService } from './sessionService.js';
import type { ChatRecord } from './chatRecordingService.js';
import { estimateContentTokens } from './tokenEstimation.js';

export const SESSION_REF_TOKEN_BUDGET = 8000;

export interface SlimmedSessionReference {
  text: string;
  meta: {
    sessionId: string;
    title: string;
    messageCount: number;
    approxTokens: number;
  };
  truncated: boolean;
}

export class SessionReferenceService {
  private readonly sessionService: SessionService;
  constructor(private readonly cwd: string) {
    this.sessionService = new SessionService(cwd);
  }

  // Indirection kept as an instance method so tests can stub it.
  protected loadSession(sessionId: string) {
    return this.sessionService.loadSession(sessionId);
  }

  async resolve(
    sessionId: string,
    opts: { budgetTokens?: number } = {},
  ): Promise<SlimmedSessionReference | { notFound: true }> {
    const resumed = await this.loadSession(sessionId);
    if (!resumed) return { notFound: true };

    const records = resumed.conversation.messages ?? [];
    const lines = this.recordsToLines(records);
    const budget = opts.budgetTokens ?? SESSION_REF_TOKEN_BUDGET;

    let kept = [...lines];
    let truncated = false;
    while (kept.length > 0 && this.estimate(kept) > budget) {
      kept.shift(); // drop oldest first (tail-retention)
      truncated = true;
    }
    const body =
      (truncated ? '[earlier turns omitted]\n' : '') + kept.join('\n');
    const title =
      resumed.conversation.messages.length > 0
        ? sessionId // caller supplies a friendlier title in Task 3; id fallback here
        : sessionId;
    const text =
      body.trim().length === 0
        ? `--- Referenced session "${title}" (slimmed, read-only) ---\n(no textual content)`
        : `--- Referenced session "${title}" (slimmed, read-only) ---\n${body}`;

    return {
      text,
      meta: {
        sessionId,
        title,
        messageCount: records.length,
        approxTokens: this.estimate(kept),
      },
      truncated,
    };
  }

  private estimate(lines: string[]): number {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: lines.join('\n') }] },
    ];
    return estimateContentTokens(contents);
  }

  private recordsToLines(records: ChatRecord[]): string[] {
    const out: string[] = [];
    for (const rec of records) {
      if (rec.toolCallResult || this.hasFunctionPart(rec.message)) {
        const name =
          rec.toolCallResult?.displayName ??
          this.functionName(rec.message) ??
          'tool';
        const status = rec.toolCallResult?.status ?? 'ok';
        out.push(`[tool: ${name} — ${status}]`);
        continue;
      }
      if (rec.type === 'user') {
        const text = this.visibleText(rec.message);
        if (text) out.push(`User: ${text}`);
      } else if (rec.type === 'assistant') {
        const text = this.visibleText(rec.message);
        if (text) out.push(`Assistant: ${text}`);
      }
      // system records ignored
    }
    return out;
  }
  // NOTE: The shipped implementation (session-reference-service.ts) uses a
  // two-pass approach instead — emit visible text first (user/assistant),
  // then tool summaries from functionResponse parts in a separate pass.
  // The `continue` above would silently drop assistant reasoning on turns
  // that also call a tool; do NOT copy this version verbatim.

  private visibleText(message?: Content): string {
    if (!message?.parts) return '';
    return message.parts
      .filter((p: Part) => !(p as { thought?: boolean }).thought && p.text)
      .map((p: Part) => p.text)
      .join('')
      .trim();
  }

  private hasFunctionPart(message?: Content): boolean {
    return (
      message?.parts?.some(
        (p: Part) =>
          (p as { functionCall?: unknown }).functionCall ||
          (p as { functionResponse?: unknown }).functionResponse,
      ) ?? false
    );
  }

  private functionName(message?: Content): string | undefined {
    const p = message?.parts?.find(
      (x: Part) =>
        (x as { functionCall?: { name?: string } }).functionCall ||
        (x as { functionResponse?: { name?: string } }).functionResponse,
    );
    return (
      (p as { functionCall?: { name?: string } })?.functionCall?.name ??
      (p as { functionResponse?: { name?: string } })?.functionResponse?.name
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/services/sessionReferenceService.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add barrel export + typecheck**

Add to `packages/core/src/index.ts` (near other `./services/*` exports):

```ts
export * from './services/sessionReferenceService.js';
```

Run: `npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: no errors in the new file.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/sessionReferenceService.ts packages/core/src/services/sessionReferenceService.test.ts packages/core/src/index.ts
git commit -m "feat(core): add SessionReferenceService for slimmed session injection"
```

---

### Task 3: Route `@session:` through `atCommandProcessor` and inject

**Files:**

- Modify: `packages/cli/src/ui/hooks/atCommandProcessor.ts` (add routing branch after the MCP-server branch near line 281, before the filesystem containment check near line 320; inject into `scopedMentionParts` assembled near line 611)
- Test: `packages/cli/src/ui/hooks/atCommandProcessor.session.test.ts`

**Interfaces:**

- Consumes: `parseSessionRef`, `SESSION_MENTION_PREFIX` (Task 1); `SessionReferenceService` (Task 2); existing `SessionService.findSessionsByTitle(title): Promise<SessionListItem[]>`.
- Produces: injected `{ text }` part appended to the scoped-mention bucket; a "Referenced session" display card; literal-text fallback for unresolved refs.

Behavior:

1. When a parsed token yields `parseSessionRef(pathName)` non-null: resolve the id.
   - `{ id }` → use directly.
   - `{ title }` → `findSessionsByTitle(title)`; 0 matches → not-found; >1 → ambiguous; 1 → use its `sessionId`.
2. Call `new SessionReferenceService(config.getWorkingDir()).resolve(id)`.
   - `{ notFound: true }` OR ambiguous OR 0-match → leave the `@session:…` token as literal text in the prompt and push a warning note (mirror how unresolved mentions are surfaced elsewhere in this file); do NOT throw.
   - success → push `{ text: result.text }` into the scoped-mention parts and add a display card titled `Referenced session` (mirror existing `Activate Extension` card construction in this file).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/ui/hooks/atCommandProcessor.session.test.ts
import { describe, it, expect, vi } from 'vitest';
// NOTE to implementer: import handleAtCommand and mirror the mock setup from
// the existing atCommandProcessor.test.ts in this directory (Config, workspace,
// addItem). This test focuses only on the @session: branch.
import { handleAtCommand } from './atCommandProcessor.js';

vi.mock('@qwen-code/qwen-code-core', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    SessionReferenceService: class {
      resolve = vi.fn().mockResolvedValue({
        text: '--- Referenced session "s1" (slimmed, read-only) ---\nUser: hi',
        meta: {
          sessionId: 's1',
          title: 's1',
          messageCount: 1,
          approxTokens: 5,
        },
        truncated: false,
      });
    },
  };
});

describe('atCommandProcessor @session:', () => {
  it('injects slimmed session text as a part', async () => {
    // Arrange config/workspace/addItem mocks per existing test harness, then:
    const result = await handleAtCommand({
      query: 'see @session:3f2504e0-4f89-41d3-9a0c-0305e82c3301 please',
      // ...harness args...
    } as never);
    const joined = JSON.stringify(result.processedQuery);
    expect(joined).toContain('Referenced session');
    expect(joined).toContain('User: hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/ui/hooks/atCommandProcessor.session.test.ts`
Expected: FAIL — assertion fails (session text not injected) because the branch does not exist yet.

- [ ] **Step 3: Implement the routing branch**

In `atCommandProcessor.ts`, add imports at the top:

```ts
import { parseSessionRef } from './sessionMentionRef.js';
import { SessionReferenceService } from '@qwen-code/qwen-code-core';
```

Add this branch immediately after the `parseMcpServerRef` handling (~line 281) and before the filesystem `isPathWithinWorkspace` check (~line 320):

```ts
const sessionRef = parseSessionRef(pathName);
if (sessionRef) {
  let sessionId = sessionRef.id;
  if (!sessionId && sessionRef.title) {
    const matches = await new SessionService(
      config.getWorkingDir(),
    ).findSessionsByTitle(sessionRef.title);
    if (matches.length === 1) {
      sessionId = matches[0].sessionId;
    } else {
      // 0 or >1: leave literal, warn, skip injection
      addItem(
        {
          type: MessageType.INFO,
          text:
            matches.length === 0
              ? `No session matches "@session:${sessionRef.title}".`
              : `"@session:${sessionRef.title}" is ambiguous (${matches.length} matches); use the picker.`,
        },
        userMessageTimestamp,
      );
      continue; // token already retained as literal text
    }
  }
  const ref = await new SessionReferenceService(config.getWorkingDir()).resolve(
    sessionId!,
  );
  if ('notFound' in ref) {
    addItem(
      { type: MessageType.INFO, text: `Session "${sessionId}" not found.` },
      userMessageTimestamp,
    );
    continue;
  }
  scopedMentionEntries.push({
    part: { text: ref.text },
    // mirror the card shape used by the extension/MCP-server branches:
    card: { title: 'Referenced session', detail: ref.meta.title },
  });
  continue;
}
```

(Implementer: match the exact `scopedMentionEntries` element shape and `addItem`/`MessageType` imports already used in this file; the block above shows intent and names.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/ui/hooks/atCommandProcessor.session.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression + typecheck**

Run: `npx vitest run packages/cli/src/ui/hooks/atCommandProcessor.test.ts`
Expected: PASS (existing tests unaffected).
Run: `npx tsc --noEmit -p packages/cli/tsconfig.json`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui/hooks/atCommandProcessor.ts packages/cli/src/ui/hooks/atCommandProcessor.session.test.ts
git commit -m "feat(cli): inject slimmed prior-session context on @session: mention"
```

---

### Task 4: `category` field + session-suggestion producer

**Files:**

- Modify: `packages/cli/src/ui/components/SuggestionsDisplay.tsx:19-45` (add `category` to `Suggestion`, add `SuggestionCategory` type)
- Create: `packages/cli/src/ui/hooks/sessionCompletion.ts` (producer, mirrors `extension-mention-ref.ts`)
- Modify: `packages/cli/src/ui/hooks/useAtCompletion.ts` (call producer; tag file results; merge near lines 439/486/493)
- Test: `packages/cli/src/ui/hooks/sessionCompletion.test.ts`

**Interfaces:**

- Consumes: `SessionService.listSessions({ size }): Promise<{ items: SessionListItem[]; hasMore }>`; `SessionListItem` fields `sessionId`, `customTitle?`, `prompt`, `mtime`; `buildSessionRef` (Task 1).
- Produces:
  - `type SuggestionCategory = 'file' | 'session' | 'mcp' | 'extension'`
  - `Suggestion.category?: SuggestionCategory`
  - `async function getSessionSuggestions(cwd: string, pattern: string): Promise<Suggestion[]>`

- [ ] **Step 1: Add the type field (no test — type-only), then write the producer test**

Edit `SuggestionsDisplay.tsx` — add above `export interface Suggestion`:

```ts
export type SuggestionCategory = 'file' | 'session' | 'mcp' | 'extension';
```

and inside `Suggestion`:

```ts
  /** Grouping category for the tabbed completion UI. Defaults to 'file'. */
  category?: SuggestionCategory;
```

Producer test:

```ts
// packages/cli/src/ui/hooks/sessionCompletion.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@qwen-code/qwen-code-core', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    SessionService: class {
      listSessions = vi.fn().mockResolvedValue({
        items: [
          {
            sessionId: 'id-1',
            customTitle: 'Fix auth bug',
            prompt: 'fix auth',
            mtime: 2,
          },
          {
            sessionId: 'id-2',
            customTitle: undefined,
            prompt: 'add tests',
            mtime: 1,
          },
        ],
        hasMore: false,
      });
    },
  };
});

import { getSessionSuggestions } from './sessionCompletion.js';

describe('getSessionSuggestions', () => {
  it('maps sessions to category:session suggestions with @session: values', async () => {
    const out = await getSessionSuggestions('/proj', '');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      label: 'Fix auth bug',
      value: 'session:id-1',
      category: 'session',
    });
    // falls back to first prompt when no custom title
    expect(out[1].label).toBe('add tests');
  });

  it('filters by pattern against title and prompt', async () => {
    const out = await getSessionSuggestions('/proj', 'auth');
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('session:id-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/ui/hooks/sessionCompletion.test.ts`
Expected: FAIL — `Cannot find module './sessionCompletion.js'`.

- [ ] **Step 3: Implement the producer**

```ts
// packages/cli/src/ui/hooks/sessionCompletion.ts
import { SessionService } from '@qwen-code/qwen-code-core';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { buildSessionRef } from './sessionMentionRef.js';

const MAX_SESSION_SUGGESTIONS = 20;

export async function getSessionSuggestions(
  cwd: string,
  pattern: string,
): Promise<Suggestion[]> {
  let items;
  try {
    const res = await new SessionService(cwd).listSessions({
      size: MAX_SESSION_SUGGESTIONS,
    });
    items = res.items;
  } catch {
    return []; // I/O failure → session tab simply empty
  }
  const needle = pattern.trim().toLowerCase();
  return items
    .map((s) => {
      const label = s.customTitle?.trim() || s.prompt || s.sessionId;
      return {
        label,
        value: buildSessionRef(s.sessionId),
        description: s.customTitle ? s.prompt : undefined,
        sourceBadge: 'Session',
        category: 'session' as const,
      } satisfies Suggestion;
    })
    .filter((sug) =>
      needle.length === 0
        ? true
        : `${sug.label} ${sug.description ?? ''}`
            .toLowerCase()
            .includes(needle),
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/ui/hooks/sessionCompletion.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `useAtCompletion.ts`**

- Add import: `import { getSessionSuggestions } from './sessionCompletion.js';`
- Tag file results with `category: 'file'` at the `fileSuggestions` map (~line 486):

```ts
const fileSuggestions = results.map((p) => ({
  label: p,
  value: escapePath(p),
  isDirectory: p.endsWith('/'),
  category: 'file' as const,
}));
```

- Tag extension suggestions `category: 'extension'` and MCP suggestions `category: 'mcp'` at their producers (in `useAtCompletion.ts` for MCP; add `category: 'extension'` inside `getExtensionSuggestions` in `extension-mention-ref.ts`).
- Fetch session suggestions and prepend them to the merged list. Where `mcpSuggestions` is assembled (~line 439) and merged with files (~line 493), add sessions so bare `@` shows them:

```ts
const sessionSuggestions = await getSessionSuggestions(
  config?.getWorkingDir() ?? process.cwd(),
  state.pattern,
);
// merge order: extensions, sessions, mcp, then files
dispatch({
  type: 'SEARCH_SUCCESS',
  payload: [...mcpSuggestions, ...sessionSuggestions, ...fileSuggestions],
});
```

(Implementer: place the `await getSessionSuggestions` alongside the existing async file search; keep it inside the same abortable path so a new keystroke cancels it. Sessions are shown on empty pattern like extensions.)

- [ ] **Step 6: Typecheck + existing completion tests**

Run: `npx tsc --noEmit -p packages/cli/tsconfig.json`
Run: `npx vitest run packages/cli/src/ui/hooks/useAtCompletion.test.ts`
Expected: PASS (existing) + no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/ui/components/SuggestionsDisplay.tsx packages/cli/src/ui/hooks/sessionCompletion.ts packages/cli/src/ui/hooks/sessionCompletion.test.ts packages/cli/src/ui/hooks/useAtCompletion.ts packages/cli/src/ui/hooks/extension-mention-ref.ts
git commit -m "feat(cli): surface prior sessions as @ completion suggestions"
```

---

### Task 5: Tab bar + category filtering in `SuggestionsDisplay`

**Files:**

- Modify: `packages/cli/src/ui/components/SuggestionsDisplay.tsx` (add `activeCategory` prop, tab bar, row filtering)
- Test: `packages/cli/src/ui/components/SuggestionsDisplay.test.tsx`

**Interfaces:**

- Consumes: `Suggestion.category` (Task 4); `activeIndex`, `scrollOffset` (existing props).
- Produces: new props `activeCategory?: SuggestionCategory | 'all'`, `availableCategories?: Array<SuggestionCategory | 'all'>`. When `activeCategory` is set and not `'all'`, only rows whose `category === activeCategory` render. A tab bar renders when `availableCategories.length > 2` (i.e., more than just `all` + one category); otherwise hidden (no regression for plain file completion).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/src/ui/components/SuggestionsDisplay.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SuggestionsDisplay } from './SuggestionsDisplay.js';

const suggestions = [
  { label: 'a.ts', value: 'a.ts', category: 'file' as const },
  { label: 'Fix bug', value: 'session:id-1', category: 'session' as const },
];

describe('SuggestionsDisplay tabs', () => {
  it('shows a tab bar when multiple categories are present', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={suggestions}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        activeCategory="all"
        availableCategories={['all', 'file', 'session']}
      />,
    );
    expect(lastFrame()).toContain('Files');
    expect(lastFrame()).toContain('Sessions');
  });

  it('filters rows to the active category', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={suggestions}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        activeCategory="session"
        availableCategories={['all', 'file', 'session']}
      />,
    );
    expect(lastFrame()).toContain('Fix bug');
    expect(lastFrame()).not.toContain('a.ts');
  });

  it('hides the tab bar for single-category (file-only) completion', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[suggestions[0]]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        activeCategory="all"
        availableCategories={['all', 'file']}
      />,
    );
    expect(lastFrame()).not.toContain('Sessions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/ui/components/SuggestionsDisplay.test.tsx`
Expected: FAIL — tab labels absent / props unknown.

- [ ] **Step 3: Implement tab bar + filter**

- Extend `SuggestionsDisplayProps` with:

```ts
  activeCategory?: SuggestionCategory | 'all';
  availableCategories?: Array<SuggestionCategory | 'all'>;
```

- Add a label map:

```ts
const CATEGORY_LABEL: Record<SuggestionCategory | 'all', string> = {
  all: 'All',
  file: 'Files',
  session: 'Sessions',
  mcp: 'MCP',
  extension: 'Extensions',
};
```

- Before slicing/rendering rows, filter:

```ts
const visible =
  !activeCategory || activeCategory === 'all'
    ? suggestions
    : suggestions.filter((s) => (s.category ?? 'file') === activeCategory);
```

Use `visible` in place of `suggestions` for the existing `scrollOffset`/`MAX_SUGGESTIONS_TO_SHOW` slice.

- Render a tab bar (mirror `StatsTabs` in `StatsDialog.tsx`) above the list, only when `(availableCategories?.length ?? 0) > 2`:

```tsx
{
  (availableCategories?.length ?? 0) > 2 && (
    <Box flexDirection="row" marginBottom={1}>
      {availableCategories!.map((cat, i) => {
        const active = cat === activeCategory;
        return (
          <Box key={cat} marginLeft={i === 0 ? 0 : 1}>
            <Text
              color={active ? theme.background.primary : theme.text.secondary}
              backgroundColor={active ? theme.text.accent : undefined}
            >
              {` ${CATEGORY_LABEL[cat]} `}
            </Text>
          </Box>
        );
      })}
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>(←/→ to switch)</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/ui/components/SuggestionsDisplay.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/components/SuggestionsDisplay.tsx packages/cli/src/ui/components/SuggestionsDisplay.test.tsx
git commit -m "feat(cli): tabbed category layout for @ completion dropdown"
```

---

### Task 6: `activeCategory` state + `←/→` tab-switch keybinding

**Files:**

- Modify: `packages/cli/src/ui/hooks/useCompletion.ts` (add `activeCategory`, `availableCategories`, `switchCategory(direction)`, reset index on switch)
- Modify: `packages/cli/src/ui/keyMatchers.ts` (or the keybindings command file) — add `Command.COMPLETION_TAB_LEFT` / `COMPLETION_TAB_RIGHT` bound to `←`/`→` while suggestions are shown
- Modify: `packages/cli/src/ui/components/InputPrompt.tsx` (~lines 1386–1448) — handle the new commands; pass `activeCategory`/`availableCategories` into `suggestionDisplayProps` (~line 1948)
- Test: `packages/cli/src/ui/hooks/useCompletion.test.ts` (extend existing)

**Interfaces:**

- Consumes: `Suggestion.category` (Task 4); `SuggestionCategory` (Task 4).
- Produces: `useCompletion` returns `activeCategory: SuggestionCategory | 'all'`, `availableCategories: Array<SuggestionCategory | 'all'>`, `switchCategory(direction: 1 | -1): void`.

Behavior: `availableCategories` = `['all', ...distinct categories present in suggestions, in fixed order file/session/mcp/extension]`. `switchCategory` cycles within `availableCategories`, wraps, and resets `activeSuggestionIndex = 0` + `visibleStartIndex = 0`. When suggestions change and the current `activeCategory` no longer exists, reset to `'all'`.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/cli/src/ui/hooks/useCompletion.test.ts
import { renderHook, act } from '@testing-library/react';
import { useCompletion } from './useCompletion.js';

it('derives availableCategories and cycles with switchCategory', () => {
  const { result } = renderHook(() => useCompletion());
  act(() => {
    result.current.setSuggestions([
      { label: 'a.ts', value: 'a.ts', category: 'file' },
      { label: 'S', value: 'session:1', category: 'session' },
    ]);
  });
  expect(result.current.availableCategories).toEqual([
    'all',
    'file',
    'session',
  ]);
  expect(result.current.activeCategory).toBe('all');
  act(() => result.current.switchCategory(1));
  expect(result.current.activeCategory).toBe('file');
  expect(result.current.activeSuggestionIndex).toBe(0);
});
```

(Implementer: match the actual `useCompletion` setter API — if it exposes `setSuggestions`/a reducer, adapt the arrange step accordingly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/ui/hooks/useCompletion.test.ts -t 'availableCategories'`
Expected: FAIL — `availableCategories`/`switchCategory` undefined.

- [ ] **Step 3: Implement state in `useCompletion.ts`**

Add:

```ts
const CATEGORY_ORDER: SuggestionCategory[] = [
  'file',
  'session',
  'mcp',
  'extension',
];

const availableCategories = useMemo<Array<SuggestionCategory | 'all'>>(() => {
  const present = new Set(suggestions.map((s) => s.category ?? 'file'));
  const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
  return ordered.length > 1 ? ['all', ...ordered] : ['all'];
}, [suggestions]);

const [activeCategory, setActiveCategory] = useState<
  SuggestionCategory | 'all'
>('all');

useEffect(() => {
  if (!availableCategories.includes(activeCategory)) setActiveCategory('all');
}, [availableCategories, activeCategory]);

const switchCategory = useCallback(
  (direction: 1 | -1) => {
    setActiveCategory((cur) => {
      const idx = availableCategories.indexOf(cur);
      const next =
        (idx + direction + availableCategories.length) %
        availableCategories.length;
      return availableCategories[next];
    });
    setActiveSuggestionIndex(0);
    setVisibleStartIndex(0);
  },
  [availableCategories],
);
```

Return `activeCategory`, `availableCategories`, `switchCategory` from the hook.

- [ ] **Step 4: Add keybindings + InputPrompt wiring**

- In the keybindings command enum/file add `COMPLETION_TAB_LEFT` (`left`/`←`) and `COMPLETION_TAB_RIGHT` (`right`/`→`).
- In `InputPrompt.tsx` inside the `showCompletionSuggestions` block (~line 1386), BEFORE the `ACCEPT_SUGGESTION` handling:

```ts
if (keyMatchers[Command.COMPLETION_TAB_RIGHT](key)) {
  completion.switchCategory(1);
  return true;
}
if (keyMatchers[Command.COMPLETION_TAB_LEFT](key)) {
  completion.switchCategory(-1);
  return true;
}
```

- In `suggestionDisplayProps` (~line 1948) add:

```ts
activeCategory: completion.activeCategory,
availableCategories: completion.availableCategories,
```

Guard: only consume `←/→` when `availableCategories.length > 2`, so left/right cursor movement in the buffer is unaffected during plain file completion. (Fold this guard into the two `if` blocks above.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/cli/src/ui/hooks/useCompletion.test.ts`
Run: `npx tsc --noEmit -p packages/cli/tsconfig.json`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui/hooks/useCompletion.ts packages/cli/src/ui/keyMatchers.ts packages/cli/src/ui/components/InputPrompt.tsx packages/cli/src/ui/hooks/useCompletion.test.ts
git commit -m "feat(cli): ←/→ tab switching for @ completion categories"
```

---

### Task 7: End-to-end verification + full test/lint gate

**Files:** none (verification only)

- [ ] **Step 1: Full core + cli test run**

Run: `npm run build && npx vitest run packages/core packages/cli`
Expected: all pass (including the new suites).

- [ ] **Step 2: Lint + typecheck (align with CI)**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Manual TUI smoke (use the run skill or a real terminal)**

1. Start the CLI in a project that has ≥2 prior sessions.
2. Type `@` → confirm a tab bar appears with `All / Files / Sessions`.
3. Press `→` to reach `Sessions`, `↑/↓` to select one, `Enter`/`Tab` to accept → buffer shows `@session:<id>`.
4. Submit a prompt → confirm a `Referenced session` card renders and the slimmed block reaches the model (labeled `--- Referenced session … ---`, no tool result bodies).
5. Type `@session:<garbage-uuid>` and submit → confirm the "not found" info line and literal-text fallback (no crash).

- [ ] **Step 4: Update the design spec status**

Edit `docs/superpowers/specs/2026-07-17-at-session-reference-design.md`: change `Status: Proposed` → `Status: Implemented`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-17-at-session-reference-design.md
git commit -m "docs: mark @ session reference design as implemented"
```

---

## Self-Review

**Spec coverage:** Goal-1 (reference sessions) → Tasks 1–4; Goal-2 (tabbed UI) → Tasks 4–6. Each locked decision maps to a task: no-LLM slimming → Task 2 (Global Constraints forbid `runSideQuery`); tool one-liners → Task 2 recordsToLines; current-project scope → Tasks 2/4 via SessionService; bare-`@` sessions → Task 4 merge; tab switch → Tasks 5/6; fixed budget tail-retention → Task 2 budget loop. Error-handling table → Task 3 (not-found/ambiguous/empty) + Task 4 (listSessions failure) + Task 5 (single-category hides tabs). Testing section → per-task tests + Task 7.

**Placeholder scan:** No TBD/TODO. Integration edits (Tasks 3–6) show concrete code with a note to match exact local names where the surrounding file's shapes (card element, reducer setters, keyMatchers file) can't be quoted verbatim without reading them at execution time — acceptable because names are specified.

**Type consistency:** `SessionRef {id?,title?}` (Task 1) consumed by Task 3; `SlimmedSessionReference` / `resolve(sessionId, opts)` (Task 2) consumed by Task 3; `SuggestionCategory` / `Suggestion.category` (Task 4) consumed by Tasks 5/6; `getSessionSuggestions(cwd, pattern)` (Task 4) consumed by useAtCompletion; `switchCategory(1|-1)`, `activeCategory`, `availableCategories` (Task 6) consumed by InputPrompt + SuggestionsDisplay props (Task 5). Names align across tasks.

**Known execution-time adaptations (flagged, not placeholders):** (a) exact `scopedMentionEntries` element/card shape in `atCommandProcessor.ts`; (b) `useCompletion` setter API for the test arrange step; (c) the keybindings command file's exact location/enum. Each is called out inline in the owning task.
