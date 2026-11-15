# Managed loop CI verification

[简体中文](./2026-11-14-managed-loop-ci.zh-CN.md)

## Scope

Implements the CI row of block M in #17045. Two packaged-process scenarios prove that Managed entry points which reuse other surfaces still execute with the shared loop enabled. The Hosted Harness's own loop evaluation remains separate.

## Paths and evidence

1. A Hosted workflow child Session accepts a pinned `workflow_launch`. Its script calls `agent()`, which runs the real WorkflowRunner, AgentHeadless and AgentCore against a controlled local provider. The final workflow outcome and executed AgentCore loop logs are asserted. Hosted workflow agents deliberately refuse subagent tools because those would access the Harness host rather than the Session workspace; the test checks that no tools are advertised. This path therefore verifies inference and completion, not a Hosted tool batch.
2. An ordinary daemon starts with paired engines and creates a Managed session. The persisted transcript must identify its owner as Managed, so a fallback to Legacy fails. A local provider requests a real file read, receives a unique file sentinel, and the turn completes. Debug messages at ACP's shared round and shared tool batch entry prove that those paths executed.

Both modes explicitly enable the shared loop. `shared` disables the event-bus switch; `kernel` enables it as well. AgentCore's existing debug marker distinguishes these executions. ACP currently uses the shared round and batch in both modes: its event-bus migration is a separate owned row of #17045. Running with both switches on is not evidence that ACP already uses the event-bus kernel. Once that migration lands, its loop evidence must be updated with the implementation.

## CI integration

The independent `managed-agent-loop.yml` workflow runs on relevant pull requests, main pushes, nightly and manual dispatch. Its two matrix jobs run both scenarios, serially, without retries, using the packaged CLI built from that checkout. It does not depend on the Java gate's `none`/`fast`/`full` selection. Only read permission is granted, no service secrets are needed, and PR code uses disposable runners (or the hosted fallback).

Each job requires exactly two passing tests and no skipped tests, plus a passing evidence file for each surface. Protocol requests, process output and executed-loop logs are uploaded even on failure. A missing package, failed setup, Legacy fallback, absent loop witness or skipped test cannot become a successful verification result.

## Boundaries and acceptance

The model is a controlled local OpenAI-compatible server. The Hosted HTTP store fixture uses the real local journal implementation; it does not prove Spring/MySQL behavior. These scenarios prove routing, a tool round and completion. They do not replace cancellation/recovery, writer-lease fault tests, cross-platform acceptance or real-provider testing, and they do not make the Managed Java gate eligible as a required check.

Acceptance requires both mode jobs to execute both paths successfully with their evidence artifacts. The default switches remain owned by block B; no default changes here. Test failures must be classified from their first failing assertion or process log before changing rollout decisions.
