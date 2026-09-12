# Container execution for subagents (Track A)

[English](2026-09-12-agent-container-execution.md) | [简体中文](2026-09-12-agent-container-execution.zh-CN.md)

Status: implemented; real Docker/Podman isolation validation pending runtime availability. Related: #11695, #11696, #9556.

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
The parent and sibling agents retain their own execution environment. The local
path remains unchanged when the feature is not enabled.

The trusted CLI operator enables the capability with
`QWEN_AGENT_EXECUTION_BACKEND=docker` or `podman`. Repository-sourced environment
values cannot enable or configure the runtime. Only when enabled does the Agent
tool advertise `execution_backend: "container"`. Omission keeps existing local
execution. The existing sandbox image override selects the image; model arguments
cannot select images, mounts, runtime endpoints, or arbitrary container flags.

For a source checkout, run `npm run build` and `npm run bundle`, then launch
`QWEN_AGENT_EXECUTION_BACKEND=docker node dist/cli.js`. Ask the Agent tool to use
`execution_backend: "container"`. Replace `docker` with `podman` when appropriate.
An operator can export `QWEN_CODE_CUSTOM_SANDBOX_IMAGE` for another toolchain.
CLI relaunches reload file-sourced environment values so they retain their
provenance instead of becoming trusted inherited values in the child process.

The option composes with `isolation: "worktree"` and `working_dir`. It does not
extend the model-visible isolation enum or change `isolation: "remote"`.
Combining it with `tools.codeModeOnly` is rejected before container startup;
the first container registry supports direct tool calls only.

## Architecture

The harness, model credentials, authorization, and agent transcript remain on the
host. A container worker runs existing workspace tool implementations. The host
uses a typed execution contract carrying structured preparation information and
`ToolResult`, not a string-only tool protocol.

The contract includes preparation, confirmation, execution, modification, and
disposal. Synchronous host tool construction validates the schema without
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
versioned worker supplied by the image. Source development must build and bundle
before exercising this backend.

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

Mask the working tree's `.git` entry with an empty read-only mount. Linked
worktrees refer to a shared common directory which contains parent and sibling
state and may contain credentials. This first backend edits working files; Git
metadata operations inside the container are unavailable. The host still sees
the actual changes and applies the existing worktree preservation rules. Git
commit transfer or a private Git metadata view requires a separate design.

## Network and credentials

General commands, file operations, builds, tests run without
network access. An explicitly recognized standalone package installation may run
in a separate install container sharing the working files. Command classification
must reject compound shell expressions as installation requests. This exception
allows ordinary networking, not a claimed registry-only restriction.

Both paths use the same explicit environment allowlist and temporary HOME. No
model, GitHub, cloud or MCP credentials are forwarded. Images and the container
runtime are trusted infrastructure. This first backend is not advertised inside
the existing whole-session sandbox: that handoff does not preserve environment
provenance. A forced container request fails as unavailable; the Docker socket
is never automatically mounted.

## Lifecycle and recovery

The selected environment owns every container name before startup and performs
idempotent cleanup on startup failure, foreground completion, background
completion, cancellation, error and teardown. Await cleanup before host worktree
inspection or removal. Killing only the host runtime client is insufficient.
Tool invocation resources are released on scheduler terminal states, including
host permission denials. Automatic history compression invalidates the worker
cache directly across derived Config layers.

The first version does not resume a disposed container subagent. Both discovery
and direct resume must reject it. Persist a container isolation marker in the
sidecar as a compatibility guard understood by older readers as unsupported;
persist the working-tree choice separately. This wire-format guard does not
change the Agent tool's isolation enum. An unknown new backend field alone is
insufficient because old readers ignore unknown properties.

Container loss becomes a tool error. A lost response after a possible write is
reported as an unknown outcome; the harness never automatically replays it.

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

Build, typecheck, bundle, run focused tests, then perform two clean self-audit
passes and the repository code-review workflow before declaring completion.

## Deferred capabilities

Remote execution and environment resources are Track C. Credential proxies are
Track B. Git metadata transfer, nested container agents, container-session resume,
external tools and image/audio/video reading (including native inline media and
provider-backed vision processing) are outside this first backend. The worker
does not receive model modality configuration. Unsupported media reads report
that limitation and must not silently fall back to host execution.
