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

HTTP filesystem routes such as `/glob` and `/list` remain workspace-scoped.
Agent `glob`, `ls`, `grep`, and other discovery-tool behavior is unchanged by
this capability. Final ACP `writeTextFile` content writes stay delegated through
`WorkspaceFileSystem`, retaining workspace, trust, symlink, atomic-write, and
audit enforcement. This does not imply that every agent write or helper
operation goes through WFS.

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
