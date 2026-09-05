# Daemon external built-in text writes

## Decision

Same-host `qwen serve` keeps the ACP filesystem capability at
`{ readTextFile: false, writeTextFile: true }`. Final text writes remain
delegated to the daemon, but the daemon-owned bridge adapter may route a
strictly marked final write from `write_file`, `edit`, `notebook_edit`, or the
shell tool's simulated sed editor to a host writer when the target is outside
the owning workspace.

Generic ACP, IDE, remote and virtual filesystem hosts remain unchanged. The
adapter option defaults off, and an injected bridge, workspace registry or
filesystem factory does not inherit the exception. HTTP filesystem routes
always retain the workspace boundary.

## Provenance and permission ordering

The four built-in consumers attach a core-only `toolWriteOrigin` field when
they call `FileSystemService.writeTextFile`. It is not part of any model tool
schema. `AcpFileSystemService` removes any caller-supplied marker and, only for
that core field, emits the versioned ACP metadata value
`qwen-code/tool-write-origin`.

The marker is created only by the final service call inside tool `execute()`.
Normal confirmation, allow rules, AUTO/AUTO_EDIT and YOLO therefore keep their
existing meaning: approval permits the final call, while rejection, Plan,
Hook/Guard refusal and pre-execution cancellation do not send it. There is no
second daemon confirmation. Cancellation after a tool has already begun a
non-cancellable filesystem operation keeps that tool's existing semantics.

The metadata is routing provenance, not an OS credential. `qwen serve` has a
same-machine, same-UID, single-security-principal model; a replaced child with
that UID already has equivalent filesystem authority through shell.

## Routing

The bridge adapter accepts the exception only when all of these are true:

- the daemon-created adapter explicitly enables same-host tool writes;
- the metadata object has exactly `version: 1` and one recognized `source`;
- the filesystem factory implements `writeSameHostToolText`.

Otherwise the request uses the ordinary WFS route and an external path fails
with `path_outside_workspace`.

The factory classifies paths with the side-effect-free workspace resolver.
Workspace paths continue through `WorkspaceFileSystem.writeTextOverwrite`.
Only `path_outside_workspace` enters the external writer; symlink escape,
parse and generation errors fail immediately. This prevents an unsuccessful
WFS audit row from being emitted before a successful fallback.

## External writer invariants

External targets must be absolute and pass the suspicious-path checks. An
existing leaf must be a regular non-symlink file. Its real path and the
original leaf must retain the same device and inode during resolution. For a
new leaf, only the existing direct parent is realpathed, allowing aliases such
as macOS `/tmp` while never writing through a leaf symlink. The canonical
target is used for locking, the atomic write and success audit.

The writer shares the runtime trust snapshot, generation guard and daemon-wide
canonical path mutex. It applies the 5 MiB UTF-8 precheck and the final encoded
byte cap, writes a `0600` temporary file, preserves an existing target's mode,
fsyncs best effort, rechecks the generation before rename and atomically
publishes the result. Only `bom`, `encoding` and `lineEnding` cross into the
encoder. The single ACP-added leading `U+FEFF` is removed before re-encoding so
UTF-16 and UTF-32 outputs do not receive two BOMs.

Each operation emits one real outcome: `fs.access` after a successful commit,
or `fs.denied` for trust, path, symlink, size, generation or I/O failure. The
route remains `ACP writeTextFile` and retains the session ID.

## Boundaries

This exception does not apply to HTTP routes, unmarked ACP writes,
caller-injected factories, arbitrary shell redirection, parent-directory
creation, file-history helpers or commit attribution. Another registered
workspace is still external to the current runtime; after the normal tool
permission policy allows the action, the canonical shared lock serializes the
write.

The change removes the systematic sequence in which a built-in write is
approved, fails only at the final WFS boundary, and encourages a shell retry.
It does not promise that a model never chooses shell or retries shell after a
separate policy failure such as the size cap or symlink rejection.

Existing full-file pre-read memory pressure, pre-approval diff fan-out and the
lack of a daemon-local-read opt-out remain separate concerns.
