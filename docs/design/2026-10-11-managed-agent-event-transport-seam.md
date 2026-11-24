# EventTransport MQ1: after-commit seam composition

[English](2026-10-11-managed-agent-event-transport-seam.md) | [简体中文](2026-10-11-managed-agent-event-transport-seam.zh-CN.md)

> **Status:** Proposed slice. This is phase **MQ1** of the cross-node
> EventTransport design
> ([2026-10-04-managed-agent-event-transport](2026-10-04-managed-agent-event-transport.md),
> §7), tracked under [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
> MQ1 introduces the named seam only: no broker dependency, no configuration,
> no behavior change. The envelope contract landed in
> [#13498](https://github.com/QwenLM/qwen-code/pull/13498); the P2 candidate
> selection (RocketMQ LiteTopic 5.5.0+) is pinned by
> [#13200](https://github.com/QwenLM/qwen-code/issues/13200).

## Problem

MQ2 will plug a broker-backed producer into the after-commit publication
point. Without a named composition point landed first, MQ2 would have to edit
the commit path and the wiring in the same diff that adds the broker client,
making its "flag-off deployment is byte-identical" exit check unprovable. MQ1
lands that composition point by itself, with the default composition equal to
today's in-process fan-out, so MQ2's diff is purely additive behind a
default-off flag.

MQ1's stated prerequisites are met: [#13300](https://github.com/QwenLM/qwen-code/issues/13300)
(H0c review follow-ups) closed and [#13265](https://github.com/QwenLM/qwen-code/issues/13265)
(H3) merged. One qualification on "the envelope keys are final": the frozen
v1 envelope names `authoritative_journal` as its only stream, while this seam
carries the public `managed_agent_event` stream — admitting a `public_event`
stream value is a tracked contract extension MQ2 needs, not a re-opening of
the frozen keys.

## Current state

Read on `e6ed740eb1` (2026-10-11).

- The after-commit seam already exists: `CommittedEventPublisher`
  (one method, `publish(List<EventRecord>)`) is injected into
  `ManagedAgentStore` and invoked from a Spring
  `TransactionSynchronization.afterCommit()` hook
  (`ManagedAgentStore.publishAfterCommit`). Its only implementation is
  `SessionEventHub`, an in-process per-Session bounded buffer feeding the
  Java SSE path. No `EventTransport` type exists in code.
- `SessionEventHub` is also injected by concrete class into
  `ManagedEventStreamService`; that coupling is unaffected by this slice.
- Production constructs no stores; of the 53 test call sites constructing
  `ManagedAgentStore`, all but one pass a `CommittedEventPublisher` lambda;
  the remaining fixture (`Issue13181QueryBudgetTest`) passes a real
  `SessionEventHub` as the publisher.

## Design

1. **`EventTransport` interface** (`store/` package, next to
   `CommittedEventPublisher`, per the house convention of ports in `store/`):
   one method, `void publish(List<EventRecord> events)`. This is the named
   adapter point the parent design calls for; MQ2's broker-backed producer
   implements it. MQ1 ships no implementation.
2. **`CompositeCommittedEventPublisher`** (`service/` package): a `@Component`
   and the **sole** `CommittedEventPublisher` bean. Constructor-injected with
   `SessionEventHub` and `List<EventTransport>` (empty by default).
   `publish` guards the empty list, calls the hub first with semantics
   identical to today (exceptions propagate exactly as they do now), then
   invokes each transport in injection order, isolating a transport's
   `RuntimeException` (log and continue) so a failing adapter can never block
   or break the local post-commit SSE fan-out — the parent design's §9
   constraint that MQ failure surfaces only as wake/materialization delay.
3. **`SessionEventHub` stops implementing `CommittedEventPublisher`.** It
   keeps its public `publish` method and stays a `@Component`; the one test
   fixture that passed it as the publisher now passes a `hub::publish`
   lambda. Every other test construction (lambdas) is untouched.
4. **No configuration, no flag, no new dependency.** The
   `qwen.managed-agent.event-transport.*` properties arrive with MQ2's
   adapter, per the parent design.

### Why single-bean composition instead of `@Primary`

Keeping `SessionEventHub implements CommittedEventPublisher` and marking the
composite `@Primary` would leave two `CommittedEventPublisher` beans in the
context permanently; any future collection injection of the interface would
fan out twice. One bean per role is the honest composition, and the total
edit cost is one `implements` clause plus one test-fixture lambda.

### Why the hub call stays outside the isolation

The try/catch wraps only the new, empty-by-default transport side. The hub
call keeps today's exact failure semantics, which is what makes "deployment
with the seam behaves identically" an inspectable property of the diff rather
than a claim.

## Scope boundaries

- No broker client, producer, consumer, or configuration wiring (MQ2).
- No second wire for authoritative journal facts
  (`ManagedSessionStore.commit`); the parent design assigns that to MQ2 and
  forbids relabeling this seam as covering it.
- No Java mirror of the envelope contract. The parent design's phase table
  originally assigned the Java fixture consumer to the contract slice landing
  in MQ1 (§7); the merged contract slice
  [#13498](https://github.com/QwenLM/qwen-code/pull/13498) deferred it to the
  transport slice (delivery ledger, #13498 row), and this slice keeps that
  exclusion.
- No change to `ManagedAgentStore`, the commit path, SSE endpoints, or the
  TypeScript side.

## Validation

- New `CompositeCommittedEventPublisherTest`: default composition delivers to
  the hub exactly; the whole batch reaches each transport unchanged; hub is
  called before transports; a throwing transport neither propagates nor
  prevents hub and later-transport delivery; a hub failure propagates and
  skips transports; a transport's `Error` is not isolated; an empty list is a
  no-op; transports run in injection order; the drop log carries
  tenant/session/sequence identity; and a Spring context collects
  `EventTransport` beans into the composite as the single
  `CommittedEventPublisher` bean.
- Existing suites unchanged and green: `SessionEventHubTest`,
  `SessionEventHubPinningTest`, `ManagedEventStreamServiceTest`,
  `ManagedEventReplayTest`, `ReplayFloorRetractionTest`, and
  `ManagedAgentServerIntegrationTest` — the last asserts commit-to-hub
  delivery through the real Spring context, which proves the composite is
  wired as the store's publisher.
- `mvn verify` gates (checkstyle, spotbugs) pass for the module.
