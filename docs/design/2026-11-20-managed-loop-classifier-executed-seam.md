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

Replace the retired inventories with one **bounded** pin, judged by a single named-clause predicate that a hostile-source control executes clause by clause. It asks only where the two delegations sit and which ids they pass — five clauses, and nothing that enumerates what may surround a call:

- exactly **two** `loopClassifierResponse(` calls;
- each passes a **literal** call id, and the two ids are **distinct**;
- the two ids are the two the arms filter their tool results by, `loop-classifier` and `loop-fire-classifier`, compared as a **set** so exchanging the arms stays green;
- the delegation's **nearest enclosing function is that callback itself** — a callback handed to `startFakeOpenAIServer`, resolved rather than matched: an inline arrow, a hoisted `const` or a named `function` declaration alike. A closure the callback merely declares is not the callback, whatever kind of member or binding holds it;
- the two sit in **distinct** callbacks, so one fake cannot serve both arms.

Every clause has a hostile case measured to pass the weaker form it replaces. The positive controls carry the behaviour-preserving rewrites — arm order, id exchange, every gate spelling, a hoisted or by-reference callback, an extra wrapper flag — **and every shape the retired inventories used to judge**, which is green here by decision.

### What the pin deliberately does not cover

Eleven review rounds measured what happens when a fast structural pin tries to judge more than placement. Each round closed a gap and produced the next round's findings, in both directions, until the pin reached **518 non-comment lines — larger than the 309-line scanner this change retired** — while still passing wiring that does not work and rejecting rewrites that emit identical bytes. Round 11 measured five false greens (`calls['push'](<hand-built>)`, `[calls] = [[…]]`, `for (calls of …)`, a getter named `toolCalls`, a member alias push) and six false reds (an unrelated `...extra`, `calls.sort(cmp)`, `splice(0, 1)`, a computed literal member key, an attributable member assignment, an unrelated computed-key write). All eleven were reproduced before the decision.

So the answer inventory and the write attribution are **retired**, and the following are explicitly not covered by the fast pin. The executed decision test owns the decision's value; the packaged `/loop` arms own the wiring behaviourally.

| Not covered                               | Example measured shape                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| an answer built beside the decision       | `{ toolCalls: [<hand-built allow>] }` returned from a loop fake                                |
| an answer built after construction        | `calls.push(<hand-built>)`, `Object.assign`, `Reflect.set`, a mutator through any key spelling |
| a write through a pattern or loop target  | `[calls] = [[…]]`, `for (calls of …)`                                                          |
| a member reached through an alias         | `const tc = answer.toolCalls; tc.push(…)`                                                      |
| a getter or class field named `toolCalls` | `{ get toolCalls() { return [<hand-built>] } }`                                                |
| the result being returned at all          | an arm binds the decision and discards it                                                      |
| the gate's presence, spelling or polarity | `if (classified === undefined) return classified;`                                             |
| the fall-through after the gate           | `return classified;`, a direct return of the call                                              |
| provenance beyond the call's position     | `body` rebound, shadowed, or its schema mutated before delegating                              |
| which arm a fake belongs to               | the pin no longer reads arm flags at all                                                       |
| what a fake's start call is bound to      | a fake started into an unused binding                                                          |
| a registration that never runs            | `startFakeOpenAIServer(cb)` inside a function nothing calls — `cb` is still credited           |

**Which of these the packaged arms actually catch is measured, not assumed.** With only the skill arm's delegation changed, discarding the decision's result and swallowing the fall-through each fail the packaged skill arm. Two rows are **not** arm-verified: mutating the request body's schema before delegating was run on the packaged skill arm and it **passed**, and an answer in the durable-failover fake is not exercised by the skill arm at all. Those are uncovered by both lanes today and are listed as such rather than folded into the arm-owned claim.

Resolution stays fail-closed: a callback argument the resolver cannot reduce to one function — `flag ? a : b`, an ambiguous name — credits nothing, so such a wiring reads `in-fake-callback` rather than guessing.

One **false red** is accepted with the containment rule and named here rather than discovered later: a delegation extracted into a helper the callback invokes (`const g = () => { … }; return g();`) reads `in-fake-callback`. The rule asks where the delegation sits, not what the callback calls, and following calls is the retired data-flow family. The previous rule — walk outwards, stop at four class-member kinds — was measured to credit the same closure written as an object-literal arrow property, a parenthesized class field, a plain nested arrow or a nested function declaration, while rejecting their method and field siblings. One containment question closes all four with less code and no kinds to enumerate; the helper extraction is its price.

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

Two of round 3's shapes were placement bugs rather than data flow, and the reduced pin kept them for eight more rounds: the borrowed arm flag and the answer one closure down. Round 12 retired both along with the inventories they belonged to — the arm flags are no longer read at all, and nothing beside the call is enumerated. The rest are the retired data-flow checks listed above.

The decision, taken by the maintainer after round 3, was to stop growing the pin and shrink it to placement. Two measurements supported it: the pin had grown to roughly 370 lines of AST analysis guarding a two-line delegation — the retired scanner measures **370 lines / 309 non-comment** on the same caliber at `8dd9567685^` (`loopClassifierWiring` 345/284 plus `loopClassifierScope` 25/25), so the two were the same size at that point, and each round's fixes had produced the next round's findings. **The size figure is per revision, because round 4 grew it back.** Caliber: the full `const` variable statement of `classifierDelegation` plus that of `delegationViolations`, taken from the TypeScript AST statement boundaries; "non-comment" counts non-blank lines that do not start with `//`. On that measure the pin spans 161 lines (141 non-comment) at the round-3 commit `d1ebe200b2`, 297 (254) at `59857272fc`, 312 (267) at `6fef090d01`, 390 (356) at the round-5 commit `dd77c9387e`, 403 (363) after the round-6 regression fix, 609 (518) after round 11, and **152 lines (130 non-comment) as shipped** after round 12 retired the inventories and unified the containment rule. Rounds 4 through 11 spent that growth removing false reds and closing evasions, and each round's closures produced the next round's findings; at 518 non-comment lines the pin had outgrown the 309-line scanner it replaced while still failing in both directions, which is what forced the round-12 decision. At 130 non-comment lines it is under half that scanner, so the reduction's cost argument holds again — on the shipped revision, not on the round-3 one. Scan time is **not** load-bearing: seven runs of `classifierDelegation` alone gave a 92.7 ms median with an 81.6–174.5 ms spread on this machine, so only the line count is quoted as a cost.

One earlier mutation survived and was attributed rather than papered over: a constraint requiring each return in a gate's branches to read the binding _and nothing else_ had no isolating fixture, because it false-reddened `return classified ?? other` — a dead fallback under the gate. It was removed rather than justified with an invented fixture. That was the same signal the third round confirmed at scale.

## Review round 4: placement had the same spelling problem

Rounds 4 through 11 below are **history**. They describe clauses that round 12 retired, and their fixtures went with them; only the resolution helpers survived. They are kept because the sequence is the evidence for the retirement, not because any of those clauses still ships. Each round's present tense is the state at that round.

A fourth review at the reduced pin returned 0 Critical and six Suggestions. Two were about the record itself rather than the predicate: a positive control listed a shape the record classifies as behaviour-breaking, and a spliced closing brace had swallowed the next test's leading comment. One was about the executed test: comparing the payload as a pre-serialised JSON string pinned the answer's **key insertion order**, so reordering three keys in `classifierBlockAnswer` reddened a behaviour-preserving rewrite; the payload is now compared parsed.

The other three measured five evasions and five false reds in the placement clauses. All ten were reproduced first. The five false reds — renamed arm flags, a renamed request binding, a hoisted cron array, a closure-wrapped delegation and a callback passed by reference — are **gone**, because placement is now resolved rather than matched. Six of the evasions are closed: a computed `toolCalls` key, the three post-construction member writes, two fakes under one arm's flag, and a fire block nested inside the skill arm. The remaining two are added to the not-covered table above. The body-mutation one was then run on the packaged skill arm and **passed**, so it is recorded as uncovered by both lanes rather than as arm-owned; closing it would need alias tracking, which is the retired data-flow family.

One earlier attribution was wrong and is corrected here: the fake-arm multiset was removed in round 3 as "a second copy of arm-scoping". Round 4's two-fakes-under-one-flag shape shows it was not — the delegations' arms can look right while the fakes' arms do not. It is restored, and that shape is its isolating fixture.

## Review round 5: one notion of arm

A fifth review returned 0 Critical and five Suggestions. Three were about the record and the diagnostics rather than the predicate: a comment still argued for deleting the fake-arm set check the record had restored; the size and timing figure described the round-3 pin, not the shipped one; and a red named a clause with no file, line or source text, which was a regression against the scanner this change deletes. Each hit now carries its line and text, and the pin passes them as the assertion message — filtered by the same arm set as the verdict, so the message never names a fake the pin does not judge.

The other two carried forward the two threads round 2 had opened — **R2-1**, "the pin accepts wiring its own clauses claim to forbid", and **R2-2**, "behaviour-preserving rewrites redden the pin" — with seven evasions and seven false reds. All fourteen were reproduced first, and they had a **single root cause**: the pin kept two notions of arm — nearest flag for a delegation, outermost for a fake — and filtered its inventories during the walk, before the arm set existed. Unifying the arm at the fake's call site and moving the filtering to a second pass closed all seven false reds at once; the remaining evasions closed with the resolutions listed above. All fourteen are committed fixtures, seven hostile and seven positive, and the committed runner still reads `[]`.

A sixth review found one **Critical, and it was a regression that round 5 introduced**: unifying the arm lookup also put the answer inventory behind the delegation probe's member boundary, so an answer built inside a class or object member the fake declares stopped being inventoried. Measured on the same runner text, an object-literal method, a class method, an object getter and a class constructor all read `[]` at `dd77c9387e` while the same four reddened `no-loop-answer-site` at `59857272fc`; the arrow-closure and inline controls reddened at both. The two questions are now separate lookups — the inventory asks for the nearest fake without the boundary, the delegation probe keeps it — and both directions are witnessed: restoring the boundary on the inventory reddens the four new member cases, and removing it from the delegation probe reddens the existing parked-delegation cases.

An eighth review returned one Critical against the retained placement clauses: seven measured wirings that do not work read `[]` and three behaviour-preserving rewrites reddened, and the record claimed the opposite for several of them. Five were bounded resolution gaps and are fixed, each with a committed fixture and a mutation that removes only it:

- a hoisted array **written after its declaration** (`calls.push(<hand-built allow>)`) was enumerated at the declaration and passed — a regression against the scanner this change deletes, since the same write through the member was flagged;
- an in-place writer whose key arrives as a **name** (`const KEY = 'toolCalls'; Reflect.set(answer, KEY, …)`) was not resolved;
- an arm flag tested as `X === false` was credited, so an arm that never runs counted as wired;
- `ids.map((id) => fakeToolCall('cron_list', {}, id))` reddened although it emits the same bytes as an inline array;
- `loopClassifierResponse(body!, …)` reddened although the assertion is the same argument.

Three more are **disclosed rather than chased**, because closing them means tracking identity or position rather than resolving a name: the arm set is derived from the delegations' own flags, the delegation's position inside the callback is not judged, and a rest binding named `body` is credited. Each is in the not-covered table with its measured `[]`. The record's fail-closed and resolution sentences were narrowed to what the code now does, so no claim is broader than the measurement behind it.

A ninth verification round measured five gaps in the round-8 remediation and one wrong claim in these records. All were reproduced before being fixed, each with a committed fixture and a mutation that removes only it:

- a **destructuring declaration** (`{ const { toolCalls } = makeCalls(); … }`) bound no counted name, so the shorthand still resolved to the hoisted array; every name a binding pattern binds is now counted;
- an unattributable write **one binding hop away** (`const alias = calls; alias.push(<hand-built>)`) was accepted; the unsafe mark now travels back along the alias chain;
- an in-place key spelled as a **concatenation of literals** (`Reflect.set(answer, 'tool' + 'Calls', …)`) was accepted; `literalText` now folds literal concatenation, so the key names the same member;
- a **legitimate push-built** cron answer (`const calls = []; calls.push(fakeToolCall('cron_list', …))`) was rejected — the write rule now distinguishes an unattributable write from one that adds only literal-named calls, so this stays accepted;
- a **quoted** `body` key (`({ 'body': body })`) reddened `argument-provenance` although it binds the same property; the key is now read as an identifier or a literal. These records previously claimed it read `[]` without being credited — that claim was wrong, and the round-8 reply's "correction" of the review was wrong with it;
- a **class field initialised with an arrow** was credited although a class method in the same position was not; a class field is now a member boundary too.

The ambiguity path also kept its first initializer instead of nulling it, so the declaration **count** is the clause that rejects a second declaration rather than a side effect of a discarded initializer; removing the count check now reddens the suite.

A tenth verification round measured three more items, all reproduced first: the alias taint travelled only from the alias to its source, so writing to the array and returning its **alias** was accepted; a **computed literal** `body` key (`({ ['body']: body })`) reddened although it binds the same property; and three decisions inside the write-attribution rule had no committed fixture, so deleting any of them left the suite green. The taint now runs to a fixpoint in both directions, the computed key is read, and the three decisions — the literal-name requirement on an added array element, the mapped-array acceptance, and the same requirement on a scalar element — each have a committed fixture and a mutation that removes only them.

An eleventh pass worked the deferred lists that rounds 9 and 10 recorded in their review bodies rather than as inline threads. Four items were measurable and are closed here: a mutator reached through an **unreadable element key** (`answer[KEY].push(<hand-built>)`) was accepted and now fails closed; five members of the mutator and in-place sets (`unshift`, `splice`, `fill`, `copyWithin`, `defineProperties`) had no committed fixture, so deleting any of them left the suite green — each now has one; a red on any of the five **placement** clauses printed an empty assertion message because only inventory hits recorded a site, so the delegation call sites are now exposed and concatenated into the message; and the record's "a write through the body chain itself is flagged" was over-broad — measurement shows the flag fires when the chain carries an **element index**, in dot or bracket form alike, and not for an index-free chain.

Two carried claims did not survive measurement and are corrected rather than fixed: `distinct-callbacks` was reported as unable to fire alone, but deleting it reddens the suite through its own isolating fixture; and the retired scanner's "roughly 370 lines" was reported as never re-measured — it measures exactly 370 lines / 309 non-comment at `8dd9567685^`, now written down with its caliber.

A twelfth pass took the decision the eleventh round's Critical argued for, and the maintainer chose it: **retire the inventories and keep only the bounded property**. The measured case was the size inversion — 518 non-comment lines against the retired scanner's 309 — together with five false greens and six false reds reproduced in one round. Adding resolutions had produced the next round's findings eleven times; the bounded question does not need them.

The pin is now **152 lines (130 non-comment)**, under half the scanner it replaced, and the six false reds read `[]`. The five false greens still read `[]` — that is the coverage the retirement gives up, listed in the table above rather than hidden, with the packaged arms named as its owner. The earlier rounds' inventory fixtures are gone with the clauses they pinned; the resolution helpers they witnessed (`resolve`'s ambiguity rule, the by-reference and named-declaration callbacks) are kept and still have fixtures.

One retained clause was also **simplified rather than extended**. A deferred item reported that the member boundary tested only the immediate parent; measurement confirmed it and found the rule inconsistent in four more spellings. Replacing the outward walk with one containment question — the nearest enclosing function must be the registered callback — closed all four with twelve fewer lines, and its own mutation (restoring the outward walk) reddens the suite. Its price, a delegation extracted into a helper the callback invokes, is disclosed above.

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

The change is test-infrastructure only, so the load-bearing evidence is: the executed decision test reddens on each hostile direction under mutation (an additive fallback, a fabricated schema, a wrong call id, a dropped gate); every clause of the delegation pin reddens when that clause alone is deleted or narrowed back, including the clauses that accept a behaviour-preserving rewrite; the retired inventories' absence does not weaken any surviving pin; and the packaged arms are run after a full rebuild, with their result attributed rather than assumed.

The placement pin's clauses are witnessed one at a time rather than as a block: deleting a whole clause can be killed by a sibling clause while a one-token narrowing of it ships green.

Measured at the merged head `5df9a05f0f`, with the scripts meta suites re-run at `ec878e275` after merging a web-shell-only commit (`186 passed (186)` again): scripts meta suites `186 passed (186)`, core parity `35 passed (35)`, core `tsc --build` clean, eslint and prettier clean, build and bundle rc=0 with the core/cli dist and the bundle asserted refreshed against the build's start timestamp, the Java SDK and the server jar rebuilt (no Java source or pom is newer than the jar), all four nested contract sidecars byte-equal, and `ManagedLoopSkillTest` 22/22. Eleven clause-level mutations of the shipped predicate — one per clause, plus the registration resolution, the containment rule, the ambiguity count, the binding-pattern count and the call-site location — were all killed by the hostile-wiring test, each restored byte-equal.

**Both packaged arms are red at this head, and the red is main's.** Re-running each arm with only the runner file replaced by `origin/main`'s version reproduces the identical failure — skill `Cron tool loop-cron-list was never called`, fire `No model round ran the /loop create input` — and the runner was restored byte-equal afterwards. This PR's runner diff is three hunks, none on those paths, so no unrelated fix is carried here. The arm-owned claims above were measured when the arms were green; they are not re-asserted as a green run today.

Where a fast-lane judgement and a reviewer's claim about behaviour disagree, the packaged arm decides. Round 2 reversed one of round 1's acceptances that way, and the scope reduction was justified the same way: with only the skill arm's delegation changed, discarding the decision's result and swallowing the fall-through each fail the packaged arm, while the committed delegation passes. Every arm run restored the runner byte-equal.

## Open questions

None blocking. The function stays in the runner rather than moving to a shared module, because `extracted` slices top-level declarations from that file and moving it would require a new loader for no benefit.
