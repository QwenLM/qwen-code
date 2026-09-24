# Public bwrap tool execution integration

[English](2026-09-16-bwrap-public-integration.md) | [简体中文](2026-09-16-bwrap-public-integration.zh-CN.md)

## Status and scope

Implementation candidate updated on 2026-09-19. This change is the third stage of the bwrap delivery: it is stacked on the runtime integration stage, exposes the public CLI boundary and retires whole-CLI bwrap. The merged execution foundation remains the transport and lifecycle base. Landlock and the public Linux x64/aarch64 acceptance workflow are separate follow-up changes.

The first public surface supports ordinary headless CLI and both terminal UIs. Supported direct shell entrypoints and built-in tools must share the immutable runtime policy. Unsupported integrations fail explicitly: ACP/serve with delegated filesystem/session execution, web terminals, executable extensions/hooks/discovery/MCP/LSP, automatic worktree management, external agents, and speculative filesystem merge. An unsupported integration is not made safe merely by hiding its model tool declaration. This narrows the initial public frontend contract in the unified design: ACP and serve require their own complete selected-runtime and delegation contract before enablement; they must reject the new policy rather than execute on the host.

## Operator policy and migration

Expose `tools.executionSandbox` only through User, SystemDefaults, System or trusted programmatic runtime construction. Required literal fields are `filesystem: read-only | workspace-write` and `network: open | closed`; optional `backend: auto | bwrap` defaults to auto, whose sole current candidate is bwrap. Workspace settings cannot enable, disable or replace this object, including by replacing its parent object with a scalar. System policy takes precedence as a complete object. Reject unknown fields/values and invalid objects. Do not derive grants from model arguments, project dotenv, ordinary include-directories, or extension settings. Bare/safe modes may suppress ordinary configuration but must not disable an operator sandbox policy.

Policy applies to the admitted canonical workspace, protected installation/global/runtime directories and per-execution scratch. Prepare a fixed real bwrap probe before supported tool execution; probe failure and actual setup failure reject execution without replay or whole-CLI fallback. Keep active Config policy immutable until a new runtime is constructed; settings require restart. Report requested selection, effective bwrap backend, filesystem and command-network policy. No Landlock placeholder or environment toggle is added.

Reject effective legacy `--sandbox bwrap`, `tools.sandbox: bwrap`, `QWEN_SANDBOX=bwrap`, equivalent programmatic selection and inherited `SANDBOX=bwrap` with a migration example before execution. New tool policy cannot combine with legacy container/Seatbelt selection, old network/proxy variables, or an inherited legacy sandbox marker. Delete bwrap's CLI restart implementation, root/state grants and re-entry helpers; keep Docker/Podman/Seatbelt behavior. Preserve `qwen sandbox` argument forwarding and nonzero failure; its native report, probe and command run use the new execution boundary. Inspection must describe host model/auth/session traffic as outside command network restrictions.

## Execution and frontend boundaries

Route Ink/OpenTUI `!`, prompt shell interpolation and Monitor through the runtime shell executor. Do not create a host temporary file merely to detect a shell cwd change; confined commands remain stateless. Ordinary model Shell and Read/Write/Edit retain the verified worker and transport. Nested Code Mode/agents are admitted only if the same policy survives all construction/restoration paths; reject custom executors, hooks, MCP additions and worktree/working-dir escape before their setup. Unported mutation/process tools remain unregistered and direct unsupported adapters also reject.

Non-bare initialization must suppress unsupported host effects before startup: speculative merge, repository hook/worktree cleanup, automatic skill or team-memory Git operations, extension discovery and executable hooks. UI rendering must not execute model-selected Mermaid/image helpers on the host. Custom status-line commands and GitHub lookups either use the runtime shell executor or are disabled in this mode. Pure in-memory rendering and protected authentication/session/history bookkeeping remain trusted runtime functions.

Keep policy per Config, never in a process-global environment marker. Derived runtimes cannot widen roots, approval/YOLO cannot disable confinement, and persisted agent flags cannot replace the policy. ACP/serve startup and delegated session paths must reject this unsupported mode before listeners, child setup or user payloads; existing ordinary ACP/serve behavior is unchanged when the mode is absent.

## Affected code and compatibility

Core changes cover policy admission, Config initialization/registry, Monitor and nested dispatch, and unsupported-effect gates. CLI changes cover settings schema and trusted merge, startup, terminal shell/process rendering, diagnostics, native sandbox command and legacy removal. ACP/serve checks cover the earliest available policy admission without refactoring runtime ownership. Build/package workers remain the already tested implementation. Documentation must give both configuration usage and unsupported capabilities, plus the explicit breaking migration from whole-CLI bwrap.

## Validation and acceptance

Before source changes, run isolated global-qwen baseline scenarios with disposable HOME/QWEN_HOME/runtime, synthetic loopback model credentials, user/system/workspace settings and TUI sessions. Record the previously ignored public setting and legacy selection behavior. Candidate E2E must invoke the real public CLI, not only the internal launcher.

On real Linux verify headless and both TUI shell paths, prompt interpolation, Monitor and supported nested calls; workspace writes succeed, sibling writes/network fail as requested, host model/session persistence succeeds, and read-only remains enforced under YOLO. Test operator precedence, hostile workspace parent values, bare/safe policy retention, unavailable backend, migration with inherited markers, unsupported startup and no payload sentinels. Preserve prior 31 runtime and 34 adapter checks where their assumptions still apply; update historical assertions deliberately. Missing kernel prerequisites fail rather than skip green.

Require build, typecheck, bundle, focused package tests, lint/format, final source/artifact checks and two clean self-audits. Track precise tested and unsupported entrypoints in `.qwen/e2e-tests/bwrap-public-integration.md`. This PR does not add Landlock, the public Linux acceptance workflow or optional adapter expansion.

Operator file parsing is fail-closed, including malformed JSON: do not reset a potentially active confinement policy to empty settings. Explicit user management diagnostics such as `/doctor`, user-selected memory files/directories opened or edited through `/memory`, and settings changes through `/skills` remain trusted host actions. These management entries are not registered as model-invocable commands; selecting a skill only fills the input box. Submitting `/skill-name` explicitly rejects this mode before applying hooks/grants, writing or clearing argument files, or updating project usage records. The model Skill tool also remains unregistered. Automatic memory/skill maintenance stays disabled, including after settings edits in the current runtime. Worktree/Arena management, file restoration and host Git diff previews reject execution; conversation-only rewind remains available. IDE auto-detection, nudges and connections are disabled. The one-command sandbox subcommand forwards literal argv and redirected stdin while preserving stdout and stderr byte-for-byte; interactive PTY commands use terminal `!`.

## Prior evidence and current acceptance

The earlier combined prototype passed 60 real-Linux public CLI groups, 31 runtime groups and 34 adapter groups on Linux aarch64 7.0.0-31-generic with Node 22.22.1, bwrap 0.11.1 and Bun 1.3.13. That evidence established the split and its expected behavior, but it belongs to the earlier combined head and does not replace exact-head validation for this PR.

For this stage, acceptance requires the current stacked head to pass core and CLI build, typecheck, focused tests, lint and formatting on macOS, followed by repository CI. Exact-head Linux x64/aarch64 enforcement remains the fourth-stage public acceptance workflow. Windows has not been exercised. Detailed historical evidence and fixture hashes remain in `.qwen/e2e-tests/bwrap-public-integration.md`.
