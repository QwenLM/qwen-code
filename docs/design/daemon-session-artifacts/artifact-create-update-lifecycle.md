# Session Artifact Create and Update Lifecycle

[English](artifact-create-update-lifecycle.md) | [简体中文](artifact-create-update-lifecycle.zh-CN.md)

- Status: Proposal (not implemented)
- Date: 2026-10-15
- Issue: [#14282](https://github.com/QwenLM/qwen-code/issues/14282)
- Related designs: [session-artifacts-persistence-v2-design.md](session-artifacts-persistence-v2-design.md), [session-artifacts-directory-expansion.md](../session-artifacts-directory-expansion.md), [web-shell-tool-file-preview.md](../web-shell-tool-file-preview.md)

## 1. Background and problem

Artifacts today follow a "register once on creation" model: `write_file` records files with certain extensions automatically, and everything else depends on the model calling `record_artifact`. Common scenarios fall through:

- A user uploads a file into the workspace and asks the agent to change it. The agent uses `edit`, no artifact is produced, and the file never shows up in the artifact list.
- When a recorded artifact is later modified by `edit`, its baseline is not reset. The next list refresh marks it `changed`, so the agent's own edit looks like an external modification.
- When `write_file` creates a file and `edit` modifies it later, the artifact stays on the creating turn and is not visible in the turn that changed it.

How a host registers non-file resources (for example data tables) as artifacts is out of scope. qwen-code only needs a reliable create/update path for workspace files.

## 2. Current behavior (verified on `main`)

### 2.1 Pipeline

```text
Tool ToolResult.artifacts
  → ACP tool_call_update._meta.artifacts          (cli: tool-call-emitter.ts)
  → bridge extractSessionUpdateArtifacts          (acp-bridge: bridgeClient.ts; field allowlist, strips _meta.artifacts before forwarding)
  → SessionArtifactStore.upsertMany               (acp-bridge: sessionArtifacts.ts; serialized mutation queue)
      expandWorkspaceDirectoryInput → normalizeInput (stat + hash, sets the qwen.workspace.* baseline)
      → created if absent; otherwise mergeArtifact → updated if public fields changed
  → artifact_changed SSE → Web Shell refetches the list
```

Other entry points: PostToolUse hook `hookSpecificOutput.artifacts`, client `POST /session/:id/artifacts`, and slash-command `_meta.sessionArtifacts`.

### 2.2 Which tools produce artifacts

| Tool                                  | Produces | Notes                                                                                                                                                                |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_file`                          | Partly   | Only extensions in `ARTIFACT_KIND_BY_EXTENSION` (`.csv/.htm/.html/.ipynb/.jpeg/.jpg/.pdf/.png/.svg/.webp` and office documents); `record_as_artifact=false` opts out |
| `record_artifact`                     | Yes      | Explicit model call                                                                                                                                                  |
| `artifact` / `image_gen` / omni tools | Yes      | Published HTML, generated images, media derivatives                                                                                                                  |
| `edit` (including file creation)      | No       | Every return path carries only `llmContent` + `returnDisplay`                                                                                                        |
| `notebook_edit`                       | No       | No artifact references at all                                                                                                                                        |
| `run_shell_command` / MCP tools       | No       | Not addressed here (see Section 6)                                                                                                                                   |

### 2.3 Store merge semantics

- Identity: `stableSessionArtifactId(sessionId, 'workspace:<canonicalPath>')`; one path is one artifact.
- Baseline: `normalizeInput` stats and hashes the file inside the queue and writes `qwen.workspace.sha256 / mtimeMs / sizeBytes`. List/get refresh lazily with a 5-second TTL and set `changed` when live content drifts from the baseline, **without publishing an event**.
- The baseline comes only from the store's own read: `normalizeMetadata` strips `qwen.workspace.*` keys from input, and the live `upsertMany` path calls `normalizeInput` without `workspaceExpected`; only restore paths pass persisted fingerprints as expected values. So today a tool cannot declare which content it wrote, and an external change between the write and the registration is silently absorbed into the baseline.
- In `mergeArtifact`, `status` and `sizeBytes` always come from the incoming input. `metadata` goes through `mergeMetadata`, which returns the existing metadata unchanged when `incoming.source !== existing.source` (or the source is a hook), so **new fingerprints are not adopted**.
- Display fields (`title`, `description`, `toolCallId`, `toolName`, `source`, `hookEventName`) refresh only when `shouldRefreshWorkspaceDisplay` is true: `record_artifact` (non-hook), a registration without `toolName`, or an exact match of `toolName`, `source`, and `hookEventName`. The code comment explicitly forbids auto-records from clobbering the user-visible title.
- Vanish-forgetting (`isVanishedAutoRecordedWorkspaceArtifact`) and presence recheck (`shouldRecheckWriteFilePresence`) are both hard-coded to `toolName === 'write_file'`.

### 2.4 Web Shell

- `canDownloadArtifact` already accepts both `available` and `changed`, `ArtifactPanel` previews them the same way, and a test pins this. The only missing piece is a "modified outside this session" hint for `changed`.
- Turn attribution: paths in `record_artifact` arguments can appear in several turns; everything else appears in the single turn of `artifact.toolCallId`.

### 2.5 Gaps

| #   | Gap                                                                                  | Consequence                                                                                                                     |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Only `write_file` auto-records; `edit` / `notebook_edit` do not                      | Uploaded-then-edited files and files created with `edit` are missing                                                            |
| G2  | Editing a recorded artifact with `edit` sends no upsert                              | No baseline reset, no event; the artifact later turns `changed`                                                                 |
| G3  | `mergeMetadata` does not adopt fingerprints across sources                           | For cross-source combinations (for example client-registered, then agent-edited) it falls back to `changed` even with an upsert |
| G4  | `shouldRefreshWorkspaceDisplay` requires the same `toolName` to advance `toolCallId` | Created by `write_file`, edited by `edit`: the artifact stays on the creating turn (raised by a reviewer)                       |
| G5  | Vanish/recheck rules are hard-coded to `write_file`                                  | Artifacts created by `edit` / `notebook_edit` are not forgotten or rechecked correctly                                          |

Note: `write_file` and `edit` both use source `tool`, so once G1 is fixed, fingerprint adoption and the `updated` event already work between them. G4 only affects turn attribution; G3 affects cross-source combinations.

## 3. Goals and non-goals

Goals:

1. Deliverables the agent **creates or modifies** in the workspace with `write_file` / `edit` / `notebook_edit` enter the artifact list under one policy.
2. When the agent modifies an **already recorded** file (any extension, any registration source), the same id emits `updated`, the baseline is reset, and status stays `available`.
3. An artifact appears at least in the most recent turn that modified it.
4. Existing artifacts coexist safely: identity rules unchanged, no migration, no workspace scan, no bulk reset.

Non-goals:

- No extension setting; the built-in set only gains the four extensions listed in 4.2.
- No revision trail, content snapshots, or shell output detection (split into separate issues, see Section 6).
- No turning every source edit into an artifact.
- No coverage of files inside remote execution workers.

## 4. Design

### 4.1 Lifecycle rules

| Event                                                        | Store behavior                                                      | status    | Event           |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | --------- | --------------- |
| Agent writes an unrecorded file matching the policy          | Create and set the baseline                                         | available | created         |
| Agent writes a **recorded** file (any extension, any source) | Update, reset the baseline, advance `toolCallId` to this call       | available | updated         |
| Agent writes an unrecorded file outside the policy           | Ignore (no stat, no hash)                                           | –         | –               |
| Unchanged rewrite / true no-op edit / failed write           | No candidate                                                        | –         | –               |
| User or external process modifies the file                   | Detected on lazy refresh                                            | changed   | None (as today) |
| File deleted                                                 | Auto-recorded artifacts are forgotten; explicit ones become missing | missing   | removed / none  |
| `write_file` with `record_as_artifact=false`                 | Blocks creation only; recorded artifacts still sync                 | –         | –               |

Semantics: `changed` only means drift caused by something other than the agent; every successful agent write resets the baseline.

### 4.2 Shared auto-record policy

Extract the extension map, workspace path resolution, skipped directories, display-safety checks, and MIME/kind inference from `write-file.ts` into `packages/core/src/tools/artifact/workspace-auto-record.ts`. `write_file`, `edit` (including creation), and `notebook_edit` call it **after the write is committed**:

- Returns `null`: artifacts disabled, outside the workspace, in a skipped directory, or an unsafe path or title.
- Built-in extension match: returns a normal candidate.
- No match, or `record_as_artifact=false`: returns a candidate with `updateOnly: true`.
- The candidate carries the hash of the content just written in a new ingestion field, `expectedSha256` (the tool already holds the content in memory, so no extra IO).

The built-in extension set gains `.sql`, `.py`, `.md`, and `.json`, all with kind `file`. They are the most common deliverables in data and analysis work; adding them to the defaults instead of a setting avoids a new settings surface. Existing skip rules (dot directories, `node_modules`, `dist`, and so on) and `record_as_artifact=false` still apply. Artifact registration problems must not turn a successful file write into a failed tool call. Only newly created artifacts append a hint to `llmContent`; `updateOnly` candidates do not.

### 4.3 Ingestion instructions: `updateOnly` and `expectedSha256`

```ts
interface ToolArtifact {
  // ...existing
  /** Update an existing artifact with the same identity; drop otherwise. Not persisted. */
  updateOnly?: boolean;
  /** sha256 of the content the tool just wrote; used by the store as the expected fingerprint. Not persisted. */
  expectedSha256?: string;
}
```

- Add both fields explicitly to the `artifactPayloadFields` allowlist in `bridgeClient.ts` and to `SessionArtifactInput`, or they are filtered out. ACP `_meta.artifacts` only gains optional fields that older clients ignore.
- They are ingestion instructions, not artifact state: never written to the journal/snapshot and never exposed on the public artifact.
- `expectedSha256` does not travel through metadata, so the existing rule that inputs may not stamp `qwen.workspace.*` keys is not loosened. It can only make the result more conservative (a mismatch yields `changed`); it can never set a baseline on its own.
- `updateOnly` only narrows behavior, so hook and client sources may use it too.

### 4.4 Store changes (`sessionArtifacts.ts`)

1. **Short-circuit `updateOnly` first**: inside the serialized queue and before `expandWorkspaceDirectoryInput`, resolve the identity from the canonical path and check existence. If absent, drop it: no create, delete, eviction, publish, or stat/hash. If present, continue through normal `normalizeInput` validation.
2. **Expected-fingerprint check (new wiring)**: `upsertMany` turns the incoming `expectedSha256` into `normalizeInput`'s `workspaceExpected: { sha256 }`. The existing comparison in `getWorkspaceStatus` is reused as is: a matching hash returns `available` and `withWorkspaceContentHashMetadata` stamps the new baseline; a mismatch (the file changed again after the write) returns `changed`, and that helper only stamps a baseline for `available`, so a stale read never becomes the baseline. Inputs without `expectedSha256` (client, hook, `record_artifact`) behave as today.
3. **Cross-source fingerprint adoption**: for `isAdoptableContentFingerprintKey` keys (`qwen.workspace.*`), `mergeMetadata` no longer requires the same source when the incoming source is `tool` and step 2 validated it. Other metadata keys, hook sources, and publisher-trust rules are unchanged.
4. **Advance turn attribution by file identity**: decouple "advance `toolCallId`" from "refresh title/description". When the incoming candidate comes from the auto-record producer set `{write_file, edit, notebook_edit}` and the content fingerprint actually changed, advance `toolCallId` to this call. `title`, `description`, `toolName`, `source`, `hookEventName`, ownership, and retention still follow the existing `shouldRefreshWorkspaceDisplay` rule, so auto-records never overwrite the user-visible title. `toolName` keeps the creator, so forgetting rules still depend on who created the artifact.
5. **Generalize vanish/recheck predicates**: replace `toolName === 'write_file'` with `source === 'tool' && toolName ∈ {write_file, edit, notebook_edit}`. Client-registered, `clientRetained`, and explicit `record_artifact` entries behave as today.

Rejected alternatives: making `edit` / `notebook_edit` masquerade as `toolName: 'write_file'` (couples behavior to a name that is not true), and relaxing `shouldRefreshWorkspaceDisplay` wholesale (auto-records would overwrite user titles).

### 4.5 Web Shell (in the first implementation PR)

- Download rules are unchanged (`changed` is already downloadable).
- Add a "modified outside this session" hint on `changed` cards, plus a regression test pinning the existing `changed` download behavior.
- Turn attribution follows the advanced `toolCallId` to the most recent modifying turn, matching how a `write_file` rewrite behaves today. The `artifactsByTurn` type does not change.

### 4.6 Uploaded files

- Files uploaded into the workspace and then modified by the agent are created by 4.2 on the first modification when they match the built-in extensions (including the new `.sql`, `.py`, `.md`, `.json`); the host does not need to register them on upload.
- Types outside the built-in set: agent modifications never create an artifact for them, and they sync through `updateOnly` only if they were already registered some other way.
- Files that are uploaded but never modified are inputs; qwen-code does not record them on its own.

### 4.7 Compatibility with existing artifacts

**No data migration, no workspace scan or backfill, and no change to existing artifact ids.** Persistence stays V2 journal/snapshot; this design adds no persisted fields.

| Scenario                                                   | Behavior after upgrade                                                                                  | Handling                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Existing artifact, untouched after upgrade                 | Same as today                                                                                           | None                                                                                 |
| Workspace file that was never recorded                     | Not backfilled                                                                                          | Only a later agent write (matching the policy) or explicit registration creates it   |
| Existing `.sql/.py/.md/.json` files in old sessions        | Not backfilled; created only when the agent modifies them after the upgrade                             | Expected behavior change from widening the defaults                                  |
| Existing artifact modified again by the agent              | Same id emits `updated`, baseline reset, `toolCallId` advanced                                          | This is the fix                                                                      |
| Old entry already `changed` (usually a past unsynced edit) | Stays `changed` (downloadable) until the next agent write                                               | **No bulk reset**: an old missed sync cannot be told apart from a real external edit |
| Client / hook / `record_artifact` registrations            | Identity, ownership, title, retention, and tombstones unchanged; agent edits adopt new fingerprints     | None                                                                                 |
| Published / managed / link / external_url                  | Not on the workspace auto-record path                                                                   | None                                                                                 |
| Old bridge + new core                                      | The old allowlist strips both new fields, so `updateOnly` candidates would be created as normal records | Core and acp-bridge changes must ship in the same release                            |
| Old Web Shell + new daemon                                 | Only the `changed` hint is missing                                                                      | None                                                                                 |

Constraints implementation and review must preserve:

1. Identity keys unchanged: `workspace:<canonicalPath>` (and managed/url).
2. No workspace scan or backfill.
3. Never bulk-convert `changed` to `available`.
4. `updateOnly` never removes or evicts an existing entry.
5. Contract test: restore a V2 snapshot/journal fixture written before the upgrade and assert the same count and ids; `edit` one entry and assert the same id with action `updated`; another untouched entry that was modified externally stays `changed`.

## 5. Phasing

### 5.1 PR 1: consistent create/update (the body of this design)

- core: shared policy module; `write_file` calls it; `edit` and `notebook_edit` return artifacts; `ToolArtifact.updateOnly` / `expectedSha256`; tool descriptions updated.
- acp-bridge: allowlist both new fields; `updateOnly` short-circuit; wire `expectedSha256` into `workspaceExpected`; cross-source fingerprint adoption; advance `toolCallId` by file identity; generalized vanish/recheck predicates.
- web-shell: `changed` hint and regression test.
- Tests: unit tests for the three tools; store tests for `updateOnly` (unknown dropped without stat, known updated), cross-source baseline reset, `write_file` create + `edit` modify advancing `toolCallId` while keeping the title, forgetting artifacts created by `edit`, concurrent queued updates, and stale reads not becoming baselines; the V2 compatibility contract test.

Four default extensions added and no settings; the PR delivers value on its own.

### 5.2 Follow-up PR: show repeated modifications per turn

Extend the existing transcript-based reference grouping to completed `write_file` / `edit` / `notebook_edit` output paths, matched against the authoritative artifact list by canonical path. The same artifact appears in every turn that modified it, deduplicated within a turn, with an "Updated" badge after the first. Because it is derived from the transcript, it survives refresh and replay without collapsing onto the latest `toolCallId`, and **the store data model does not change**. Cards show current content and do not imply historical snapshots.

## 6. Split out of scope (separate issues)

- A bounded per-artifact revision trail (tool call, hash, size) and revision content snapshots.
- Detecting and attributing files created or modified by foreground shell commands.
- Mapping artifacts from MCP tool result `_meta`.

## 7. Risks

- **Treating every write as a new artifact**: bounded by "everything outside the built-in policy is `updateOnly`", with tests.
- **Noise in coding sessions**: the new `.md`, `.json`, and `.py` are common in ordinary coding (README, `package.json`, source files) and become artifacts once the agent modifies them. Mitigation: skip-directory rules unchanged; `record_as_artifact=false` still opts out per call; the store's 200-entry cap and eviction rules unchanged. This is the cost of widening defaults instead of adding a setting, and review should confirm it is acceptable.
- **Accepting an unverified fingerprint as a baseline**: bounded by in-queue stat/hash compared with `expectedSha256`.
- **Large files**: files over 100MB are not hashed, and with `expectedSha256` present the existing logic returns `changed`; tools should omit the field for such files, keeping today's size-based baseline.
- **Performance**: `updateOnly` candidates for unrecorded files short-circuit before stat; recorded files are stat'ed and hashed on each modification (existing 100MB cap).
- **Journal growth**: one event per update, using the existing snapshot compaction cadence.
- **Turn attribution moves**: an artifact modified again appears in the newer turn, matching today's `write_file` behavior; this is intended.

## 8. Validation

Before implementation, write an E2E plan in `.qwen/e2e-tests/` and dry-run it against the global `qwen` CLI to record the baseline.

1. Upload `orders.csv` and ask the agent to add a column with `edit` → artifact created, shown in this turn, previewable and downloadable.
2. Modify again next turn → same id emits `updated`, status `available`, shown in the latest turn.
3. `write_file` creates `report.html`, then `edit` modifies it → same id, `toolCallId` advanced, title unchanged.
4. The host registers `data.xlsx` (client) first, then the agent modifies it → synced, not `changed`, ownership and retention unchanged.
5. Upload `orders.sql` and ask the agent to add a column with `edit` → artifact created without any host registration; same for `.py`, `.md`, `.json`.
6. Unrecorded `src/foo.ts` (outside the built-in set) edited → no artifact, and the store does not stat it.
7. External modification → `changed` with the hint, still downloadable.
8. The file changes externally between the write and the registration (simulated in a unit test) → `expectedSha256` mismatch, status `changed`, baseline not updated.
9. In a worktree / multi-workspace setup, write and edit the same file → same id.
10. V2 compatibility contract (constraint 5 in 4.7).

Each code PR runs the affected package unit tests and `npm run build && npm run typecheck`, completes the self-audit, and attaches E2E evidence.

## 9. Open questions

1. Should external modifications (`changed`) publish an event so hosts notice them in real time?
2. When a host saves user edits through `/file/write`, should that reset the baseline? It requires reaching the session-scoped store from a workspace-scoped route, which raises route-ownership questions, so it is not included for now.
