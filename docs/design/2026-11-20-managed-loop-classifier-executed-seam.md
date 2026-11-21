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
| same file, `:3068`–`:3092`                                    | skill arm's inline decision: tools extraction → `respond_in_schema` lookup → `blockProperties` → helper → `!== undefined` gate → `{ toolCalls: [fakeToolCall('respond_in_schema', blockAnswer, 'loop-classifier')] }`, else fall through.                                      |
| same file, `:3167`–`:3191`                                    | fire arm's inline decision — identical but for the call id `'loop-fire-classifier'`.                                                                                                                                                                                           |
| `integration-tests/fake-openai-server.ts:115`                 | `fakeToolCall(name, args, id)` → `{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }`. The third argument is the tool-call id.                                                                                                                      |
| `scripts/tests/managed-agent-server-e2e.test.js:710` / `:741` | `extracted(names)` slices **top-level** declarations from the runner and transpiles them; `load(names, returns, ...params)` builds a `new Function` with injected dependencies. This is the existing execution mechanism, already used for `classifierBlockAnswer` at `:4096`. |
| same file, `:157` / `:509`                                    | `loopClassifierWiring` / `loopClassifierScope` — the scanner and its loop-callback scoping, producing ten inventories.                                                                                                                                                         |
| same file, `:3890`                                            | the pin test. Asserts the ten classifier inventories **and** unrelated contracts (arm terminal, body scope, caller-import markers, sidecar discriminators, union marker).                                                                                                      |
| same file, `:4153` / `:4413`                                  | the executed hostile control and the isolated allow-site case — both exist only to prove the scanner non-vacuous.                                                                                                                                                              |

The scanner has no consumer outside this meta-test; the only other references are the historical #17594 design record.

## Proposed changes

### Runner: one executed decision, two delegating arms

Add a top-level pure function beside `classifierBlockAnswer`:

`loopClassifierResponse(body, callId)` returns the whole fake response for a block-schema side query, or `undefined` when the request is not one. It performs the tools extraction, the `respond_in_schema` lookup, the properties read, the narrowing through `classifierBlockAnswer`, and the gate, and constructs the response with `fakeToolCall`. Both fakes replace their inline block with a delegation that returns the function's result when it is defined and otherwise falls through exactly as today.

The function is top-level so the existing `extracted`/`load` mechanism reaches it without change; `fakeToolCall` is injected as a dependency, the same way `inspect` is injected for `waitUntil`.

### Meta-test: execute the decision, retire the shape inventories

A new executed test drives `loopClassifierResponse` against hostile bodies and asserts the **whole response** — tool name, call id and the arguments payload together — or `undefined`. Hostile directions: stage-1 and stage-2 block schemas; the three non-block side queries (title, tool-use summary, next speaker); absent, non-array and malformed `tools`; a schema tool whose name is not `respond_in_schema`; several schema tools where a non-block schema precedes the block schema, so the first match wins and the later block schema does not rescue it; malformed `tools` entries and a non-object `properties`, which must fall through rather than throw; and both call ids, so an arm cannot answer under the other's id.

Retire `loopClassifierWiring`, `loopClassifierScope`, the writer-name set and the target-wrapper set, the ten classifier assertions in the pin test, the hostile control and the isolated allow-site case. Keep everything in the pin test that is not about the classifier decision, and keep the separate minted-id face (`mintedIdWiring`, `mintedScheduleId`, the fake-createdId pins) untouched.

Replace the retired inventories with one small **placement** pin, judged by a single named-clause predicate that a hostile-source control executes clause by clause. It checks where the delegation sits and that nothing answers beside it — seven clauses, no data-flow analysis:

- two delegations, each passing a **literal** call id, the ids compared **as a set**;
- the two delegations in **distinct** callbacks;
- each delegation inside a `startFakeOpenAIServer` callback, one in each loop arm, keyed on the arm flag rather than on the id;
- **one fake per arm**, so a second fake wrapped in the same flag cannot lend its arm to a delegation parked in the durable failover server;
- the first argument the callback's own `body` parameter;
- inside a loop arm's fake — **including any closure it declares** — no `respond_in_schema` answer, and no `toolCalls` element that is not a `fakeToolCall` with a literal tool name. The inventory is judged **per element**, not per property, because both arms legitimately build `toolCalls` for the cron fixtures.

The fake inventory keys the arm on the callback; a delegation's own arm is the nearest flag around it, so one gated by the sibling arm's flag inside this arm's fake is not credited to it. A second fake borrowing the arm is caught by the count, which is why that clause is a count and not a second copy of the arm multiset. Every clause has a hostile case that was measured to pass the weaker form it replaces, and the behaviour-preserving rewrites — arm order, id exchange, every gate spelling, an arrow-const decision, a legitimate third fake, a legitimate cron answer — are positive controls.

### What the pin deliberately does not cover

Three review rounds measured what happens when a fast structural pin tries to judge data flow. Round 1 found six shapes, round 2 six more in the clauses round 1 had just added, round 3 eleven more in the clauses round 2 had just added — every closure produced a fresh evasion and a fresh false red, because recognising provenance, gates, rebindings and fall-through by AST is hand-written semantic analysis over an unbounded rewrite space. That is the same treadmill this PR exists to end for the decision, re-entered one level up.

So the data-flow clauses are **retired by decision**, and the following are explicitly not covered by the fast pin. Each was measured to read `[]` against the committed predicate before retirement, so none is a silent gap:

| Not covered                                    | Example measured shape                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| the result being returned at all               | an arm binds the decision and discards it                                                                      |
| the gate's presence, spelling or polarity      | `if (classified === undefined) return classified;`, `undefined === classified`, a return from the wrong branch |
| a rebinding of the bound name                  | `classified = undefined`, destructuring, for-of, `++`, `delete`, `Object.assign`                               |
| the fall-through after the gate                | `return classified;`, `return classified ?? fixture;`, a direct return of the call                             |
| provenance beyond the parameter's name         | `body` rebound or shadowed before the call                                                                     |
| an alias of the bound name                     | `const alias = classified; return alias;`                                                                      |
| an answer built by a helper the callback calls | `return bypass(body);` — no `toolCalls` property at the call site                                              |

The packaged arms own all of these behaviourally, and that ownership is measured rather than asserted: with only the skill arm's delegation changed, discarding the decision's result and swallowing the fall-through each fail the packaged skill arm, while the committed delegation passes. The fast pin is a cheap smoke check on placement; it is not a second copy of the decision and not a substitute for the arms.

## Key design decisions

- **One function parameterized by call id, not two copies.** The two blocks are already identical apart from the id; duplicating them is what lets a fix reach one arm and miss the other. Parameterizing also makes "an arm answers under the other's id" a direction the executed test can assert.
- **Return the whole response, not just the answer.** Asserting the answer alone would leave the tool name and the call id unpinned, and pinning them separately would repeat the mapping weakness that scattered assertions have shown before. One deep-equality on the response pins the mapping.
- **Keep a placement pin, drop the decision inventories and the data-flow clauses.** The fast suite cannot run the packaged arms, so "the fake delegates from the right place" needs a cheap assertion. The unbounded family lived _inside_ the decision, and executing it removes that family outright. Three review rounds then showed that judging the wiring's data flow by AST re-enters the same family one level up, so the pin stops at placement and the arms own the behaviour.
- **Retire the scanner rather than keep it as a second opinion.** Two guards for one behaviour drift apart, and the scanner's maintenance cost was the thing this change removes. Its historical record stays in the #17594 design doc.
- **`undefined` keeps its exact meaning.** It means "not a block side query, fall through to the rest of the fake". The delegation must not convert it into a response, and must not swallow the fall-through path. That invariant is owned by the executed decision test and the packaged arms; the fast pin no longer claims to check it.

## Three review rounds, and where they led

Every shape below was measured against the predicate then committed, on the real runner text, before anything was changed. The committed runner read `[]` throughout.

**Round 1** (bot review on the PR) found six issues in the first replacement pin: it missed hand-built and computed-name answers, a fabricated body argument, a rebinding write, returns from class members, a delegation parked in another arm's fake and a swallowed fall-through; and it reddened on six behaviour-preserving rewrites — arm-block order, id exchange, a nullish-fallback return, an inverted undefined gate, an arrow-const decision, and a legitimate third fake answering a title query.

**Round 2** (17-agent local review) found six more in the corrected pin: eleven non-bare write spellings, a return exempted by another binding's gate, a rebound or shadowed `body`, five equivalent gate spellings priced as defects, an alias, and — reversed on packaged-arm evidence — round 1's acceptance of a direct return, which fails the skill arm both bare and with a `??` fallback.

**Round 3** (17-agent local review) found eleven more in _those_ clauses: `delete` and in-place API writes, a second gate returning another binding, an arm flag borrowed by a nested `if`, a block-scoped shadow of the bound name, the commuted `undefined === classified`, a non-enclosing `body` shadow priced as a defect, a return from the wrong branch, and an answer built one closure down. Zero Criticals; the undirected audit named the cause directly — the wiring pin had become hand-written semantic analysis over an unbounded rewrite space.

Two of round 3's shapes were placement bugs rather than data flow, and are fixed in the reduced pin: the borrowed arm flag (now `one-fake-per-arm`, with the arm keyed on the callback) and the answer one closure down (the inventory now walks every enclosing function). The rest are the retired data-flow checks listed above.

The decision, taken by the maintainer after round 3, was to stop growing the pin and shrink it to placement. Two measurements supported it: the pin had grown to roughly 370 lines of AST analysis guarding a two-line delegation, and each round's fixes had produced the next round's findings. The reduced pin is about 150 lines and scans the runner in a median 63.9 ms against 95.6 ms for the round-2 version, measured over seven runs of `classifierDelegation` alone.

One earlier mutation survived and was attributed rather than papered over: a constraint requiring each return in a gate's branches to read the binding _and nothing else_ had no isolating fixture, because it false-reddened `return classified ?? other` — a dead fallback under the gate. It was removed rather than justified with an invented fixture. That was the same signal the third round confirmed at scale.

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

The change is test-infrastructure only, so the load-bearing evidence is: the executed decision test reddens on each hostile direction under mutation (an additive fallback, a fabricated schema, a wrong call id, a dropped gate); every clause of the delegation pin reddens when that clause alone is deleted or narrowed back, including the clauses that accept a behaviour-preserving rewrite; the retired inventories' absence does not weaken any surviving pin; and both packaged arms still pass after a rebuild, with the fire arm's scheduled/fired/completed witness intact.

The placement pin's clauses are witnessed one at a time rather than as a block: deleting a whole clause can be killed by a sibling clause while a one-token narrowing of it ships green.

Where a fast-lane judgement and a reviewer's claim about behaviour disagree, the packaged arm decides. Round 2 reversed one of round 1's acceptances that way, and the scope reduction was justified the same way: with only the skill arm's delegation changed, discarding the decision's result and swallowing the fall-through each fail the packaged arm, while the committed delegation passes. Every arm run restored the runner byte-equal.

## Open questions

None blocking. The function stays in the runner rather than moving to a shared module, because `extracted` slices top-level declarations from that file and moving it would require a new loader for no benefit.
