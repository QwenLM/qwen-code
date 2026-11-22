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

Placement is resolved, not spelled, and it has **one notion of arm**. A fake's arm is read at its `startFakeOpenAIServer` **call site**, so a callback declared above the flag and passed inside the block still belongs to that arm. A delegation's arm comes from **the fake it sits in**, and a flag around the delegation that disagrees with that fake's arm means the arm never runs it. Both inventories are filtered by the set of arms that actually delegate in a **second pass**, which keeps the durable-failover fake out. An arm flag is a boolean local tested directly **or against a literal boolean**; a wrapper flag no delegation reports is not an arm.

Everything else resolves too: a fake passed **by reference** is resolved to its declaration; the request binding is only the binding element that binds the **`body` property**, not a sibling field of the same handler context; a delegation wrapped in a **closure** — arrow, function expression or named declaration — still belongs to its fake, while a class member does not; a **hoisted** answer array is followed along its identifier chain, and any name with more than one declaration, **with an initializer or not**, resolves to nothing rather than guessing.

The answer inventory fails closed on what it cannot enumerate: an unreadable property **or element-access** key, a spread assignment, and an answer built after construction — assigned, indexed, pushed through a **mutator**, or written by an in-place writer (`Object.assign`, `defineProperty`, `Reflect.set`) that reaches the member through an argument. A **read-only** call on a `toolCalls` member builds no answer and is not flagged. An allow hoisted outside the fake is the same answer as an inline one. The inventory asks for the nearest fake **without** the member boundary: a class or object member the arm's callback declares is still code that arm can run, so an answer built there is an answer beside the decision. Only the delegation probe keeps the boundary, where a dead member must not credit a delegation. Every clause has a hostile case that was measured to pass the weaker form it replaces, and the behaviour-preserving rewrites — arm order, id exchange, every gate spelling, an arrow-const decision, a legitimate third fake, a legitimate cron answer — are positive controls.

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
| an answer in a fake outside the loop arms      | the durable-failover fake answering with a loop call id                                                        |
| the request body's schema being mutated        | an arm writing `shouldBlock` into `body.tools[0]…properties` before delegating                                 |

**Four of these rows have a measured arm verdict; the other five have none and are not claimed either way.** With only the skill arm's delegation changed, discarding the decision's result and swallowing the fall-through each fail the packaged skill arm (`Cron schedule admission denied: Classifier stage 1 unavailable` and `Managed Turn terminal event did not become ready`), while the committed delegation passes. Two rows are **not** arm-verified: mutating the request body's schema before delegating was run on the packaged skill arm and it **passed** (rc=0, modelRounds 6, cronCreate true), and an answer in the durable-failover fake is not exercised by the skill arm at all. Those two are uncovered by both lanes today, and are listed as such rather than folded into the arm-owned claim. Closing the body-mutation one would need alias tracking — the write lands on a binding derived from `body`, not on `body` itself — which is the data-flow family this pin stopped judging.

The fast pin is a cheap smoke check on placement; it is not a second copy of the decision and not a substitute for the arms.

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

The decision, taken by the maintainer after round 3, was to stop growing the pin and shrink it to placement. Two measurements supported it: the pin had grown to roughly 370 lines of AST analysis guarding a two-line delegation, and each round's fixes had produced the next round's findings. **The size figure is per revision, because round 4 grew it back.** Caliber: the brace-balanced span of `classifierDelegation` plus that of `delegationViolations`, from `const X = (` through its closing `};`; "non-comment" counts non-blank lines that do not start with `//`. On that measure the pin spans 161 lines (141 non-comment) at the round-3 commit `d1ebe200b2`, 297 (254) at `59857272fc`, 312 (267) at `6fef090d01`, 390 (356) at the round-5 commit `dd77c9387e`, and **400 lines (362 non-comment) as shipped** after the round-6 regression fix. **The shipped pin is therefore larger than the roughly 370-line scanner it replaced.** Rounds 4 and 5 spent that growth removing false reds and closing evasions in the placement clauses; the reduction's original cost argument no longer holds, and the decision to keep the pin at all is worth revisiting on that number rather than on the round-3 one. Scan time is **not** load-bearing: seven runs of `classifierDelegation` alone gave a 92.7 ms median with an 81.6–174.5 ms spread on this machine, so only the line count is quoted as a cost.

One earlier mutation survived and was attributed rather than papered over: a constraint requiring each return in a gate's branches to read the binding _and nothing else_ had no isolating fixture, because it false-reddened `return classified ?? other` — a dead fallback under the gate. It was removed rather than justified with an invented fixture. That was the same signal the third round confirmed at scale.

## Review round 4: placement had the same spelling problem

A fourth review at the reduced pin returned 0 Critical and six Suggestions. Two were about the record itself rather than the predicate: a positive control listed a shape the record classifies as behaviour-breaking, and a spliced closing brace had swallowed the next test's leading comment. One was about the executed test: comparing the payload as a pre-serialised JSON string pinned the answer's **key insertion order**, so reordering three keys in `classifierBlockAnswer` reddened a behaviour-preserving rewrite; the payload is now compared parsed.

The other three measured five evasions and five false reds in the placement clauses. All ten were reproduced first. The five false reds — renamed arm flags, a renamed request binding, a hoisted cron array, a closure-wrapped delegation and a callback passed by reference — are **gone**, because placement is now resolved rather than matched. Six of the evasions are closed: a computed `toolCalls` key, the three post-construction member writes, two fakes under one arm's flag, and a fire block nested inside the skill arm. The remaining two are added to the not-covered table above. The body-mutation one was then run on the packaged skill arm and **passed**, so it is recorded as uncovered by both lanes rather than as arm-owned; closing it would need alias tracking, which is the retired data-flow family.

One earlier attribution was wrong and is corrected here: the fake-arm multiset was removed in round 3 as "a second copy of arm-scoping". Round 4's two-fakes-under-one-flag shape shows it was not — the delegations' arms can look right while the fakes' arms do not. It is restored, and that shape is its isolating fixture.

## Review round 5: one notion of arm

A fifth review returned 0 Critical and five Suggestions. Three were about the record and the diagnostics rather than the predicate: a comment still argued for deleting the fake-arm set check the record had restored; the size and timing figure described the round-3 pin, not the shipped one; and a red named a clause with no file, line or source text, which was a regression against the scanner this change deletes. Each hit now carries its line and text, and the pin passes them as the assertion message — filtered by the same arm set as the verdict, so the message never names a fake the pin does not judge.

The other two carried forward the two threads round 2 had opened — **R2-1**, "the pin accepts wiring its own clauses claim to forbid", and **R2-2**, "behaviour-preserving rewrites redden the pin" — with seven evasions and seven false reds. All fourteen were reproduced first, and they had a **single root cause**: the pin kept two notions of arm — nearest flag for a delegation, outermost for a fake — and filtered its inventories during the walk, before the arm set existed. Unifying the arm at the fake's call site and moving the filtering to a second pass closed all seven false reds at once; the remaining evasions closed with the resolutions listed above. All fourteen are committed fixtures, seven hostile and seven positive, and the committed runner still reads `[]`.

A sixth review found one **Critical, and it was a regression that round 5 introduced**: unifying the arm lookup also put the answer inventory behind the delegation probe's member boundary, so an answer built inside a class or object member the fake declares stopped being inventoried. Measured on the same runner text, an object-literal method, a class method, an object getter and a class constructor all read `[]` at `dd77c9387e` while the same four reddened `no-loop-answer-site` at `59857272fc`; the arrow-closure and inline controls reddened at both. The two questions are now separate lookups — the inventory asks for the nearest fake without the boundary, the delegation probe keeps it — and both directions are witnessed: restoring the boundary on the inventory reddens the four new member cases, and removing it from the delegation probe reddens the existing parked-delegation cases.

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
