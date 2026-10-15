# Session artifacts: directory expansion and office files

## Problem

Models often register a generated folder as one workspace artifact
(`kind: file`, `workspacePath` pointing at the directory). Clients then
open or download it through `GET /file` or `GET /file/bytes`, which
require a regular file and return HTTP 400.

Office outputs (Word / Excel / PowerPoint) were also second-class:
they were not treated as artifact-like files, and the preview path tried
to read them as text.

## Decision

Directories are never artifacts. If a registration points at a
directory, the store expands it to one artifact per recordable file
inside that directory. The original directory path is not stored.

Office documents are first-class file artifacts (`kind: document`) and
are opened as downloadable binaries, not text previews.

The chat turn-output list shows at most 3 artifact cards, with the same
expand/collapse control already used for edited files.

## Behavior

- Expansion happens in the session artifact store so every ingest path
  (`record_artifact`, hooks, client POST) behaves the same.
- Walk is recursive, skips hidden names, Excel lock files (`~$*`),
  symlinks, and well-known junk directories. Cap is 100 files and 4
  directory levels; either limit is disclosed to the model and store
  warnings instead of silently dropping files.
- Chat grouping uses a recorded directory path as a prefix only for
  artifacts from that same `record_artifact` call (or artifacts with no
  tool call id). Later files written under the same folder stay on their
  own turn.
- Each child uses its filename as the title, inherits tool/source
  metadata, and infers kind from its own extension.
- A leftover directory path (empty, unlistable, or not expanded) is
  rejected; it is never marked `available`.
- Word / Excel / PowerPoint / OpenDocument extensions map to
  `kind: document`. The client shows a type label and a download action
  instead of a CodeMirror text preview.

## Out of scope

- Directory artifacts or a folder browser kind.
- Auto-zip at record time.
- Auto-registering every `write_file` / shell output without
  `record_artifact`.

## Adjustments after #9385 triage

Upstream analysis (QwenLM/qwen-code@main) confirmed the original
decision. Keep store-side expansion, `kind: document`, and the 3-card
collapse. Fine-tune the landing, do not change the product rule.

### Coordinate with #9142

#9142 (`fix/artifact-workspace-path-contract`) stats the locator in
`record_artifact` and **rejects** directories (`TARGET_IS_DIRECTORY`).
That stops the 400, but it is not this issue: the user still does not
get one card per generated file.

Keep #9142's path canonicalization (workspace-root-relative
`workspacePath`, worktree prefix, no invented `w/agent/` prefixes).
Replace its directory rejection with expansion:

- If the locator is a regular file, verify + canonicalize as in #9142.
- If it is a directory, succeed and let the store expand. The tool
  result should say the directory was expanded, not `Recorded artifact`
  for the folder itself.
- If it is empty, missing, escaped, or not a regular file, fail as in
  #9142.

`.xlsx` in #9142's `write_file` whitelist must be `document`, not
`file`. `.csv` stays `file` (text-previewable).

### Client

Upstream Web Shell already has Download (`canDownloadArtifact`,
`readWorkspaceFileAsBlob`) and `GET /stat`. Reuse those. Do not add a
second download stack.

- `kind: document` and other non-text kinds (`pdf`, `image`, `video`,
  `audio`) never fall through to the `'source'` / CodeMirror preview.
- If `GET /stat` returns `type: directory` (legacy dirty records),
  disable Open and do not call `/file` or `/file/bytes`.
- Add `document` to `ARTIFACT_FORMAT_ICONS` and kind labels.

### write_file reminder

On current main the whitelist is `ARTIFACT_KIND_BY_EXTENSION`, not a
plain extension set. Office/OpenDocument entries belong there as
`document`. Do not call `record_artifact` again for a path
`write_file` already recorded.
