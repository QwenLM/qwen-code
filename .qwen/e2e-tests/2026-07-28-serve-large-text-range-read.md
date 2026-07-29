# Serve large-text range reads

## Automated verification

Run the focused Core range and service tests:

```bash
cd packages/core
npx vitest run src/utils/read-text-range.test.ts src/services/fileSystemService.test.ts
```

Run the WorkspaceFileSystem, ACP adapter, and HTTP route tests:

```bash
cd packages/cli
npx vitest run src/serve/fs/workspace-file-system.test.ts
npx vitest run src/serve/bridge-file-system-adapter.test.ts
npx vitest run src/serve/routes/workspace-file-read.test.ts
```

Then run repository verification:

```bash
npm run lint
npm run typecheck
npm run build
```

## Manual scenario

1. Put a valid UTF-8 CSV larger than 256 KiB in the bound workspace. The
   original reproduction used a 406,892-byte, 5,000-row CSV.
2. Start `qwen serve` and connect an ACP session to that workspace.
3. Ask the agent to call `read_file` with `limit: 20` and read the first 20
   lines.
4. Confirm the first `read_file` call succeeds with that finite limit and
   returns the requested CSV lines.
5. Confirm the agent does not need a shell command such as `head`, `sed`, or
   `awk` as a fallback.
6. Request a later finite line window and confirm it also succeeds without
   returning more than 256 KiB.

## Regression checks

- No-limit, line-only, maxBytes-only, and line-plus-maxBytes requests against
  the same large file remain `file_too_large`.
- A finite line window over a large binary file remains `binary_file`.
- A large non-UTF-8 text window remains `file_too_large` with a UTF-8
  conversion hint.
- A supported non-UTF-8 file within the full-snapshot cap still obeys
  `maxBytes` after its content is decoded to UTF-8.
- A partial large-file response reports the complete `sizeBytes`, sets
  `truncated: true`, omits the full-file hash, and exposes
  `originalLineCount: null` until EOF is known.
- Replacing the pathname, appending, truncating, or overwriting the opened file
  during the read is rejected instead of returning a mixed or stale result.
- A deep offset beyond 10 MiB still succeeds when the request has a finite
  line limit.

## Baseline status

Before the fix, Core could read the requested range from the 406,892-byte CSV,
but Serve rejected the file at its 256 KiB full-snapshot gate before slicing.
The focused automated tests cover the corrected Core, WorkspaceFileSystem, ACP,
and HTTP paths; the manual ACP/model scenario remains the release smoke test.
