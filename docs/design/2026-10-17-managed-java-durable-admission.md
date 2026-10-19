# Managed java_durable admission (Stage D7-3)

[English](2026-10-17-managed-java-durable-admission.md) | [简体中文](2026-10-17-managed-java-durable-admission.zh-CN.md)

Status: implemented in this change, in contract `1.61.0`. No schema change.

This is slice **D7-3** of [#14122](https://github.com/QwenLM/qwen-code/issues/14122) (the D7 umbrella of [#12380](https://github.com/QwenLM/qwen-code/issues/12380), Stage D), tracked by [#14167](https://github.com/QwenLM/qwen-code/issues/14167). #12380 lets Stage D expose `java_durable` only with durable command delivery and original-command reconciliation. For Turn input and cancel, both exist on `main`. D7-1 ([turn command operations](2026-10-16-managed-turn-command-operations.md)) saves a `submit_input` or `cancel` operation with every admission. D7-2 ([operation reconciliation](2026-10-17-managed-operation-reconciliation.md)) reconciles an input whose acceptance is unknown from the Session journal.

## Problem

`java_durable` was only an outcome: a stage recorded when no Harness confirmed an operation. No caller could ask for it, and no switch existed for it to be off or on. A Turn admission answered `202` with a Turn id, and the operation D7-1 saved stayed invisible, so a client that lost the response had nothing to resolve it through. The contract reserved `operation_id`, `admission_stage` and `delivery_state` on `CommandAdmission` and `WebShellAdmission`, and `durable_operations` on the Session capabilities, all `planned`.

## Goals

From #12867's D7 row and #14167:

- The capability stays off unless enabled. With the switch off, behaviour is byte-identical, and that is a property of the configuration class.
- With the switch on, `harness_confirmed` remains the product default. Enabling the profile does not move any existing entry onto it.
- A requested `java_durable` admission returns the operation, its admission stage and its delivery state. A lost response resolves through the original operation without duplicate side effects.

## Non-goals

- New delivery or reconciliation. The profile only exposes what D7-1 saves and D7-2 reconciles.
- The ten internal `admission_stage` write sites #14167's triage listed. They keep their rules: the profile governs what Turn input and cancel admission expose, not how any operation records its stage.
- `PublicTurn` / `WebShellTurn` operation fields. A Turn read would need a per-row operation join; they stay `planned`.
- Renaming `harness_confirmed`. The pinned reference design spells it `qwen_confirmed`; the contract records the pairing and uses the in-repo name.
- Session creation. Its `WebShellAdmission` never carries the fields.

## Decisions

### 1. A switch whose off state has nothing to run

`qwen.managed-agent.java-durable-admission.enabled` (default `false`) gates `JavaDurableAdmissionConfiguration`, a `@ConditionalOnProperty` configuration that is the only place `JavaDurableAdmission` is created. That class is not a component. #14029 used the same pattern for the event transport. `ManagedAgentService` receives the bean through an optional setter, so off means null: admissions answer the legacy body, no Session carries `durable_operations`, and request digests, SQL and dispatch are unchanged.

### 2. The caller asks, per command

A Turn input or cancel asks with a body field: `admission_profile` on the public event route, `admissionProfile` on WebShell `turns/submit` and `turns/cancel`. Its values are `harness_confirmed` (the default, also when absent) and `java_durable`.

- **Body, not header.** In signed mode, the HMAC covers the body but not new headers, and WebShell routes carry every input in the body.
- **Left out of the request digest.** The operation exists for every admission since D7-1, and the profile only selects the response view. A retry may switch views and still replays, and digests recorded earlier stay valid.
- **Refused where the profile is off.** Asking for `java_durable` without the profile answers `400 unsupported_feature`. The check is the first statement of `submitTurn`/`cancelTurn`, before any read, replay or write. Silently answering with `harness_confirmed` semantics would mislead a caller that believes `202` means saved and responsible for delivery. Every request valid under `1.60.0` is unaffected, because the four request schemas reject unknown properties.

### 3. What the response carries

`CommandAdmission` (`operation_id`, `admission_stage`, `delivery_state`) and `WebShellAdmission` (`operationId`, `admissionStage`, `deliveryState`) carry the three fields together, and only for a `java_durable` request. `JavaDurableAdmission.operation` reads the operation through `AgentStateStore.findOperation` and lowercases its stage and state.

- **Fresh admission.** The body is built before the dispatcher runs, so it reports the operation as its admission saved it: an input reads `java_durable` and `pending`; a cancel of a live Turn reads the same; a cancel of an ended Turn, settled inside its admission transaction, reads its settled values.
- **Replay.** The same key and digest return the original `operation_id` (from the receipt's `result_operation_key`) with `replayed: true` and the operation's current stage and state. A key recorded before D7-1 has no operation and keeps the legacy body.
- **Lost response.** The client either retries the key, which returns the id, or reads the operation by id through `GET …/operations/{operationId}` or WebShell `operations/query`.

### 4. Discovery

`SessionCapabilities.durable_operations` and `WebShellSessionCapabilities.durableOperations` are present only where the profile is on, and there they follow Session readability, as the other flags do. Off, they are omitted, which the contract's `default: false` reads as off.

## Validation

- `JavaDurableAdmissionConfigurationTest`: flag absent or `false` creates no `JavaDurableAdmission` and no configuration bean; `true` creates the profile.
- `ManagedAgentApiContractTest.javaDurableAdmissionIsRefusedWhileTheProfileIsOff` (profile off, the default context): `java_durable` answers `400 unsupported_feature` on the public event route and both WebShell Turn routes, with no Turn and no Turn command operation admitted; explicit `harness_confirmed` answers the legacy body; capabilities carry no `durable_operations`.
- `JavaDurableAdmissionContractTest` runs the whole contract suite again with the profile on, on its own database. Every default admission answers as with it off; `bothSurfacesReportTheSameSession` gains exactly `durable_operations` / `durableOperations`. Its own case, `javaDurableAdmissionNamesTheOperationItsAdmissionSaved`, checks the following:
  - A held input names `op_…`, `java_durable`, `pending`.
  - A retry under the key names the same operation with `replayed: true`, and without the profile it keeps the legacy body.
  - The cancel names its own operation.
  - Both ids resolve through the operation query to `submit_input` and `cancel`, completed.
  - A plain input keeps the legacy body.
  - WebShell returns the camelCase fields.
- All bodies are validated against the contract.

## Acceptance (from #14167)

- With the switch off, behaviour is byte-identical, as an inspectable property of the configuration class (decision 1, `JavaDurableAdmissionConfigurationTest`, and the full suite with the profile on).
- With the switch on, `harness_confirmed` remains the default (decision 2; the plain inputs in the switch-on suite).
- A requested `java_durable` admission returns the operation, admission stage and delivery state, and a lost response resolves through the original operation (decision 3).
