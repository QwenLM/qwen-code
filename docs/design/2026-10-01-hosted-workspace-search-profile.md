# Hosted Workspace search profile: glob

[English](2026-10-01-hosted-workspace-search-profile.md) | [简体中文](2026-10-01-hosted-workspace-search-profile.zh-CN.md)

Status: implemented. Resolves #13030.

## Problem and scope

A Hosted Session sees only the tools its pinned profile declares:
`hosted-workspace-files/1` offers Read/Write/Edit and `hosted-workspace-shell/1`
adds foreground Shell. Neither offers a way to find a file the model was not
told about: the file profile has no search at all, and the Shell profile can
only fall back to `rg`/`find` inside a command, each with a full durable
dispatch.

This slice adds the read-only `glob` tool behind new profile versions,
`hosted-workspace-files/2` and `hosted-workspace-shell/2`. The model-facing
profile decides what is offered, while worker admission widens under the
existing `managed-runtime-tools/1` identity. Unlike H1, glob advertisement is
static, not derived from worker discovery; the unchanged digest cannot prove
glob support. Java and Broker remain unchanged, and public profile selection
stays on `/1`. The coordinated rollout requirement below applies even to
private `/2` Sessions.

`grep_search` is excluded: the hosted-runtime boundary document excludes both
Grep implementations until physical process ownership and cancellation
settlement exist. `list_directory` is excluded: it ships disabled in the local
product and `glob` covers the need.

## Harness

The Hosted Harness accepts the two new profile strings at Session create and
load, persisted in the Session definition exactly like `/1`; a load with a
different profile is still a `409 hosted_tool_profile_conflict`, and existing
Sessions keep their pinned `/1` snapshot. Both the initial turn and
continuation construct their tool turn with that saved profile. Shell `/2`
inherits the Shell wiring (capture capacity, publisher or deferred-capture
options) unchanged.

The `glob` declaration takes a required `pattern` and an optional `path`
relative to the saved Session working directory. The Harness validates `path`
with the existing `normalizeWorkspaceRelativePath` before acquisition, so an
absolute or `..` path is a model-correctable refusal with no Runtime work, the
same treatment `file_path` gets today. A blank or null `path` is treated as
omitted. The trimmed `pattern` must be a nonempty string; the shared checker
refuses absolute or `..` brace alternatives after unescaping, and unsafe expansion before
acquisition, and the worker re-checks the dispatched value. Patterns use `/`
as the directory separator; backslashes retain glob escape semantics.

Glob is read-only, so the hosted approval policy pre-approves it under the
`default` and `auto-edit` modes, alongside `read_file`.

## Worker

The worker admits `GlobTool` and builds it into the managed tool set. These
invariants hold there, because Glob's own validation admits external paths:

- The search is pinned to the Session's installed context directory. An omitted
  `path` resolves to that directory (never the workspace-wide include list,
  which spans sibling Sessions on the same mount), and any other value must
  resolve inside it; anything else settles as a tool error the model can
  correct.
- The walk itself is contained: the managed `GlobTool` is built with a
  `containmentRoot` of the Session directory, and glob's traversal hooks
  prune every entry whose lexical path, or whose parent's realpath, leaves
  it. No pattern spelling (`..`, `[.][.]`, `\.\.`, brace alternatives, a
  symlinked directory) can walk, report or count anything outside, so an
  existing and a missing outside path answer identically.
- The pattern is bounded before anything expands it. brace-expansion's
  output cap exceeds the Hosted search budget, and glob expands the same
  pattern again. Both the Harness (pre-acquisition) and the worker refuse
  patterns over 1024 characters, with unbalanced braces, with unsafe numeric
  endpoints, steps or spans, or with more than 64 brace alternatives computed
  from their structure. Only then are they expanded and their alternatives
  unescaped and checked for absolute or `..` segments as a fast path.
- Results are rewritten relative to the Session working directory before
  reaching the wire, the model, or the durable record. The Runtime host's physical layout
  must not leak to the Harness; for a search tool the paths are the payload.

Hosted searches run their traversal and matching in a terminable worker thread
with a five-second deadline per search directory. Cancellation or deadline expiry
terminates that thread before returning the tool outcome, keeping Runtime status
and cancel routes responsive even when glob matching backtracks. A deadline
returns a correctable error asking the model to narrow the pattern or path; the
ordinary CLI keeps its existing in-process search behavior.

Core ignore filtering is rooted at the Session directory. A Session below
the repository root does not inherit ancestor `.gitignore` rules; dependency
files may consume the scan limit. Its own ignore files still apply. This
slice does not promise repository-root ignore semantics. An outward symlink
that a broad glob merely lists (a venv's `bin/python`) stays visible, because
entries are judged by their parent's realpath. Walking through that link is
pruned, including ordinary workspace-dependency links; a broad search retains
its in-Session matches.

The boot-v2 file-tool containment permits shared locations inside the mount
and excludes directories owned by another Session installed in the same
worker. A stale sibling whose location cannot be resolved retains its occupied
path without refusing unrelated shared reads. A resolvable redirect retains
ownership of its target, including a formerly shared directory; access there is
refused until the binding is repaired. Own-directory access remains available.
Ownership is geometric, with one exact exemption: a Session bound at a
non-root ancestor of the caller owns its whole subtree, including what the
caller reaches past its own directory, while a binding exactly at the mount
root (`'.'`, a Workspace selection without `cwd_relative`) delimits no
private area and never vets another Session's targets. Symmetrically, a
caller bound at the mount root holds no private directory: its glob hits,
reads, writes and edits refuse every target a non-root sibling owns,
however the path is spelled, while shared locations owned by no sibling
stay reachable. Whether nested or overlapping installations may exist at
all is install-time policy and out of scope for this slice; the ownership
above governs whatever the registry accepts. Dangling links are checked against
their intended targets before a write. That registry check is worker-local, not a confidentiality guarantee
across separate workers. It preserves `/1` linked-dependency reads; file
history retains its own write boundary. Boot v1 keeps the stricter Session
boundary. Non-ENOENT resolution failures of the requested target must fail without exposing Node's
physical-path diagnostics.

## Bounds

A glob result is a path list. When the serialized outcome would exceed the
64 KiB inline Session limit, the Harness keeps the longest whole-line prefix
that fits both the outcome resource and transcript record and appends a
narrowing hint (`Narrow the pattern or path.`), on both live turns and crash
recovery, instead of dropping the whole result into the output-omitted path
that `read_file`'s offset/limit retry hint supplements. If even an empty list cannot fit, the
existing omitted path still applies.

## Implementation boundaries

- CLI Harness: profile acceptance and pinning, declaration, pre-acquisition
  argument validation, bounded truncation.
- CLI worker: admission, containment, Workspace-relative output.
- Core: `GlobTool` gains opt-in `containmentRoot` and `executionTimeoutMs` constructor options; the
  ordinary CLI does not set it and keeps external globs behind permission.
- Workspace recovery: W1 recovery accepts the `/2` profiles through the same
  shared profile predicates as creation and load.
- Java: unchanged. The production connector still pins
  `hosted-workspace-files/1`; enabling `/2` for public Sessions is a separate
  deployment decision.

## Validation and acceptance

Focused CLI suites are `hosted-glob-pattern`, `hosted-workspace-tool-turn`,
`hosted-harness-session`, `hosted-runtime-recovery`, `managed-context-worker`,
`managed-runtime-tool-executor`, `hosted-tool-approval`, and
`workspace-recovery-session`. They cover profile declarations and pinning at
create/load/continuation, free correctable refusals and normalized dispatch,
expansion budgets, live/recovered prefix truncation at both durable ceilings,
relative output and error handling, worker-local file containment, linked
reads, creation through symlinks, and W1 `/2` recovery. Relativizer units pin
path-token anchoring and the filesystem-root case. Core's `glob` suite covers
contained traversal and unchanged ordinary CLI behavior. Executed platform
and test totals belong in the PR verification report rather than this
changing design inventory.

## Risks and open questions

Worker admission of `glob` is not gated per Session. The unchanged worker
identity does not distinguish old workers from workers with glob support.
A new Harness dispatching glob to an old worker can leave the execution
unknown and retain the Workspace lease, blocking other Sessions.

**Rollout requirement:** before creating any `/2` Session, stop admission,
drain existing Runtime workers, deploy this worker build to every provisioner,
and verify that no old worker can be reused or newly provisioned. Only then
upgrade/enable the Harness `/2` path. Keep `/2` disabled if that cannot be
proven. Rollback likewise requires draining `/2` Sessions before restoring
old workers. This is an operator-enforced requirement, not a negotiated
capability or an automatic safety check. Public connector enablement remains
separate. Mixed-version operation needs a versioned worker identity or
worker-derived capability advertisement before it can be supported.

**Behavior change for existing Sessions:** the realpath containment that
glob made necessary applies to `read_file`, `write_file` and `edit` on every
Hosted profile, `/1` included. On a Workspace-capability worker, shared
locations inside the mount remain reachable when no sibling owns that target.
Directory-external access is refused when its realpath leaves the mount,
lands in another installed Session's directory, or the mount root cannot be
verified. A removed or unresolvable sibling location does not veto unrelated
shared dependencies. A sibling redirected into a shared directory continues to
exclude that destination. A linked dependency inside the mount
(`node_modules/@acme/ui -> ../../packages/ui`) still reads through when it is not
owned by a sibling. A boot-v1
worker has no Workspace mount or Session registry, so its boundary is the
Session directory itself: a path that resolves through a symlink outside it,
a linked dependency included, is refused where it previously read through.

A lighter dispatch path for read-only, idempotent tools is out of scope.
