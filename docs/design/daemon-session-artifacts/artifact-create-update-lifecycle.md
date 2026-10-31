# Session Artifact Create and Update Lifecycle

[English](artifact-create-update-lifecycle.md) | [简体中文](artifact-create-update-lifecycle.zh-CN.md)

- Status: In implementation (PR 1)
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
- Eviction: above 200 entries the store evicts, in order, the oldest missing entry, entries over their source reservation, then the oldest non-`clientRetained` entry. If every remaining candidate is `clientRetained`, a last tier evicts the oldest entry anyway.
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

| Event                                                                | Store behavior                                                                          | status    | Event             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------- | ----------------- |
| Agent writes an unrecorded file matching the policy                  | Create and set the baseline                                                             | available | created           |
| Agent writes a **recorded** file (any extension, any source)         | Update, sync the content baseline, advance `toolCallId` to this call                    | available | updated           |
| Agent writes an unrecorded file outside the policy                   | Ignore (no stat, no hash)                                                               | –         | –                 |
| Agent writes a path the **user deleted**                             | Treated as `updateOnly`, not resurrected; explicit `record_artifact` still recreates it | –         | –                 |
| File changes again between write and registration                    | Absorbed into the baseline, as today (see 4.3)                                          | available | created / updated |
| `write_file` rewrites identical content                              | Handled like any other write (no content comparison)                                    | available | created / updated |
| True no-op edit / failed write                                       | No candidate                                                                            | –         | –                 |
| User or other means modify the file (including agent shell commands) | Detected on lazy refresh                                                                | changed   | None (as today)   |
| File deleted                                                         | Auto-recorded artifacts are forgotten; explicit ones become missing                     | missing   | removed / none    |
| `write_file` with `record_as_artifact=false`                         | Blocks creation only; recorded artifacts still sync                                     | –         | –                 |

Semantics: `changed` only means "drifted from the content most recently written by an agent file tool".

### 4.2 Shared auto-record policy

Extract the extension map, workspace path resolution, skipped directories, display-safety checks, and MIME/kind inference from `write-file.ts` into `packages/core/src/tools/artifact/workspace-auto-record.ts`. `write_file`, `edit` (including creation), and `notebook_edit` call it **after the write is committed**:

- Returns `null`: artifacts disabled, outside the workspace, in a skipped directory, or an unsafe path or title.
- Built-in extension match: returns a normal candidate.
- No match, or `record_as_artifact=false`: returns a candidate with `updateOnly: true`.

The built-in extension set gains `.sql`, `.py`, `.md`, and `.json`, all with kind `file`. They are the most common deliverables in data and analysis work; adding them to the defaults instead of a setting avoids a new settings surface. Existing skip rules (dot directories, `node_modules`, `dist`, and so on) still apply. `record_as_artifact=false` on `write_file`, `edit`, and `notebook_edit` skips creating an artifact; an artifact the session already has for the path is still refreshed. Artifact registration problems must not turn a successful file write into a failed tool call: building the candidate only resolves paths (a failed realpath falls back to the lexical path), and the store registers it after the tool result is returned. Only candidates for built-in extensions append a hint to `llmContent`; `updateOnly` candidates do not.

### 4.3 Ingestion field: `updateOnly`

```ts
interface ToolArtifact {
  // ...existing
  /** Only refresh an artifact the session already has; never create one. */
  updateOnly?: boolean;
}
```

- Add the field explicitly to the `artifactPayloadFields` allowlist in `bridgeClient.ts` and to `SessionArtifactInput`, or it is filtered out.
- It never enters the artifact journal/snapshot and never appears on the public artifact, but it is persisted with the tool result in the transcript. Snapshot-less replay re-applies it in order, and as with `write_file` today the store reads the current file as the baseline.

The baseline still comes from the store's own read; tools do not send an expected fingerprint. An earlier draft added `expectedSha256` (the hash of the bytes the tool wrote) so that a change between the write and the registration would stay `changed`. It was dropped: in daemon mode the bridge advertises the `fs.writeTextFile` client capability, so agent writes are delegated over ACP to the bridge's filesystem adapter and the agent never holds the bytes that reach disk. The field would be missing on the main path. Reading disk bytes in the store also means files whose encoding the tools preserve (GBK, UTF-8 BOM, CRLF) stay `available` with no tool-side handling. The cost is that a change inside the short window between the write and the store's read is absorbed into the baseline, exactly as today.

### 4.4 Store changes (`sessionArtifacts.ts`)

The auto-record producer set is `{write_file, edit, notebook_edit}` with a tool source.

1. **Short-circuit `updateOnly` first**: inside the serialized queue and before `expandWorkspaceDirectoryInput`, resolve the identity with the same path normalization as `normalizeInput` and check existence with the same lookup as `upsertMany` (id, then the published workspace target). If absent, drop it: no create, delete, eviction, publish, or stat/hash, and write `action=dropped reason="unmatched workspace update"`. If present, continue through normal `normalizeInput`.
2. **Content-only sync across ownership**: inputs from the producer set skip `denyCrossClientMutation`, so a client registration with a `clientId` accepts the agent's write. The merge only changes content fields: the fingerprint baseline, `status`, `sizeBytes`, and `toolCallId`. `title`, `description`, `source`, `clientId`, retention, and `clientRetained` never change, because `mergeArtifact` keeps the existing `source` and owner, the display refresh rule rejects the tool name, and `mergeRetention` never overrides an explicit retention. Any other tool input (such as `record_artifact`, or a hook input that carries a producer `toolName`) is still denied. This is the accepted permission boundary.
3. **Cross-source fingerprint adoption**: for inputs from the producer set, `mergeMetadata` adopts `isAdoptableContentFingerprintKey` keys without requiring the same source, and adds no other keys. Other inputs, hook-sourced inputs, and publisher-trust rules are unchanged.
4. **Advance turn attribution by file identity**: decouple "advance `toolCallId`" from "refresh title/description". When a producer-set input merges into a workspace entry, `toolCallId` advances to this call. `title`, `description`, `toolName`, `source`, and `hookEventName` still follow the existing `shouldRefreshWorkspaceDisplay` rule, so auto-records never overwrite the user-visible title. `toolName` keeps the creator, so forgetting rules still depend on who created the artifact.
5. **No resurrection after deletion**: a non-`updateOnly` candidate from the producer set that hits a tombstone is treated as `updateOnly` (and dropped because the entry does not exist). Resurrection rules for explicit `record_artifact`, hooks, and client registrations are unchanged.
6. **Generalize vanish/recheck predicates**: replace `toolName === 'write_file'` with `toolName ∈ {write_file, edit, notebook_edit}`. Like today, the predicate does not look at the source, so a hook entry whose `toolName` is in that set is forgotten when its file vanishes, the same way a `write_file` hook entry already was. Those entries are also re-stated on every list/get, without the 5-second presence TTL. Client registrations and explicit `record_artifact` entries keep their own `toolName`, so they behave as today.

Rejected alternatives: making `edit` / `notebook_edit` masquerade as `toolName: 'write_file'` (couples behavior to a name that is not true), and relaxing `shouldRefreshWorkspaceDisplay` wholesale (auto-records would overwrite user titles).

### 4.5 Web Shell (in the first implementation PR)

- Download rules are unchanged (`changed` is already downloadable).
- Add a "Modified since recorded" hint to the meta line of `changed` cards (not "outside this session", because the agent's own shell commands also cause `changed`). Existing tests already pin the `changed` download behavior.
- `getArtifactsByTurn`: for workspace artifacts, **also** add the turn of `artifact.toolCallId` alongside `record_artifact` / `reportedArtifacts` matches (today it is used only when nothing matches). Explicitly registered files then also appear in the most recent modifying turn; for today's entries `toolCallId` and the registering call share a turn, so results do not change. Published and link artifacts keep the old rule, because their `toolCallId` does not follow later writes. The `artifactsByTurn` type does not change.

### 4.6 Uploaded files

- Files uploaded into the workspace and then modified by the agent are created by 4.2 on the first modification when they match the built-in extensions (including the new `.sql`, `.py`, `.md`, `.json`); the host does not need to register them on upload.
- Types outside the built-in set: agent modifications never create an artifact for them, and they sync through `updateOnly` only if they were already registered some other way.
- Files that are uploaded but never modified are inputs; qwen-code does not record them on its own.

### 4.7 Compatibility with existing artifacts

**No data migration, no workspace scan or backfill, and no change to existing artifact ids.** Artifact persistence stays V2 journal/snapshot with no new persisted fields.

| Scenario                                                   | Behavior after upgrade                                                                                                                                                                                         | Handling                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Existing artifact, untouched after upgrade                 | Same as today                                                                                                                                                                                                  | None                                                                                 |
| Workspace file that was never recorded                     | Not backfilled                                                                                                                                                                                                 | Only a later agent write (matching the policy) or explicit registration creates it   |
| Existing `.sql/.py/.md/.json` files in old sessions        | Not backfilled; created only when the agent modifies them after the upgrade                                                                                                                                    | Expected behavior change from widening the defaults                                  |
| Existing artifact modified again by the agent              | Same id emits `updated`, baseline synced, `toolCallId` advanced                                                                                                                                                | This is the fix                                                                      |
| Old entry already `changed` (usually a past unsynced edit) | Stays `changed` (downloadable) until the next agent write                                                                                                                                                      | **No bulk reset**: an old missed sync cannot be told apart from a real external edit |
| Host registrations (with a `clientId`)                     | Agent edits sync content only; title, retention, ownership, and tombstones unchanged                                                                                                                           | Accepted in 4.4 step 2                                                               |
| Hook / `record_artifact` registrations                     | Identity, title, retention unchanged; agent edits adopt new fingerprints                                                                                                                                       | None                                                                                 |
| `write_file` artifacts the user deleted                    | **Behavior change**: today a rewrite resurrects them; after the upgrade it does not                                                                                                                            | Use `record_artifact` to recreate explicitly when needed                             |
| Published / managed / link / external_url                  | A producer write does not update a published entry; its content fields stay frozen                                                                                                                             | None                                                                                 |
| Snapshot-less replay of old transcripts                    | Ids stay the same. Replay has no saved fingerprint, so it hashes the current file and stamps that baseline; a previously `changed` entry comes back `available`                                                | Not a bulk conversion of a stored snapshot                                           |
| Core and acp-bridge versions                               | Supported only when the daemon and the agent come from the same install. `QWEN_CLI_ENTRY` can point at another tree; a split install is unsupported, and an older bridge drops `updateOnly`                    | Do not split the install                                                             |
| Old Web Shell + new daemon                                 | No "Modified since recorded" hint. The daemon still advances `toolCallId`, so the old shell's fallback shows the card on the latest write's turn only, not on both the registering turn and the modifying turn | None                                                                                 |

Constraints implementation and review must preserve:

1. Identity keys unchanged: `workspace:<canonicalPath>` (and managed/url).
2. No workspace scan or backfill.
3. Never bulk-convert stored `changed` entries to `available` on upgrade or snapshot restore. Snapshot-less replay has no saved fingerprint, so it baselines the current file instead.
4. `updateOnly` never removes or evicts an existing entry.
5. Cross-ownership sync touches content fields only, never title, retention, or ownership.
6. Contract test: restore a V2 snapshot written before the upgrade and assert the same count and ids; `edit` one entry and assert the same id with action `updated`; another untouched entry that was modified externally stays `changed`.

## 5. Phasing

### 5.1 PR 1: consistent create/update (the body of this design)

- core: shared policy module; `write_file` calls it; `edit` and `notebook_edit` return artifacts; `ToolArtifact.updateOnly`; tool descriptions updated.
- acp-bridge: allowlist the new field; `updateOnly` short-circuit; content-only sync across ownership; cross-source fingerprint adoption; advance `toolCallId` by file identity; no resurrection after deletion; generalized vanish/recheck predicates.
- web-shell: `changed` hint, turn attribution that includes `toolCallId` for workspace artifacts, and regression tests.
- Tests: unit tests for the three tools and the policy; bridge passthrough of `updateOnly`; store tests for `updateOnly` (unknown dropped without stat, known updated), cross-source and cross-ownership sync keeping title, retention, and ownership, `write_file` create + `edit` modify advancing `toolCallId` while keeping the title, no resurrection after deletion, forgetting artifacts created by `edit` and `notebook_edit`, and concurrent queued updates; the V2 compatibility contract test.

Four default extensions added and no settings; the PR delivers value on its own.

### 5.2 Follow-up PR: show repeated modifications per turn

Extend the existing transcript-based reference grouping to completed `write_file` / `edit` / `notebook_edit` output paths, matched against the authoritative artifact list by canonical path. The same artifact appears in every turn that modified it, deduplicated within a turn, with an "Updated" badge after the first. Because it is derived from the transcript, it survives refresh and replay without collapsing onto the latest `toolCallId`, and **the store data model does not change**. Cards show current content and do not imply historical snapshots.

## 6. Split out of scope (separate issues)

- A bounded per-artifact revision trail (tool call, hash, size) and revision content snapshots.
- Detecting and attributing files created or modified by foreground shell commands.
- Mapping artifacts from MCP tool result `_meta`.

## 7. Risks

- **Treating every write as a new artifact**: bounded by "everything outside the built-in policy is `updateOnly`", with tests.
- **Noise in coding sessions and eviction**: the new `.md`, `.json`, and `.py` are common in ordinary coding (README, `package.json`, source files) and become artifacts once the agent modifies them. The 200-entry cap is the risk itself rather than a mitigation: past the cap the oldest non-`clientRetained` entries are evicted, and if every remaining entry is `clientRetained` the oldest of those is evicted too. Mitigation: skip-directory rules unchanged; `record_as_artifact=false` on `write_file`, `edit`, and `notebook_edit` opts out of creating one; no resurrection after deletion. This is the cost of widening defaults instead of adding a setting, and review should confirm it is acceptable.
- **Credential-bearing files**: the new extensions also match files such as `certs/service-account.json` or `config/credentials.json`, including gitignored ones, that no skip rule excludes. Recording only lists the path, title, size, and fingerprints in the session; content is not copied or uploaded on this path, and previews and downloads go through the workspace file route the session can already read. No name-based skip is added; `record_as_artifact=false` opts out per call.
- **Permission boundary**: content-only sync across ownership bypasses `denyCrossClientMutation`. It is limited to tool inputs from the producer set and to content fields, with tests pinning that title, retention, and ownership never change.
- **Write-to-registration window**: a change between the agent's write and the store's read is absorbed into the baseline, as today (see 4.3).
- **Performance**: `updateOnly` candidates for unrecorded files short-circuit before stat; recorded files are stat'ed and hashed on each modification (files over 100MB keep today's size-based baseline). Artifacts created by the producer set skip the 5-second presence TTL and are stat'ed on every list/get, so a deleted file is forgotten on the next list. Snapshot-less replay hashes once per recorded write.
- **Transcript and diagnostics**: every `edit` of any file adds one candidate (path, title, kind) to the transcript tool result, and `toolResultBoundaryArtifact` diagnostics report an extra `file` kind.
- **Journal growth**: one event per update, using the existing snapshot compaction cadence.

## 8. Validation

Before implementation, write an E2E plan in `.qwen/e2e-tests/` and dry-run it against the global `qwen` CLI to record the baseline.

1. Upload `orders.csv` and ask the agent to add a column with `edit` → artifact created, shown in this turn, previewable and downloadable.
2. Modify again next turn → same id emits `updated`, status `available`, shown in the latest turn.
3. `write_file` creates `report.html`, then `edit` modifies it → same id, `toolCallId` advanced, title unchanged.
4. Upload one GBK, one UTF-8 BOM, and one CRLF CSV and have the agent modify each → all `available`, never `changed` (the store hashes the bytes on disk).
5. The host registers `data.xlsx` (with a `clientId`) first, then the agent modifies it → synced, status `available`, title, retention, and ownership unchanged.
6. `record_artifact` registers `notes.md`, then a later turn `edit`s it → the artifact appears in both the registering turn and the modifying turn.
7. Upload `orders.sql` and ask the agent to add a column with `edit` → artifact created without any host registration; same for `.py`, `.md`, `.json`.
8. Unrecorded `src/foo.ts` (outside the built-in set) edited → no artifact, and the store does not stat it.
9. The user deletes an auto-recorded artifact and the agent modifies the file again → not resurrected; a later `record_artifact` for the path → recreated.
10. External modification, or modification through an agent shell command → `changed` with the hint, still downloadable.
11. Delete the artifact snapshot and `session/load` (snapshot-less replay) → the same ids as before replay. Status follows a fresh hash of the current file, so an entry that was `changed` comes back `available`.
12. In a worktree / multi-workspace setup, write and edit the same file → same id.
13. V2 compatibility contract (constraint 6 in 4.7).

Each code PR runs the affected package unit tests and `npm run build && npm run typecheck`, completes the self-audit, and attaches E2E evidence.

## 9. Open questions

1. Should external modifications (`changed`) publish an event so hosts notice them in real time?
2. When a host saves user edits through `/file/write`, should that reset the baseline? It requires reaching the session-scoped store from a workspace-scoped route, which raises route-ownership questions, so it is not included for now.
3. The content-only sync across ownership in step 2 of 4.4 needs maintainer confirmation of the permission boundary.
