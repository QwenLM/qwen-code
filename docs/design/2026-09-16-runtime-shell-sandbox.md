# Runtime shell sandbox integration

[English](2026-09-16-runtime-shell-sandbox.md) | [简体中文](2026-09-16-runtime-shell-sandbox.zh-CN.md)

## Status and problem

Implementation stage, 2026-09-16. The structured process API and bwrap adapter are implemented and have Linux kernel evidence. Previously, production ShellTool launched through the legacy service without receiving an operator policy. This stage connects the trusted runtime to foreground and background shell execution. It is an internal integration stage of the [unified design](2026-09-16-tool-execution-sandbox.md), not the public sandbox release.

This document records the completed Shell-stage snapshot. The subsequent [runtime file-tool integration](2026-09-16-runtime-file-sandbox.md) expands the restricted registry to Read/Write/Edit and replaces the prototype worker protocol. Registry and artifact statements below describe this historical stage.

## Design

The existing runtime-only `loadCliConfig` host-policy argument accepts `shellExecutionSandbox`, which is copied into Config. There is no settings, environment, or public CLI switch. Config admits and freezes the original canonical workspace policy and protects both the runtime state and global configuration directories. Derived Configs inherit that ceiling; derivation or relocation outside it fails before mutation. The trusted host must construct a newly admitted Config to authorize another workspace.

This internal mode requires a bare, noninteractive runtime and rejects explicit extensions, MCP servers, tool discovery, LSP, legacy whole-CLI sandboxing, and provisional workspaces. Its registry contains only `run_shell_command` and `task_stop`. Bare startup suppresses hooks and ambient extensions/MCP. Unsupported model tool calls cannot reach file tools, subagents, worktrees, or Exec. This is a constrained headless integration; arbitrary embedders, slash commands, TUI, ACP, and other effect entrypoints remain release gates.

A runtime shell helper preserves the legacy path when no policy exists. With a policy, it builds an explicit `/bin/bash -c` launch, the existing sanitized shell environment and current session context, and invokes bwrap. Foreground, background, and promotion retain the existing registry, stream, cancellation, timeout, and host relay PID behavior. A failed admission or launch never falls back to an unconfined command.

Sandbox receipt validation applies to ordinary completion and promoted terminal callbacks. Confirmed nonzero exits remain command failures. Unconfirmed termination produces an error warning that the command may have run and must not be automatically replayed. Interrupted termination cannot become success. Promotion is only a running snapshot; terminal validation and resource ownership continue after it.

The sed preview/write optimization is disabled so the original command executes inside the sandbox. Git notes, PR binding metadata subprocesses, and the system prompt's Git status snapshot are suspended in this internal mode; even `git status` can execute repository-configured clean filters on the host. Git status remains available through the confined Shell tool. Pure textual co-author and PR-body rewriting remains. Permission defaults conservatively ask instead of running host Git configuration probes, and confirmation does not perform those probes. Ordinary approval and YOLO never expand the OS policy. Background launch exceptions close their output stream. Headless turn and exit cleanup skip review worktree leases: those records live inside the writable workspace and cannot authorize host cleanup in this mode.

## Affected layers and boundaries

Core Config owns immutable admission and restricted registration. CLI config transports trusted policy. ShellTool delegates launches and disables uncovered shortcuts. The bwrap adapter transports validated terminal status. Tests cover policy ownership, shell routing, default behavior, and Linux production headless execution.

File-tool migration, complete effect inventory, attribution migration, retiring whole-CLI bwrap, Landlock, and automatic backend selection are later stages. Read confidentiality and inode-level immutability are not claimed. Host model/auth/session persistence remain outside the tool sandbox. No new public enabled mode is delivered here.

## Validation and acceptance

First run a global CLI baseline with an isolated HOME, disposable workspace/state, and a deterministic fake OpenAI server. It should demonstrate the existing unconstrained ShellTool behavior. Then build, typecheck, bundle, and run focused package tests, preserving the legacy shell suite.

On real Linux, a test-only launcher invokes production `loadCliConfig`, auth initialization, and `runNonInteractive`, injecting only the trusted policy. Verify model HTTP and host session persistence, workspace writes, outside-write and closed-network denial, real sed confinement, unsupported file-tool rejection, foreground/background lifecycle, and two independent workspace policies. Explicitly label this production headless pipeline rather than claiming that the ordinary public `node dist/cli.js` accepts the mode. Smoke-test the ordinary bundle separately. Reuse the process adapter's Linux lifecycle evidence and rerun it when changed.

Acceptance requires no unconfined fallback, no false terminal success, no implicit grants during derivation/relocation, and preserved default behavior. Record exact artifact and test evidence under `.qwen/e2e-tests/`. Complete two clean self-audit passes and independent code review. No open design questions remain for this bounded stage.

## Verification results (2026-09-16)

The implementation passed 2,769 focused tests (2,154 core and 615 CLI, with one existing skipped test), the full repository build, typecheck, bundle, targeted lint and formatting. The ordinary bundled CLI still reports `0.23.4`. The isolated global CLI baseline demonstrated the previous outside-write behavior before implementation.

On Lima `qwen-sbx` (Linux `7.0.0-31-generic`, ARM64, Node `v22.22.1`, bwrap `0.11.1`), the tracked `scripts/sandbox-runtime` harness passed 22 checks through the production headless pipeline and real ShellTool lifecycle. The existing adapter harness passed 31 checks; its source input hashes remain unchanged, so that evidence is still current. Evidence includes two Config instances in one process with distinct session IDs and denied cross-root writes, host model requests and session JSONL, kernel write/network denial, restricted startup/tool registration, Git clean filters executing only inside the sandbox, and direct/background/promoted receipt-loss failures. Namespace cleanup checks compare identities rather than numeric PIDs. Review-lease lifecycle unit tests exercise both ordinary turn finalization and the registered exit callback, proving that only the ordinary mode invokes host cleanup; no additional destructive lease scenario was constructed.

The final runtime v4 manifest has 4,787 source and test-script input hashes, all rechecked against the checkout after execution. Its launcher SHA-256 is `3be748159cd10d7b1f1054042061b3e6f6678aab707fabe995cb8e49267dd792`. The detailed baseline, intermediate LSP rejection-contract correction, Git snapshot and review-lease cleanup fixes, final reports and test limitations are in `.qwen/e2e-tests/runtime-shell-sandbox.md`. Linux x64, other kernels, macOS/Windows enforcement and a public CLI enablement path were not validated in this stage.
