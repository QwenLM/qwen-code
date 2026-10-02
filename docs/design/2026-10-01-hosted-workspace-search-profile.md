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
Sessions keep their pinned `/1` snapshot. Shell `/2` inherits the Shell wiring
(capture capacity, publisher or deferred-capture options) unchanged.

The `glob` declaration takes a required `pattern` and an optional `path`
relative to the saved Session working directory. The Harness validates `path`
with the existing `normalizeWorkspaceRelativePath` before acquisition, so an
absolute or `..` path is a model-correctable refusal with no Runtime work, the
same treatment `file_path` gets today. An empty `pattern` is refused the same
way.

Glob is read-only, so the hosted approval policy pre-approves it under the
`default` and `auto-edit` modes, alongside `read_file`.

## Worker

The worker admits `GlobTool` and builds it into the managed tool set. Two
invariants hold there, because Glob's own validation admits external paths:

- The search is pinned to the Session's installed context directory. An omitted
  `path` resolves to that directory (never the workspace-wide include list,
  which spans sibling Sessions on the same mount), and any other value must
  resolve inside it; anything else settles as a tool error the model can
  correct.
- Results are rewritten to Workspace-relative paths before they reach the
  wire, the model, or the durable record. The Runtime host's physical layout
  must not leak to the Harness; for a search tool the paths are the payload.

Core ignore filtering is rooted at the Session directory. A Session below
the repository root does not inherit ancestor `.gitignore` rules; dependency
files may consume the scan limit. Its own ignore files still apply. This
slice does not promise repository-root ignore semantics or change core.
An outward symlink listed by a broad glob currently refuses the whole result;
this conservative containment behavior also remains unchanged.

## Bounds

A glob result is a path list. When the serialized outcome would exceed the
64 KiB inline Session limit, the Harness keeps the longest whole-line prefix
that fits and appends a narrowing hint (`Narrow the pattern or path.`), instead
of dropping the whole result into the output-omitted path that `read_file`'s
offset/limit retry hint supplements. If even an empty list cannot fit, the
existing omitted path still applies.

## Implementation boundaries

- CLI Harness: profile acceptance and pinning, declaration, pre-acquisition
  argument validation, bounded truncation.
- CLI worker: admission, containment, Workspace-relative output.
- Core: `GlobTool` is reused unchanged; no core edit.
- Java: unchanged. The production connector still pins
  `hosted-workspace-files/1`; enabling `/2` for public Sessions is a separate
  deployment decision.

## Validation and acceptance

Focused tests cover: declarations per profile version, refusal of a `glob`
call a `/1` Session never advertised, model-correctable argument refusals
before acquisition, path normalization on dispatch, prefix truncation at the
inline limit, and profile pinning across create/load. Worker route tests cover
containment (a sibling Session's files are never searched), relative output,
and the `..` refusal. Approval tests pin glob's pre-approval. Local validation:
`packages/cli` typecheck of the touched files is clean, and the four affected
suites (995 tests) pass.

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

A lighter dispatch path for read-only, idempotent tools is out of scope.
