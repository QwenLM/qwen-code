# Container execution for subagents (Track A)

[English](2026-09-12-agent-container-execution.md) | [简体中文](2026-09-12-agent-container-execution.zh-CN.md)

Status: backend and operator/definition policy implemented. Independent Linux Docker and rootful/rootless Podman verification covers `e544823995`; subsequent review fixes have local controlled-worker verification and still need native-runtime revalidation. Related: #11695, #11696, #9556.

## Problem and current state

Worktree isolation changes the working directory, but commands still run as the
host user. File tools also call host filesystem APIs during validation,
permission preparation, execution, and cache maintenance. Replacing
`FileSystemService` or the static shell entry alone cannot relocate execution.

The existing review command runner provides useful container policy: an explicit
environment allowlist, temporary HOME, named cleanup, and offline build/test
commands. Its review-specific mount layout is not a general workspace policy.
Install currently has ordinary container networking, not registry-only egress.

## Scope and activation

This change implements the container execution backend for ordinary subagents.
The parent model loop and its tools remain local. Each supported child has its
own environment; an operator container requirement applies to all ordinary
siblings. This is subagent execution policy, not whole-session confinement.

The trusted CLI operator requires container execution with
`QWEN_AGENT_EXECUTION_BACKEND=docker` or `podman`. Repository-sourced environment
values cannot enable or configure the runtime. Project `.env` and settings
values are excluded from initial loading and reload for this selector; reloading
or deleting a project value cannot overwrite or relabel an operator requirement.
For this selector, a nonempty file-sourced value (including a home `.env` or
inherited file provenance) is rejected with an instruction to export it in the
launch environment. It must never silently become a local default. Home-file
activation is not supported by this slice. A nonempty selector in merged
`settings.env`, including user settings, remains excluded and emits an export
remediation diagnostic during loading, runtime snapshots and reloads.
Agent has no `execution_backend` parameter. Definitions can request
`executionBackend: container`; omission
inherits the operator policy, and no definition value can weaken it. Without
either requirement execution stays local. The existing image override selects
the image; model arguments cannot select images, mounts, runtime endpoints, or
arbitrary container flags.

This initial backend is available on Unix hosts. Windows, whole-session sandbox
and Daemon/Serve handoffs have no factory. A required container with no available
factory fails before child launch; factory absence is not a local default.

Use an independently installed, complete CLI bundle. From the target project,
launch `QWEN_AGENT_EXECUTION_BACKEND=docker qwen`. Ordinary Agent dispatches then
require containers. Replace `docker` with `podman` when appropriate.
An operator can export `QWEN_CODE_CUSTOM_SANDBOX_IMAGE` for another toolchain.
The workspace must not overlap the CLI bundle or its dependency lookup directories
in either direction, including canonical aliases and currently absent lookup
directories. Before starting a container, the CLI checks its installation and
Node's dependency search directories for links escaping those protected roots.
This prevents a writable workspace alias from changing code the host later loads.
Hoisted dependencies and package links that stay within the protected roots are
supported when link targets are normalized (ordinary leading `../` is allowed).
Symlinked installation/search roots or ancestors, external or dangling links,
hard-linked installation files, and unreadable directories are rejected.
Shared hard-link package-store layouts are therefore unsupported.
This conservative check can also reject unrelated linked packages in a shared
Node search directory. In that case, use a local installation outside the shared
global package directory and launch
`QWEN_AGENT_EXECUTION_BACKEND=docker node --no-global-search-paths /path/to/independent/cli.js`.
The flag disables Node's global fallback lookups; it does not exclude ancestor
`node_modules` directories, so the independent installation still matters.
Source and tsc launches are unsupported. For CLI development, build, bundle and
prepare the npm package, then install it separately without source-workspace
links; use the target checkout or a separate worktree as the agent's workspace.
CLI relaunches preserve environment values for startup-time consumers such as
Node TLS certificates and settings interpolation. Private parent-to-child
metadata preserves their file provenance before environment files are loaded;
no file scope can supply this metadata. The metadata remains in the process
environment for ordinary child CLI launches, including Shell and review children,
and is refreshed on reload without losing the provenance of frozen or retained
values. Container runtime clients discard both the metadata and all file-sourced
values.

The policy composes with `isolation: "worktree"` and `working_dir`. It does not
extend the model-visible isolation enum or change `isolation: "remote"`.
Combining it with `tools.mode: "code_mode_only"` is rejected before container startup;
`tools.mode: "code_mode"` warns and continues with direct tools only, registering
no `exec`. The first container registry supports direct tool calls only.

## Backend policy and definition boundaries

The initial model opt-in allowed an enabled operator capability to remain unused.
The revision separates an immutable Config requirement from the factory lifecycle.
Derived approval, worktree, workflow and resume contexts inherit that requirement,
including after shutdown. Resolve a definition's backend once per dispatch; use
it for validation, environment ownership, hooks and persisted metadata. Unknown
model arguments cannot override it.

Only the resolved string `container` is a valid definition value. Project
declarations require a trusted workspace, matching external executors. Null, `local`, other
values, duplicate keys, malformed YAML and invalid required fields must produce
a named refusal, not fall through to a lower-priority local agent. Refusals
reserve every declared top-level name, including middle duplicate keys. Preserve the
field through save, unrelated edits, extensions and SDK session objects. Validate
session objects when consumed; never filter invalid declarations and continue
initialization with a builtin. Explicit deletion removes only the definition
preference, never the operator floor. Claude plugin conversion preserves valid
declarations and leaves rejected source unchanged for the extension loader to
record its refusal. Daemon REST and ACP HTTP create/update reject the field within
their existing resolved-workspace and trust guards; no runtime is configured.

The CLI variable sets both capability and requirement. Core API hosts can inject
a factory without a default for definition-only selection. A definition cannot
provision missing capability. This slice adds no CLI capability-only setting.

Teams, Arena, workflows, external executors and retained regular/fork resumes
have no container lifecycle and refuse when container execution is required.
Workflow container refusals are run-level errors: sequential dispatch,
`parallel()`, `pipeline()` and nested compositions reject instead of returning
successful `null` slots. The journal does not record these policy refusals as
admitted-agent failures or results.
When the operator requires containers, Team creation and Arena startup refuse
before creating or reclaiming team files, resetting tasks or inboxes, attaching
team state, or provisioning Arena worktrees.
Direct Headless construction and the current in-process team backend must guard
before a local tool loop starts. Tool-capable internal forks (memory extraction,
dream, remember and skill review) also refuse; cache-only fork queries that
discard tool calls remain available. Do not clear derived policy to bypass these
limits. Daemon, managed runtime and SSH support remain out of scope. No policy
question remains open: definitions may strengthen, but cannot downgrade, the
operator floor.

Affected areas are Config and CLI activation, Agent resolution, definition
types/parser/serializer, plugin conversion, SDK type parity, direct runtime
construction and both daemon mutation protocols. Transport and worker lifecycle
follow the ownership and cancellation rules below.

Acceptance requires actual dispatch checks: omitted/forged model selectors cannot
run a required-container child locally; factory-unavailable cases fail loudly;
trusted definition-only selection works; malformed higher-priority declarations
refuse; save/SDK/plugin paths preserve policy; unsupported entry points and daemon
mutation protocols reject it. Unconfigured local dispatch is the control.

## Architecture

The harness, model credentials, authorization, and agent transcript remain on the
host. A container worker runs existing workspace tool implementations. The host
uses a typed execution contract carrying structured preparation information and
`ToolResult`, not a string-only tool protocol.

The contract includes preparation, confirmation, execution, modification, and
disposal. User modifications are bound to the scheduler call ID and discarded
when that call ends, so identical parameters cannot consume another call's edit.
Synchronous host tool construction validates the schema without
calling the original tool's filesystem-dependent build method. Original build
and path validation run in the worker. The host retains the tool's classifier
projection. Approval callbacks and modified content cross the same invocation
boundary; worker-only callback functions are never serialized as data.

The worker persists for its owning subagent so reads, edits, notebook preparation,
and background tool state share one tool session. Cache invalidation from the
harness must propagate to that session. The worker receives only the explicit
configuration required by tools; it does not receive model-provider credentials,
MCP credentials, the parent Config object, or a model client.
The explicit tool configuration preserves file filtering, new-file encoding,
shell timeout and heartbeat settings, output capture limits, and truncation
settings, including an unset threshold and zero meaning unlimited output.

Automatic session artifact registration is unavailable in container subagents.
The worker disables it even when an image enables artifacts through environment
variables or a write requests `record_as_artifact: true`. Files remain in the
workspace, but the worker does not claim they were registered. The container
Write tool advertises this limit; the host continues to discard worker artifact
metadata and does not interpret it as host paths. Ordinary local writes retain
their existing artifact behavior. A host-validated artifact bridge, including
child worktree-to-parent session path ownership, is deferred.

File-history checkpoints, host-path IDE diffs and automatic path-triggered
rule/skill activation are unavailable in container subagents; they must not read
container-reported paths through the host filesystem. Inline confirmation diffs
use the worker's original and proposed content. ToolSearch runs in the host
harness against only the private tool registry, preserving deferred discovery
and permission denials. Container agents refresh their declarations before each
model round; revealing a tool never refreshes the parent's model client.

Execution startup is lazy within the explicitly selected environment. The worker
is bundled with the installed CLI and mounted read-only, avoiding an independently
versioned worker supplied by the image. Development verification uses a separately
installed package built from the same source.

## Execution ownership

| Surface                                                                               | Owner in a container subagent                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Read, Write, Edit, NotebookEdit, Glob, Grep, directory listing                        | Container worker, including preparation and path resolution           |
| Shell, shell task output and stopping                                                 | Container execution session; host PIDs never represent container PIDs |
| Approval decisions, invocation guard, model requests, transcript                      | Host harness                                                          |
| Worktree creation, change detection, preservation and removal                         | Host, after execution cleanup                                         |
| Parent `!` commands and `@` file expansion                                            | Parent's environment; this change introduces no session-level backend |
| Monitor, nested Agent, external ACP agents, custom command tools, skills, LSP and MCP | Not available in this first container tool registry                   |
| User or subagent executable hooks                                                     | Incompatible combinations are rejected, not silently disabled         |

Container subagents cannot silently obtain host-bound discovered tools from their
parent. Unsupported combinations fail before starting the subagent. No container
failure retries an operation on the local backend.

## Filesystem and Git boundary

Bind only the resolved working tree at its canonical absolute path. Do not widen
the mount to satisfy dependency symlinks outside that tree. Use a temporary HOME;
do not mount the host HOME, credential stores, runtime directory, or container
socket. The same-path mapping reduces translation but is not authorization:
actual path resolution and file operations occur inside the container.
Protected host directories are resolved through their existing ancestors even
when the directory itself has not been created. A symlink alias must not hide
their containment in the writable workspace.

A separate temporary output directory is mounted at the same path in both the
primary and installation workers. The harness writes truncated tool output there
as well, so recovery paths remain readable after an installation worker exits.
This directory contains tool output only and is removed with the owning agent;
it does not expose the host runtime directory.
The temporary root must be outside the writable workspace, including after
resolving symlinks, so the worker cannot replace the output directory's parents.
Host persistence creates shared files exclusively, including truncation and
fallback writes, without reopening entries or changing permissions by path.
Existing entries are never overwritten by the host; failed writes use the
existing recovery path. Workers can still modify their shared output contents.

Always mask the working tree's `.git` entry with an empty read-only mount on
both the primary and installation workers, even when the entry is initially
absent. This also prevents container code from creating root Git metadata that
host Git clients could subsequently interpret, including configuration that
runs external programs. Use a directory mask for an absent entry or directory and a file mask
for a regular file. Reject symbolic links and other entry types. Recheck before
container creation and attachment; a file/directory kind change requires a new
agent environment. These checks are not atomic with concurrent host filesystem
changes.

For an absent entry, the CLI creates an empty mount-point directory as the host
user before starting the runtime, and records its device and inode. Sibling
environments in the same CLI process share its ownership. After all owning
workers have stopped, the last environment removes only that same empty directory
with a non-recursive removal. Pre-existing entries, replacements and directories
that gained contents are preserved. Failed worker cleanup retains ownership and
the backing mask. A later disposal call, including root-session shutdown after
agent cleanup failed, retries failed removals without reopening execution.
Concurrent calls share the current attempt; successful removals and lease
releases are not repeated. Filesystem cleanup can also be retried without
releasing another sibling's lease. A hard exit can leave the mount point behind;
there is no crash reaper or coordination between independent CLI processes. Do not run
independent CLI processes concurrently in the same non-Git workspace. While in
use, the placeholder is visible to host-side repository discovery too.

The container sees an empty read-only `.git` even for a non-Git workspace.
Existence-gated package lifecycle scripts may take their Git branch and fail
when they propagate the Git error; this does not imply that all hook installers
fail. In-container repository detection can also change ignore-file filtering
and select Git-backed search strategies. File discovery may therefore omit
paths that the parent, initialized before the placeholder, still lists.
In-container `git init` at the workspace root is unsupported. Linked
worktrees refer to a shared common directory which contains parent and sibling
state and may contain credentials. Only the selected workspace root's `.git` is
masked. Nested repositories and
submodules inside the workspace remain readable and writable workspace content,
including any credentials stored there. Their repository-local configuration
can name programs that host Git clients later execute; container-written files
may have the invoking user's ownership. Container isolation does not make those
files safe for subsequent host execution. This is not a repository-secret filter.
The host still sees the actual changes and applies the existing worktree
preservation rules. Git
commit transfer or a private Git metadata view requires a separate design.

## Network and credentials

General commands, file operations, builds, tests run without
network access. An explicitly recognized standalone package installation may run
in a separate install container sharing the working files. Command classification
must reject compound shell expressions as installation requests. This exception
allows ordinary networking, including package lifecycle scripts and access to
the writable workspace. Scripts can transmit workspace contents. Lifecycle
scripts remain enabled for dependency/toolchain compatibility; registry-only
egress or mandatory `--ignore-scripts` would be a separate policy change.

Both paths use the same explicit environment allowlist and temporary HOME. No
model, GitHub, cloud or MCP credentials are forwarded. Images and the container
runtime are trusted infrastructure. Rootless detection reads only Docker
`SecurityOptions` and Podman `Host.Security.Rootless` or `host.security.rootless`;
unrelated labels and unknown shapes do not disable host UID/GID mapping.
Rootful runtimes use the invoking host
UID/GID; a root operator therefore runs UID 0 inside the container. The dropped
capabilities and `no-new-privileges` still apply; UID mapping does not guarantee
an unprivileged user. This first backend is unavailable inside
the existing whole-session sandbox or daemon/embedded-bridge ACP children:
those handoffs do not preserve environment provenance. A forced container
request fails as unavailable; the Docker socket
is never automatically mounted.

Inherited file provenance marks trust without giving the child ownership of the
ancestor's reload scope. Reload only removes keys known from the child's own
files or settings; surviving ancestor values retain their provenance in later
child CLIs. A malformed definition reserves every usable top-level AST name when
refusing an execution declaration. The lenient parser's name is used only when
the AST resolves no usable name; prose cannot add names alongside AST declarations.

## Lifecycle and recovery

The selected environment owns every container name before startup and performs
idempotent cleanup on startup failure, foreground completion, background
completion, cancellation, error and teardown. Await cleanup before host worktree
inspection or removal. Killing only the host runtime client is insufficient.
Tool invocation resources are released on scheduler terminal states, including
host permission denials. If installation execution finishes but cleanup fails,
return its original output with a cleanup warning, retain the worker's ownership,
and fail session cleanup rather than remove its workspace. Foreground and
background agent completion also retain their result and termination status
with a cleanup warning; the root session keeps ownership of failed resources.
A cleanup failure is
not grounds for replaying an already completed command. Automatic history
compression invalidates the worker cache directly across derived Config layers.
An invalidation failure is logged without abandoning the already compressed
history and token bookkeeping; the next tool still requires successful cache
synchronization. Failed path-specific invalidation after microcompaction also
advances the host cache generation, so the next tool must resynchronize before
reading; already compressed history and its result are retained.
Memory-only cache eviction does not invalidate worker reads.
Container cleanup failure reports preserved worktrees only when Agent created
them. Caller-owned `working_dir` worktrees retain caller ownership and are never
reported as leftover worktrees created by Agent.
Permission preparation receives the caller cancellation signal, defaulting to
the invocation-owned signal when omitted. Releasing an invocation cancels
pending preparation and permission; abort listeners are removed first to avoid
reentrant release. Its release RPC has an independent
30-second timeout so an unresponsive worker cannot strand cancellation cleanup.
Container creation may pull a cold
image and has no fixed 30-second limit; it remains cancellable. With
`QWEN_DEBUG_LOG_FILE=1`, the session debug log records the runtime, container name,
image and possible pull before waiting for creation. Nonempty `ServerErrors`
from runtime metadata abort startup before temporary directories or containers
are allocated, even when the command exits successfully. A failed create still
requires cleanup because its runtime-side outcome may be unknown. Runtime metadata
and removal commands retain their 30-second limit. If startup cleanup fails,
its error retains a disposal callback for the root session; the failed factory
promise remains owned until that cleanup succeeds. Completed cleanup attempts
may be retried after failure. A timed-out attempt stays shared until its actual
work settles, so another shutdown cannot start concurrent recovery.
Session shutdown aborts
pending startup and begins container disposal before other exit cleanups. Its
wait is bounded at one second, within the CLI's unchanged two-second per-step
and five-second overall exit limits. A timeout or removal failure remains
visible and preserves resource/workspace ownership; unfinished disposal reports
the container names and temporary directory. Cleanup can continue until the
process exits, but successful removal is not claimed when the deadline expires.

The first version does not resume a disposed container subagent. Both discovery
and direct resume must reject it. Persist a container isolation marker in the
sidecar as a compatibility guard understood by older readers as unsupported;
persist the working-tree choice separately. This wire-format guard does not
change the Agent tool's isolation enum. An unknown new backend field alone is
insufficient because old readers ignore unknown properties.

Container loss becomes a tool error. A lost response after a possible write is
reported as an unknown outcome; the harness never automatically replays it.
Cancellation rejects only its request and sends a scoped cancellation message;
other requests and later tool calls remain usable. An interrupted execution
still warns about possible writes, and no operation is automatically replayed.
A housekeeping timeout can be followed by another cache synchronization attempt.
Malformed protocol responses and broken transports still fail the whole worker;
silently skipping corruption would hide a possibly lost result, so transport
recovery is deferred.

The worker and its tool subprocesses currently share a UID and PID namespace.
The stdin/stdout protocol has no authentication or separate identity protecting
it from those subprocesses. Where the runtime permits access to the worker's
file descriptors, in-container code can inject a valid reply, not just a malformed
line. The host accepts the first matching reply, including preparation parameters,
permission decisions, confirmation details and tool results. A forged edit
confirmation can also affect the child's host-side approval mode if the user
chooses to allow future edits. Request IDs and malformed-response rejection do not establish
reply authenticity. Treat this channel as part of the untrusted container;
Track A does not provide trustworthy tool reporting or permission mediation
against hostile in-container code. Separating the endpoint and payload identities
requires a follow-up design that preserves workspace ownership and rootless
runtime compatibility. No such separation is implemented in this slice.

A host exit before cleanup completes, including `SIGKILL` or an expired shutdown
deadline, can leave containers, temporary output directories and a session-created
empty workspace `.git` mount point. That empty entry can affect project-root
discovery. Failed removal retains these resources for retry while the process is
alive; they are released only after worker removal succeeds. There is no startup
sweeper in this slice, and a later session preserves pre-existing `.git` entries.
Operators must verify ownership and that execution has stopped before manual
removal. A cross-session reaper requires separate ownership/race rules.

## Affected areas

- Core execution contract, local tool session, container transport and worker.
- Agent tool parameters, Config derivation, registry ownership and cleanup.
- Agent metadata and both background resume paths.
- File-read cache invalidation; the existing filesystem service API stays unchanged.
- CLI trusted capability activation and shared review container policy.
- Bundle entry points, focused contract tests and E2E fixtures.

## Validation and acceptance

Run common contract cases through local and container tool sessions: read/write,
read-before-edit, notebook edits, search, errors, streaming, cancellation and
disposal. Run host integration tests proving parent/sibling isolation, no host
filesystem fallback, approval/classifier preservation and incompatible resume
rejection. Assert container argv, environment, mounts and network classification.

Drive the global CLI first to record the unsupported baseline, then the built
CLI with a deterministic model fixture. With a real Docker or Podman runtime,
verify inaccessible host sentinel credentials, worktree persistence, denied
networking, installation, process cleanup and container death. Simulated runtime
tests are protocol evidence, not evidence of kernel isolation. Report unavailable
real-runtime tests explicitly.

[Independent Linux verification](https://github.com/QwenLM/qwen-code/pull/11711#issuecomment-5645312113)
reports ten harness suites and thirteen CLI arms at `ebae028529` with rootful
Docker 26.1.5. It used the published 0.23.0 image because 0.23.3 could not be
pulled, and a local HTTP tarball server because the bridge lacked public egress.
Podman, a live rootless daemon and the configured 0.23.3 image remain unverified
by that report. These are external results, distinct from local process-fixture
checks.

[Independent Linux round 2](https://github.com/QwenLM/qwen-code/pull/11711#issuecomment-5652725410)
reports policy and lifecycle verification at `e544823995`, including fourteen
boundary checks on each of Docker 26.1.5 and rootful/rootless Podman 5.4.2 with
the configured 0.23.3 image. It used a copied independent bundle, a local HTTP
tarball server, and rootless Podman via `runuser` with cgroupfs and tmpfs storage.
Public-registry egress, npm packed installation and subsequent review fixes are
outside that report. Its results are attributed external evidence, not local
runtime verification.

Build, typecheck, bundle, run focused tests, then perform two clean self-audit
passes and the repository code-review workflow before declaring completion.

## Deferred capabilities

Remote execution and environment resources are Track C. Credential proxies are
Track B. Git metadata transfer, nested container agents, container-session resume,
external tools and image/audio/video reading (including native inline media and
provider-backed vision processing) are outside this first backend. The worker
does not receive model modality configuration. Unsupported media reads report
that limitation and must not silently fall back to host execution.
