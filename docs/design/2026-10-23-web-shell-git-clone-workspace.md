# Creating a Web Shell Workspace from a Git URL

[English](2026-10-23-web-shell-git-clone-workspace.md) | [简体中文](2026-10-23-web-shell-git-clone-workspace.zh-CN.md)

Status: proposed

## Problem statement

The Web Shell Add-workspace dialog can only register a directory that already
exists on the daemon host, or create an empty directory through the scratch
path. A user who wants to start work from a repository must first leave the
browser, clone in a terminal on that machine, and then register the resulting
path. On a remote daemon this is the common case, and the detour is the main
usability gap in workspace creation.

The desired behavior is a first-class "Git repository" source: paste a clone
URL, choose where it lands, watch the clone progress, and land in the new
workspace.

## Current state

- `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx` accepts
  an absolute path or an `ssh://` workspace address and submits it through
  `onAdd`.
- `POST /workspaces` in
  `packages/cli/src/serve/routes/workspace-management.ts` registers an existing
  directory, or takes exactly `{ "kind": "scratch" }` to create and register an
  empty directory under the daemon-owned scratch root
  (`~/.qwen/scratch-workspaces/scratch-*`).
- There is no clone path anywhere. The `workspace-git*` routes are read-only
  (status, diff, log, branches, worktrees).
- A new workspace is `untrusted` unless it is a managed scratch or live
  conversation runtime, so trust approval stays in the user's hands.

## Goals

- Create a workspace directly from a Git clone URL inside the Add-workspace
  dialog, with progress and cancellation.
- Keep registration semantics identical to today: capacity, nesting, display
  name, persistence, and the daemon's trust policy are unchanged. The clone
  path neither grants nor bypasses trust.
- Bound the new filesystem write surface: explicit URL validation, an explicit
  target path that must not exist, and cleanup of a failed clone.
- Advertise the capability so older daemons and clients keep working.

## Non-goals

- Cloning through a remote daemon from another daemon's page (the existing
  in-place remote add proxy). Version 1 offers Git only for the connected
  daemon, matching how other unverifiable affordances are withheld for a
  non-connected location.
- Branch, tag, or commit selection, shallow clones, submodule recursion, and
  Git LFS handling.
- Collecting Git credentials in the browser. Private repositories rely on the
  daemon host's SSH agent, or on a token embedded in the pasted URL.
- Resuming clone progress after the page closes. The daemon keeps cloning and
  leaves the directory in place; the user can register it afterwards.

## Proposed solution

### Daemon API

`POST /workspaces` gains a second discriminated variant:

```json
{
  "kind": "git",
  "url": "https://example.com/org/repo.git",
  "target": "/home/me/src/repo"
}
```

The request is bounded and returns immediately:

```json
202 { "kind": "git-workspace-clone", "jobId": "..." }
```

Two job routes are added:

- `GET /workspace-git-clone-jobs/:jobId` returns status, a percentage, a
  bounded message, and on success the canonical `cwd`.
- `DELETE /workspace-git-clone-jobs/:jobId` cancels a running clone.

The job ends in `succeeded`, `failed`, or `cancelled`. A succeeded job has only
written the directory; the client then registers it through the existing
`POST /workspaces { "cwd": ... }` call. This split deliberately reuses the
current registration path instead of duplicating its capacity, nesting,
persistence, and trust logic inside the clone job.

### Target path policy

- `target` is an absolute path; a leading `~` is expanded on the daemon host.
- The parent directory must exist, be a directory, and be writable.
- The target must not exist. The daemon claims it with a non-recursive `mkdir`
  so two concurrent requests cannot both clone into the same path.
- The target must not be inside a registered workspace, contain one, equal a
  reserved workspace root, or conflict with the managed scratch root. These
  checks reuse the predicates already in the management route.
- On failure the daemon removes the directory it claimed. On success the
  directory is left untouched.

### Clone execution

- Run `git clone --progress -- <url> <target>` through an argv array: the URL
  and target never reach a shell. The one exception is the inline
  `credential.helper` injected for a URL with credentials, which git itself
  runs through `/bin/sh`, so it prints with `printf` rather than `echo`.
- Set `GIT_TERMINAL_PROMPT=0` so a missing credential fails instead of hanging.
- Reject URLs that are not `http(s)://`, `ssh://`, `git://`, `git+ssh://`,
  scp-like (`user@host:path`), or `file://`; reject any URL starting with `-`
  (option injection) and the `ext::` remote-helper transport.
- Cap the clone at 15 minutes and allow cancellation. Cancellation kills the
  process tree, not just the direct child.
- Keep at most two clones running and eight finished jobs, drop finished jobs
  after ten minutes, and keep progress reporting bounded (a percentage plus a
  short sanitized message).
- Move URL userinfo out of git's argv: the clone URL passed to git is
  credential-free and a command-line credential helper reads the secret from
  the child environment. The remote URL stored in `.git/config` is therefore
  credential-free, and job state, progress messages, and error envelopes are
  redacted.
- Disable global/system git config for the clone child (`GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL` pointed at the platform null device) and sweep the
  environment channels that outrank those files (`GIT_CONFIG_PARAMETERS`,
  `GIT_CONFIG_COUNT`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH*`,
  `GIT_PROXY_COMMAND`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`), so a repository's
  committed `.gitattributes` cannot select host-configured filter commands
  during the clone's checkout, and a browser-chosen URL cannot borrow host
  credentials or transport settings. The cost is that the host's
  `credential.helper`, `url.*.insteadOf`, and `http.*` configuration does not
  apply to the clone: SSH-agent authentication (through the inherited
  `SSH_AUTH_SOCK`) and credentials embedded in the URL are what work.

### Capability

A new `git_workspace_clone` feature is advertised when dynamic workspace
registration is available and a `git` binary responds on the daemon host.
Clients that do not see the tag keep the current dialog.

### Web Shell

- The dialog gains a source selector with two values: directory and Git
  repository. The Git source is offered only for the connected daemon and only
  when the capability is advertised.
- Git mode collects the URL and the target directory, with Browse for the
  parent location.
- Submitting starts a job and replaces the form with a progress panel: a
  percentage bar, the latest message, and Cancel.
- Polling stops on a terminal state. On success the dialog calls the existing
  add action with the returned `cwd`, then closes.
- If the clone succeeded but registration failed, the dialog keeps the cloned
  path and retries only registration on the next submit, so a transient
  registration error cannot cause a second clone.
- If the job state is unknown (network failure while polling), the dialog
  reports that the outcome is unknown and does not start another clone; the
  user can re-check the workspace list.

## Key design decisions

| Decision                                                         | Rationale                                                                                                                                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asynchronous job instead of one long request                     | The client's mutation budget is 30 seconds and proxies bound request duration; clone time is unbounded and must be observable and cancellable.                                                      |
| Clone the directory, then register through the existing endpoint | Keeps one implementation of capacity, nesting, persistence, and trust. A separate registration path inside the job would drift.                                                                     |
| Clone grants no trust of its own                                 | The job only writes a directory; the normal registration path decides trust. A host with folder trust disabled therefore registers the clone as trusted exactly as it would any existing directory. |
| Explicit target that must not exist                              | Avoids overwriting user files and makes failed-clone cleanup unambiguous.                                                                                                                           |
| Git source limited to the connected daemon                       | The page cannot verify a remote daemon's capability, and the existing dialog already withholds unverifiable affordances for a non-connected location.                                               |
| Retry after a clone reuses the remembered `cwd`                  | Clone is not idempotent; registration is. Separating the two makes retries safe.                                                                                                                    |

## Constraints

- No relative imports across packages; ESM and strict TypeScript.
- New `.ts` files under `packages/core` and `packages/cli` use `kebab-case`.
- The route must follow the existing mutation gate and error envelope.
- Job state is process-local; a daemon restart forgets running jobs, and the
  cloned directory (if complete) remains on disk.
- The daemon shutdown path must kill running clones.

## Risks

- Cloning an untrusted repository does not run host-configured smudge/clean
  filters because the clone child ignores global/system git config. Repository
  content can still define hooks or filters that execute when the user later
  runs commands in the workspace; the clone path does not grant trust, so the
  workspace keeps the daemon's trust policy and tool approvals still apply.
- Very large repositories can fill disk. The 15-minute cap, cancellation, and
  per-daemon concurrency limit bound the impact but do not reserve space.
- A clone that finishes after the page closes leaves an unregistered
  directory; this is visible in the filesystem and can be added later.

## Validation plan

- Unit tests for URL and target validation, progress parsing, credential
  redaction, job limits, cancellation, and failed-clone cleanup, using an
  injected process runner.
- A real-Git test that clones a repository created in a temporary directory.
- Dialog tests for source switching, start/poll/success, failure, cancellation,
  and registration-only retry.
- `npm run build`, `npm run typecheck`, and focused Vitest runs for the changed
  packages.
- A browser E2E pass through the Web Shell Add-workspace dialog against a
  daemon serving the local build.

## Acceptance criteria

- A user can paste a public clone URL, an SSH-agent URL, or an HTTPS URL that
  carries its own token, choose a target, see progress, cancel it, and land in
  the cloned workspace.
- A failed or cancelled clone leaves no target directory behind.
- A cloned workspace is registered exactly like an existing directory; the
  clone path neither grants nor bypasses trust, and it appears in the workspace
  list like any other dynamically registered workspace.
- Daemons without the capability, and older clients, keep working unchanged.
- Job responses never include URL credentials.

## Open questions

- Should the dialog offer a shallow clone switch in a follow-up? It is a small
  addition but out of scope here.
- Should a completed clone be registered by the daemon when the client
  disconnects? A follow-up could persist the job and finish registration
  server-side.
