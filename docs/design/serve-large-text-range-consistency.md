# Serve large-text range consistency

## Context

Serve now streams finite-limit text windows from files larger than
`MAX_READ_BYTES`. A line-only or maxBytes-only request does not unlock this
path. The workspace boundary opens the file once, reads through that handle,
and returns partial metadata without a full-file hash.

An open file descriptor fixes the inode, but it does not freeze the inode's
bytes. Node also does not synchronize file-system operations that modify the
same file concurrently. A reader can therefore observe bytes written after
`open`, including an in-place rewrite with the same inode and size.

Issue #7946 requires files changed or replaced during a read to remain
rejected. Append-tolerant reads are not part of that contract.

## Decision

Large streamed windows use the file's open-time stat as their snapshot
baseline:

1. The initial `lstat` and open-time `fstat` must identify the same regular
   file with the same device, inode, size, modification time, and change time.
2. After streaming, both `fstat` and pathname `lstat` must retain that
   identity and version, and the pathname must not be a symlink.
3. The caller closes the handle in `finally`, after all read and stability
   checks.
4. A mismatch detected by these stability checks returns `hash_mismatch`.

Content validation errors are captured until the post-read checks finish, so a
concurrent mutation that also causes decoding to fail still returns
`hash_mismatch`. Without a mutation, binary content remains `binary_file` and
large non-UTF-8 text remains `file_too_large` with a conversion hint.

This matches the existing full-snapshot stability policy. It intentionally
rejects concurrent appends: size growth proves that the open-time snapshot was
not stable, while inode identity alone cannot prove that the original prefix
was unchanged.

Reliable append tolerance would require a separate snapshot mechanism or a
second bounded read that verifies every byte used to locate and produce the
requested line window. That additional I/O and protocol policy are outside
this bug fix.

## Range-reader cleanup

A caller-owned file handle always selects the streaming path. The separate
`forceStreaming` switch and handle-buffering fast path are therefore removed.
The handle chunk reader limits positional reads to the caller's captured file
size, so a read cannot cross the open-time EOF, and reuses one 512 KiB buffer
because each chunk is decoded synchronously before the generator advances.

There is no fixed scan-byte budget: line offsets require scanning from byte
zero, so deep windows remain O(file size). The finite line limit and
`MAX_READ_BYTES` cap bound returned content and memory, while cancellation is
checked between reads. A future scan-cost policy needs a cursor or equivalent
continuation contract instead of silently making valid deep offsets
unreachable.

Serve derives `lineEnding` from the returned content, matching its existing
full-snapshot behavior. Core can continue reporting file-level metadata for its
other consumers.

Every large-file window keeps `truncated: true`, even when the scan happens to
reach EOF. This boundary uses the flag to distinguish a window without a
full-file hash from a complete snapshot that is safe to treat as whole-file
content; it does not mean only that decoded characters were omitted.

## Consumers

All Serve callers resolve through the selected workspace runtime before
reaching this boundary:

- `GET /file`
- ACP HTTP `_qwen/file/read`
- the injected ACP `readTextFile` adapter

Windowless reads used by workspace setup retain the existing 256 KiB
full-snapshot refusal.

## Verification

- A mixed-EOL large file reports the ending style present in the returned
  slice.
- Concurrent append, truncation, pathname replacement, and symlink replacement
  are rejected. A same-size in-place rewrite is rejected whenever the change
  lands in a later timestamp quantum: the checks compare modification time and
  change time, so a rewrite that also restores modification time is caught only
  by change time advancing, which is best-effort at the kernel's coarse-clock
  resolution rather than an absolute guarantee, though still strictly stronger
  than the prior size + modification time full-snapshot comparison.
- Handle-bound range reads never use the full-buffer fast path and reuse their
  streaming buffer.
- A deep offset beyond 10 MiB succeeds with a finite line limit.
- No-limit, line-only, and maxBytes-only requests remain behind the 256 KiB
  full-snapshot gate.
- Existing output, encoding, binary, hash, and line-count limits remain
  unchanged.
