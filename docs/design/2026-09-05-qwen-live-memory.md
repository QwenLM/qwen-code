# Qwen Live memory

## Scope

Port the memory subsystem from qwen-omni-realtime-agent into standalone Qwen
Live: library storage and management, dialogue recording and segmentation,
working-memory edits, LTM/STM preload and consolidation, hybrid dialogue and
visual-observation retrieval, and optional visual observation. Memory is enabled
by default and stores its data beneath the Live data directory, normally
`~/.qwen-live/memories`.

The orb provides Memory and Visual memory switches, library selection, New,
and Rename. Library ids are stable and names never become filesystem paths.
Browser session archives, hidden prompt inspectors, library deletion, Frontier,
and publishing are outside this port.

## Runtime and storage

One daemon owns MemoryStore and shared model clients. Each Live call attaches
one MemorySession to the selected library. The library retains the prototype's
SQLite v1 schema and meta.json shape; no existing prototype data is imported
automatically. Node's built-in SQLite/FTS5 requires Node >=22.13. Jieba search
tokenization is used consistently for index and query text.

The recorder stores final dialogue text, segments and interrupted-answer
markers. Synthetic Proactive, backend speech and repair turns do not become
user dialogue. Raw audio and camera frames are not persisted. LTM and STM are
preloaded once per attachment, while retrieved context and the ordered WM list
change through tools. All ids, paths, database statements and model patches are
validated; directories/files use private permissions.

Dialogue retrieval retains FTS OR/AND ranking, vector fallback and RRF fusion,
soft time-range boosting, unsegmented tail search, and both raw/rendered
budgets. Env retrieval has a separate index, keyword-first ranking and temporal
spacing. Embeddings use text-embedding-v4 by default, cache queries, backfill
missing rows asynchronously, and degrade to keyword search on unavailable or
slow providers. Model identity is included when selecting stored vectors.

Closing an attachment flushes dialogue and schedules WM consolidation. Model
work is serialized per library. Each WM snapshot version is applied at most
once, including repeated OFF/ON within a call. Updater patches follow the
source LTM/STM operation ordering and never write visual observations. Shutdown
waits for the configured bounded grace period; abandoned work is reported and
does not silently claim successful consolidation.

## Model configuration

Port only effective memory settings, in camelCase groups: retrieve, preload,
updater, observer, wm and segment. The master default is true. Observer capture
defaults to false and its periodic interval defaults to 60 seconds.

Updater and Observer use ordinary compatible Chat Completions, not the Live
Realtime model or voice. The public default is qwen3.7-plus, using the
current DashScope API key and matching compatible endpoint; optional baseUrl
and apiKeyEnv overrides preserve alternate deployments. The prototype's
internal gateway and private credential name are not hardcoded. The user
confirmed this choice. Init asks whether to enable Memory and, when enabled,
asks for this model name. The orb exposes the same consolidation-model setting.

## Memory tools and prompt publication

Preserve the source omnibio and omniretrieve schemas, descriptions and memory
guidance. Both are local receipt tools operating only with genuine-user-turn
authority. Memory sections are untrusted data and cannot authorize tools.

The four sections are always ordered user_profile, recent, retrieved,
personalized_user_memories. A successful retrieval replaces retrieved as a
whole; a valid empty result clears it, while invalid/failed requests preserve
it. Tool receipts carry status/counts, and the text itself is sent through
instructions. A continuation response.create includes the latest instructions;
the durable session.update is deferred until response idle. Socket event
handlers never await session.updated. Disabling memory immediately revokes
memory tool handling and stages removal of all memory instructions.

## Orb settings and isolation

The daemon is authoritative for settings and publishes memory state over the
existing authenticated Host WebSocket. Actions carry correlation ids and
explicit results. Accepted switch/selection changes persist by atomically
merging only memory preferences into the Live config file.

Source-compatible behavior: Memory and Visual memory switches apply
to the active call; Rename changes metadata at any time. Select/New are locked
while a call is starting/active/stopping and become available after it ends,
preventing old-library context from leaking into a newly selected library.
The user confirmed this boundary. New creates and selects a
library; turning Memory off preserves its selection and stored contents.

The Host uses an English overlay panel with inline name editing, Save/Cancel,
and a bounded scrolling library list. Input drafts, focus and selection survive
normal audio/status updates. No browser prompt dialog or extra management HTTP
server is needed. Built-in qwen serve omits the optional memory capability.

## Visual observations

When enabled, observation follows the orb's current Screen/Camera source.
Live Feed reuses the latest frame. On Demand privately captures a bounded frame
at the observation cadence without invoking foreground Appshot or creating an
asset. The first available frame is observed promptly; stale frames are
discarded. Observer records only a cleaned description in stm_env and its
indexes. A source marker accompanies the original Observer prompt so screen
content is not presented as the user's physical room.

Capture/model completions are fenced by attachment, library and source
generation. Switching a source or turning memory/visual observation off
invalidates outstanding observation work. Historical visual retrieval remains
available while live visual observation is off.

## Verification

Port the prototype's key behavioral tests: SQLite interoperability and private
files, library isolation, recorder sequencing, WM operation order, LTM/STM
patch validation and expiry, ranking and budgets, embedding fallback, visual
deduplication, consolidation idempotence, and late callback rejection.
Integration tests cover live transcript ownership, safe prompt publication,
toggle/selection lifecycle and all orb actions. Model/network/camera behavior
uses local controlled fixtures rather than recording user media.

The detailed baseline and results are kept in
`.qwen/e2e-tests/2026-09-05-qwen-live-memory.md`. Existing Proactive, Appshot and
audio regression suites remain required.
