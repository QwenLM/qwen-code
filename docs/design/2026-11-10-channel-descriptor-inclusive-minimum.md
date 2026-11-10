# Channel config descriptors: an inclusive lower bound

[English](2026-11-10-channel-descriptor-inclusive-minimum.md) | [简体中文](2026-11-10-channel-descriptor-inclusive-minimum.zh-CN.md)

Status: proposed. Closes the last non-blocking item left by the #16690 verification round.

## Problem statement

A number field whose real floor is **0** cannot say so. The descriptor vocabulary offers only `exclusiveMinimum`, so the GitHub channel's `prWatchBudgetReserve` declares `exclusiveMinimum: -1` to admit 0 — and that also admits everything in `(-1, 0)`.

The two layers then disagree about `-0.5`:

| Layer                                  | Predicate                                | `-0.5`       |
| -------------------------------------- | ---------------------------------------- | ------------ |
| Editor (`channel-editor-state.ts`)     | reject when `parsed <= exclusiveMinimum` | **accepted** |
| Adapter (`validateBoundSessionConfig`) | reject when `reserve < 0`                | **rejected** |

The operator types `-0.5`, the form shows no error, and the save fails. The range message compounds it by naming `-1` as the floor — a bound the validator does not enforce, worded so that `-0.5` reads as legal.

## Current state

- `ChannelConfigNumberFieldDescriptor` declares `exclusiveMinimum` and `maximum`. There is no inclusive lower bound.
- The editor validates with `parsed <= exclusiveMinimum` and interpolates that same number into `channels.editor.validation.outOfRange`.
- The adapter's `reserve < 0` check was added deliberately as compensation for the vocabulary gap, and its comment says so.

## Proposed change

Add an optional `minimum` to the number descriptor, honour it in the editor's validation and in the range message, and declare `minimum: 0` on `prWatchBudgetReserve`.

The adapter check **stays**. It is not redundant: configuration also arrives from a hand-edited `settings.json` and from daemon API calls, neither of which passes through the editor. Removing it would turn a vocabulary fix into a validation regression on those paths.

## Design decisions and rationale

**Additive vocabulary, not a replacement.** `exclusiveMinimum` keeps its meaning and every descriptor except the reserve is untouched. `minimum` is optional, so the change is backward compatible for a package published to npm — the export shape only gains an optional field, and no consumer is forced to move.

**Both bounds may be declared; the stricter wins at the margin.** Validation rejects `parsed <= exclusiveMinimum` **or** `parsed < minimum`, which composes correctly without a precedence rule. The message names whichever floor is stricter, with a tie going to the exclusive bound because it also rejects equality.

**The message must not invent a floor.** The existing three-branch shape is preserved verbatim: a field with only a maximum still says "at most N" with no lower clause. The new inclusive wording is added alongside, not folded into a rewrite that would start asserting "greater than 0" on fields that declare no floor.

## Files affected

The table lists every reader and writer of the vocabulary, including the wire-shape guard, which is a reader implemented as a test. The pins themselves live in the collocated test files and are enumerated in the validation plan below.

| File                                                                      | Change                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/channels/base/src/types.ts`                                     | Optional `minimum` on the number descriptor.               |
| `packages/sdk-typescript/src/daemon/types.ts`                             | The same optional field on the SDK's wire mirror.          |
| `packages/cli/src/commands/channel/channel-registry.ts`                   | Registration guard validates the new bound.                |
| `packages/cli/src/commands/channel/channel-descriptor-sdk-mirror.test.ts` | Wire-shape allowlist admits the new key.                   |
| `docs/developers/qwen-serve-protocol.md`                                  | The client-facing vocabulary contract.                     |
| `packages/cli/src/serve/channel-settings-store.ts`                        | The daemon's descriptor-driven check honours the floor.    |
| `packages/web-shell/client/components/channels/channel-editor-state.ts`   | Reject below the inclusive floor.                          |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`   | Name the effective floor.                                  |
| `packages/web-shell/client/i18n.tsx`                                      | Inclusive wording, EN and ZH.                              |
| `packages/channels/github/src/index.ts`                                   | `minimum: 0` on the reserve; corrected requirement clause. |
| `packages/channels/github/src/GithubAdapter.ts`                           | Comment: the check is now a backstop, not a compensation.  |

## Constraints and risks

- The adapter's negative check is load-bearing for non-editor paths and must not be removed as "now redundant".
- Other channels keep `exclusiveMinimum: 0` where the floor really is exclusive; this change does not migrate them.
- A descriptor declaring both bounds is legal but unusual; the composition rule is pinned by a test rather than left to reading order.
- The unchanged-value forgiveness is descriptor-layer only, and for the one field this change migrates it does not reach the operator. GitHub's `validateConfig` refuses a negative reserve unconditionally, so a hand-edited `settings.json` holding one still fails every save until the value is corrected. What this change removes is the mismatch for a value the operator **types**; a pre-existing stored value on a plugin that re-checks the field is out of its reach.

## Validation plan

- Daemon store: a value below an inclusive floor is refused at upsert, and the bound itself is admitted. This consumer was found by enumerating readers of the bound, not by the original report — without it, moving a field from `exclusiveMinimum: -1` to `minimum: 0` would silently drop the daemon's descriptor-level floor.
- Daemon store: with both lower bounds declared, the stricter one decides. The conjunction is what makes that true — rewriting it as exclusive-wins precedence keeps both keys in use and starts admitting a value the inclusive clause refuses, on the path that serves hand-edited settings files and daemon API clients. Both directions are pinned: the mirror shape, where the exclusive bound is the stricter one, is the half an inclusive-wins precedence slips past.
- Daemon store: an unchanged stored value below a newly declared floor is still forgiven **by the descriptor check**, while a changed one is refused. The forgiveness wraps the whole range; hoisting the inclusive clause out of it strands an operator whose settings file predates the floor.
- Daemon store: the forgiveness ends at the descriptor layer. `upsert` runs the plugin's `validateConfig` afterwards, and a plugin that re-checks the field refuses the save regardless — GitHub's does, unconditionally, for a negative reserve. A case whose fixture plugin re-checks the floor pins this seam by asserting the plugin's own message rather than the store's.
- Editor state: values below an inclusive floor are refused, the bound itself and positive fractions are admitted.
- Editor state: with both bounds declared, the stricter one decides.
- Editor state: the unchanged-value forgiveness covers the inclusive floor too, so a stored below-floor number raises no inline error; a value the operator typed is still refused. This is the same descriptor-layer limit — it does not promise the save succeeds when the plugin re-checks the field.
- Dialog: an inclusive-only floor is worded "at least N"; a tie names the exclusive bound; a strictly-higher inclusive bound wins; a strictly-lower one loses. All four shapes are needed — the tie pins the `>` against `>=`, and the strictly-lower shape pins the comparison against being dropped altogether.
- Range message: the pre-existing exclusive-floor strings are pinned verbatim in both locales, so folding the lower clause into one variable cannot silently respace them.
- Descriptor: the reserve declares `minimum: 0` and no `exclusiveMinimum`.
- Adapter: negatives, non-numbers and NaN are still refused; 0 and positive fractions still pass.
- Registration: a non-finite `minimum`, a `minimum` on a non-number field, and a `maximum` below the inclusive floor are each refused; a single-value interval where `maximum === minimum` **registers**, which is what keeps the inclusive clause strict `<`.
- Wire shape: the built-in descriptor allowlist admits `minimum` on number fields and still refuses it elsewhere.

Every runtime fix site has a mutation witness: the daemon clause, the daemon's composition and its unchanged-value forgiveness, the plugin-hook seam, the editor clause and its own forgiveness, the dialog's tie-break and its stricter-floor comparison, the registration guard's rejection set and its strict `<`, the zh spacing, the wire-shape allowlist, and the descriptor's own declaration. All but the plugin-hook seam are isolating: deleting the hook call also reddens five pre-existing hook cases, so the seam's isolating arm is the descriptor-side hoist, which reddens only the two tolerance cases by swapping the plugin's message for the store's. The SDK type mirror has no runtime behaviour to mutate; it is pinned by the typecheck, which is how the missing mirror was found — the unit suites strip types and stayed green without it.

### Consumers found by enumeration, not by the report

The original finding named only the editor and the adapter. Three more readers of the bound turned up by walking every consumer, and two of them would have been silent regressions:

- The **daemon store** validates against the descriptor independently of the editor. Moving the field to `minimum: 0` without teaching it the bound would have dropped that layer's floor entirely.
- The **registration guard** would have accepted a non-finite or misplaced `minimum`, and a `maximum` below it.
- The **SDK wire mirror** is a separate hand-written interface. Without it the web-shell does not compile — caught by `npm run build`, not by any test.

Review then found a **fourth** that the enumeration above still missed, and it was the one that turned CI red: `channel-descriptor-sdk-mirror.test.ts` allowlists the keys a built-in descriptor may emit and asserts every own key is in that set. Adding `minimum` to a built-in descriptor without extending the allowlist fails that assertion, and `packages/cli`'s `test:ci` runs with `--bail=1`, so one assertion took down the whole CLI job. The lesson is about the verification, not the code: running two hand-picked files in that package could not reach it. Run the package's whole channel directory.

The **protocol document** is a fifth reader — the contract a client author implements against, independent of any TypeScript type. Leaving it unchanged reproduces the accept-then-fail mismatch for every client built from the docs.

## Acceptance criteria

- A typed `-0.5` is refused by the editor before save, matching the adapter.
- `0` still disables the gate and is accepted by both layers.
- The range message names a floor the validator actually enforces.
- The vocabulary's existing keys keep their meaning, and every descriptor except the reserve is untouched. The reserve's floor narrows deliberately from `(-1, …)` to `[0, …)`; a stored value in `(-1, 0)` was already refused by the adapter, so nothing that saved before stops saving. The published export shape only gains an optional field.
