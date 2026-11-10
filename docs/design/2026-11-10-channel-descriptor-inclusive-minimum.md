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

**Additive vocabulary, not a replacement.** `exclusiveMinimum` keeps its meaning and every existing descriptor is untouched. `minimum` is optional, so the change is backward compatible for a package published to npm — no export shape changes, no consumer is forced to move.

**Both bounds may be declared; the stricter wins at the margin.** Validation rejects `parsed <= exclusiveMinimum` **or** `parsed < minimum`, which composes correctly without a precedence rule. The message names whichever floor is stricter, with a tie going to the exclusive bound because it also rejects equality.

**The message must not invent a floor.** The existing three-branch shape is preserved verbatim: a field with only a maximum still says "at most N" with no lower clause. The new inclusive wording is added alongside, not folded into a rewrite that would start asserting "greater than 0" on fields that declare no floor.

## Files affected

| File                                                                    | Change                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/channels/base/src/types.ts`                                   | Optional `minimum` on the number descriptor.               |
| `packages/sdk-typescript/src/daemon/types.ts`                           | The same optional field on the SDK's wire mirror.          |
| `packages/cli/src/commands/channel/channel-registry.ts`                 | Registration guard validates the new bound.                |
| `packages/cli/src/serve/channel-settings-store.ts`                      | The daemon's descriptor-driven check honours the floor.    |
| `packages/web-shell/client/components/channels/channel-editor-state.ts` | Reject below the inclusive floor.                          |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx` | Name the effective floor.                                  |
| `packages/web-shell/client/i18n.tsx`                                    | Inclusive wording, EN and ZH.                              |
| `packages/channels/github/src/index.ts`                                 | `minimum: 0` on the reserve; corrected requirement clause. |
| `packages/channels/github/src/GithubAdapter.ts`                         | Comment: the check is now a backstop, not a compensation.  |

## Constraints and risks

- The adapter's negative check is load-bearing for non-editor paths and must not be removed as "now redundant".
- Other channels keep `exclusiveMinimum: 0` where the floor really is exclusive; this change does not migrate them.
- A descriptor declaring both bounds is legal but unusual; the composition rule is pinned by a test rather than left to reading order.

## Validation plan

- Daemon store: a value below an inclusive floor is refused at upsert, and the bound itself is admitted. This consumer was found by enumerating readers of the bound, not by the original report — without it, moving a field from `exclusiveMinimum: -1` to `minimum: 0` would silently drop the daemon's descriptor-level floor.
- Editor state: values below an inclusive floor are refused, the bound itself and positive fractions are admitted.
- Editor state: with both bounds declared, the stricter one decides.
- Dialog: an inclusive floor is worded "at least N", and the exclusive wording is absent.
- Descriptor: the reserve declares `minimum: 0` and no `exclusiveMinimum`.
- Adapter: negatives, non-numbers and NaN are still refused; 0 and positive fractions still pass.
- Registration: a non-finite `minimum`, a `minimum` on a non-number field, and a `maximum` below the inclusive floor are each refused at registration.

Five runtime fix sites have mutation witnesses: dropping the daemon clause, dropping the editor clause, forcing the exclusive wording, restoring `exclusiveMinimum: -1`, and disabling the registration guard each turn exactly their own cases red. The SDK type mirror has no runtime behaviour to mutate; it is pinned by the typecheck, which is in fact how the missing mirror was found — the unit suites strip types and stayed green without it.

### Consumers found by enumeration, not by the report

The original finding named only the editor and the adapter. Three more readers of the bound turned up by walking every consumer, and two of them would have been silent regressions:

- The **daemon store** validates against the descriptor independently of the editor. Moving the field to `minimum: 0` without teaching it the bound would have dropped that layer's floor entirely.
- The **registration guard** would have accepted a non-finite or misplaced `minimum`, and a `maximum` below it.
- The **SDK wire mirror** is a separate hand-written interface. Without it the web-shell does not compile — caught by `npm run build`, not by any test.

## Acceptance criteria

- `-0.5` is refused by the editor before save, matching the adapter.
- `0` still disables the gate and is accepted by both layers.
- The range message names a floor the validator actually enforces.
- No existing descriptor changes meaning; no published export shape changes.
