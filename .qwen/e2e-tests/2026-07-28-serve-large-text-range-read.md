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
npx vitest run src/serve/fs/workspace-file-system.test.ts src/serve/bridge-file-system-adapter.test.ts src/serve/routes/workspace-file-read.test.ts
```

Run the SDK query-serialization tests:

```bash
cd packages/sdk-typescript
npx vitest run test/unit/DaemonClient.test.ts test/unit/acpRouteTable.test.ts
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
6. Follow the returned `nextCursor` until `hasMore` is false. Confirm the
   rejoined pages equal the original file and no page returns more than
   256 KiB.
7. Append rows after the first page and confirm the outstanding cursor remains
   valid.

## Regression checks

- A no-window read against the same large file remains `file_too_large`;
  line-only, maxBytes-only, and line-plus-maxBytes requests are admitted as
  explicit bounded windows.
- A finite line window over a large binary file remains `binary_file`.
- A large non-UTF-8 text window is `binary_file` with a UTF-8 conversion or
  `readBytes` hint.
- A supported non-UTF-8 file within the full-snapshot cap still obeys
  `maxBytes` after its content is decoded to UTF-8.
- A partial large-file response reports the complete `sizeBytes`, sets
  `truncated: true`, omits the full-file hash, and exposes
  `originalLineCount: null` until EOF is known.
- Replacing the pathname, truncating, or overwriting the opened file during the
  read is rejected; append-only growth remains readable.
- A deep line offset beyond the 8 MiB scan budget returns `file_too_large` and
  points the client at cursor paging or `readBytes`.
- A malformed cursor or a cursor combined with `line` returns `parse_error`;
  a cursor for a replaced or truncated file returns `hash_mismatch`.

## Baseline status

Before the fix, Core could read the requested range from the 406,892-byte CSV,
but Serve rejected the file at its 256 KiB full-snapshot gate before slicing.
The first bounded-window implementation then required repeated line scans and
could not reach pages beyond the scan budget. The focused automated tests cover
the corrected Core, WorkspaceFileSystem, ACP, HTTP, and SDK paths; the manual
ACP/model scenario remains the release smoke test.
