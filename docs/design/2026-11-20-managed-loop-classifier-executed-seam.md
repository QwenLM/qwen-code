# Managed /loop classifier: execute the decision instead of scanning for it

- Status: proposed
- Date: 2026-11-20
- Related: [deferred review pins](2026-11-17-managed-loop-deferred-pins.md) (#17594, merged), tracking issue #17673 item 1
- 中文版本: [2026-11-20-managed-loop-classifier-executed-seam.zh-CN.md](2026-11-20-managed-loop-classifier-executed-seam.zh-CN.md)

## Problem statement

The managed-agent E2E runner answers `cron_create`'s admission side query inside each fake model callback. The seam is drawn at `blockProperties`: the schema lookup, the narrowing, the gate and the answer site all stay inline in the fake, so the only thing a fast test can assert about them is their **shape**. A hand-rolled AST scanner inventories that shape, and fourteen review rounds on #17594 were largely spent extending the scanner after a newly measured sibling evaded it.

The evasion surface is unbounded by construction. Any way of writing the same value, or emitting the same answer, without the spelling the scanner looks for defeats it. Rounds 13 and 14 measured eight such siblings and closed each one — a shorthand `toolCalls` key, a shorthand allow key, an allow whose value is a binding initialised to `false`, rest-destructuring writes, parenthesized and cast assignment targets, and for-of / for-in initializers — and each closure was another inventory keyed on another spelling. The residual is already documented: an allow computed as `!true` or `Boolean(false)` spells no `false`, so no inventory of spellings can see it.

Two further costs follow from the same root cause. The two arms carry **byte-identical decision blocks apart from the call id**, so a fix applied to one arm can silently miss the other. And the scanner's own non-vacuity has to be proven by a hostile control that has grown to 21 write shapes, 5 allow sites, 7 answer sites, 13 tool-name sites and 5 helper calls — a fixture whose only purpose is to show that the scanner is not idle.

## Current state

Measured at `768cad5fcc`:

| Site                                                          | What it does                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/run-managed-agent-server-e2e.ts:2718`                | `classifierBlockAnswer(blockProperties)` — already a top-level pure function, already executed by the meta-test. Narrows the block schema: stage 1 yields `{ shouldBlock: false }`, stage 2 adds `thinking`/`reason`, a non-block schema yields `undefined`.                   |
| same file, `:3067`–`:3092`                                    | skill arm's inline decision: tools extraction → `respond_in_schema` lookup → `blockProperties` → helper → `!== undefined` gate → `{ toolCalls: [fakeToolCall('respond_in_schema', blockAnswer, 'loop-classifier')] }`, else fall through.                                      |
| same file, `:3167`–`:3191`                                    | fire arm's inline decision — identical but for the call id `'loop-fire-classifier'`.                                                                                                                                                                                           |
| `integration-tests/fake-openai-server.ts:115`                 | `fakeToolCall(name, args, id)` → `{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }`. The third argument is the tool-call id.                                                                                                                      |
| `scripts/tests/managed-agent-server-e2e.test.js:710` / `:741` | `extracted(names)` slices **top-level** declarations from the runner and transpiles them; `load(names, returns, ...params)` builds a `new Function` with injected dependencies. This is the existing execution mechanism, already used for `classifierBlockAnswer` at `:4095`. |
| same file, `:157` / `:509`                                    | `loopClassifierWiring` / `loopClassifierScope` — the scanner and its loop-callback scoping, producing ten inventories.                                                                                                                                                         |
| same file, `:3890`                                            | the pin test. Asserts the ten classifier inventories **and** unrelated contracts (arm terminal, body scope, caller-import markers, sidecar discriminators, union marker).                                                                                                      |
| same file, `:4269` / `:4414`                                  | the executed hostile control and the isolated allow-site case — both exist only to prove the scanner non-vacuous.                                                                                                                                                              |

The scanner has no consumer outside this meta-test; the only other references are the historical #17594 design record.

## Proposed changes

### Runner: one executed decision, two delegating arms

Add a top-level pure function beside `classifierBlockAnswer`:

`loopClassifierResponse(body, callId)` returns the whole fake response for a block-schema side query, or `undefined` when the request is not one. It performs the tools extraction, the `respond_in_schema` lookup, the properties read, the narrowing through `classifierBlockAnswer`, and the gate, and constructs the response with `fakeToolCall`. Both fakes replace their inline block with a delegation that returns the function's result when it is defined and otherwise falls through exactly as today.

The function is top-level so the existing `extracted`/`load` mechanism reaches it without change; `fakeToolCall` is injected as a dependency, the same way `inspect` is injected for `waitUntil`.

### Meta-test: execute the decision, retire the shape inventories

A new executed test drives `loopClassifierResponse` against hostile bodies and asserts the **whole response** — tool name, call id and the arguments payload together — or `undefined`. Hostile directions: stage-1 and stage-2 block schemas; the three non-block side queries (title, tool-use summary, next speaker); absent, non-array and malformed `tools`; a schema tool whose name is not `respond_in_schema`; several schema tools where a non-block schema precedes the block schema, so the first match wins and the later block schema does not rescue it; malformed `tools` entries and a non-object `properties`, which must fall through rather than throw; and both call ids, so an arm cannot answer under the other's id.

Retire `loopClassifierWiring`, `loopClassifierScope`, the writer-name set and the target-wrapper set, the ten classifier assertions in the pin test, the hostile control and the isolated allow-site case. Keep everything in the pin test that is not about the classifier decision, and keep the separate minted-id face (`mintedIdWiring`, `mintedScheduleId`, the fake-createdId pins) untouched.

Replace the retired inventories with one bounded delegation pin, judged by a single named-clause predicate that a hostile-source control executes clause by clause. The pin requires: exactly two calls with the two arm call ids; the two calls in **distinct** callbacks; each call inside a `startFakeOpenAIServer` callback rather than a dead helper; the result bound; the bound result returned **inside** a `!== undefined` guard in that same callback, where the branch's returns are collected **stopping at function boundaries** so a closure declared in the branch cannot credit it; and exactly one `respond_in_schema` answer construction in the whole runner, inside `loopClassifierResponse` itself, so a bypass sibling in a callback cannot answer non-block side queries with a schema-invalid allow. Every clause exists because a measured evasion satisfied the weaker form it replaces, and the control carries each of those shapes plus a positive control.

One limit is disclosed rather than chased: the answer-site inventory keys on a literal `'respond_in_schema'` first argument, so a computed tool name still evades it. That is the same unbounded spelling family the executed decision removes for the decision itself; what remains here is one bounded site count, and the packaged arms cover the behaviour.

## Key design decisions

- **One function parameterized by call id, not two copies.** The two blocks are already identical apart from the id; duplicating them is what lets a fix reach one arm and miss the other. Parameterizing also makes "an arm answers under the other's id" a direction the executed test can assert.
- **Return the whole response, not just the answer.** Asserting the answer alone would leave the tool name and the call id unpinned, and pinning them separately would repeat the mapping weakness that scattered assertions have shown before. One deep-equality on the response pins the mapping.
- **Keep a delegation pin, drop the decision inventories.** The fast suite cannot run the packaged arms, so "the fake actually delegates" needs a cheap assertion. The unbounded family lived _inside_ the decision; a single delegation call has no comparable evasion surface, and not delegating at all is caught behaviourally by the packaged arms.
- **Retire the scanner rather than keep it as a second opinion.** Two guards for one behaviour drift apart, and the scanner's maintenance cost was the thing this change removes. Its historical record stays in the #17594 design doc.
- **`undefined` keeps its exact meaning.** It means "not a block side query, fall through to the rest of the fake". The delegation must not convert it into a response, and must not swallow the fall-through path.

## Files affected

| File                                                                            | Change                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/run-managed-agent-server-e2e.ts`                                       | add `loopClassifierResponse`; both fakes delegate to it                                                                                                                          |
| `scripts/tests/managed-agent-server-e2e.test.js`                                | new executed decision test; bounded delegation pin; retire the scanner, its two helper sets, the ten classifier assertions, the hostile control and the isolated allow-site case |
| `docs/design/2026-11-20-managed-loop-classifier-executed-seam.md` / `.zh-CN.md` | this record                                                                                                                                                                      |

No production runtime module, no contract, no sidecar and no Java file changes. The runner is E2E infrastructure.

## Scope boundaries

Only #17673 item 1. Items 2–6 (derived degeneration threshold, cross-language fixture binding, shape-independent Java routing assertion, one exported Parsing grammar, machine-readable creator declaration) are untouched, as is the minted-id face and every non-classifier pin in the same test. The packaged arms are re-run as verification, not modified.

## Verification

The change is test-infrastructure only, so the load-bearing evidence is: the executed decision test reddens on each hostile direction under mutation (an additive fallback, a fabricated schema, a wrong call id, a dropped gate); the delegation pin reddens when an arm stops delegating or uses the other arm's id; the retired inventories' absence does not weaken any surviving pin; and both packaged arms still pass after a rebuild, with the fire arm's scheduled/fired/completed witness intact.

## Open questions

None blocking. The function stays in the runner rather than moving to a shared module, because `extracted` slices top-level declarations from that file and moving it would require a new loader for no benefit.
