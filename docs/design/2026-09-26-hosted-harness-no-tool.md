# Hosted Harness no-tool turn

[English](2026-09-26-hosted-harness-no-tool.md) | [简体中文](2026-09-26-hosted-harness-no-tool.zh-CN.md)

## Problem and scope

The Spring control plane can create a Managed Session and call the private Hosted Harness client, while `qwen serve --profile hosted-harness` currently rejects startup. This slice connects one text-only, no-tool turn end to end on top of the durable Managed Session authority in #12693. It does not enable Runtime tools, approval-dependent work, worker lifecycle, or automatic crash recovery.

## Design

- The Java control plane supplies the canonical RFC UUID Session ID and tenant/workspace-scoped private store connection. The Hosted Harness must use that ID for its session, transcript, prompt, and event stream; it must not create a second public identity or fall back to a Legacy session. Service authentication for the store remains a separate deployment gate.
- The profile requires HTTP bridge mode, binds to loopback, requires its bearer token and capability digest, hides browser and ordinary daemon surfaces, and rejects channel, shell, and WebSocket tunnel options before opening a listener. Its private API serves the Java client; possession of the bearer token is required for create/load and turn submission.
- Opening a Session acquires one durable writer and activation through #12693's storage assembly. Accepted prompts retain the caller's prompt identity and payload digest. The model loop records output before the private stream exposes it; Java persists and forwards events using its existing post-commit path.
- No Runtime provider is attached in this slice. A tool call or other unsupported continuation must fail closed before any local tool side effect. A no-tool turn reaches a durable terminal boundary and preserves enough history for a fresh load. The attachment holds its writer and activation until detach or close.
- Initialization tolerates unavailable tool factories because this profile skips their supporting subsystems and removes all local tools before inference. Failed or cancelled turns remain in the durable journal, but their unanswered prompts are omitted from the next model request. Unexpected turn failures log their cause on the daemon while the public error stays generic.
- A retry with the same Session and Prompt identity must not run model inference twice. Conflicting payloads, uncertain ownership, stale generation, store failure, and unsupported tools return explicit errors without Legacy or local-tool fallback.

## Validation and acceptance

Run the repository build and typecheck, focused Managed Session and Hosted Harness tests, and a process-level test with Java, MySQL, and a real `qwen serve` process. The process test must show one canonical Session ID, a successful no-tool text turn, committed event replay after reconnect, and unchanged ordinary daemon behavior. Negative cases cover missing authentication, conflicting prompt identity, store failure, and a requested tool that performs no local side effect. After one or multiple failed or cancelled turns, the next model request must contain the new prompt and retain completed conversation history without resubmitting unanswered prompts, including when successful turns follow the failed turns. This slice does not claim the complete Hosted Runtime or crash-recovery gates in #12380.
