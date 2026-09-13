# Container execution for subagents (Track A)

[English](2026-09-12-agent-container-execution.md) | [简体中文](2026-09-12-agent-container-execution.zh-CN.md)

Status: backend and operator/definition policy implemented. Independent Linux rootful Docker verification covers an earlier revision; Podman/rootless verification remains pending. Related: #11695, #11696, #9556.

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
values cannot enable or configure the runtime. Agent has no `execution_backend`
parameter. Definitions can request `executionBackend: container`; omission
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
Combining it with `tools.codeModeOnly` is rejected before container startup;
the first container registry supports direct tool calls only.

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
a named refusal, not fall through to a lower-priority local agent. Preserve the
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
remain unchanged by this revision.

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

Mask the working tree's `.git` entry with an empty read-only mount. Linked
worktrees refer to a shared common directory which contains parent and sibling
state and may contain credentials. Only the selected workspace root's `.git` is
masked. Nested repositories and
submodules inside the workspace remain readable and writable workspace content,
including any credentials stored there. This is not a repository-secret filter.
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
runtime are trusted infrastructure. Rootful runtimes use the invoking host
UID/GID; a root operator therefore runs UID 0 inside the container. The dropped
capabilities and `no-new-privileges` still apply; UID mapping does not guarantee
an unprivileged user. This first backend is unavailable inside
the existing whole-session sandbox or daemon/embedded-bridge ACP children:
those handoffs do not preserve environment provenance. A forced container
request fails as unavailable; the Docker socket
is never automatically mounted.

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
synchronization. Memory-only cache eviction does not invalidate worker reads.
Permission preparation receives the caller cancellation signal, and releasing
an invocation cancels pending preparation. Container creation may pull a cold
image and has no fixed 30-second limit; it remains cancellable. Runtime metadata
and removal commands retain their 30-second limit.

The first version does not resume a disposed container subagent. Both discovery
and direct resume must reject it. Persist a container isolation marker in the
sidecar as a compatibility guard understood by older readers as unsupported;
persist the working-tree choice separately. This wire-format guard does not
change the Agent tool's isolation enum. An unknown new backend field alone is
insufficient because old readers ignore unknown properties.

Container loss becomes a tool error. A lost response after a possible write is
reported as an unknown outcome; the harness never automatically replays it.
Cancellation and malformed protocol responses fail the whole worker session.
Current product cancellation also stops the owning agent. Silently skipping
protocol corruption would hide a possibly lost result, so recovery is deferred.

A hard host exit such as `SIGKILL` cannot run this cleanup. Exited containers and
temporary output directories may remain; there is no startup sweeper in this
slice. Operators must verify ownership and that execution has stopped before
manual removal. A cross-session reaper requires separate ownership/race rules.

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

Build, typecheck, bundle, run focused tests, then perform two clean self-audit
passes and the repository code-review workflow before declaring completion.

## Deferred capabilities

Remote execution and environment resources are Track C. Credential proxies are
Track B. Git metadata transfer, nested container agents, container-session resume,
external tools and image/audio/video reading (including native inline media and
provider-backed vision processing) are outside this first backend. The worker
does not receive model modality configuration. Unsupported media reads report
that limitation and must not silently fall back to host execution.
