# Workspace skill installer limits

[English](2026-10-21-workspace-skill-installer-limits.md) |
[简体中文](2026-10-21-workspace-skill-installer-limits.zh-CN.md)

## Status

Implemented by this pull request, initially proposed on 2026-10-21.
The baseline sections describe the previous limits; the solution below
describes this implementation. Merge and cross-platform validation are pending.

## Problem

The native skill installer rejects packages that are ordinary skills. One
file over 2 MiB fails. The 129th file fails. GitHub and local-folder
installs fail at 6 MiB even though those sources never enter a JSON body.

Two constraints are coupled, and only one of them is about HTTP:

- **Transport.** `POST /workspace/skills/install` sends a ZIP as
  `source.contentBase64` inside JSON. `express.json({ limit: '10mb' })` in
  `packages/cli/src/serve/server/error-handlers.ts` parses that body.
  `bytes@3.1.2` maps `mb` to `1 << 20`, so the ceiling is 10,485,760 bytes.
  A body past it becomes `413` with `Request body too large (max 10 MB)`
  and never reaches the installer.
- **Memory.** `SkillPackageFile.content` is a `Buffer`. Zip, GitHub, and
  folder installs all accumulate those buffers, then write them to the
  staging directory. The 6 MiB uncompressed cap is that heap budget. It
  also stops a compressed archive from expanding without bound. GitHub and
  folder installs pay it even though their bytes are already on the wire
  or on disk.

`docs/design/web-shell/web-shell-skill-manager-page.md` describes file
count, individual size, aggregate size, path depth, and path length as
bounded below the daemon JSON parser. That sentence matches the original
installer from commit `0ecba4b3c70` (PR #7018). It is the wrong bound for
GitHub and folder once the package is no longer held in memory. The 2 MiB
per-file cap and the 128-file cap have no finer written rationale.

A second skill download path already allows much larger fetches. It is not
this installer, and its decompressed budget is not safe to copy while this
process still buffers every file. See Baseline before this change.

## Baseline before this change

`packages/cli/src/serve/workspace-skill-management.ts` uses one budget for
every source:

| Constant          | Value | What it gates                                                                 |
| ----------------- | ----- | ----------------------------------------------------------------------------- |
| `MAX_FILES`       | 128   | Zip entries, GitHub files, folder files, and the normalized package           |
| `MAX_FILE_BYTES`  | 2 MiB | One zip entry, one GitHub response, one folder file, and each normalized file |
| `MAX_TOTAL_BYTES` | 6 MiB | Decoded base64, uncompressed zip bytes, GitHub totals, and folder totals      |
| `MAX_PATH_LENGTH` | 512   | Relative paths and the GitHub directory                                       |
| `MAX_PATH_DEPTH`  | 16    | Relative paths, zip layout, GitHub walk, and folder walk                      |

`decodeBase64` rejects a decoded archive larger than `MAX_TOTAL_BYTES`.
`filesFromZip` then reads every entry into memory (`readZipEntry`
concatenates chunks) and applies the same per-file and total caps again.
`fromBuffer` keeps the compressed archive alive for the whole read.
`downloadGitHubDirectory` pushes each `fetchBytes` buffer into
`state.files`. The git sparse-checkout fallback checks the tree out under
`os.tmpdir()` and then `filesFromFolder` reads it back into buffers.
`filesFromFolder` `readFile`s every file before `installWorkspaceSkill`
writes the buffers into the existing staging directory
(`.skills-<name>.installing-*` under the skills parent). Peak heap for a
legal package is the whole uncompressed tree, plus the zip buffer on the
zip path, plus the JSON body (up to 10 MiB) until the request ends.

`packages/web-shell/client/components/skills/SkillInstallDialog.tsx` sets
`MAX_SKILL_ZIP_BYTES` to 6 MiB and refuses the file before upload. Both
catalogs in `packages/web-shell/client/i18n.tsx` say:

- `skills.install.error.zipTooLarge`: `The ZIP file must not exceed 6 MB.`
- Chinese catalog: `ZIP 文件不能超过 6 MB。`

The dialog maps every server `skill_package_too_large` onto that ZIP
sentence, including a GitHub or folder package that exceeded the
uncompressed cap and a single file that exceeded 2 MiB.

Size failures use `skill_package_too_large` at HTTP 413. File-count
failures use `invalid_skill_package` at HTTP 400 (`Skill package has too
many files`, `Skill ZIP contains too many files`, or `Skill package has
an invalid file count` for an empty package). Daemon messages do not
include the numeric caps.

Tests in `workspace-skill-management.test.ts` lock the old ceilings:
`stops reading an oversized GitHub Skill file` (2 MiB plus one byte),
`reports an expanded ZIP entry over the limit as too large` (one entry of
2 MiB plus one byte), and `reports a ZIP whose total expanded content is
over the limit` (four 1,600,000-byte files, about 6.4 MiB). The skill
manager design calls these ZIP-bomb limits.

`packages/cli/src/acp-integration/skill-source-download.ts` is a different
feature. It allows 100 MiB compressed
(`MAX_SKILL_DOWNLOAD_BYTES`), 500 MiB decompressed
(`MAX_SKILL_DECOMPRESSED_BYTES`), 2000 API files
(`MAX_SKILL_API_FILE_COUNT`), and depth 16
(`MAX_SKILL_API_DIR_DEPTH`). Inflation is aborted once the cap is crossed,
but a legal archive is still `Buffer.concat`'d, and the GitHub API walker
still retains every file buffer. Those 500 MiB can sit on the daemon heap.
This installer must not adopt that decompressed number.

Codex, for citation only: `openai/codex` `install-skill-from-github.py`
has no compressed, uncompressed, per-file, or file-count cap. It copies a
repo zip or a git sparse checkout onto disk and rejects path escape,
symlinks, bad skill names, an existing destination, and a missing
`SKILL.md`. Plugin bundles in `codex-rs/core-plugins` allow 100 MiB
remote download and 512 MiB extracted (PR #36485, 2026-08-01, raised from
50/250). Share and npm archives are 50 MiB, npm extracted 250 MiB, with
no per-file or entry-count cap. The OpenAI plugin submission portal
allows a zip up to 100 MB, a member up to 100 MiB, 5000 entries,
uncompressed size up to 512 MiB, and path depth 20. Its
`skill_bundle_too_large` numeric cap is not published. Those installers
do not hold the extracted tree in the process heap. Matching their
unlimited skill installer, or their 512 MiB extract cap, is not available
to a path that still buffers every file.

## Goals

- Split the ZIP transport ceiling from the on-disk package ceiling.
- Raise the per-file and file-count ceilings to values that admit a skill
  with real assets and a real reference tree.
- Keep zip-bomb, path, symlink, and staging rollback behavior.
- Avoid retaining the expanded package in the installer heap; retain only
  streaming buffers and the separately bounded manifest read.
- Tell Web Shell the new ZIP ceiling in both languages, and stop
  describing every size failure as a 6 MB ZIP.

## Non-goals

- No new upload protocol. The JSON body can carry a useful source ZIP
  once expansion is no longer capped at the compressed size. A
  binary-heavy package that does not fit the transport ceiling uses the
  existing GitHub or folder source.
- No change to `express.json({ limit: '10mb' })` or to the global 10 MiB
  body limit. That limit covers every JSON route.
- No change to `packages/cli/src/acp-integration/skill-source-download.ts`.
  A shared constant would copy a heap budget this path is refusing.
- No user setting, environment variable, or per-workspace override.
- No change to `MAX_PATH_LENGTH` (512) or `MAX_PATH_DEPTH` (16). Depth
  already matches `MAX_SKILL_API_DIR_DEPTH`.
- Preserve skill-name rules, `SKILL.md` name matching, symlink rejection,
  single-root stripping, staging rollback, and API-then-git fallback
  behavior while adapting their implementation to disk staging. Git
  timeouts remain 60 s for clone and 30 s for sparse-checkout.
- No rewrite of `docs/design/web-shell/web-shell-skill-manager-page.md`.
  That page has no Chinese twin; editing one sentence would require a
  full translation. This document is the limit spec. The old sentence
  describes the installer that shipped in #7018.
- No concurrency limit for installs, and no switch of the GitHub path
  onto a single archive download.

## Proposed solution

Replace `MAX_TOTAL_BYTES` with two ceilings. Raise the per-file and
file-count ceilings. Stream each accepted file into the staging directory
the installer already creates, and apply the package ceiling to bytes
written there.

```text
MAX_ZIP_ARCHIVE_BYTES = 7_864_071
MAX_FILE_BYTES        = 32 * 1024 * 1024    // 33_554_432
MAX_PACKAGE_BYTES     = 64 * 1024 * 1024    // 67_108_864
MAX_FILES             = 2000
MAX_PATH_LENGTH       = 512                 // unchanged
MAX_PATH_DEPTH        = 16                  // unchanged
```

`MAX_SKILL_ZIP_BYTES` in the Web Shell dialog equals
`MAX_ZIP_ARCHIVE_BYTES`. The dialog cannot import the CLI module. Duplicate
the literal. Do not add a shared package.

### Transport ceiling

A compliant body is compact `JSON.stringify` output:

```json
{
  "name": "<256 chars>",
  "scope": "workspace",
  "source": { "type": "zip", "contentBase64": "<base64>" }
}
```

`name` is at most `MAX_WORKSPACE_SKILL_NAME_LENGTH` (256) characters from
`[A-Za-z0-9._-]`, so it does not JSON-escape. `scope` `"workspace"` is the
longer scope. `contentBase64` uses the standard alphabet, which does not
JSON-escape. Key order does not change the length. With an empty
`contentBase64` that envelope is 330 bytes.

```text
JSON_BODY_LIMIT_BYTES   = 10 * 1024 * 1024          // 10_485_760
ENVELOPE_BYTES          = 330
BASE64_BUDGET           = 10_485_760 - 330          // 10_485_430
MAX_ZIP_ARCHIVE_BYTES   = 3 * floor(10_485_430 / 4) // 7_864_071
```

The encoded body is 330 + 10,485,428 = 10,485,758 bytes, two bytes under
the parser. The next raw byte encodes to four more base64 characters
(10,485,762 bytes) and is rejected by the parser before `decodeBase64`.
`decodeBase64` enforces `MAX_ZIP_ARCHIVE_BYTES` on the decoded buffer so a
short name cannot sneak a larger archive past the installer. The client
checks `file.size` against the same number before it builds base64.

That is about 7.50 MiB, up from 6 MiB. The useful ZIP change is not this
bump. A text-heavy archive under 7,864,071 bytes may expand up to
`MAX_PACKAGE_BYTES` on disk. An incompressible archive cannot, and GitHub
or folder is the source for that package.

### On-disk package ceiling

Create the existing staging directory before reading the source. For each
accepted file, validate the relative path (unchanged rules), then write it
and drop the body:

- **ZIP.** Keep `fromBuffer` on the decoded archive. That buffer is at most
  `MAX_ZIP_ARCHIVE_BYTES`. Pipe each entry to a file in staging. Count
  bytes. `destroy` the entry stream when `entry.uncompressedSize` or the
  bytes read would pass `MAX_FILE_BYTES` or `MAX_PACKAGE_BYTES`. Do not
  `Buffer.concat` the entry.
- **Folder.** `lstat`, reject symlinks and special files as today, then
  `copyFile` into staging. Do not `readFile` the payload. If the size
  changes across the copy, reject, as today's length check does.
- **GitHub API.** Pipe `fetchBytes` to the staging file. Honor
  `content-length` and the streamed total against `MAX_FILE_BYTES`, and
  the running total against `MAX_PACKAGE_BYTES`. Cancel the body when the
  cap is crossed.
- **Git sparse checkout.** Keep the temp checkout. Copy it into staging
  with the folder walk. Delete the temp checkout in the existing `finally`.
  Do not read the checkout back into an array of buffers.

Skip `__MACOSX`, `.DS_Store`, and `._*` entries before they consume
`MAX_FILES` or `MAX_PACKAGE_BYTES`, and do not install them. Today the zip
pre-check counts that junk and `normalizePackageFiles` drops it afterwards.
The caps then describe installed files.

After the tree is on disk, strip a single enclosing directory with renames
when there is no root `SKILL.md` and every file shares one root. Require
root `SKILL.md`. Parse `SKILL.md` from the staged file, as today. On any
failure, remove staging and restore the backup, as today. Keep calling
`assertGenerationOpen` around the writes so a closed generation does not
leave a skill directory.

During staging, retained file bodies do not grow with `MAX_PACKAGE_BYTES`
(the later manifest read is accounted for under Risks):

| Source       | What stays in the heap                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| ZIP          | The JSON body (≤ 10 MiB) until the handler returns, the archive buffer (≤ 7,864,071 bytes), and one stream chunk |
| GitHub API   | The directory listing plus one stream chunk                                                                      |
| Git checkout | Nothing from the file bodies. Git and `copyFile` use the kernel                                                  |
| Folder       | Nothing from the file bodies. `copyFile` uses the kernel                                                         |

A path set for duplicate detection is required. It holds strings, not
contents.

### Per-file and file-count ceilings

`MAX_FILE_BYTES` is 32 MiB. `MAX_FILES` is 2000. Both are on-disk limits
enforced before or during the streamed write. They are not heap
reservations.

## Decisions

**`MAX_ZIP_ARCHIVE_BYTES = 7_864_071`.** This is the largest raw ZIP that
fits in the 10 MiB JSON body with the worst-case compliant envelope, as
calculated above. Rounding down to 7 MiB would leave usable bytes unused.
Rounding up to 7.5 MiB (7,864,320) would make a max-length skill name fail
in the parser with the generic 10 MB error. The client and the server use
the same integer so the file picker fails before upload.

**`MAX_PACKAGE_BYTES = 64 MiB`.** Six MiB is the old heap budget, applied
even to sources that are already on disk. Once files are streamed into
staging, this ceiling is disk. 64 MiB covers `SKILL.md`, scripts, and more
than one multi-megabyte asset (documents, a wasm module, a small database,
images). It stays in the same tens-of-megabytes band as the daemon's 50 MiB
binary upload (`MAX_UPLOAD_BYTES` in `packages/cli/src/serve/fs/policy.ts`)
without taking that constant: the upload route buffers the body, and this
path must not. 100 MiB / 500 MiB / 512 MiB from the other skill downloader
and from Codex plugin extraction are plugin-sized trees and, on the other
Qwen path, still a heap budget. They are not the skill staging budget.

**`MAX_FILE_BYTES = 32 MiB`.** Two MiB rejects one ordinary asset even when
the rest of the package is tiny. 32 MiB admits one PDF, wasm module,
SQLite file, font, or small binary helper. It is half of the package
ceiling, so a second large asset has to fit in what remains. The write is
a stream or `copyFile`. The process must not allocate a 32 MiB `Buffer` for
the file. There is no per-file cap on `skill-source-download.ts` to align
with; copying "no cap" would let one entry grow toward the package ceiling
without a separate early reject, and the 2 MiB constant needs a replacement
that is still a single-entry zip-bomb guard.

**`MAX_FILES = 2000`.** A reference tree plus scripts passes 128 files
while the byte total is still small. 2000 is `MAX_SKILL_API_FILE_COUNT`,
the in-repo cap for the same kind of GitHub directory walk. It is safe
here because the installer retains paths, not 2000 buffers. The portal's
5000 and Codex's unlimited skill copy are not used. Empty packages still
fail `invalid_skill_package`. Metadata files do not count.

**Stream into the existing staging directory.** Raising `MAX_TOTAL_BYTES`
in place and still filling `SkillPackageFile[]` would pin the new package
ceiling on the daemon heap. At 64 MiB that is most of a small worker; at
the other downloader's 500 MiB it is the failure mode this design refuses.
The staging directory, rollback, and `SKILL.md` parse-from-disk already
exist. The implementation writes there earlier and deletes the in-memory
package array. No new type of temp directory and no new route.

**Retry and cleanup isolation.** Before a Contents API failure falls back
to git, empty the same staging directory and reset paths, file count, and
byte count together. Staging and backup names embed the owning pid, so a
second daemon reclaims a crashed run's artifacts but leaves a live peer's
in place; the in-process registry covers the window from before the
staging directory exists to after commit. Artifact cleanup matches the
complete suffix after the skill-specific prefix, so installing `foo`
cannot sweep the staging or backup of `foo.backup-1` or
`foo.installing-abc123`. Requested names are rejected only when the sweep
could reach them: a leading-dot name ending in `.backup-` or
`.installing-` followed by `[A-Za-z0-9-]`, or a name ending in a
two-number `backup`/`installing` suffix that the skill loaders already
skip. Names such as `release.installing-notes` or `db.backup-2024` carry
no leading dot and stay installable. This does not introduce
cross-process install locks; the route mutex keys on the resolved skills
directory so aliased scopes serialize.

**Keep one size error code.** `skill_package_too_large` (413) still covers
the archive, one file, and the package total. Messages stay specific.
File count gets its own code so Web Shell can translate it. See
Implementation scope.

## Constraints

- The parser ceiling is 10,485,760 bytes, inclusive. `body-parser` rejects
  only a body that exceeds `limit`.
- The transport formula assumes compact JSON and a valid skill name. A
  client that pretty-prints, adds fields, or sends a name that
  JSON-escapes can still receive the generic parser 413. The official
  client uses compact `JSON.stringify` of `{ name, scope, source }`, but
  does not enforce the name-length ceiling before submission. Overlong
  names can therefore hit the parser before route validation.
- `yauzl`'s `fromBuffer` requires the whole archive. That cost is capped
  by `MAX_ZIP_ARCHIVE_BYTES` and is acceptable. Do not add a temp-file ZIP
  reader in this change.
- GitHub Contents API listings stop at the API's 1000-entry page maximum.
  A listing at that length is treated as truncated and re-read through the
  existing git fallback, so enumeration completeness does not depend on the
  API walk where the git transport can authenticate: public repositories, or
  hosts with git credentials configured. For a private repository reached
  with only the configured API token, a listing at or above 1000 entries has
  no working transport until the deferred fallback authentication lands (see
  the Git credential bullet below). A 2000-file API walk can still be slow
  or rate-limited. The new
  file cap is a ceiling, not a completion-time guarantee. Both the SDK
  request and Web Shell action currently time out after 30 s. A slow
  install may finish on the daemon after the client reports a timeout;
  cancellation and timeout changes are follow-up work.
- Git fallback keeps the existing Git environment and credential helpers. The
  configured API token is not injected into Git subprocesses. Dedicated private
  repository fallback authentication is deferred: it needs host scoping,
  inherited configuration preservation, and lazy-fetch coverage. This deferral
  is a correctness boundary for the ≥1000-entry listing path above, not just an
  enhancement.
- Web Shell and the CLI do not share a module for this constant. The two
  literals must be kept equal by review.
- ZIP compression ratio is not limited separately. The archive and
  expanded-byte ceilings apply independently, including to highly
  compressible packages.

## Risks

**Heap, if the stream is skipped.** Implementing only the new constants
and leaving `SkillPackageFile.content` arrays in place would hold up to
64 MiB of file bodies, plus up to 7,864,071 bytes of ZIP, plus the 10 MiB
JSON body, per in-flight install. Concurrent installs multiply that. This
design does not paper over that cost. The implementation is wrong if the
package still resides in those buffers at the new ceiling.

**ZIP heap that remains.** A ZIP install still holds the JSON text and the
decoded archive until the handler finishes. Together those are at most
the 10 MiB JSON body plus the 7,864,071-byte archive, plus one stream
chunk. Manifest validation additionally reads the whole `SKILL.md`
(up to 32 MiB) into a string, as do subsequent skill-loader reads.
Streaming removes retained package bodies, not this manifest cost.
Do not describe any source as allocation-free.

**Disk.** Staging can hold up to 64 MiB, then the rename makes that the
installed skill. Replacing an existing skill briefly keeps a backup of the
old tree as well. The git fallback briefly keeps the temp checkout and the
staging copy until `finally` deletes the checkout. The checkout itself
is not bounded by the installer caps: git materializes it before the
copy validates sizes. The ≥1000-entry page-limit trigger routes the
largest directories through this path deterministically, so the unbounded
checkout cost is no longer limited to 429/5xx retries. Do not treat
128 MiB as a disk-usage bound.
A failed install must still delete staging. A partial entry that crossed
the cap lives only inside that staging directory.

**Rejected installs may leave the base directory.** The skills base
directory is created before the source is acquired, so a missing source
folder, a GitHub 404, or a ZIP that fails to decode fails after
`<workspace>/.qwen/skills` (or the global equivalent) exists. Only the
invalid-base64 ZIP shape is rejected before the directory is created.
The leftover empty directory is deliberate: staging must live beside the
destination so the final rename stays on one filesystem.

**Misleading UI if the mapping is left alone.** Today's ZIP sentence is
already wrong for GitHub, folder, and per-file failures. Pointing it at
7,864,071 bytes without a separate package sentence would keep that bug.

**Generation close.** `does not create Skill directories after the
generation closes` throws on the third `assertGenerationOpen` and expects
no `.qwen` directory. Reordering writes must not leave `.qwen` or a
staging directory behind. Update the check index if the call sequence
changes; keep the observable.

## Implementation scope

Touch only:

- `packages/cli/src/serve/workspace-skill-management.ts`
- `packages/cli/src/serve/workspace-skill-management.test.ts`
- `packages/cli/src/serve/workspace-skill-management-recovery.test.ts`
  (new; Contents API failure retry with a staging reset, and artifact-prefix
  collision isolation)
- `packages/web-shell/client/components/skills/SkillInstallDialog.tsx`
- `packages/web-shell/client/components/skills/SkillInstallDialog.test.tsx`
  (error-code rows for the new size and file-count codes)
- `packages/web-shell/client/i18n.tsx` (English and Chinese catalogs)

Do not touch `error-handlers.ts`, `workspace-skills.ts` (the route passes
`contentBase64` through), `skill-source-download.ts`, SDK types, or the
global JSON limit.

### Behavior

- Decoded ZIP larger than 7,864,071 bytes: `413 skill_package_too_large`,
  message `Skill ZIP exceeds the allowed archive size`.
- One file or zip entry over 32 MiB: `413 skill_package_too_large`. Keep
  the current sentences (`Skill file is too large`, `Skill file is too
large: <path>`, `Skill ZIP entry is too large: <name>`, `Skill ZIP entry
exceeds the allowed size`).
- Installed bytes over 64 MiB: `413 skill_package_too_large`. Keep
  `Skill package exceeds the allowed size` and `Skill ZIP expands beyond
the allowed size`.
- More than 2000 installed files: `400 skill_too_many_files`. Messages:
  `Skill package has too many files (max 2000)` and `Skill ZIP contains
too many files (max 2000)`.
- A staging write fault (an errno in `ENOSPC`, `EDQUOT`, `EROFS`, `EIO`,
  `EMFILE`, `ENFILE`, `EBUSY`, `EACCES`, `EPERM`) raised by a write into
  the staging directory: `500 skill_staging_failed`. The folder copy
  keeps the ambiguous errnos honest: Node reports both the source `path`
  and the target `dest` for every `copyFile` failure, so `EACCES` and
  `EPERM` map to 500 only while the source is still readable; `EIO` and
  the other read-or-write errnos keep the per-source 400/502 mapping.
  Direct staging writes (`open`, `write`, `mkdir`) map `EACCES` and
  `EPERM` unconditionally. A staged file that disappeared before
  finalize is also `500 skill_staging_failed`.
- Empty package, bad paths, duplicates, and excess depth: unchanged
  `invalid_skill_package` messages and status 400.
- A ZIP entry that would make one path both a file and a directory, in
  either order: `400 invalid_skill_package`, message
  `Skill package has conflicting file and directory entries: <path>` with
  the later entry's path.
- A folder or ZIP whose expanded size is over 6 MiB and within the new
  caps installs. A file of 2 MiB plus one byte installs.
- Path length, depth, symlink, encryption, absolute path, and `..`
  rejection are unchanged.
- Web Shell file picker: `file.size > 7_864_071` shows
  `skills.install.error.zipTooLarge` and does not upload.
- Web Shell server `skill_package_too_large`: show
  `skills.install.error.packageTooLarge`, not the ZIP sentence.
- Web Shell server `skill_too_many_files`: show
  `skills.install.error.tooManyFiles`.
- Other `invalid_skill_package` results keep
  `skills.install.error.invalidPackage`.

### Copy

`skills.install.error.zipTooLarge`:

- English: `The ZIP file must not exceed 7,864,071 bytes.`
- Chinese: `ZIP 文件不能超过 7,864,071 字节。`

`skills.install.error.packageTooLarge`:

- English: `The skill exceeds the installer limit of 32 MiB per file or 64 MiB total.`
- Chinese: `技能超过安装限制：单文件最大 32 MiB，合计最大 64 MiB。`

`skills.install.error.tooManyFiles`:

- English: `The skill package has too many files (max 2000).`
- Chinese: `技能包文件过多（最多 2000 个）。`

Remove both current sentences that say `6 MB`. Do not describe
7,864,071 bytes as 7.5 MiB in the UI: 7.5 MiB is 7,864,320 and would
accept 249 bytes the server rejects.

A short comment next to `MAX_ZIP_ARCHIVE_BYTES` records the envelope
formula; the number is otherwise unexplained. Two further why-comments are
budgeted: one above the Contents-API page limit and one on the
`liveInstallArtifacts` invariant. No other new comments.

## Validation

Update `packages/cli/src/serve/workspace-skill-management.test.ts` and the
new `packages/cli/src/serve/workspace-skill-management-recovery.test.ts`.
Do not run the full suite for the design; the implementation PR runs both
files.

- Assert `MAX_ZIP_ARCHIVE_BYTES` equals the formula above, and that a
  worst-case envelope plus the base64 of that many bytes is ≤ 10,485,760,
  while one more raw byte is over. Export the constant for the assertion,
  or assert it from the module if it is already exported. Do not export it
  for configuration.
- Flip `reports an expanded ZIP entry over the limit as too large`: an
  entry of 2 MiB plus one byte installs.
- Flip `reports a ZIP whose total expanded content is over the limit`:
  four 1,600,000-byte files install.
- Replace `stops reading an oversized GitHub Skill file`: a body of 2 MiB
  plus one byte without `content-length` is under the new per-file cap.
  A response whose `content-length` is `MAX_FILE_BYTES + 1` returns 413
  and does not require a 32 MiB body. One streamed body of
  `MAX_FILE_BYTES + 1` bytes still returns 413 and cancels the read. That
  single test may allocate 32 MiB plus one byte. Do not also allocate
  64 MiB.
- Folder: a sparse file (`fs.truncate`) of `MAX_FILE_BYTES + 1` returns 413. Sparse files whose sizes sum to `MAX_PACKAGE_BYTES + 1` return 413.
  Neither test should allocate those buffers in the test process.
- Folder or ZIP: 129 small files install. 2001 small files return
  `skill_too_many_files`.
- A file of 2 MiB plus one byte in a folder installs.
- Existing symlink, traversal, manifest, and rollback tests stay green.
- `does not create Skill directories after the generation closes` still
  leaves no skill directory. Adjust its check index if needed.

No existing Web Shell test asserts the 6 MB string
(`SkillsManagerPage.test.tsx` does not). The UI change is the two i18n
catalogs, the dialog constant, and the error-code rows added to
`SkillInstallDialog.test.tsx`. Do not add a browser suite for this.

The implementation PR runs the focused installer tests, Web Shell
typecheck for the dialog and i18n edits, and `npm run typecheck` for the
touched packages. It does not need a new E2E plan beyond those tests: the
behavior is the same install flow with new ceilings. Record that in the PR
test notes.

## Acceptance criteria

1. The four constants above are the ones in
   `workspace-skill-management.ts`. `MAX_TOTAL_BYTES` is gone.
   `MAX_PATH_LENGTH` and `MAX_PATH_DEPTH` are unchanged.
2. `MAX_SKILL_ZIP_BYTES` is 7,864,071. Both i18n catalogs use the strings
   in this document. Neither catalog still contains `6 MB` for this error.
3. A reviewer can recompute 7,864,071 from 10 MiB minus the 330-byte
   envelope. The global JSON limit is still `10mb`.
4. GitHub and folder installs write into the existing staging directory
   without retaining a `SkillPackageFile[]` of file bodies. ZIP expansion
   pipes entry streams to files. The archive buffer remains, bounded by
   `MAX_ZIP_ARCHIVE_BYTES`.
5. A package over 6 MiB and within 64 MiB, 32 MiB per file, and 2000 files
   installs from folder and from ZIP. Crossing any one of those ceilings
   returns the status and code in this document and leaves no staging
   directory and no partial skill.
6. Symlinks, path escape, depth, path length, manifest checks, and
   rollback behave as they do now.
7. `skill-source-download.ts` and `error-handlers.ts` have no diff.
8. The old skill-manager design is untouched. Where it still says every
   size is bounded below the JSON parser, this document wins for the
   installer limits.

## Open questions

None. The ceilings and the decision to stream into the existing staging
directory are settled. A follow-up may move GitHub installs onto one
archive download if the contents-API walk is too slow at the new file
cap. That follow-up is not required for this change.
