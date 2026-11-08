# Channel Named Sessions: Part 3A

## Status

Implemented design. This document refines the correlation and presentation
prerequisite from
[`channel-named-sessions-part3.md`](./channel-named-sessions-part3.md).

The source audit was refreshed against `origin/main` at
`a3ec41a2816fa50a80191ca69daa8e63e0ca7355` after Part 2 merged in PR #10198.
No Part 3 implementation PR exists at that baseline.

## Decision

Part 3A makes every result or interactive surface from an opt-in named Channel
task visibly attributable to the exact originating task. It also exposes the
exact request ID in named-mode text permission prompts. It deliberately keeps
all Part 2 busy guards and permission-selection behavior.

Part 3A is therefore a safe, independently useful prerequisite rather than a
partial concurrency release:

- a named task remains selectable only while the old and destination tasks are
  idle;
- `/session cancel [<name>]` is not added;
- bare `/approve`, `/approve-always`, and `/deny` keep their current chat-level
  lookup behavior; and
- no scheduler, daemon route, bridge protocol, registry version, or persisted
  transcript changes.

Part 3B may remove selection-related busy guards only after Part 3A is merged.

## Goals

1. Resolve an exact managed session ID to its persisted task name and owner
   target without scanning the registry for every stream chunk.
2. Capture one immutable source label when a named turn or permission is
   admitted and carry it separately from model text.
3. Render that label at every independently visible delivery boundary,
   including adapter-internal splits, retries, cards, and fallbacks.
4. Show an actionable exact request ID in named-mode text permission prompts.
5. Keep disabled-mode output and all Part 2 selection, close, reset, ownership,
   and recovery behavior unchanged.

## Non-goals

Part 3A does not:

- permit switching from or to a preparing, queued, running, permission-pending,
  or cancellation-winding-down task;
- add named or selected-task cancellation;
- reinterpret bare permission commands as selected-task-only;
- add label persistence to the named-session registry, transcript, cards,
  permissions, or general runtime state; the existing GitHub final-delivery
  outbox retains an optional captured label only so its current restart-safe
  retry contract remains restart-safe;
- label Channel management acknowledgements such as `/sessions` or
  `/session use` whose text already names the affected task;
- make loops, webhooks, ambient group history, standalone execution, or a
  non-user session scope compatible with named sessions;
- add task-directed prompt submission; or
- add Part 4 worktree isolation.

## Verified baseline

### Registry and ownership

`NamedSessionManager` owns the version 1 registry. An owner is exactly
`(channelName, chatId, senderId)`. Stored tasks already contain the immutable
task name, exact session ID, working directory, status, isolation, and delivery
target. Registry validation rejects duplicate session IDs across all owners.

Only open tasks are capped at eight. Closed task records may accumulate, so a
per-chunk linear registry scan is not bounded by the open-task limit.

The manager already serializes operations per owner, writes the whole next
registry atomically, and publishes it in memory only after the write succeeds.
The first named operation can adopt an exact legacy route as `default` when the
channel, chat, sender, and current working directory match.

### Prompt and permission correlation

`ChannelBase` already keys prompt queues, queued-turn reservations, active
prompts, output segments, collection buffers, cancellation state, and pending
permissions by exact session ID. A pending permission retains its request ID,
session ID, target, and request. Output-segment and user-input contexts retain
session, run, owner, and target correlation.

Normal named inbound messages call `NamedSessionManager.resolve()` before shell
execution or model submission, so a valid owner record already exists at that
point. Background responses and permission events can arrive without an active
prompt and therefore need a bounded exact-route bootstrap path.

### Visible delivery boundaries

There is no single final `sendMessage` boundary shared by every adapter:

- the base one-shot path calls `sendResponseMessage`;
- block streaming calls `sendResponseMessage` once per emitted block;
- DingTalk and Feishu replace whole cards and have terminal/fallback surfaces;
- DingTalk also splits Markdown and can send a projector tail during prompt
  cleanup;
- QQ owns per-session raw buffers and emits size, idle, tool-call, retry, and
  final flushes;
- Telegram converts Markdown to HTML and then splits to the platform limit;
- WeCom removes media markers and then performs byte-limited Markdown splits;
- GitHub and DWS override final response delivery;
- the plugin example emits progressive WebSocket chunk messages; and
- GitLab and Weixin use the base final path, with Weixin parsing image markers
  after it receives the text.

This is why prepending the label once before adapter processing is incorrect:
later platform chunks would be unlabeled, while prepending in both base and
adapter code would duplicate the label.

## User-visible contract

### Label format

Named output uses one of these plain-text labels:

```text
[feature-a]
[Alice · feature-a]
```

Direct chats show only the task name. Group chats show the originating owner
label and task name. Task names are already bounded ASCII slugs. The sender
label is selected in this order:

1. the originating envelope's sanitized `senderName` captured for the turn;
2. the newest sanitized observed-contact label for that sender in the same
   group, then the channel-wide user contact;
3. the sanitized owner `senderId`; and
4. `unknown` only if sanitization leaves no usable identifier.

Whether the delivery uses direct or group form comes from the active envelope
when present, then the exact task/route target, then a matching observed group
record. If legacy metadata remains unknown, the conservative group form with
the sanitized sender ID is used; an extra owner label in a direct chat is safer
than an ambiguous task-only label in a group where different owners may reuse
the same task name.

Observed-contact lookup is presentation-only. It does not modify the registry
and cannot change ownership. A label captured for a turn or permission remains
stable even if a later contact observation changes the display name.

`sourceLabel` is sanitized plain text, not pre-escaped Markdown or HTML. Each
rich-text adapter escapes only the label for its own dialect at the final
rendering boundary. This avoids both markup injection from a display name and
visible backslashes in plain-text adapters.

### Placement

For a plain message, the label prefixes the first line:

```text
[feature-a] Result text
```

For a Markdown message, the escaped label occupies its own first line so the
body's line-leading block syntax, including fenced code, remains intact.

Every independently sent block or platform chunk repeats the label. A card
replacement contains one label because it replaces one visible object. Token
updates within the same card are not individually prefixed.

In group adapters that already mention the sender, the mention remains first
and the source label follows it. Continuation chunks repeat the source label
but do not repeat a platform mention unless the platform already does so.

The label is delivery-only. Raw bridge chunks and the final response remain
unchanged for transcript persistence, telemetry, memory, and resume.

### Permission prompt in 3A

When named mode uses the plain-text permission fallback, the prompt displays
the exact request ID and exact commands:

```text
[feature-a] Permission required to run a tool
Request: req-123

Command:
Run tests

Reply with:
/approve req-123          allow once
/approve-always req-123   always allow for this project
/deny req-123             deny
```

The always-allow line is omitted when the request has no such option. Tool raw
input remains hidden.

The named-mode prompt intentionally does not advertise a bare command as
"selected task only" in 3A. That rule is not implemented until Part 3B. Bare
commands continue to work exactly as they do in Part 2, while the prompt guides
the user to the already-supported exact request form.

When `multiSession` is absent or false, the existing permission text remains
byte-for-byte unchanged, including its current option-description wording and
the absence of `Request: ...`.

## Exact task presentation lookup

### Derived index

`NamedSessionManager` adds an in-memory derived index:

```ts
interface NamedSessionTaskReference {
  taskName: string;
  status: 'open' | 'closed';
  target: SessionTarget;
}

private taskBySessionId: Map<string, NamedSessionTaskReference>;
```

The reference exposes only what Channel presentation needs. Status lets stale
background and permission events for a closed task be rejected in O(1) rather
than making the task visible or actionable again. The reference does not expose
the registry owner list, timestamps, working directory, or daemon catalog.
Returned targets are copied so callers cannot mutate registry state.

The index is built from every validated open and closed task. It is constructed
once after registry load and reconstructed for a proposed registry before an
atomic commit. Commit ordering is:

1. build and validate the next registry;
2. build the corresponding next derived index;
3. atomically write the next registry;
4. assign the in-memory registry; and
5. assign the in-memory index.

A failed write publishes neither object. Because registry validation already
rejects duplicate session IDs, index construction does not introduce a second
conflict rule or authority.

### Read operations

The manager adds two narrow reads:

```ts
presentation(sessionId: string): NamedSessionTaskReference | undefined;

resolvePresentation(
  sessionId: string,
): Promise<NamedSessionTaskReference | undefined>;
```

`presentation` is synchronous and side-effect free. Prompt, streaming, shell,
and card hot paths use it only after normal named resolution has already
created or loaded the catalog entry.

`resolvePresentation` first checks the index. On a miss, it may adopt one exact
legacy selected route as `default`, using the existing per-owner lock and
`ensureOwner` rules. Before adoption it requires all of the following:

- `SessionRouter.getTarget(sessionId)` belongs to this Channel;
- the compatibility route for that exact channel/chat/sender owner still
  points to the same `sessionId`;
- the target's channel, chat, and sender match exactly; and
- the route working directory is absent or canonicalizes to the current
  Channel working directory.

It persists `default` before returning the reference. It never adopts an
unknown inactive route, selects a different task, loads a replacement session,
or falls back to the currently selected task.

This asynchronous path is used only for background and permission events that
can precede the first named inbound operation after upgrade.

The index proves persisted task ownership; it does not replace live delivery
routing. For background and permission events, `ChannelBase` also obtains the
current router/active-prompt target and requires its
`(channelName, chatId, senderId)` tuple to match the indexed task target. The
active thread may differ and remains a delivery dimension, not a new owner
dimension. A missing target or owner-tuple mismatch fails closed. Neither side
is replaced with the currently selected task's target.

## Presentation capture and propagation

### Minimal type changes

Part 3A uses an optional string rather than a new general presentation
abstraction:

```ts
export interface ChannelOutputSegmentContext {
  // existing fields
  sourceLabel?: string;
}

export interface ChannelUserInputRequestContext {
  // existing fields
  sourceLabel?: string;
}
```

`ActivePrompt` gains an internal optional `sourceLabel`; `PendingPermission`
gains optional `sourceLabel` and `taskName`. The latter is the exact bounded
ASCII name from the same presentation reference, not parsed back out of a
formatted label. `ChannelBase` adds a protected read-only
`getResponseSourceLabel(sessionId)` beside the existing response message,
sender, metadata, and thread helpers. This lets a lifecycle-driven adapter
label a status card created before the first output segment exists.

GitHub's existing `PendingFinalDelivery` record also gains optional
`sourceLabel`. This is adapter-owned delivery metadata, not registry or
transcript state. Old records without the field retain their existing unlabeled
retry behavior, while new named-mode records can reproduce the exact captured
label after a worker restart. Its persisted-record validator accepts only an
absent field or the same bounded, sanitized plain-text label shape used at
capture time.

The following protected delivery hooks gain a final optional `sourceLabel`
argument:

```ts
sendThreadMessage(chatId, threadId, text, sourceLabel?): Promise<void>;
sendResponseMessage(chatId, text, sessionId, sourceLabel?): Promise<void>;
deliverBackgroundReply(chatId, text, sessionId, sourceLabel?): Promise<void>;
pushProactive(target, text, sourceLabel?): Promise<void>;
```

`sendThreadMessage` is the common attributed non-model send boundary. Direct
shell results, named permission text, single-request
error/acknowledgement text, and user-input fallbacks pass their captured label
here. Management messages such as `/sessions`, pairing, or `/session use` keep
calling it without a label. Split-aware adapters override this optional
argument so a long shell or permission message cannot label only its first
platform chunk.

Existing subclasses remain source-compatible because the argument is optional.
All in-repository overrides are updated and the plugin example documents how a
custom streaming adapter must retain it.

Source compatibility is not a claim that an out-of-repository custom adapter's
own streaming, splitting, or card code is automatically presentation-safe. A
custom adapter may advertise `multiSession` support only after it consumes
`sourceLabel` at every independently visible boundary and passes the same
contract tests. Part 3A can certify all in-repository adapters and the plugin
example; it cannot inspect deployed external code. This explicit extension
contract is smaller and more honest than adding a second temporary adapter
capability registry solely for this rollout.

The existing `onResponseChunk` and `onResponseComplete` hooks do not need
another positional parameter: their optional `ChannelOutputSegmentContext`
already carries `sourceLabel`.

`ChannelTaskLifecycleEvent` also remains unchanged. Content-bearing
DingTalk/Feishu status cards read the captured label through active run state
and `getResponseSourceLabel`; contentless typing indicators and reactions stay
keyed to their existing session/message anchor and do not create synthetic
task-label messages.

### Capture points

For a normal named inbound turn, `ChannelBase` performs the following after
exact session resolution and before shell execution or model submission:

1. synchronously fetch the exact task reference;
2. compute the source label from the task and originating envelope;
3. reject the turn with a bounded management error if the reference is
   unexpectedly absent;
4. pass the captured label with direct shell success or failure through the
   attributed `sendThreadMessage` boundary; and
5. store the label in `ActivePrompt` before emitting the `started` lifecycle
   event.

Every output segment copies the active prompt's label. Block-streaming sends
pass it explicitly. The final response remains raw until the selected adapter
delivery boundary renders it.

For a permission event, `dispatchPermissionRequest` requires an open exact task
whose owner tuple matches the active/router permission target, then resolves
and captures the task name and label before inserting `PendingPermission`.
`formatPermissionRequest` continues to build raw permission content; the
dispatcher passes content and label separately to a small label-aware thread or
proactive sender. Plain prompts, single-request option/failure messages, and
acknowledgements use the captured permission label at that final boundary. The
user-input context copies the same label, so a card action never re-reads the
current selection after an await. A replayed permission event for a closed task
is cancelled rather than presented.

An ambiguity response can describe several pending tasks and therefore has no
single message-level source label. Each list item uses the captured ASCII task
name instead, for example `- Task review — req-123: Run tests`. It never parses
the display label or interpolates an unescaped sender display name. Errors and
acknowledgements that identify one pending request use that request's full
captured source label through the attributed thread-send boundary.

For a background response, `dispatchBackgroundResponse` calls the asynchronous
exact lookup once and requires an open task plus an owner-matching router
target. It computes the label from that reference and delivery target and
passes it to proactive or fallback delivery. A stale event for a closed task is
rejected even though its record remains indexed. No per-chunk registry or
contact lookup occurs.

### Rendering rule

Raw content and the source label stay separate until an adapter is about to
emit or replace a visible object. The renderer never decides that model text is
already labeled by inspecting a string prefix. This matters for model output
that legitimately begins with `[feature-a]` and for retries.

Control and projection logic always examines the raw content first. In
particular, GitHub `<no-reply/>`, DWS `[NO_REPLY]`, QQ `<noreply>`, DingTalk
file/image projection, WeCom media-marker extraction, and publication audit
input all run before label rendering. Otherwise adding a label would turn a
suppressed response into a visible one, corrupt marker parsing, or record
presentation text as model output.

A whitespace-only raw body also remains whitespace-only and is not turned into
a visible label-only message. Media-marker input is not empty: DingTalk,
Weixin, and WeCom first extract its attachments from the raw body, then
intentionally emit the label as the logical text envelope when no ordinary
body remains. A display label is never passed through a marker parser.

The base `sendThreadMessage` uses a small protected formatter that returns the
input unchanged when `sourceLabel` is undefined and otherwise prepends it
exactly once. Default response, background, and proactive hooks pass raw text
plus the optional label into that boundary. Split and card adapters keep the
raw label in their own existing state, escape it for the platform dialect,
reserve its size, and render it at each actual boundary.

## Delivery flows

| Origin               | Correlation source                | Capture lifetime    | Rendering boundary                               |
| -------------------- | --------------------------------- | ------------------- | ------------------------------------------------ |
| normal prompt        | exact resolved session + envelope | `ActivePrompt`      | final message, block, stream state, or card      |
| direct shell         | exact resolved session + envelope | shell invocation    | attributed thread-send and platform chunks       |
| output segment       | active prompt                     | segment context     | segment card/message                             |
| permission           | pending exact session + target    | `PendingPermission` | text prompt, card, fallback, and acknowledgement |
| background response  | event session ID + router target  | one dispatch        | proactive or background-reply send               |
| terminal card/status | adapter run/card state            | run lifetime        | whole-card replacement or fallback               |

Loop and webhook prompt paths remain outside the table because named-mode
configuration already rejects them. Public taskless proactive delivery remains
unchanged because it has no session identity from which to derive a task.

## Adapter responsibilities

### Base and Weixin

The default `onResponseComplete` passes `segment?.sourceLabel` to
`sendResponseMessage`. The default response/background/proactive one-shot path
passes raw text plus the label to `sendThreadMessage`, whose base implementation
prefixes once immediately before `sendMessage`.

Every `BlockStreamer` send passes the active prompt's label, so each block is
independently attributable.

Weixin factors its existing `sendMessage` projection into a private
label-aware sender. It parses `[IMAGE: ...]` markers from the raw body first,
then formats the cleaned text with the label and sends images. A media-only
named response therefore sends the label as visible text before the image. This
ordering also prevents a sender display label such as `IMAGE:` from being
interpreted as an AI-controlled local image marker. Public `sendMessage`
delegates with no label; its `sendThreadMessage` override delegates the raw body
and optional label as two arguments rather than invoking the base preformatter.

### GitHub, GitLab, and DWS

These Markdown comment adapters accept the optional label on both their
thread-send and final-response boundaries and escape it for their comment
dialect. GitHub and DWS evaluate their no-reply sentinel, and GitHub builds
publication audit data, from the raw final text before prefixing only the
comment body passed to the existing publication logic. They do not add labels
to audit metadata or model content. GitHub persists the optional raw label
separately in its existing pending-final-delivery record, so an accepted
definite-no-write retry retains the same presentation across restart; the retry
formats the comment body only at send time. GitLab adds the same narrow
final-send override rather than inheriting the base plain-text renderer.

DWS also overrides `pushProactive(target, text, sourceLabel?)` because its
background IM path already recognizes `[NO_REPLY]`. The override checks
`isNoReply(text)` on the raw body, then delegates the unsuppressed body and
structured label to the base proactive sender. This preserves the existing
proactive-sentinel contract instead of turning it into a visible label plus
sentinel.

### Plugin example

The example stores the first label seen for each segment. Its first WebSocket
chunk for a segment is prefixed; subsequent token chunks remain raw. The final
whole-response message is also labeled because it is a separate visible
object. Segment-end cleanup removes the marker. This becomes the reference
contract for third-party progressive adapters.

### DingTalk

DingTalk stores `sourceLabel` in the existing run presentation and output
segment state. Status, output, completed, cancelled, failed, question, and
fallback cards render it once per whole card. Existing `@sender` presentation
is preserved.

Plain replies and proactive replies use a prefix-aware Markdown splitter. The
splitter reserves the escaped label on every chunk and additionally reserves
the mention only on the first chunk. The title remains derived from raw answer
content rather than the label. File/image projection runs before label
rendering so source text cannot be mistaken for a marker. A projector tail sent
during `onPromptEnd` uses the still-active prompt's label.

Retries retain the raw body and structured label separately; they do not
inspect or strip body prefixes.

### Feishu

Feishu adds `sourceLabel` to `CardSessionState`, captured at prompt start and
confirmed by the first segment. Streaming updates, final replacements,
stopped/failed cards, creation-failure fallbacks, and proactive messages render
the same label. Card truncation reserves room for the label, existing sender
mention, and terminal status.

The question-card builder accepts `sourceLabel` from
`ChannelUserInputRequestContext` and retains it in initial, processing,
submitted, cancelled, and expired projections plus fallback text. Existing
owner, chat, message, request, and run validation does not change.

### QQ

`QQStreamState` stores the structured label beside the raw buffer. Its effective
flush threshold reserves the label length. Idle, size, tool-call, deferred,
retry, and final flushes check the raw `<noreply>` sentinel first and then prefix
every actual message. Re-buffering stores only raw content, so a retry cannot
double-prefix or defeat sentinel suppression.

Block-streaming and non-stream fallback calls accept the optional label through
`sendResponseMessage`. Reply message IDs, message sequence counters, active
message policy, reconnect identity guards, and permanent/transient retry
classification remain unchanged.

### Telegram

Telegram converts the source label to escaped HTML separately from the body and
uses a local prefix-aware HTML splitter. The helper preserves the existing
Telegram tag/code-block rules while accepting an effective content limit of
`4096 - prefix.length`; every returned HTML chunk is independently valid,
contains the prefix, and is at most 4096 characters. If the dependency leaves
one indivisible block above that effective limit, the sender falls back to
bounded plain-text chunks and repeats the label on each chunk.

`sendThreadMessage`, `sendResponseMessage`, and `pushProactive` delegate to this
helper. This is required because direct shell/permission text and Telegram
proactive delivery bypass different normal-response seams; without the common
helper they lose either the label or its per-chunk size accounting.

This helper is necessary because adding a prefix after the dependency's
existing 4096-character split can exceed the platform limit, while prefixing
only before that split labels only the first chunk. HTML-send fallback strips
tags from the already-prefixed failed chunk, so the plain fallback retains the
source label.

### WeCom

WeCom parses media markers from the raw model response first, then passes the
cleaned text and label to a prefix-aware Markdown splitter. The splitter
reserves the UTF-8 byte length of the label and repeats it on every chunk while
preserving code-fence close/reopen behavior.

When markers leave no text, the label itself becomes one text message before
the attachments. `sendThreadMessage`, `sendResponseMessage`, and
`pushProactive` all delegate to this private label-aware sender; otherwise a
long shell/permission message or background response would repeat the label
only on its first chunk.
Unsupported media and upload failures keep their existing behavior.

## Permission behavior retained for 3B

Part 3A does not change `pendingPermissionForEnvelope` or the authorization
predicate. Explicit request IDs already address one exact pending request after
chat, thread, sender/shared-session, and bridge-side session ownership checks.
Card callbacks remain bound to their captured request, session, run, owner,
target, and operator.

Only the following presentation changes land now:

- named plain prompts display the exact request ID and exact command form;
- named ambiguity entries include each request's task source;
- named request-specific error and acknowledgement messages include the
  captured source label; and
- named user-input cards and their fallbacks include the source label.

Part 3B changes a bare command to first capture the authenticated owner's
selected task and filter candidates to that session. Keeping that semantic
change out of 3A ensures this PR does not silently widen or narrow permission
authority while concurrency is still disabled.

## Failure and recovery semantics

### Missing task presentation

Named presentation never falls back to the selected task or another owner.

- A normal inbound turn detects an impossible missing reference before shell or
  model execution and sends a bounded management error asking the user to retry
  after listing/selecting the task.
- A permission event whose exact presentation cannot be verified is removed and
  cancelled through the bridge; the same applies to a replay for a closed task,
  and no actionable prompt or card is shown.
- A background event whose exact lookup and exact legacy bootstrap both fail,
  whose task is closed, or whose live target has a different owner tuple is
  rejected and logged with bounded identifiers; no unlabeled or guessed result
  is delivered.

An observed-contact read failure is not a correlation failure. It falls back to
the sanitized owner sender ID because task ownership was already verified.

### Send and retry failure

Adapter send failures preserve their current retry, fallback, and terminal
behavior. The captured label is immutable and remains separate from raw
content, so every retry reapplies exactly one label. A failed label-aware split
or impossible platform budget fails delivery rather than emitting an oversized
or unlabeled chunk.

### Restart

After worker restart the derived index is rebuilt from registry version 1.
Display labels are recomputed from the next active envelope or persisted
observed-contact graph. In-flight prompts, permissions, and cards remain
runtime-only and are not newly promised to survive restart. The one existing
durable delivery exception is GitHub's pending-final-delivery outbox: a new
named-mode record retains its captured optional label so the same comment can
be retried without changing either the raw response or audit hash.

## Compatibility

When `multiSession` is absent or false:

- `sourceLabel` is always undefined;
- every base helper returns the original text;
- adapter state and split limits follow their existing branches;
- permission prompt and acknowledgement strings remain unchanged; and
- no registry read or observed-contact lookup is added to delivery.

Part 2 behavior remains unchanged when named mode is enabled:

- create/use still reject leaving a busy selected task;
- use still rejects a busy destination;
- close still rejects every busy state and a busy fallback;
- reset/clear still affects only the selected task; and
- exact load failure still leaves the old task selected and creates no
  replacement.

The registry remains version 1. No daemon REST route, ACP event, bridge method,
configuration field, or persisted transcript changes.

For the protected adapter extension API, adding the optional field and optional
arguments is source-compatible. It is a behavioral contract change only for a
custom adapter that opts into `multiSession`: such an adapter is unsupported
for named concurrency until it carries and renders the field at all of its own
visible boundaries. The checked-in plugin example and Channel documentation
must state this requirement.

## Implementation sequence

1. Add the manager's derived exact-session index, side-effect-free read, exact
   bootstrap read, and rollback/load tests.
2. Add base capture, optional contexts and hook arguments, one-shot/block/shell/
   background/permission rendering, and disabled-mode tests.
3. Update one-shot overrides, the plugin example, and Channel/plugin
   documentation so the repository compiles with a complete extension
   contract.
4. Update DingTalk card and prefix-aware split paths, including question cards,
   media projection, mention ordering, terminal fallbacks, and projector tail.
5. Update Feishu run/question card state, truncation accounting, fallbacks, and
   proactive delivery.
6. Update QQ structured stream state and every flush/retry/final path.
7. Update Telegram HTML and WeCom Markdown prefix-aware splitters plus media-only
   behavior.
8. Run focused package tests, build, typecheck, lint, and the Part 3A E2E plan.
9. Re-audit every `ChannelBase` override and every independently visible send
   before opening the PR.

The order keeps each intermediate commit compilable, but Part 3A should be one
PR. Splitting base metadata from adapter rendering would leave some Channels
able to enable `multiSession` while silently violating the source-attribution
contract. Adding an adapter allowlist would be a larger and temporary product
surface.

## Expected file scope

Production changes should remain within:

- `packages/channels/base/src/named-session-manager.ts`
- `packages/channels/base/src/ChannelBase.ts`
- `packages/channels/base/src/types.ts`
- in-repository Channel adapters and their existing presentation/split helpers
- the plugin example
- `packages/channels/plugin-example/README.md`
- `docs/developers/channel-plugins.md`
- `docs/developers/daemon/15-channel-adapters.md`
- `docs/users/features/channels/overview.md`

Tests remain collocated in the same packages. No `packages/core`, daemon server,
route schema, configuration parser, or dependency file should change. If
implementation requires one of those, stop and revisit the design.

## Verification plan

### Named-session manager

- Build the index after a valid registry load, including closed tasks.
- Refresh it after create, use, close, reset, and exact legacy adoption; reset
  removes the prior session ID and adds only the replacement.
- Publish neither registry nor index after a write failure.
- Restore the prior open reference when close commits `closed` but detach fails
  and the existing close rollback rewrites the prior owner.
- Reject duplicate persisted session IDs through existing validation.
- Resolve a known session without scanning owners or mutating the registry.
- Return closed status so stale background and permission events are both
  rejected without a registry scan.
- Exact-bootstrap only when the current compatibility route is the same session
  and owner in the current workspace.
- Reject an unknown inactive route, another channel/owner, stale workspace, and
  missing target without creating or selecting a session.
- Reject background and permission targets whose live owner tuple differs from
  the indexed task while allowing an active delivery thread to differ.

### Channel base

- Direct and group turns capture `[task]` and `[sender · task]` respectively.
- Active envelope name, same-group observed name, channel user name, sender ID,
  and sanitization fallbacks are selected in order.
- Raw bridge chunks and final response passed by the bridge are unchanged.
- GitHub, DWS, and QQ no-reply sentinels are still suppressed from raw content;
  labels do not enter GitHub publication audit input.
- Whitespace-only raw output does not become a label-only message, while
  media-only output still retains its documented labeled text envelope.
- Sender labels containing Markdown/HTML metacharacters render literally in
  every rich-text adapter and without escape artifacts in plain-text adapters.
- A Weixin sender label beginning with `IMAGE:` is never parsed as a media
  marker; only the raw result body is eligible for marker extraction.
- One-shot, each block-stream send, background proactive/fallback, direct shell
  success/failure, and media-only logical text are labeled.
- A long direct-shell or named-permission message uses the attributed thread
  boundary, so every adapter-owned platform split repeats the label.
- Output segment and user-input contexts carry the captured label.
- Started lifecycle consumers can read the label before the first segment.
- Named permission text contains the exact request ID and only supported exact
  command lines; raw tool input remains absent.
- Permission prompts, single-request failures, and acknowledgements use the
  captured session label after awaits; a multi-request ambiguity response lists
  the captured ASCII task name beside every request ID without claiming one
  message-level source.
- Missing presentation fails before prompt/shell execution, cancels permission,
  and rejects background output as specified.
- Legacy permission and output snapshots are byte-for-byte unchanged.
- Every Part 2 busy-selection test remains green and gains an explicit assertion
  that switching while running is still rejected.

### Adapters

- DingTalk: status/output/question/terminal cards, mentions, Markdown splits,
  proactive/background delivery, retries, image/file projection, and projector
  tail.
- Feishu: streaming/final/stopped/failed cards, truncation, question lifecycle,
  fallback, mention, and proactive delivery.
- QQ: idle, size, tool-call, deferred, retry, final, and block-stream flushes;
  no double prefix and unchanged reply sequence/context.
- Telegram: response and proactive paths prefix every HTML chunk, keep it
  valid and within 4096 characters, and retain the label across code blocks,
  links, nested tags, and plain fallback.
- WeCom: every Markdown chunk is prefixed and within 3800 UTF-8 bytes; code
  fences, response and proactive paths, and media-only results retain the label.
- GitHub, DWS, GitLab, Weixin, and plugin example: custom/inherited final,
  progressive, thread, and media paths render once at the correct boundary.
- DWS named proactive IM delivery still suppresses raw `[NO_REPLY]` before the
  base proactive formatter can add a label.
- GitHub definite-no-write persistence stores raw response and optional label
  separately; a retry after adapter restart has the same visible label while
  its audit hash and character count still describe the raw response. Legacy
  records without the optional field and malformed records follow their
  existing compatibility and rejection behavior.

### Repository verification

Run individual package tests from each package directory, then:

```bash
npm run build
npm run typecheck
npm run lint
```

Execute the focused plan in
`.qwen/e2e-tests/channel-named-sessions-part3a.md`. The three-task concurrent
switch/cancel plan remains deferred to Part 3B.

## Size and review strategy

The adapter audit shows the earlier umbrella estimate was too small because it
did not include every custom final-send override or prefix-aware Telegram,
WeCom, and DingTalk split path.

Expected Part 3A diff, excluding generated files and lockfiles:

| Area                                                |  Production |      Tests/docs |
| --------------------------------------------------- | ----------: | --------------: |
| manager index and bootstrap                         |       45–75 |         100–170 |
| base capture and permission presentation            |     110–180 |         260–420 |
| DingTalk and Feishu cards/splits                    |     140–230 |         300–500 |
| QQ, Telegram, and WeCom splits/retries              |     110–190 |         260–450 |
| GitHub, DWS, Weixin/GitLab coverage, plugin example |       45–85 |         100–190 |
| **Total**                                           | **450–760** | **1,020–1,730** |

The change is cross-package infrastructure and should be escalated for
maintainer awareness. It remains a feature rather than a large refactor, and
its production scope is bounded by the existing delivery consumers. Review
should be performed by behavior family: manager/base, cards, streaming/splits,
and compatibility. Part 3B must not be folded into review fixes.

## Alternatives reviewed

### Prefix once in ChannelBase

Rejected. Adapter-internal splits after that point would leave later messages
unlabeled, and card adapters own whole-object replacement semantics.

### Let every adapter look up the selected task

Rejected. Selection is an inbound compatibility pointer and can differ from
the originating session in Part 3B. It would also duplicate registry and
observed-contact logic across adapters.

### Persist the formatted label

Rejected as registry, transcript, or general runtime state. Display names are
mutable, presentation-specific data, so persisting them there would require a
migration and introduce another authority beside the owner registry and
observed-contact graph. GitHub's pre-existing durable final-delivery outbox is
the narrow exception: it stores the already-captured optional label separately
from raw response content only for retrying that exact visible comment.

### Infer whether a retry is already labeled from text

Rejected. Model output can legitimately begin with the same bracketed text,
and string inspection cannot distinguish raw content from an earlier
presentation attempt.

### Change bare permission semantics in 3A

Rejected. The selected-task filter is required for concurrent switching but is
not a presentation prerequisite. Shipping it here would expand authority
behavior and make the intermediate permission copy claim a concurrency model
that remains unreachable behind Part 2's busy guard.

### Support only DingTalk, Feishu, and QQ initially

Rejected. `multiSession` is a common Channel option, not an adapter-specific
capability. Partial rendering would make the same configuration silently unsafe
on another in-repository adapter such as Telegram, WeCom, GitHub, or DWS. The
repository therefore lands all built-ins together; out-of-repository adapters
remain governed by the explicit extension contract above rather than being
silently certified by this PR.

## Exit criteria for Part 3B

Part 3B may begin only when all of the following are true on the merged Part 3A
head:

- every exact managed session has a tested presentation lookup;
- every independently visible in-repository delivery boundary is labeled in
  named mode;
- every named text permission prompt exposes its exact request ID;
- permission and card actions still enforce their existing captured ownership;
- raw transcript content and disabled-mode output remain unchanged;
- Part 2 busy-switch rejection remains intact; and
- focused tests, build, typecheck, lint, and Part 3A E2E evidence are green.
