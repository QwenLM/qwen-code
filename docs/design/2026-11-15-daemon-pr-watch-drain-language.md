# Daemon PR watch: prompt language

[English](2026-11-15-daemon-pr-watch-drain-language.md) | [简体中文](2026-11-15-daemon-pr-watch-drain-language.zh-CN.md)

Status: implemented as #17352 (proposed 2026-11-15). The body below describes the increment as designed.

## Problem

The daemon's PR-state watch delivers bound event prompts in English even when the operator's UI language is Chinese. The channel lane was localized in #16773, and the shared builder has carried a per-language envelope, role-guidance table and copy map ever since, but the daemon producer never passes a language: `PrWatchDrainDeps` declares no `language` member, `buildDrainPrompt` calls `buildBoundEventPrompt` without one, and the four transition summaries are authored as English literals in the observation producer. A zh deployment with an event subscription therefore receives English daemon prompts today.

[Bound-session event prompt language](2026-11-09-bound-event-prompt-language.md) decision 7 recorded this as owed rather than scheduled: the enablement increment (#17032) landed without threading it. This increment threads it.

## Current state

The table describes the tree before this increment.

| Surface                                                                              | Location                                                                          | Language today                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Envelope prose (header, notices, workflow sentence, truncation marker)               | `packages/channels/base/src/bound-session-prompt.ts`, `BOUND_ENVELOPE_COPY`       | localized; the drain passes no `language`, so it resolves to `en`           |
| Built-in role guidance                                                               | same file, `DEFAULT_BOUND_ROLE_GUIDANCE_BY_LANGUAGE`                              | localized; the drain indexes the English-only `DEFAULT_BOUND_ROLE_GUIDANCE` |
| Provenance line                                                                      | `packages/cli/src/serve/server/pr-watch-drain.ts`, `buildDrainPrompt`             | hardcoded English literal                                                   |
| Transition summaries (`head_change`, `ci_failure`, `merge_conflict`, `state_change`) | `packages/cli/src/serve/server/pr-watch-observation.ts`, four `summary:` literals | hardcoded English, persisted into `pending[].summary`                       |
| Locale resolution                                                                    | `packages/cli/src/commands/channel/runtime.ts`, `resolveChannelLocale`            | exists, read by the channel's `daemon-worker.ts` and `start.ts`             |

## Goals

- A daemon whose `general.language` resolves to `zh` delivers bound PR-watch prompts whose envelope prose, role guidance and provenance are Chinese, and whose transition summary is Chinese for every transition it detects under that locale.
- An `en` (or unset, or unrecognized) language keeps today's output **byte-identical**.
- A pending entry's persisted summary keeps its detection language; the envelope, role guidance and provenance follow the locale in force at delivery. This is the channel lane's rule too: it persists the producer-composed body (`boundText`) and composes the envelope at delivery, so in both lanes the detection-language guarantee covers the persisted text, not the whole prompt.
- No store schema change and no change to any transition key.

## Non-goals

- Live language switching. The locale is read once at daemon boot, exactly as the channel worker reads it at startup.
- Localizing operator templates. `sessionPrWatch.actions` values render verbatim in whatever language the operator wrote them.
- Localizing the channel's comment lane, which #16773 already covers.
- Structural markers. Field labels (`Repo:`, `PR:`, `Title:`, `URL:`, `Event:`, `Summary:`, `Role:`), the trusted-instruction label and the `Source:` line stay English in every language, as the shared contract requires.

## Proposed changes

### One locale, resolved at boot

`run-qwen-serve.ts` resolves `resolveChannelLocale(bootSettings?.general?.language)` next to the existing `resolveSessionPrWatchConfig` call and carries it into `prWatchSources`; `bootSettings` is the bound workspace's merged settings, the first `--workspace`, and `prWatchSources` is the single daemon-wide sources object. Both seams read the same value, so within one boot the observation and the drain cannot disagree about the locale. Across a restart they can: a summary persisted under the old locale is delivered inside an envelope composed under the new one, which is the intended split.

### The observation localizes the summary at detection time

`PrWatchObservationTickDeps` gains `language?: BoundPromptLanguage`. The four `summary:` literals become a per-language render, so the persisted `pending[].summary` is already in the detection language. This is what makes a pending summary keep its detection language across a restart or a later locale change, and it is why no structured fields are added to the store.

### The drain localizes what it composes at delivery time

`PrWatchDrainDeps` gains `language?: BoundPromptLanguage`. `buildDrainPrompt` takes it and:

- passes `language` to `buildBoundEventPrompt`, which selects the envelope copy;
- indexes `DEFAULT_BOUND_ROLE_GUIDANCE_BY_LANGUAGE[language][role]` instead of the English-only table;
- selects the provenance line from a per-language map.

The summary is passed through unchanged: it was localized where it was authored.

### Absent language means English

Every new field is optional and defaults to `en`. A caller that does not set it — including every existing test — gets today's bytes.

## Files affected

| File                                                              | Change                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/utils/channel-locale.ts` (new)                  | the import-free locale resolver, moved out of the channel runtime                                                                                                                                                                                  |
| `packages/cli/src/commands/channel/runtime.ts` (+ test)           | re-exports the resolver so its two existing importers are unchanged; the resolver table gains trim and uppercase rows                                                                                                                              |
| `packages/cli/src/serve/fast-path-settings.ts`                    | the boot settings surface carries `general.language`; the reader copies a string and drops anything else                                                                                                                                           |
| `packages/cli/src/serve/fast-path.test.ts`                        | six reader cases: the value is carried, a non-string is tolerated without discarding the summary, chatRecording survives alongside it, the workspace-over-user precedence with its trust-on mirror, and the per-key merge of general across scopes |
| `packages/cli/src/serve/run-qwen-serve.ts`                        | resolve the locale at boot and pass it into the sources                                                                                                                                                                                            |
| `packages/cli/src/serve/run-qwen-serve.pr-watch-shutdown.test.ts` | a real serve boot with `general.language: zh` carries the locale into both watch seams                                                                                                                                                             |
| `packages/cli/src/serve/server/pr-watch-deps.ts` (+ test)         | `language` on the sources, carried into both seams                                                                                                                                                                                                 |
| `packages/cli/src/serve/server/pr-watch-observation.ts` (+ test)  | `language` on the tick and sweep deps; per-language summary render                                                                                                                                                                                 |
| `packages/cli/src/serve/server/pr-watch-drain.ts` (+ test)        | `language` on the drain deps; envelope, guidance and provenance selection                                                                                                                                                                          |
| `packages/cli/src/serve/server/pr-watch-drain.scenario.test.ts`   | two end-to-end language scenarios through the real gh child and the real admission                                                                                                                                                                 |
| `packages/cli/src/serve/server/session-pr-refresh.ts` (+ test)    | the listing write carries the language; the two no-deps cases assert their stated effects; stale "switch" wording retired                                                                                                                          |
| `packages/channels/github/src/GithubAdapter.ts` (+ test)          | the deprecation predicate's JSDoc names all four keys; the warning test asserts both limit knobs                                                                                                                                                   |
| `docs/users/configuration/settings.md`                            | the `general.language` row records the prompt-language effect, the match rule and the trust condition; the `serve.sessionPrWatch.events` row points at it and distinguishes a present setting from an absent one                                   |
| `docs/users/features/channels/github.md`                          | the prompt locale is not the rendered UI language; the match rule replaces the shape list; each producer's read point is named                                                                                                                     |
| `docs/design/2026-11-09-bound-event-prompt-language.md` (+ zh-CN) | decision 7 moves to the past tense, the current-state table is calibrated to the shipped tree, and the deferred open question is resolved                                                                                                          |
| `docs/design/2026-11-08-bound-session-role-guidance.md` (+ zh-CN) | the same deferred open question is resolved                                                                                                                                                                                                        |

## Key design decisions

1. **Localize the summary where it is authored, not where it is rendered.** Re-rendering at delivery would need structured fields in the store and would make a pending summary change language when the locale changes. The channel lane makes the same split — it persists the producer-composed `boundText` and composes the envelope at delivery from its startup locale — so this is that lane's rule applied to the daemon's `pending[].summary`, not a narrower one. Detection-time rendering needs no schema change and keeps the summary's language stable.
2. **One locale for both seams.** Resolving it once at boot and carrying it through the shared sources prevents the observation and the drain from disagreeing about the locale within one boot. A summary persisted under an earlier boot's locale is the one part that can differ, by design.
3. **Absent means English, byte-identical.** The fields are optional so no existing caller changes behaviour, and the `en` arm is a regression guard rather than a new code path.
4. **Keys are language-independent.** A transition key is built from identity, type and sha/state, never from the summary, so localizing cannot change idempotency or deduplication.
5. **Structural markers stay English.** The shared contract keeps field labels and the trusted-block label English in every language; this increment does not touch them.

6. **Platform data keeps its bytes; the prose around it localizes.** The shas interpolate unchanged and check names keep the `, ` join in both languages, as the prompt-language design pins. `state_change` localizes too: its `PR …` wrapper is authored prose, not the platform token, so a zh daemon reads `PR 已合并` / `PR 已关闭` while the transition key still uses the raw state pair.
7. **A bad `general.language` is dropped, not thrown.** This is a per-key choice, not a blanket reader policy: the reader throws on malformed values for `general.chatRecording`, `advanced.excludedEnvVars`, `advanced.runtimeOutputDir` and `security.folderTrust.enabled`, plus the legacy top-level `folderTrust` on a legacy-key file where no `security.folderTrust.enabled` was picked — five sites in `pickFastPathSettings`. For this key `resolveChannelLocale` already reads a non-string as English, so dropping the value loses nothing, while throwing would discard the whole summary — taking the permission policy and the PR-watch subscription with it.

## Constraints and risks

- The locale is frozen at boot. An operator who changes `general.language` sees the new language only after a daemon restart, which is the same trade the channel lane already documents — and even then a summary already queued keeps its detection language.
- The locale inherits `general.language`'s scope, and its reach is daemon-wide. It is resolved once at boot from the **bound** workspace's merged settings — the first `--workspace` — so a trusted file there overrides the user scope and re-languages the PR-watch prompts delivered into every hosted workspace, while the same key in any other workspace's file changes nothing. The boot reader's `general.*` values are daemon-wide in general — `general.chatRecording` from the same reader gates session-artifact persistence for the whole daemon — so this is the reader's existing behaviour, not something this increment introduces. This increment documents that source rather than narrowing it: gating the key here would make the daemon disagree with the rest of the repo.
- Entries detected before this change keep their English summary. That is the detection-language rule applied to history, not a defect.
- The summary render is now shared by four transition types. The copy table is a total `Record<BoundPromptLanguage, …>`, so a new language cannot be added without its entries, and an absent language resolves to `en` — neither path can put `undefined` in a prompt.

## Validation plan

- Unit (observation): each of the four transitions renders its zh summary; the `en` render is byte-identical to today; an absent language renders English; the transition key is unchanged between languages.
- Unit (drain): a zh language selects the zh envelope, the zh role guidance and the zh provenance; the summary passes through unchanged; an absent language is byte-identical to today.
- Unit (deps): the sources' language reaches both seams; absent stays absent.
- Unit (boot settings and wiring): the fast-path reader carries `general.language` and drops a non-string without discarding the summary; a workspace value overrides the user scope while folder trust is off, the same value is ignored when trust is on and no rule trusts the folder, and `general` merges per key across the two scopes; a real serve boot with `general.language: zh` and an event subscription carries the resolved locale into both `getPrWatchDeps()` and `getPrDrainDeps()`.
- Unit (refresh): the two no-deps cases assert the effects their names claim by spying the store — neither claims an owner record nor writes a watch file. A fixture cannot seed a file where a deps-less drain would look, because `drainNow` returns at the deps gate before any directory is resolved.
- Unit (adapter): the deprecation warning test asserts `prWatchLimit` as well as `prWatchBudgetReserve`, including a case that sets only `prWatchLimit`.
- Real scenario: the scenario suite drives the shipped observation and drain over a real temporary watch directory, a real gh child and a real admission, with the locale set on the deps, and asserts the delivered prompt text in both languages. The boot path itself is covered by the serve-boot case and the reader cases above; a local full-chain probe run for this increment — a verification probe, not a committed test — additionally drove the shipped resolver and deps builder from a real settings file. A further case flips the locale between detection and delivery and asserts one prompt carrying an English envelope around a Chinese summary.

## Acceptance criteria

1. A zh daemon delivers a bound PR-watch prompt whose envelope, guidance and provenance are Chinese, with English structural markers; a transition it detected under `zh` also carries a Chinese summary.
2. An `en` daemon's delivered prompt is byte-identical to the pre-change output.
3. A pending entry detected under one language keeps that language in its persisted summary when delivered after a locale change; the envelope, role guidance and provenance follow the locale in effect at delivery.
4. No transition key differs between the two languages for the same detection.
5. The two no-deps refresh cases fail when the effect they name is broken, not only when the seam goes unread.
6. The deprecation warning test fails when `prWatchLimit` is dropped from the warning.

## Related

- [Bound-session event prompt language](2026-11-09-bound-event-prompt-language.md) — decision 7 recorded this threading as owed and now points here for its delivery.
- [Daemon PR watch: delivery drain](2026-11-08-daemon-pr-watch-drain.md) — the drain this increment localizes.
- [PR state transitions from the daemon PR refresh](2026-11-04-daemon-pr-state-transitions.md) — the master design.
