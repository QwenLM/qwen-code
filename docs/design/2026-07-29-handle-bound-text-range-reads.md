# Handle-Bound Text Range Reads

## Context

PR #7947 let the Serve workspace filesystem return bounded line windows from
text files above `MAX_READ_BYTES` (256 KiB). To keep those reads pinned to one
inode across validation, binary probing, and streaming, it threaded a
caller-owned `FileHandle` down into `readTextRange` as an optional field, and
added a second optional field, `forceStreaming`, to suppress the buffering fast
path that would otherwise defeat the memory bound.

Two optional fields on one entry point produced four combinations, of which one
is meaningful, one is unreachable, and one is unsafe:

| `fileHandle` | `forceStreaming` | Result                                                                 |
| ------------ | ---------------- | ---------------------------------------------------------------------- |
| unset        | unset            | ordinary path read                                                     |
| unset        | set              | streams a small file — used by one test                                |
| set          | set              | the Serve boundary's read                                              |
| set          | unset            | buffers the whole file through the handle — **no caller can reach it** |

The unreachable combination carried a dedicated helper, `readFileHandleBuffer`,
with no test coverage. Separately, `readFileWithLineAndLimit` accepted the same
`fileHandle` but could only honor it on its range branch: an unbounded read fell
through to a by-path `readFileWithEncodingInfo`, silently returning bytes from
whatever the path resolved to at that moment rather than from the pinned inode.
PR #7947's follow-up commit guarded that with a runtime `RangeError`, which
documented the trap without removing it.

Encoding detection had forked for the same reason. `detectFileEncoding` takes a
path and opens its own descriptor, so the handle path could not use it; a
private `detectFileHandleEncoding` was added alongside, deriving the encoding
name from `decodeBufferWithEncodingInfoAsync(...).encoding` instead of from
chardet directly. The two disagree when chardet names an encoding `iconv-lite`
cannot load: the path variant returns that name, the handle variant returns
`'utf-8'` and defers to the streaming decoder's `fatal: true` failure. Both
refuse the file, with different messages.

## Goals

- One encoding detector, usable from a path or a borrowed descriptor.
- No mode flags on the range reader; make the unreachable combination
  unrepresentable rather than merely unused.
- Make the by-path fallthrough structurally impossible instead of guarded.
- No observable change at the Serve boundary or in the `read_file` tool.

## Non-goals

- Collapsing `decodeBufferWithEncodingInfo` (sync) into its async twin. The sync
  variant is a deliberate public-API compatibility shim
  ([`lazy-first-use-dependencies.md`](./lazy-first-use-dependencies.md)) pinned
  by a parity test.
- Any change to what the Serve boundary returns. This is preparation for
  byte-cursor paging, not that feature.

## Design

### One detector

`detectFileEncoding(source: string | FileHandle)`. A supplied handle is
_borrowed_: reads use explicit positions so the caller's file position is
untouched, and the `finally` block closes only a descriptor this function
itself opened. `detectFileHandleEncoding` is deleted, and the open-coded
BOM-to-name switch is replaced with the existing `bomEncodingToName`.

This makes the handle path slightly stricter, which is the intended direction:
an encoding `iconv-lite` cannot load now raises
`LargeNonUtf8TextError(detected)` naming that encoding, rather than reaching the
decoder and raising the generic `'invalid-utf8'` variant. The refusal is
unchanged; the message improves. The Serve boundary maps both to `binary_file`,
so nothing downstream moves.

A second, smaller delta comes with the merge: `detectFileEncoding` catches all
errors and falls back to `'utf-8'`, whereas `detectFileHandleEncoding` had no
handler and let an I/O failure propagate. The failure is not lost — a handle bad
enough to fail the 8 KiB probe fails the streaming read immediately after, and a
file that is not really UTF-8 is still refused by the `fatal: true` decoder — so
the error surfaces from a different call rather than disappearing. Accepted for
the single fallback policy; noted because it is a real change in which call
reports the problem.

### Two entry points

```ts
readTextRange(request: ReadTextRangeRequest)                    // path
readTextRangeFromHandle(fh, request: ReadTextRangeFromHandleRequest)
```

The handle variant always streams — there is no flag, because a caller reaches
for a handle precisely when it needs the read bounded, and the buffering fast
path would read the whole file. Its request type has no `path` (nothing for one
to disambiguate), retains the numeric `fileSize` captured from the opening
`fstat`, and makes both byte bounds required rather than optional.
`maxOutputBytes` caps what the read returns, `maxScanBytes` caps what it costs,
and `fileSize` prevents an append from widening the descriptor snapshot while
the read is in flight. A handle-bound read exists because a security boundary
needs all three bounds.

`maxScanBytes` stays optional on the path variant, where it defaults to
`Infinity` so the `read_file` tool is unchanged.

Both delegate to the same streaming implementation, which now takes
`source: string | FileHandle` and selects `createReadStream` or
`chunksFromHandle` accordingly. `readFileHandleBuffer` and the branch that
called it are deleted.

### The fallthrough disappears

`readFileWithLineAndLimit` loses `fileHandle`, `forceStreaming`, and
`maxScanBytes` — its single production caller passes none of them.
`StandardFileSystemService.readTextFileFromHandle` now calls
`readTextRangeFromHandle` directly, and the two read paths share a
`toReadTextFileResponse` helper so their metadata shaping cannot drift. With no
`fileHandle` parameter left to ignore, the `RangeError` guard is removed: the
trap it described can no longer be expressed.

`readTextFileFromHandle` stays off the `FileSystemService` interface, so
`AcpFileSystemService` and the typed fallback mock in `filesystem.test.ts` are
untouched.

## Blast radius

- `readTextRange` is not exported from `packages/core/src/index.ts`; the three
  boundary-facing error classes are. The reshaped reader surface is
  core-internal.
- `readTextRange` and `readFileWithLineAndLimit` have exactly one production
  caller each (`fileUtils.ts`, `fileSystemService.ts`).
- `detectFileEncoding` is public via `export * from './utils/fileUtils.js'`.
  Widening a parameter is source-compatible.
- The only cross-package importer of the touched modules is
  `packages/cli/src/serve/fs/workspace-file-system.ts`. Its only change is
  dropping two arguments the handle path no longer accepts — see below; the
  `decodeBufferWithEncodingInfoAsync` import it also carries is untouched.

### `CoreReadTextFileHandleRequest` becomes standalone

It was `Omit<CoreReadTextFileRequest, 'limit' | 'stats' | 'maxOutputBytes'> &
{...}`, which left two fields the handle path never reads:

- **`stats`** was documented as required — "must pass the Stats captured from
  that handle" — and nothing downstream read the object. The final API retains
  only its numeric `fileSize`: the handle path does not need metadata to choose
  a strategy, but it does need the opening size to keep reads bounded when the
  file is appended to concurrently.
- **`path`** became dead once `readTextRangeFromHandle` replaced the
  path-plus-handle call: the read is bound to the descriptor, and errors are
  labelled with the path by the Serve boundary that owns it.

Neither was caught by the compiler. The ACP `ReadTextFileRequest` this type
derived from permits extra properties, so passing a field the type had removed
raised nothing. That is the argument for declaring the type standalone rather
than deriving it: the `Omit` chain was stripping four of six inherited fields
and quietly re-admitting the rest.

At the refactor commit, 282 production logic lines changed in `packages/core`;
the later cursor follow-up adds behavior and tests on top of that baseline.

## Testing

At the refactor commit, the existing suites were the specification: the whole
point was that the Serve boundary could not tell. The later cursor follow-up
adds boundary behavior and its own tests.

Three tests in `read-text-range.test.ts` moved to `readTextRangeFromHandle`. Two
used `fileHandle` directly. The third used a _path_ with `forceStreaming: true`
to force streaming on a file too small to leave the fast path, so that it could
exercise the budget-at-EOF boundary; with the flag gone, the handle variant is
the only thing that always streams.

One of the moved tests changed meaning. It previously passed a handle for one
file and a path naming a different file, asserting the handle won — a test for
the confusion the old signature permitted. The handle variant has no `path`, so
that confusion is now unrepresentable and the test would assert nothing. It was
rewritten to cover the property that actually motivated the API: open a handle,
rename another file over the path, and confirm the read still follows the inode.

Two tests in `fileSystemService.test.ts` were deleted rather than repaired. They
mocked `readFileWithLineAndLimit` and asserted the argument object it received;
since `readTextFileFromHandle` no longer calls it, they could only have been
kept by re-pointing them at a new mock, which would again assert only that one
function passes arguments to another. The behaviour they nominally covered is
tested against real files in `read-text-range.test.ts` and at the real boundary
in `workspace-file-system.test.ts`. The argument-validation tests beside them
are kept — they need no mock.

## Follow-up

`chunksFromHandle` gained a `from` parameter as the single seam byte-cursor text
paging needed. The follow-up now uses it to resume from a non-zero byte offset.
