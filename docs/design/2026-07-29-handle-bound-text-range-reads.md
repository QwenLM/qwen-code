# Handle-Bound Text Range Reads

## Context

PR #7947 let the Serve workspace filesystem return bounded line windows from
text files above `MAX_READ_BYTES` (256 KiB). To keep those reads pinned to one
inode across validation, binary probing, and streaming, it threaded a
caller-owned `FileHandle` down into `readTextRange` as an optional field. When
the field was set the read always streamed — the buffering fast path does not
apply to a handle read — through a private `readFileHandleChunks(handle,
sourceSize, signal)` bounded by the size captured at `open`.

An optional field on a shared entry point expressed the handle path as a branch
inside `readTextRange` rather than as its own operation: the request type still
carried `path` and `stats` that a handle read never uses, and the streaming
implementation chose between `createReadStream` and the handle chunk reader by
testing whether the field was present.

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
- No mode flags and no optional handle field on the range reader; the handle
  path is its own entry point, so a path read and a handle read can no longer
  share a request shape.
- No observable change at the Serve boundary or in the `read_file` tool, apart
  from the deliberately disclosed deltas listed below.

## Non-goals

- Collapsing `decodeBufferWithEncodingInfo` (sync) into its async twin. The sync
  variant is a deliberate public-API compatibility shim
  ([`lazy-first-use-dependencies.md`](./lazy-first-use-dependencies.md)) pinned
  by a parity test.
- Any change to what the Serve boundary admits. The large-file admission
  contract (a finite `limit` is required above `MAX_READ_BYTES`) is #7947's and
  is not revisited here; this is preparation for byte-cursor paging, not that
  feature.

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
to disambiguate) and makes `maxOutputBytes` required rather than optional: it
caps what the read returns, and a handle-bound read exists because a security
boundary needs that bound. `limit` stays optional — a caller may read to end of
file — and the borrowing boundary decides which reads to admit.

Both delegate to the same streaming implementation, which now takes
`source: string | FileHandle` and selects `createReadStream` or
`chunksFromHandle` accordingly. The old handle chunk reader
(`readFileHandleChunks`) becomes `chunksFromHandle(fh, from)`: it gains a start
offset and drops the open-time size bound, and allocates a fresh buffer per
chunk instead of reusing one. Both changes are detailed under Behaviour deltas.

### The service layer

`StandardFileSystemService.readTextFileFromHandle` now calls
`readTextRangeFromHandle` directly instead of routing through `readTextRange`
with an optional handle field, and `readTextFile`'s body is extracted to a
module-level `readTextFileStandard`. Both read paths share a
`toReadTextFileResponse` helper — typed structurally rather than as a union of
the two result shapes — so their metadata shaping cannot drift.

The argument-validation `RangeError` guards are kept, rewired so
`maxOutputBytes` is the required positive-finite field while `limit` becomes
optional and `Infinity`-tolerant (a caller may read to end of file). The
`limit: Infinity` admission this introduces is disclosed under Behaviour deltas.

`readTextFileFromHandle` stays off the `FileSystemService` interface, so
`AcpFileSystemService` and the typed fallback mock in `filesystem.test.ts` are
untouched.

## Behaviour deltas

The refactor is meant to be unobservable at the Serve boundary, and the
`packages/cli/src/serve/fs/` suites pass against it unchanged apart from the one
assertion noted in Testing. Four changes are nonetheless observable in principle
and are disclosed here rather than left implicit in the diff:

1. **Handle reads are bounded to the file size at open.**
   `readTextRangeFromHandle` stats the descriptor and passes the size as an end
   bound to `chunksFromHandle`, which reads `while (position < to)` rather than
   to live EOF. Bytes appended after the handle is opened are not returned.
   This matches #7947's behaviour and keeps the chunk reader bounded even when
   the requested line window is unreachable. Pinned by
   `bounds handle reads to the stat size, not live EOF`.
2. **Fresh buffer per chunk.** #7947 reused one 512 KiB buffer across
   iterations, so a yielded view was valid only until the next read.
   `chunksFromHandle` allocates a fresh buffer per chunk, so a yielded chunk
   stays valid after the generator advances. This is the safer contract.
3. **`limit` stays optional but must be finite.** An omitted `limit` means
   "read to end of file," still capped at `maxOutputBytes`. `Infinity` is
   rejected by the handle-boundary validator: every production caller already
   enforces a positive safe integer before reaching `readTextFileFromHandle`,
   so the relaxation bought nothing and was removed per Simplicity First.
4. **Large undecodable text maps to `binary_file`, not `file_too_large`.** A
   large file in an encoding the text route cannot decode previously surfaced as
   `file_too_large` (413); it is now `binary_file` (422), matching sniffed
   binary content. A client that retries a 413 with a smaller window can never
   exit that loop for an encoding problem; `readBytes` is the same remedy that
   already applies to binary content. Documented in
   `docs/developers/daemon/07-workspace-filesystem.md` and
   `docs/developers/qwen-serve-protocol.md`, and asserted at the HTTP layer.

## Blast radius

- `readTextRange` is not exported from `packages/core/src/index.ts`; only
  `LargeNonUtf8TextError` is. The reshaped surface is core-internal.
- `readTextRange` and `readFileWithLineAndLimit` have exactly one production
  caller each (`fileUtils.ts`, `fileSystemService.ts`).
- `detectFileEncoding` is public via `export * from './utils/fileUtils.js'`.
  Widening a parameter is source-compatible.
- The only cross-package importer of the touched modules is
  `packages/cli/src/serve/fs/workspace-file-system.ts`. Its only changes are
  dropping the two arguments the handle path no longer accepts (`path`,
  `stats`) and mapping `LargeNonUtf8TextError` to `binary_file` (Behaviour
  deltas #4); the `decodeBufferWithEncodingInfoAsync` import it also carries is
  untouched.

### `CoreReadTextFileHandleRequest` becomes standalone

It was `Omit<CoreReadTextFileRequest, 'limit' | 'stats' | 'maxOutputBytes'> &
{...}`, which left two fields the handle path never reads:

- **`stats`** was documented as required — "must pass the Stats captured from
  that handle" — and nothing downstream read it. The handle path always streams,
  so it never needs a size to choose a strategy, and the encoding probe does its
  own `fstat`.
- **`path`** became dead once `readTextRangeFromHandle` replaced the
  path-plus-handle call: the read is bound to the descriptor, and errors are
  labelled with the path by the Serve boundary that owns it.

Neither was caught by the compiler. The ACP `ReadTextFileRequest` this type
derived from permits extra properties, so passing a field the type had removed
raised nothing. That is the argument for declaring the type standalone rather
than deriving it: the `Omit` chain was stripping four of six inherited fields
and quietly re-admitting the rest.

The change is confined to `packages/core` internals and the single
cross-package call site named above.

## Testing

The existing suites are the specification: the whole point is that the Serve
boundary cannot tell. `packages/cli/src/serve/fs/` and the bridge adapter pass
against the refactor unchanged apart from one assertion updated for the
deliberate non-UTF-8 → `binary_file` mapping (Behaviour deltas #4), as does the
full `packages/core` `src/utils` + `src/services` run. The HTTP route suite also
gains a case asserting that a large non-UTF-8 file requested with a finite
`limit` returns `422 binary_file`.

The new handle-path contracts are pinned directly in `read-text-range.test.ts`:
a deep multi-chunk read with a byte cap, a multi-byte character straddling the
8 KiB encoding-probe boundary, read-to-EOF (bytes appended after `open` are
returned), an omitted/`Infinity` `limit` reading the whole file, and aborts
landing before and during a handle-bound stream.

Two tests in `read-text-range.test.ts` moved to `readTextRangeFromHandle`. One
of them changed meaning. It previously passed a handle for one
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

`chunksFromHandle` accepts an options object `{ from, to, signal }`. `from`
defaults to 0 and nothing yet passes a non-zero value; it is the seam
byte-cursor text paging needs. `to` defaults to the file size captured at open
(Behaviour deltas #1), so the follow-up inherits the bound automatically.
