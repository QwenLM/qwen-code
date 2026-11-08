# Daemon local text reads

## Decision

`BridgeOptions.delegateReadTextFileToClient` defaults to `true`, preserving
generic ACP, IDE, remote, and virtual-filesystem behavior. Same-host `qwen
serve` runtimes set it to `false`, so the ACP initialize capability is
`{ readTextFile: false, writeTextFile: true }` and the child uses its regular
CLI filesystem service for text reads. Caller-injected bridges remain under
the caller's control.

## Behavior

Direct external text `read_file` calls use the normal CLI permission flow:
their default is `ask`, approval allows the read, and rejection prevents tool
execution. Allow rules and automatic approval modes behave as in the CLI.
Non-text `read_file` paths were already read locally by the child and are
unchanged.

Because the capability applies to `FileSystemService.readTextFile`, shared
text pre-reads used by write, edit, notebook, sed, and artifact operations also
move to the regular CLI filesystem service. This intentionally accepts the
CLI's read-side limits and behavior instead of WFS's 256 KiB returned-output
and full-snapshot cap, 8 MiB large-text scan cap, read audit, symlink rejection,
and read-side TOCTOU protections. Direct `read_file` still applies the core line
and output limits, subject to their existing configuration.

This document is the single owner of that tradeoff list. Other documents
reference it rather than restating the limits, so tuning one of them does not
leave stale copies behind.

### Final writes

Reads become child-local, while final ACP text writes stay delegated. A narrow
same-host route now closes the approved external-write failure for built-in
text tools without moving writes wholesale into the child: marked final calls
from `write_file`, `edit`, `notebook_edit`, and simulated sed retain trust,
symlink, size, generation, atomic-write, mode and audit enforcement. Generic
ACP and HTTP writes remain workspace-scoped. The complete boundary and threat
model live in [Daemon external built-in text writes](./daemon-external-tool-text-writes.md).

### Pre-approval exposure in the daemon

A confirmation payload is built by reading the file, so an edit or write
confirmation for an out-of-workspace path now carries that file's content in
its diff. The daemon fans that payload out to every attached SSE subscriber
before the approval decision exists. In the interactive CLI the same diff is
seen only by the person at the terminal. This follows from treating
authenticated daemon clients as one security principal, and is called out here
because that framing is easy to read past.

HTTP filesystem routes such as `/glob` and `/list` remain workspace-scoped.
Agent `glob`, `ls`, `grep`, and other discovery-tool behavior is unchanged by
this capability. Final ACP `writeTextFile` content writes stay delegated. They
use WFS inside the workspace and the narrowly gated host writer outside it;
both retain trust, symlink, atomic-write, size and audit enforcement. This does
not imply that every agent write or helper operation goes through WFS.

## Resource and audit boundaries

A child-local text read does not emit WFS `fs.access`; direct external
`read_file` retains its permission audit and core file-operation telemetry.
Same-host reads run under the daemon user's OS identity. `qwen serve` assumes
one machine, one UID, and one security principal; it is not an OS sandbox.

## Compatibility

Only the default embedded daemon bridge and primary, static-secondary, and
dynamic `qwen serve` workspace runtimes disable read delegation. The WFS
adapter keeps its read implementation so an unexpected or
capability-violating delegated read still reaches the workspace boundary and
fails closed for external paths.

That "fails closed" is bounded, not absolute. `AcpFileSystemService` has a
second, pre-existing bypass: when a delegated read is refused with
`path_outside_workspace` or `symlink_escape`, it retries the read locally if
the path's realpath sits under one of its managed read roots. Those roots
include `/tmp` unconditionally on POSIX, plus anything named by
`QWEN_ACP_LOCAL_READ_ROOTS`. So the boundary is fail-closed only for paths
outside those roots. The daemon neutralizes the env-supplied half by setting
`QWEN_ACP_LOCAL_READ_ROOTS` empty for the child.

With the capability off, that retry path is unreachable in the daemon anyway —
the capability check returns before the delegated call is attempted — so it
now guards only generic ACP hosts that keep delegation enabled.
