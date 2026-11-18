# Configurable Conversations working-directory root

[English](conversations-working-directory-root.md) | [简体中文](conversations-working-directory-root.zh-CN.md)

## Status and problem

Local implementation design for [#15298](https://github.com/QwenLM/qwen-code/issues/15298),
based on main `9dde2f657d3dfc9183bbe5534efcbaa39564758d`. The issue is accepted
for exploration by automated triage; maintainer approval of the interface is
still pending.

Containers need an explicit persistent working-files location independent of
the operating-system home. The existing root is
`<home>/Documents/Qwen Code/Conversations`. Mounting that exact location or
changing process home are valid alternatives. `QWEN_HOME`, `QWEN_RUNTIME_DIR`
and `advanced.runtimeOutputDir` do not select this working root.

## Configuration and lifetime

Provide `QWEN_CONVERSATIONS_DIR` and an additive `--conversations-dir` option
on `qwen serve` and `qwen daemon start`. `ServeOptions.conversationsDir`
provides the same launcher configuration to embedded callers. Selection is:

1. Explicit CLI/API option.
2. `QWEN_CONVERSATIONS_DIR` from the launch environment or user-level `.env`.
3. The existing home-derived default.

Use the existing hardcoded project-environment exclusions to reject this key
from project `.env`, from `settings.env` at every scope, and from environment
reload. Do not add a project setting or a browser/session request field. Resolve
the chosen path once at daemon boot and pass it into the existing
`ConversationWorkspace`. No later environment reload may redirect that object.

An explicit value must be a nonempty absolute, fully qualified filesystem path
without NUL. Relative paths, unexpanded `~`, and Windows drive-relative/rooted
paths that depend on the current drive are rejected with a clear configuration
error. Do not trim or silently fall back on invalid values. The higher-priority
source wins; a valid CLI option can override an invalid environment value.

Validate path syntax before listening. Directory creation and filesystem
identity acceptance remain lazy for both explicit and default roots. An
unused daemon must not create the default Conversations tree. Existing
filesystem failures remain errors on first use, without switching roots.

## Runtime and storage contract

Standalone and Live continue using one daemon-owned Conversations runtime and
its shared ACP child. Only root selection changes. Each session keeps its
deterministic `conversation-<sha256(normalized session ID)>` direct child as
the tool/shell cwd. ACP relocation already consumes the daemon's chosen root
and pinned identity; no new ACP parameter or core storage policy is required.

Keep root/child ownership, POSIX private permissions, canonical identity,
available device/inode checks, direct-child and link/reparse checks, writer
leases, and deletion recovery unchanged. Retain documented Windows and
inode-verifiability limits. The configured tree is reserved from ordinary
workspace registration using the existing checks; this adds no general
workspace-root restriction and no OS containment claim.

| Data                       | Location and responsibility                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Session working files      | Private children of the selected Conversations root                                                 |
| Shared root configuration  | User-authored configuration under the selected root; it is not private to a session                 |
| Transcripts and sidecars   | Existing runtime-base storage keyed by the canonical Conversations runtime cwd                      |
| Deletion recovery journals | Existing stable `<home>/.qwen/conversations/deletions` namespace                                    |
| Live discovery             | Existing stable `<home>/.qwen/live/daemon.json`, plus the daemon-runtime-base copy where applicable |

This option does not move the last three categories or remove the deployment's
need to preserve the relevant home-based recovery state.

## Launch and restart behavior

Keep ordinary serve parsing and the serve fast path consistent. Forward the
option through `daemon start`'s explicit serve argument list. Environment-only
launches keep ordinary process inheritance. Desktop launchers can supply the
environment variable; a new desktop setting is out of scope.

Add an optional, validated `conversationsDir` to the local daemon discovery
record and publish the resolved configured path, including the default.
`daemon restart` replays this path through `daemon start --conversations-dir`
so a changed shell environment cannot silently select a different root.
Older records lack this field and retain the previous environment/default
resolution behavior. Automatic update relaunch must likewise preserve the
selected root. These records store the configured path, not persistent inode
attestation; normal filesystem acceptance runs again after restart.

Intentional reconfiguration uses stop followed by start with the new value;
`daemon restart` preserves the recorded selection. Keep the same runtime base
and required control state when resuming the same root. Before changing roots,
finish pending deletion recovery against the original root and stop all writers
using it. Do not remove recovery evidence to force acceptance. If original-root
recovery cannot complete, changing the option is not a repair mechanism.

A new canonical root changes history storage/discovery and shared root config.
No files, session records, configuration or discovery state are automatically
migrated, and complete old-history visibility is not promised. Existing pending
journals continue failing closed on identity mismatches.

## Affected layers and validation

- Conversations root resolution/workspace construction and daemon boot wiring.
- Serve types, ordinary/fast CLI parsing, daemon start/restart and local discovery.
- Shared environment exclusions and both loader regression suites.
- User configuration/serve documentation and focused collocated tests.

The E2E plan lives in `.qwen/e2e-tests/conversations-working-directory-root.md`.
Use isolated home, configuration, runtime and work directories. Verify default
laziness; env and CLI precedence; invalid input; project injection rejection;
standalone shell cwd and files; same-root restart/history; ordinary-workspace
isolation; and unchanged link/permission/identity safeguards. Existing shared
runtime tests cover Live/standalone consistency. No real model call is required
for prompt-less session creation and session-shell tests.

Run the repository build, typecheck and bundle, focused unit and E2E tests,
format/reference checks, two clean self-audit passes and independent review.
Record platform or runtime coverage limitations rather than claiming unrun
checks. The current environment has no global `qwen`; baseline testing must
record that limitation and use an unmodified checkout executable instead.

## Scope and remaining review decisions

No migration, configurable lock placement, directory browser/creation APIs,
per-session selection, new workspace policy, or UI is included. Public naming
and the supported interface remain subject to maintainer review. This design
chooses syntax validation at boot, lazy filesystem acceptance and restart
preservation as concrete behavior to review.
