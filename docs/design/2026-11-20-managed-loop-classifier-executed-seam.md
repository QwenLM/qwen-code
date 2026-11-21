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

Replace the retired inventories with one bounded delegation pin, judged by a single named-clause predicate that a hostile-source control executes clause by clause. The pin judges **properties, not spellings** — the first version of it did not, and review round 1 measured both failure directions (below). It requires: two delegations whose call ids compare **as a set**; two **distinct** callbacks; one delegation in each loop arm's own fake, keyed on the arm flag rather than on the id, so a delegation parked in the durable failover fake or in the sibling arm is caught while exchanging the two ids between the arms is not; the first argument the callback's own `body`, which the callback must neither rebind nor shadow; the result bound and returned inside a gate that **reads** that binding — any `if` whose test reads it, so truthiness, `!= null`, `typeof`, a coercion and both undefined comparisons are the same gate — with the branch's returns collected **stopping at every function boundary** (function, method, accessor, constructor) and every one of them required to read that binding — reading something else alongside it is allowed, because under the gate a `?? other` fallback is dead code; no write to that binding in the callback's own body, where a write is **any write context's target subtree** (an assignment's left side, a for-of/for-in initializer, an increment operand), so destructuring, parenthesized and cast targets are covered without enumerating wrappers; no return outside such a gate whose expression reads that binding, which would swallow the fall-through however it is spelled — a bare identifier, a `??` fallback, a spread or a shorthand key all read it, while a property key that merely shares the name does not; and, confined to the two loop callbacks, no `respond_in_schema` answer and no answer element that is not a `fakeToolCall` with a literal tool name. The answer inventory is judged **per element**, not per `toolCalls` property, because both arms legitimately build `toolCalls` for the cron fixtures. Every clause exists because a measured shape satisfied the weaker form it replaces, and the control carries each of those shapes plus the behaviour-preserving rewrites as positive controls.

The rule that keeps this from becoming the scanner again: **acceptance is judged by property, detection may be bounded.** An acceptance that lists spellings prices a correct rewrite as a defect, so every acceptance here is a property; a detector that lists spellings only misses shapes, which is a disclosed residual rather than a blocked author. Gate polarity is the one place this is visible — acceptance takes any gate that reads the binding, and a separate bounded detector flags the literal `X === undefined` form returning X from its then branch.

Four limits are disclosed rather than chased, all measured on the committed runner rather than inferred. The pin is **structural**: a fast-lane approximation of what the packaged arms prove behaviourally, not a second copy of the decision. A write to the bound name from a nested function that is actually invoked is outside `no-rebinding`, which keys on the callback's own body. A response returned from a helper called inside the callback carries no `toolCalls` property at the call site, so the answer inventory cannot see it — the retired file-wide count did see that one, and also reddened on a legitimate third arm; confining the inventory trades that reach for not pricing a correct fake as a defect. And an **alias** of the binding (`const alias = classified; return alias;`) is not tracked: following aliases transitively is the unbounded data-flow problem this PR refuses to re-enter, so the fall-through clause judges the binding's own name.

## Key design decisions

- **One function parameterized by call id, not two copies.** The two blocks are already identical apart from the id; duplicating them is what lets a fix reach one arm and miss the other. Parameterizing also makes "an arm answers under the other's id" a direction the executed test can assert.
- **Return the whole response, not just the answer.** Asserting the answer alone would leave the tool name and the call id unpinned, and pinning them separately would repeat the mapping weakness that scattered assertions have shown before. One deep-equality on the response pins the mapping.
- **Keep a delegation pin, drop the decision inventories.** The fast suite cannot run the packaged arms, so "the fake actually delegates" needs a cheap assertion. The unbounded family lived _inside_ the decision, and executing it removes that family outright. The wiring around it is a smaller but still real surface — round 1 measured both failure directions against the first pin, tabulated below — so the pin is kept small, judged by property, and explicitly subordinate to the packaged arms rather than presented as complete.
- **Retire the scanner rather than keep it as a second opinion.** Two guards for one behaviour drift apart, and the scanner's maintenance cost was the thing this change removes. Its historical record stays in the #17594 design doc.
- **`undefined` keeps its exact meaning.** It means "not a block side query, fall through to the rest of the fake". The delegation must not convert it into a response, and must not swallow the fall-through path.

## Review round 1: the first delegation pin was itself a shape pin

The first version of the replacement pin keyed on spellings and on source order, so it reproduced the treadmill it was meant to end — on both sides. Every shape below was measured with the committed predicate and the corrected one over the same runner text, the committed runner reading `[]` under both.

| Direction           | Shape                                                                   | First pin                  | Corrected pin            |
| ------------------- | ----------------------------------------------------------------------- | -------------------------- | ------------------------ |
| missed              | hand-built `toolCalls` element in a loop callback                       | `[]`                       | `no-loop-hand-built`     |
| missed              | `toolCalls` source that is not an inline array (and its shorthand form) | `[]`                       | `no-loop-hand-built`     |
| missed              | computed tool name on a `fakeToolCall` element                          | `[]`                       | `no-loop-hand-built`     |
| missed              | fabricated body argument, or another binding than `body`                | `[]`                       | `argument-provenance`    |
| missed              | rebinding write between the binding and the guard                       | `[]`                       | `no-rebinding`           |
| missed              | return from a class method or getter inside the guard's branch          | `[]`                       | `result-returned`        |
| missed              | delegation parked in a dead class member inside the callback            | `[]`                       | `arm-scoping`            |
| missed              | delegation moved into the durable failover fake                         | `[]`                       | `arm-scoping`            |
| missed              | fall-through swallowed by a return after the guard                      | `[]`                       | `fall-through-preserved` |
| missed              | the same swallow spelled `classified ?? fixture` or `{ ...classified }` | `[]`                       | `fall-through-preserved` |
| false red           | `if (loopFire)` block moved above `if (loopSkill)`                      | `call-ids`                 | `[]`                     |
| false red           | the two call ids exchanged between the arms                             | `call-ids`                 | `[]`                     |
| reversed in round 2 | `return loopClassifierResponse(...) ?? { content: 'fixture' }`          | `result-bound`             | `fall-through-preserved` |
| false red           | `=== undefined` gate returning from the else branch                     | `returned-under-own-guard` | `[]`                     |
| false red           | the decision spelled as an arrow const                                  | `single-answer-site`       | `[]`                     |
| false red           | a legitimate third fake answering a title side query                    | `single-answer-site`       | `[]`                     |

The disposition was to judge properties rather than spellings — ids as a set, arms as a multiset keyed on the arm flag, either gate polarity, an answer inventory confined to the loop callbacks and judged per element — and to add a bounded clause for each measured miss. One acceptance from this round did not survive round 2: the directly returned call expression, which the packaged arm showed to be behaviour-breaking. Shapes that are not valid TypeScript were excluded by measurement: a setter returning a value is `TS2408`, and a constructor returning the delegated value is `TS2322`/`TS2409`, so neither is used as a fixture; the setter's function-boundary disjunct is witnessed instead by a write from a setter, which must **not** count as a rebinding of the callback's binding.

## Review round 2: the corrected pin still tracked bindings by name in narrow positions

A second full review of the corrected pin measured six more shapes, all reproduced before any fix. Four were false negatives in clauses round 1 had just added — three fixed, the alias one disclosed instead; one was a false-positive family; and one of round 1's own acceptances turned out to be wrong.

| Direction        | Shape                                                                                                                                                  | Before                                      | After                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------ |
| missed           | eleven non-bare write spellings (array/object destructuring, rename, parenthesized, `as`, non-null, for-of, for-of pattern, for-in, `++`, prefix `++`) | `[]`                                        | `no-rebinding`           |
| missed           | return of the binding inside **another** binding's gate, either polarity                                                                               | `[]`                                        | `fall-through-preserved` |
| missed           | `body` rebound or shadowed before the call                                                                                                             | `[]`                                        | `argument-provenance`    |
| false red        | gate spelled `if (classified)`, `!= null`, `!== null`, `typeof`, `Boolean()`                                                                           | `result-returned`, `fall-through-preserved` | `[]`                     |
| wrongly accepted | bare direct return, and `?? { content: 'fixture' }` on one                                                                                             | `[]`                                        | `fall-through-preserved` |
| disclosed        | an alias of the binding returned outside the gate                                                                                                      | `[]`                                        | `[]` (residual)          |

The last acceptance was reversed on measurement, not on argument. Round 1 had accepted both direct-return forms as behaviour-preserving; the packaged skill arm was run three times at the same head with only the skill arm's delegation changed:

```
committed delegation                 rc=0   modelRounds 6, cronCreate true
?? { content: 'fixture' } on the call rc=1   Error: Cron tool loop-cron-create was never called
bare direct return                    rc=1   Error: Managed Turn terminal event did not become ready
```

Both forms terminate the callback, so a non-block request never reaches the arm's own fixtures. They are hostile cases now, and the runner was restored byte-equal after each arm.

One mutation survived this round and was attributed rather than papered over: requiring each return in the gate's branches to read the binding **and nothing else** had no isolating fixture, and measurement showed why — it reddened `return classified ?? other`, a dead fallback under the gate. The over-constraint was removed and that shape became a positive control, instead of inventing a fixture to justify a rule that prices a correct rewrite as a defect.

The write fix is the shape the retired scanner never reached: instead of enumerating target wrappers, the inventory walks **every write context's target subtree**, which covers destructuring, parentheses and casts at once because they are just nodes in that subtree. The gate fix is the same move on the acceptance side. The exemption that had been a global set of return positions is now keyed by the gate's test names, so another binding's gate cannot exempt a return of this one.

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

The delegation pin's clauses are witnessed one at a time rather than as a block: deleting a whole clause can be killed by a sibling clause while a one-token narrowing of it ships green, which is how the first pin's `guard.returns.includes(...)` and `guard.name` checks survived review round 1's own mutations.

Where a fast-lane judgement and a reviewer's claim about behaviour disagree, the packaged arm decides. Round 2 reversed one of round 1's acceptances that way, with a three-arm run at one head and a byte-equal restore after each.

## Open questions

None blocking. The function stays in the runner rather than moving to a shared module, because `extracted` slices top-level declarations from that file and moving it would require a new loader for no benefit.
