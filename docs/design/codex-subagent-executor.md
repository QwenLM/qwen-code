# Codex subagent executor

[English](codex-subagent-executor.md) | [简体中文](codex-subagent-executor.zh-CN.md)

## Problem and baseline

PR #11003 introduced a shared external subagent executor and a Claude Code ACP
implementation. This change builds on that interface instead of maintaining a
second dispatch and task lifecycle. The baseline is commit
`89da433888c02e2bcc1e5293161c2ba7eea27778`, the squash merge of PR #11003 into main.

## Behavior and scope

Add built-in `claude-code` and `codex` definitions, foreground by default with
explicit background execution available. Claude Code selects the existing ACP
executor and the installed `claude-agent-acp` adapter. Codex selects a new
executor using the installed `codex app-server --stdio`. Neither executable is
downloaded automatically. Both use their own authentication and model settings.

Existing custom definitions keep precedence over these builtin names and can
still be deleted at project or user level without removing the builtin.

Custom definitions use the existing `executor` field. Its `kind` accepts `acp`
or `codex`; `command` remains required and `args` supplies executable arguments.
For Codex, omitted arguments default to `app-server --stdio`. Existing Qwen
model overrides and unsupported host tool restrictions remain rejected.

Codex sends the rendered agent instructions and independent task into a fresh
ephemeral native thread. It returns a final answer through the shared event and
transcript pipeline. It does not project native tool activity or token usage.
It runs one task and cannot accept messages, resume, or continue through a Stop
hook. Claude ACP retains its existing events, approvals, and live continuation.
Both retain the baseline restrictions on workflows, teams and fork history.
Worktree launches keep the shared isolation lifecycle and derived working
directory. No daemon routes or UI components are added.

## Integration and decisions

Extend the existing executor specification and the CLI's injected factory.
Implement Codex in `packages/cli/src/external-agents`, without a separate SDK
package or new dependencies. Reuse the shared process registry for cleanup.

Add optional `continuationBlockedReason` to the executor contract. Codex sets it;
Qwen and ACP omit it. Agent copies it into the existing task resume blocker,
skips message/monitor wiring and resident retention, and surfaces a warning if
a Stop hook requests another execution. The registry refuses queued input for
blocked tasks. Existing metadata records the executor kind and prevents cold
recovery as a Qwen conversation.

The affected layers are the frontmatter schema and builtins, executor contract,
CLI factory and Codex implementation, task admission and continuation guards,
and persisted executor provenance. Discovery, scheduling, notifications,
transcripts and user-facing task controls keep the baseline implementation.

## Permissions and lifecycle

Native builtins require a trusted workspace and are unavailable in safe mode.
Both executors support macOS/Linux (including WSL); native Windows launches fail
before spawning with platform guidance.

Agent resolves Codex permissions before the manager constructs the executor.
Read the live session mode through derived Config layers, including nested,
worktree and resumed agents; intermediate Qwen auto-edit or fork yolo modes do
not grant native access. Only the Codex definition or the session can grant it.
Without an agent override, Codex inherits the session mode without the in-process
auto-edit fallback: default/plan/auto map to read-only. Native execution does not
use Qwen's AUTO classifier. Workspace writes and unattended workspace commands
require an explicit agent or session auto-edit grant; yolo grants native sandbox
bypass. A session already in auto-edit or yolo retains precedence over a stricter
agent definition. Other effective modes fail before startup. Approval requests
and human input are denied; native tool permissions are not Qwen tool-rule
enforcement. Qwen and ACP retain their existing permission resolution.

Validate the initialization response, ephemeral thread acknowledgment, associated
thread/turn IDs and successful terminal result. Missing answers, wrong-turn
results and protocol errors before completion cannot count as success. After a
terminal notification, freeze notifications and answers while still validating
any outstanding turn/start reply; trailing output cannot replace the result.
Initialization has a 10-second deadline; optional `runConfig.max_time_minutes` bounds execution.
Already cancelled calls do not start a product. Cancellation, timeout and failure
release pending requests and await process cleanup before the executor returns.
After root exit, output draining is limited to 10 seconds. A completed answer
survives cancellation during cleanup, with the task still marked cancelled.
Genuine cleanup failures propagate as errors with any validated completed answer
retained in the error text, except the initial process-tree snapshot race: as in ACP, it reports an unproven-tree diagnostic
without replacing the task outcome. Cancellation does not undo workspace edits.

## Validation and acceptance

The test plan is `.qwen/e2e-tests/codex-subagent-executor.md`. Confirm the missing
capability with global Qwen, then verify the rebuilt CLI using isolated model
and native-protocol fixtures. Check both builtin definitions, actual Codex
dispatch, foreground/background results, completion notification, message and
resume rejection, Stop-hook behavior, permission clamping, missing executable,
malformed protocol, cancellation, timeout and process cleanup. Retest Claude ACP
and ordinary Qwen execution. Distinguish fixtures from real native-product runs.

Run build, typecheck, bundle and focused package tests. Review the complete
incremental diff until two consecutive passes find no confirmed issue. Acceptance
requires #11474 to show only changes on top of #11003, and no remaining `backend`
dispatch, Claude SDK package or duplicate task lifecycle from its earlier form.

## Risks and open questions

Installed Codex versions may change the app-server protocol. Native product
settings and filesystem effects remain their own responsibility. The inherited
background registry emits a fallback cancellation notification after five
seconds, which can precede process cleanup and omit late cleanup diagnostics;
this increment does not change that shared timing. Platform cleanup claims must
distinguish executed tests from source review. No open design questions remain;
verification results are recorded separately.
