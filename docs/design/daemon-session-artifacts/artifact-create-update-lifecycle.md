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
  → persisted with the tool result in the transcript (record.metadata.artifacts)
  → ACP tool_call_update._meta.artifacts          (cli: tool-call-emitter.ts)
  → bridge extractSessionUpdateArtifacts          (acp-bridge: bridgeClient.ts; field allowlist, strips _meta.artifacts before forwarding)
  → SessionArtifactStore.upsertMany               (acp-bridge: sessionArtifacts.ts; serialized mutation queue)
      expandWorkspaceDirectoryInput → normalizeInput (stat + hash, sets the qwen.workspace.* baseline)
      → created if absent; otherwise ownership check → mergeArtifact → updated if public fields changed
  → artifact_changed SSE → Web Shell refetches the list
```

Other entry points: PostToolUse hook `hookSpecificOutput.artifacts`, client `POST /session/:id/artifacts` (with a trusted `clientId`), and slash-command `_meta.sessionArtifacts`.

### 2.2 Which tools produce artifacts

| Tool                                  | Produces | Notes                                                                                                                                                                |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_file`                          | Partly   | Only extensions in `ARTIFACT_KIND_BY_EXTENSION` (`.csv/.htm/.html/.ipynb/.jpeg/.jpg/.pdf/.png/.svg/.webp` and office documents); `record_as_artifact=false` opts out |
| `record_artifact`                     | Yes      | Explicit model call                                                                                                                                                  |
| `artifact` / `image_gen` / omni tools | Yes      | Published HTML, generated images, media derivatives                                                                                                                  |
| `edit` (including file creation)      | No       | Every return path carries only `llmContent` + `returnDisplay`                                                                                                        |
| `notebook_edit`                       | No       | No artifact references at all                                                                                                                                        |
| `run_shell_command` / MCP tools       | No       | Not addressed here (see Section 6)                                                                                                                                   |

### 2.3 Store semantics

- Identity: `stableSessionArtifactId(sessionId, 'workspace:<canonicalPath>')`; one path is one artifact.
- Baseline: `normalizeInput` stats and hashes the file inside the queue and writes `qwen.workspace.sha256 / mtimeMs / sizeBytes`. List/get refresh lazily with a 5-second TTL and set `changed` when live content drifts from the baseline, **without publishing an event**. An entry without a fingerprint baseline has the current content stamped as its baseline on refresh.
- The baseline comes only from the store's own read: `normalizeMetadata` strips `qwen.workspace.*` keys from input, and the live `upsertMany` path calls `normalizeInput` without `workspaceExpected`; only restore paths pass persisted fingerprints as expected values. An external change between the write and the registration is absorbed into the baseline.
- Ownership: `denyCrossClientMutation` rejects upserts from a different `clientId` against `source: 'client'` entries that carry a `clientId`. Tool inputs carry no `clientId`, so **an agent edit to a host-registered file is rejected**.
- Merge: in `mergeArtifact`, `status` and `sizeBytes` come from the incoming input; `mergeMetadata` keeps the existing metadata when `incoming.source !== existing.source` (or the source is a hook), so **new fingerprints are not adopted**.
- Display fields (`title`, `description`, `toolCallId`, `toolName`, `source`, `hookEventName`) refresh only when `shouldRefreshWorkspaceDisplay` is true: `record_artifact` (non-hook), a registration without `toolName`, or an exact match of `toolName`, `source`, and `hookEventName`. The code comment explicitly forbids auto-records from clobbering the user-visible title.
- Deletion: `shouldSuppressTombstonedUpsert` only blocks client sources from resurrecting; a tool or hook artifact the user deleted is recreated by the next registration of the same path.
- Eviction: above 200 entries the store evicts, in order, the oldest missing entry, entries over their source reservation, then the oldest non-`clientRetained` entry.
- Vanish-forgetting (`isVanishedAutoRecordedWorkspaceArtifact`) and presence recheck (`shouldRecheckWriteFilePresence`) are both hard-coded to `toolName === 'write_file'`.

### 2.4 Web Shell

- `canDownloadArtifact` already accepts both `available` and `changed`, `ArtifactPanel` previews them the same way, and a test pins this. The only missing piece is a hint for `changed`.
- Turn attribution (`getArtifactsByTurn`): paths from `record_artifact` arguments and `reportedArtifacts` are matched first; **only when none match** does `artifact.toolCallId` place the artifact in a single turn.

### 2.5 Downstream consumers of `ToolResult.artifacts`

| Consumer                                                                | Behavior                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Bridge live ingestion (`sessionUpdate` → `upsertAndPublishArtifacts`)   | Writes to the artifact store                                                                                                         |
| Transcript recording and `session/load` replay (`transcript-replay.ts`) | Tool results are persisted as is; without an artifact snapshot, or when restore fails, `seedSessionUpdates` re-ingests them in order |
| `toolResultBoundaryArtifact`                                            | Counts artifact kinds for diagnostics only                                                                                           |
| Managed runtime provider protocol                                       | Drops `artifacts` when the result exceeds the size limit                                                                             |
| Media policy collection                                                 | Only for tools with a `mediaPolicyDescriptor`; `write_file` / `edit` / `notebook_edit` have none                                     |

### 2.6 Gaps

| #   | Gap                                                                                  | Consequence                                                                                               |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| G1  | Only `write_file` auto-records; `edit` / `notebook_edit` do not                      | Uploaded-then-edited files and files created with `edit` are missing                                      |
| G2  | Editing a recorded artifact with `edit` sends no upsert                              | No baseline reset, no event; the artifact later turns `changed`                                           |
| G3  | `mergeMetadata` does not adopt fingerprints across sources                           | Artifacts registered by a hook or an anonymous client fall back to `changed` after a tool rewrite         |
| G4  | Host registrations with a `clientId` reject tool upserts                             | Host-registered files edited by the agent do not sync and turn `changed`                                  |
| G5  | `shouldRefreshWorkspaceDisplay` requires the same `toolName` to advance `toolCallId` | Created by `write_file`, edited by `edit`: the artifact stays on the creating turn (raised by a reviewer) |
| G6  | Web Shell ignores `toolCallId` when a `record_artifact` reference exists             | Even with `toolCallId` advanced, explicitly registered artifacts never show in the modifying turn         |
| G7  | Vanish/recheck rules are hard-coded to `write_file`                                  | Artifacts created by `edit` / `notebook_edit` are not forgotten or rechecked correctly                    |
| G8  | A tool artifact the user deleted is resurrected by the next registration             | Becomes frequent once `edit` auto-records                                                                 |

## 3. Goals and non-goals

Goals:

1. Deliverables the agent **creates or modifies** in the workspace with `write_file` / `edit` / `notebook_edit` enter the artifact list under one policy.
2. When the agent modifies an **already recorded** file (any extension, any registration source, including host registrations with a `clientId`), the same id emits `updated`, the content baseline syncs, and status stays `available`. The host's title, retention, and ownership are unchanged.
3. An artifact appears in the most recent turn that modified it.
4. Existing artifacts coexist safely: identity rules unchanged, no migration, no workspace scan, no bulk reset.

Non-goals:

- No extension setting; the built-in set only gains the four extensions listed in 4.2. Source files outside the allowlist (such as `.ts`) never create artifacts when modified.
- No revision trail, content snapshots, or shell output detection (split into separate issues, see Section 6).
- No coverage of files inside remote execution workers.

## 4. Design

### 4.1 Lifecycle rules

| Event                                                                         | Store behavior                                                                          | status    | Event             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------- | ----------------- |
| Agent writes an unrecorded file matching the policy                           | Create and set the baseline                                                             | available | created           |
| Agent writes a **recorded** file (any extension, any source)                  | Update, sync the content baseline, advance `toolCallId` to this call                    | available | updated           |
| Agent writes an unrecorded file outside the policy                            | Ignore (no stat, no hash)                                                               | –         | –                 |
| Agent writes a path the **user deleted**                                      | Treated as `updateOnly`, not resurrected; explicit `record_artifact` still recreates it | –         | –                 |
| File changes again between write and registration (`expectedSha256` mismatch) | Baseline is the agent's written content                                                 | changed   | created / updated |
| Unchanged rewrite / true no-op edit / failed write                            | No candidate                                                                            | –         | –                 |
| User or other means modify the file (including agent shell commands)          | Detected on lazy refresh                                                                | changed   | None (as today)   |
| File deleted                                                                  | Auto-recorded artifacts are forgotten; explicit ones become missing                     | missing   | removed / none    |
| `write_file` with `record_as_artifact=false`                                  | Blocks creation only; recorded artifacts still sync                                     | –         | –                 |

Semantics: `changed` only means "drifted from the content most recently written by an agent file tool".

### 4.2 Shared auto-record policy

Extract the extension map, workspace path resolution, skipped directories, display-safety checks, and MIME/kind inference from `write-file.ts` into `packages/core/src/tools/artifact/workspace-auto-record.ts`. `write_file`, `edit` (including creation), and `notebook_edit` call it **after the write is committed**:

- Returns `null`: artifacts disabled, outside the workspace, in a skipped directory, or an unsafe path or title.
- Built-in extension match: returns a normal candidate.
- No match, or `record_as_artifact=false`: returns a candidate with `updateOnly: true`.
- `expectedSha256`: the sha256 of the **bytes actually written to disk**. Tools preserve the original file's encoding (for example GBK), BOM, and CRLF line endings when writing, so the in-memory string differs from the bytes on disk and must not be hashed. The write implementation returns the hash of the bytes it wrote (`StandardFileSystemService` already holds the encoded data; `encodeTextFileContentAsync` produces the same bytes). When unavailable (writes delegated to the ACP client, managed/remote backends, files over 100MB), the field is omitted and today's "store reads its own baseline" behavior applies.

The built-in extension set gains `.sql`, `.py`, `.md`, and `.json`, all with kind `file`. They are the most common deliverables in data and analysis work; adding them to the defaults instead of a setting avoids a new settings surface. Existing skip rules (dot directories, `node_modules`, `dist`, and so on) and `record_as_artifact=false` still apply. Artifact registration problems must not turn a successful file write into a failed tool call. Only newly created artifacts append a hint to `llmContent`; `updateOnly` candidates do not.

### 4.3 Ingestion fields: `updateOnly` and `expectedSha256`

```ts
interface ToolArtifact {
  // ...existing
  /** Update an existing artifact with the same identity; drop otherwise. */
  updateOnly?: boolean;
  /** sha256 of the bytes the tool actually wrote; used by the store as the expected fingerprint. */
  expectedSha256?: string;
}
```

- Add both fields explicitly to the `artifactPayloadFields` allowlist in `bridgeClient.ts` and to `SessionArtifactInput`, or they are filtered out.
- They never enter the artifact journal/snapshot and never appear on the public artifact, but they are persisted with the tool result in the transcript. Snapshot-less replay re-applies them in order: intermediate entries whose hash differs from the current file are briefly `changed`, and the last write converges to `available` when it matches the current file; a file modified externally after the session correctly stays `changed`.
- `expectedSha256` does not travel through metadata, so the rule that inputs may not stamp `qwen.workspace.*` keys is not loosened. It only applies to tool sources.

### 4.4 Store changes (`sessionArtifacts.ts`)

1. **Short-circuit `updateOnly` first**: inside the serialized queue and before `expandWorkspaceDirectoryInput`, resolve the identity with the same path normalization as `normalizeInput` and check existence with the same lookup order as `upsertMany` (id, published targets). If absent, drop it: no create, delete, eviction, publish, or stat/hash. If present, continue through normal `normalizeInput`.
2. **Expected fingerprint (new wiring)**: `upsertMany` turns `expectedSha256` into `normalizeInput`'s `workspaceExpected: { sha256 }`, reusing the comparison in `getWorkspaceStatus`. Match: keep the store's own sha/mtime/size as the baseline, `available`. Mismatch: status `changed`, and **`expectedSha256` is stamped as the fingerprint baseline**. Otherwise a newly created entry would have no baseline, and the lazy refresh 5 seconds later would stamp the modified content as the baseline and flip the status back to `available`. Inputs without the field behave as today.
3. **Content-only sync across ownership**: when the input comes from the auto-record producer set `{write_file, edit, notebook_edit}` and the existing entry is a client registration with a `clientId`, do not reject through `denyCrossClientMutation`; merge only content fields instead: the fingerprint baseline, `status`, `sizeBytes`, and `toolCallId`. `title`, `description`, `source`, `clientId`, retention, and `clientRetained` never change. This loosens a permission boundary and **needs maintainer confirmation**.
4. **Cross-source fingerprint adoption**: for tool-sourced inputs that passed step 2, `mergeMetadata` adopts `isAdoptableContentFingerprintKey` keys without requiring the same source. Other metadata keys, hook-sourced inputs, and publisher-trust rules are unchanged.
5. **Advance turn attribution by file identity**: decouple "advance `toolCallId`" from "refresh title/description". When an input from the producer set is accepted, `toolCallId` advances to this call. `title`, `description`, `toolName`, `source`, and `hookEventName` still follow the existing `shouldRefreshWorkspaceDisplay` rule, so auto-records never overwrite the user-visible title. `toolName` keeps the creator, so forgetting rules still depend on who created the artifact.
6. **No resurrection after deletion**: a non-`updateOnly` candidate from the producer set that hits a tombstone is treated as `updateOnly` (and dropped because the entry does not exist). Resurrection rules for explicit `record_artifact`, hooks, and client registrations are unchanged.
7. **Generalize vanish/recheck predicates**: replace `toolName === 'write_file'` with `source === 'tool' && toolName ∈ {write_file, edit, notebook_edit}`. Client-registered, `clientRetained`, and explicit `record_artifact` entries behave as today.

Rejected alternatives: making `edit` / `notebook_edit` masquerade as `toolName: 'write_file'` (couples behavior to a name that is not true), and relaxing `shouldRefreshWorkspaceDisplay` wholesale (auto-records would overwrite user titles).

### 4.5 Web Shell (in the first implementation PR)

- Download rules are unchanged (`changed` is already downloadable).
- Add a "modified by other means since it was recorded" hint on `changed` cards (not "outside this session", because the agent's own shell commands also cause `changed`), plus a regression test pinning the existing `changed` download behavior.
- `getArtifactsByTurn`: **also** add the turn of `artifact.toolCallId` alongside `record_artifact` / `reportedArtifacts` matches (today it is used only when nothing matches). Explicitly registered artifacts then also appear in the most recent modifying turn; for today's entries `toolCallId` and the registering call share a turn, so results do not change. The `artifactsByTurn` type does not change.

### 4.6 Uploaded files

- Files uploaded into the workspace and then modified by the agent are created by 4.2 on the first modification when they match the built-in extensions (including the new `.sql`, `.py`, `.md`, `.json`); the host does not need to register them on upload.
- Types outside the built-in set: agent modifications never create an artifact for them, and they sync through `updateOnly` only if they were already registered some other way.
- Files that are uploaded but never modified are inputs; qwen-code does not record them on its own.

### 4.7 Compatibility with existing artifacts

**No data migration, no workspace scan or backfill, and no change to existing artifact ids.** Artifact persistence stays V2 journal/snapshot with no new persisted fields.

| Scenario                                                   | Behavior after upgrade                                                                                        | Handling                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Existing artifact, untouched after upgrade                 | Same as today                                                                                                 | None                                                                                 |
| Workspace file that was never recorded                     | Not backfilled                                                                                                | Only a later agent write (matching the policy) or explicit registration creates it   |
| Existing `.sql/.py/.md/.json` files in old sessions        | Not backfilled; created only when the agent modifies them after the upgrade                                   | Expected behavior change from widening the defaults                                  |
| Existing artifact modified again by the agent              | Same id emits `updated`, baseline synced, `toolCallId` advanced                                               | This is the fix                                                                      |
| Old entry already `changed` (usually a past unsynced edit) | Stays `changed` (downloadable) until the next agent write                                                     | **No bulk reset**: an old missed sync cannot be told apart from a real external edit |
| Host registrations (with a `clientId`)                     | Agent edits sync content only; title, retention, ownership, and tombstones unchanged                          | Depends on maintainer confirmation of step 3 in 4.4                                  |
| Hook / `record_artifact` registrations                     | Identity, title, retention unchanged; agent edits adopt new fingerprints                                      | None                                                                                 |
| `write_file` artifacts the user deleted                    | **Behavior change**: today a rewrite resurrects them; after the upgrade it does not                           | Use `record_artifact` to recreate explicitly when needed                             |
| Published / managed / link / external_url                  | Not on the workspace auto-record path                                                                         | None                                                                                 |
| Snapshot-less replay of old transcripts                    | Old records carry no new fields, so replay behaves as today                                                   | None                                                                                 |
| Core and acp-bridge versions                               | The daemon launches the agent from the same install (`process.execPath`), so they are always the same version | None                                                                                 |
| Old Web Shell + new daemon                                 | Only the hint is missing; turn attribution follows the old rule                                               | None                                                                                 |

Constraints implementation and review must preserve:

1. Identity keys unchanged: `workspace:<canonicalPath>` (and managed/url).
2. No workspace scan or backfill.
3. Never bulk-convert `changed` to `available`.
4. `updateOnly` never removes or evicts an existing entry.
5. Cross-ownership sync touches content fields only, never title, retention, or ownership.
6. Contract test: restore a V2 snapshot/journal fixture written before the upgrade and assert the same count and ids; `edit` one entry and assert the same id with action `updated`; another untouched entry that was modified externally stays `changed`.

## 5. Phasing

### 5.1 PR 1: consistent create/update (the body of this design)

- core: shared policy module; `write_file` calls it; `edit` and `notebook_edit` return artifacts; the write implementation returns the sha256 of the bytes written; `ToolArtifact.updateOnly` / `expectedSha256`; tool descriptions updated.
- acp-bridge: allowlist both new fields; `updateOnly` short-circuit; wire `expectedSha256` into `workspaceExpected` and stamp it as the baseline on mismatch; content-only sync across ownership; cross-source fingerprint adoption; advance `toolCallId` by file identity; no resurrection after deletion; generalized vanish/recheck predicates.
- web-shell: `changed` hint, turn attribution that includes `toolCallId`, and regression tests.
- Tests: unit tests for the three tools (including hashes matching disk for GBK, UTF-8 BOM, and CRLF files); store tests for `updateOnly` (unknown dropped without stat, known updated), a hash mismatch staying `changed` after refresh, cross-source and cross-ownership sync keeping title and ownership, `write_file` create + `edit` modify advancing `toolCallId` while keeping the title, no resurrection after deletion, forgetting artifacts created by `edit`, and concurrent queued updates; snapshot-less replay convergence; the V2 compatibility contract test.

Four default extensions added and no settings; the PR delivers value on its own.

### 5.2 Follow-up PR: show repeated modifications per turn

Extend the existing transcript-based reference grouping to completed `write_file` / `edit` / `notebook_edit` output paths, matched against the authoritative artifact list by canonical path. The same artifact appears in every turn that modified it, deduplicated within a turn, with an "Updated" badge after the first. Because it is derived from the transcript, it survives refresh and replay without collapsing onto the latest `toolCallId`, and **the store data model does not change**. Cards show current content and do not imply historical snapshots.

## 6. Split out of scope (separate issues)

- A bounded per-artifact revision trail (tool call, hash, size) and revision content snapshots.
- Detecting and attributing files created or modified by foreground shell commands.
- Mapping artifacts from MCP tool result `_meta`.

## 7. Risks

- **Treating every write as a new artifact**: bounded by "everything outside the built-in policy is `updateOnly`", with tests.
- **Noise in coding sessions and eviction**: the new `.md`, `.json`, and `.py` are common in ordinary coding (README, `package.json`, source files) and become artifacts once the agent modifies them. The 200-entry cap is the risk itself rather than a mitigation: past the cap the oldest non-`clientRetained` entries are evicted, which can push out important reports from early in the session. Mitigation: skip-directory rules unchanged; `record_as_artifact=false` opts out per call; no resurrection after deletion. This is the cost of widening defaults instead of adding a setting, and review should confirm it is acceptable.
- **Permission boundary**: content-only sync across ownership bypasses `denyCrossClientMutation`. It is limited to tool inputs from the producer set and to content fields, with tests pinning that title and ownership never change.
- **Hash differing from disk**: if the hash is computed with a different encoding than the write, every modification turns `changed`. Bounded by "the write implementation returns the hash of its own bytes, and the field is omitted when unavailable".
- **Large files**: files over 100MB are not hashed, so tools omit `expectedSha256`, keeping today's size-based baseline.
- **Performance**: `updateOnly` candidates for unrecorded files short-circuit before stat; recorded files are stat'ed and hashed on each modification. Snapshot-less replay hashes once per recorded write.
- **Transcript and diagnostics**: every `edit` of any file adds one candidate (path, title, kind) to the transcript tool result, and `toolResultBoundaryArtifact` diagnostics report an extra `file` kind.
- **Journal growth**: one event per update, using the existing snapshot compaction cadence.

## 8. Validation

Before implementation, write an E2E plan in `.qwen/e2e-tests/` and dry-run it against the global `qwen` CLI to record the baseline.

1. Upload `orders.csv` and ask the agent to add a column with `edit` → artifact created, shown in this turn, previewable and downloadable.
2. Modify again next turn → same id emits `updated`, status `available`, shown in the latest turn.
3. `write_file` creates `report.html`, then `edit` modifies it → same id, `toolCallId` advanced, title unchanged.
4. Upload one GBK, one UTF-8 BOM, and one CRLF CSV and have the agent modify each → all `available`, never `changed`.
5. The host registers `data.xlsx` (with a `clientId`) first, then the agent modifies it → synced, status `available`, title, retention, and ownership unchanged.
6. `record_artifact` registers `notes.md`, then a later turn `edit`s it → the artifact appears in both the registering turn and the modifying turn.
7. Upload `orders.sql` and ask the agent to add a column with `edit` → artifact created without any host registration; same for `.py`, `.md`, `.json`.
8. Unrecorded `src/foo.ts` (outside the built-in set) edited → no artifact, and the store does not stat it.
9. The user deletes an auto-recorded artifact and the agent modifies the file again → not resurrected; a later `record_artifact` for the path → recreated.
10. External modification, or modification through an agent shell command → `changed` with the hint, still downloadable.
11. The file changes between the write and the registration (simulated in a unit test) → `changed`, and still `changed` after the 5-second refresh.
12. Delete the artifact snapshot and `session/load` (snapshot-less replay) → the same result as before replay.
13. In a worktree / multi-workspace setup, write and edit the same file → same id.
14. V2 compatibility contract (constraint 6 in 4.7).

Each code PR runs the affected package unit tests and `npm run build && npm run typecheck`, completes the self-audit, and attaches E2E evidence.

## 9. Open questions

1. Should external modifications (`changed`) publish an event so hosts notice them in real time?
2. When a host saves user edits through `/file/write`, should that reset the baseline? It requires reaching the session-scoped store from a workspace-scoped route, which raises route-ownership questions, so it is not included for now.
3. The content-only sync across ownership in step 3 of 4.4 needs maintainer confirmation of the permission boundary.
