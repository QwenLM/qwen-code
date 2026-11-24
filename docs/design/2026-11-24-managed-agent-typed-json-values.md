# Managed Agent Typed JSON Values

[English](2026-11-24-managed-agent-typed-json-values.md) | [简体中文](2026-11-24-managed-agent-typed-json-values.zh-CN.md)

Status: implemented locally; CI acceptance pending

Investigation baseline: `e6e2857b65`

## Problem and current state

The Managed Agent production sources contain 1,448 lines matching
`Map<String, Object>`. These maps serve different purposes: closed protocol
documents, encrypted database JSON, heterogeneous execution results, open user
JSON, and generic JDBC rows. Replacing all of them would destroy useful dynamic
boundaries and create large nullable DTOs.

Four closed structures have enough stable fields and bounded consumers to
justify typed Java values now:

1. `SessionModelConfig` already validates a closed model configuration but stores
   it as a map and reads fields by string.
2. Runtime reconciliation accepts a closed `state` plus optional dynamic `result`
   document after transport-specific projection.
3. `ManagedContextProtocol` constructs and validates closed Boot and Ready
   documents, while Java consumers continue to pass them as untyped maps.
4. AgentDefinition compilation validates execution fields but discards most of
   them, causing later policy and Harness consumers to parse the pinned JSON
   again.

The goal is readability and compile-time field access, not a change to product
behavior or a repository-wide elimination of maps.

## Goals and scope boundaries

The change will:

- introduce named values for the four structures above;
- keep dynamic payloads dynamic instead of inventing universal result or
  extension schemas;
- preserve HTTP JSON, encrypted database plaintext, canonical digests, Runtime
  error mapping, and Java/TypeScript protocol behavior;
- migrate every in-repository caller affected by a Java signature change,
  including the two archived CSI source call sites.

The change will not:

- convert open metadata, tool input/results, event data, recursive user JSON, or
  generic JDBC rows;
- change TypeScript implementations, OpenAPI, shared JSON Schema, fixtures, SQL,
  transaction boundaries, or stored schema versions;
- introduce Jackson default typing, fastjson2 AutoType, reflection-selected class
  names, or polymorphic deserialization from input;
- add compatibility overloads without an in-repository consumer;
- align the existing Java/TypeScript difference for a developer
  `managedExtensions.cgroupRoot`; that is a separate behavioral decision.

## Design

### 1. Session model configuration

`SessionModelConfig` remains the public validating domain class. Its long-lived
state changes from a map to private `Value` and `Generation` records. The records
contain only the admitted fields:

- value: `protocol`, `model`, `baseUrl`, `apiKey`, and optional `generation`;
- generation: `temperature`, `topP`, `topK`, `maxTokens`, `presencePenalty`,
  `frequencyPenalty`, and `seed`.

Parsing remains explicit `JsonNode` validation. Unknown fields, nulls, URI rules,
text limits, sampling ranges, and numeric normalization stay in their current
order. Integer sampling fields remain `Integer`; other sampling fields remain
`Double`. Boxed generation components represent absent fields, while a non-null
`Generation` with all-null components represents an explicitly empty object.

`wireValue()` becomes the only serialization projection. It reconstructs the
existing snake_case map, omits absent values, preserves an empty generation
object, and returns immutable outer and nested maps. `baseUrl()` reads the typed
value. `digest()` and the byte-size check continue to operate on that exact wire
projection, not on Jackson's default record serialization. The existing redacted
`toString()` remains authoritative.

Controllers, session creation commands, encrypted persistence, SDK, CLI, and
WebShell consumers retain their current contracts.

### 2. Runtime execution status

Add `RuntimeExecutionStatus` to `contracts` as a small immutable value with:

- a five-value state enum using the existing wire names `prepared`, `executing`,
  `cancel_requested`, `settled`, and `unknown`;
- a nullable dynamic `Map<String, Object>` result, present only for `settled`.

A single explicit conversion from the projected map validates the closed key
set, state name, and `result` presence rules. It rejects present-null and
non-object results and takes a recursive immutable JSON snapshot through
`BrokerValues`. The typed value does not validate the tool-specific terminal
`executionStatus`; `ToolExecutionRecord` retains that later domain check.

`RuntimeExecutionReconciler.absorbRuntimeStatus` consumes the typed value. Raw
maps remain at `RuntimeTransport`, HTTP v2/v3/v4 projection, cancellation,
background polling, measurement completion, and Workspace forwarding boundaries.
The three reconciliation inputs—durable publication evidence, durable v3
shortcut, and live transport lookup—share the same conversion and preserve the
existing `runtime_execution_status_invalid` mapping and takeover downgrade.

`RuntimeBrokerSupport.projectV3Status` remains deliberately lenient for a
non-settled scalar or null `result`, which it currently discards. The stricter
canonical status validation must not move ahead of that projection. No public
HTTP, cooldown, cancellation, or transport signature changes.

### 3. Managed Context Boot and Ready

`ManagedContextProtocol` gains nested `Boot` and `Ready` records.

`Boot` stores the thirteen variable core fields, including a `long epoch`, string
`workspaceGeneration`, and optional dynamic `managedExtensions`. Fixed
`type=boot`, `version=2`, and `managedContext=managed-context/1` values are added
only by `toWire()`. `Boot.toString()` redacts the token. `toWire()` reconstructs
the existing closed map and is mandatory at JSON, digest, and outer-envelope
boundaries; the record itself is never serialized directly.

`boot(...)` returns `Boot`. `parseBoot(Map<String, Object>)` takes an immutable
JSON snapshot before applying the existing validation, preventing later caller
mutation from invalidating an admitted value. The existing Map-based
`validateBoot` remains for adversarial fixtures and raw protocol consumers.

`ready(...)` accepts a typed Boot and returns a typed Ready containing the three
matched identity fields, epoch, and validated loopback URI. Ready has no
speculative wire serializer because Java only validates this worker-produced
document. External publication fields remain outside this closed core type.

`attestationRequest` and `attestationResponse` retain Map signatures and their
existing remove-and-add algorithms. `parse`, `verify`, `installation`, `receipt`,
legacy v1/v2 paths, External storage envelopes, and all TypeScript code remain
unchanged. Live Java callers and the two archived CSI envelope builders add an
explicit `toWire()` where a map is still required.

### 4. AgentDefinition execution fields

`AgentDefinitionCompiler.Compiled` now exposes `modelId`, `instructions`, the
effective `approvalMode` and `toolProfile`, normalized `skills`, `mcpServers`,
`hookCatalog`, and `hookCatalogPresent`. Admission keeps its existing model,
instructions, policy, tools, extension, and environment validation order. Open
`metadata` is deliberately absent from this value and cannot affect execution.

`fromPinnedContent` projects an already pinned Session without reapplying the
current deployment model or tool allowlists. It takes approval and tool profile
from the Session, keeps absent and present-null Hook entries distinct, and reuses
the existing normalized extension values rather than introducing another leaf
Map-to-record conversion layer. Creation and stored JSON remain forward-compatible;
this is not a closed request DTO change.

`AgentSessionPolicies` consumes the compiled skills, MCP, and Hook presence
directly instead of parsing the definition again. `QwenHostedHarnessConnector`
projects pinned content once per create/load and shares it across definition,
MCP, and Hook construction. Create still publishes model, instructions, and
skills, while load sends only definition identity plus the existing MCP/Hook
values. Full raw content remains available to resource accounting and other
non-execution consumers.

## Compatibility and security invariants

| Area               | Required invariant                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| JSON names         | Existing snake_case/camelCase wire names and fixed protocol markers are unchanged.                       |
| Absence and null   | Omitted optional fields stay omitted; explicit empty objects stay empty; rejected nulls remain rejected. |
| Numbers            | Existing integer, floating-point, safe-integer, and normalization behavior is unchanged.                 |
| Digests            | Model configuration and External identity hashes consume the same canonical map content as before.       |
| Collections        | Typed values cannot be mutated through retained source maps or nested lists.                             |
| Errors             | Runtime reconciliation and cancellation retain their distinct status codes and failure timing.           |
| Secrets            | Model API keys and Boot tokens never appear in value `toString()` output.                                |
| Deserialization    | Only explicit target types and manual validators are used; no AutoType or default typing is introduced.  |
| Wire compatibility | Java records are implementation details, not new wire schemas or polymorphic envelopes.                  |

## Files affected

Production changes are limited to:

- `contracts`: `SessionModelConfig`, new `RuntimeExecutionStatus`,
  `ManagedContextProtocol`, and `AgentDefinitionCompiler`;
- `runtime-broker`: `RuntimeExecutionReconciler`, the durable shortcut in
  `RuntimeBrokerService`, and the shared state-name check in
  `RuntimeBrokerSupport`;
- `runtime-http`, `runtime-local`, `runtime-ssh`, `runtime-external`, and
  `persistence`: Managed Context caller migration plus compiled-definition
  consumption in `AgentSessionPolicies`;
- `adapters`: shared compiled-definition consumption in
  `QwenHostedHarnessConnector`;
- `sdk-java/managed-kubernetes-archive`: two mechanical Boot `toWire()` call-site
  updates, without reactivating or redesigning the archive.

Tests remain in `verification`, except that unchanged TypeScript conformance
tests are run as consumer evidence. Existing test classes are extended where
possible; focused value tests are added only for the new Runtime status and new
Boot/Ready behavior not already covered.

## Validation plan

### Session configuration

- Pin historical wire JSON and digest vectors before changing the implementation.
- Cover absent generation, explicit empty generation, rejected nulls, unknown
  fields, numeric lexical normalization, immutable maps, and redaction.
- Exercise encrypted save/read, inheritance, private HTTP reads, and unchanged
  response field names.

### Runtime status

- Cover all five states, malformed key sets, absent/present-null results, dynamic
  nested JSON, defensive copies, and invalid JSON values.
- Retain reconciliation, takeover, durable v3, malformed lookup, cancellation,
  polling, measurement, and cooldown regressions.
- Add direct v3 projection cases proving its current non-settled scalar/null
  discard behavior has not moved or tightened.

### Managed Context

- Run every shared Boot/Ready fixture and compare typed round trips as JSON trees.
- Cover both managed extension profiles, immutable snapshots, token redaction,
  attestation derivation, epoch bounds, and the existing developer cgroupRoot
  behavior.
- Run affected HTTP, Local, SSH, External ownership, extension, recovery, and
  capacity tests, plus unchanged TypeScript worker/conformance tests.
- Keep archived CSI verification explicitly separate because the ordinary Maven
  reactor does not build it.

### AgentDefinition

- Assert every compiled field, normalized extension value, empty collections, and
  absent versus present-null Hook presence.
- Prove pinned projection does not reapply current allowlists and metadata still
  has no execution effect.
- In one create+load scenario, assert identical model, instructionsRef, skillsRef,
  MCP, Hook, and load-only identity, and verify one pinned-content read per
  operation.
- Run admission, approval-change, resource-accounting, and Hosted definition
  consumer regressions.

## Acceptance criteria

1. The four closed structures expose named Java fields at their domain
   consumers; dynamic result and extension payloads remain explicit.
2. No wire JSON, OpenAPI, TypeScript, SQL, or stored-format change is required.
3. Historical model configuration JSON and digests still decrypt, parse, and
   compare exactly as before.
4. Runtime reconciliation preserves error codes, UNKNOWN/takeover behavior, and
   dynamic result bytes.
5. Managed Context fixtures, identity hashes, extension variants, and live Java
   callers retain their existing behavior.
6. Focused Java tests and both Checkstyle executions pass locally within the
   module's shared ten-minute budget, or any unrun evidence is reported as
   pending rather than implied. CI retains the complete Java, Hosted, fault,
   MySQL, and other required profiles.
7. The complete diff receives the repository self-audit and code review; fixes
   invalidate and rerun the affected checks.

## Implementation evidence and remaining acceptance

The four slices are implemented with explicit wire projections. Historical model
JSON and digest assertions passed against the old implementation before the
production change. Two open-ended self-audit passes and an in-place diff review
found no remaining correctness issue.

| Evidence                     | Observed result                                                                                                                                                                                   | Limit                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Baseline Java                | 236/236 passed; the new model golden then passed 13/13 on the old implementation.                                                                                                                 | Baseline evidence is not a substitute for post-change tests.                           |
| Focused post-change Java     | 249/249 passed, including all production and 702 verification test sources compiling.                                                                                                             | This is a focused suite, not full Maven verify.                                        |
| External cross-language path | Real Worker boot contract passed 2/2; External ownership passed 13/13.                                                                                                                            | Local, SSH and the complete Hosted/fault profiles were not run within the Java budget. |
| AgentDefinition              | Core compiler/Connector/admission/approval tests passed 331/331; another 58 consumer tests passed; SDK passed 4/4 and the TS consumer passed 3/3. Create+load reads pinned content exactly twice. | Full Hosted and MySQL profiles remain pending.                                         |
| Checkstyle                   | Both executions reported zero violations for every production module and verification.                                                                                                            | Focused execution, not full Maven verify.                                              |
| TypeScript consumers         | The same four files passed 1,673/1,673 before and after; repository build and typecheck passed.                                                                                                   | No TypeScript source was changed.                                                      |
| Review                       | `git diff --check` passed; two self-audit passes and the in-place review found no bugs.                                                                                                           | No external bugbot subagent was available.                                             |

Earlier architecture runs reported baseline violations in `AgentSessionPolicies`
and `AgentTurnExecution`. The AgentDefinition slice removed duplicate parsing and
brought `AgentSessionPolicies` back below its ceiling; the latest run still
reports unchanged `AgentTurnExecution` at 798>797 lines. This remaining baseline
failure is not hidden by filtering or counted as a pass. Full Java/H2, SpotBugs,
MySQL, Hosted, fault, and archived CSI acceptance remain pending; no CI or
archived result is implied.

## Open questions

None for the scoped implementation. Out-of-repository Java source compatibility
is not a reason to retain duplicate typed and untyped APIs; external integrations
must remain on the unchanged wire protocols.
