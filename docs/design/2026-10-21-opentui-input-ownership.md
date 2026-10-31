# OpenTUI composer attachment and submission ownership

[English](2026-10-21-opentui-input-ownership.md) |
[简体中文](2026-10-21-opentui-input-ownership.zh-CN.md)

Current delivery (2026-10-21): this work is consolidated with input ownership,
editing and status lines in [#14964](https://github.com/QwenLM/qwen-code/pull/14964).
The original batch boundaries, source bases, validation results and stack-promotion
steps below are historical. Follow the [delivery plan](2026-10-20-opentui-migration-delivery.md)
for the active sequence. Combined acceptance requires fresh results for the
integrated commit and is still pending.

Status: U2A is implemented and locally accepted after baseline reproduction.
Base is U1
`69ffa32d46a1283fb1f1dc224e105275c1ebe493`; branch
`codex/opentui-input-ownership` depends on `codex/opentui-dialog-acceptance`
because it reuses U1's real product renderer/runtime fixture. This is one complete
input transaction, including its recovery and regression tests.

## Problem and scope

At the base commit, OpenTUI clears text and attachments before its asynchronous
command gateway acknowledges them. Late clipboard results can enter the next
draft, overlapping pastes can reverse image order, and the string-only live queue
drops images. Ctrl+Q is advertised without a production input consumer. The
independent baseline reproduced six component/hook failures with two passing
controls; native and product evidence are separate.

Cover paste, attachment selection/removal, admission, rejection, steering,
deferral, pop-back, cancellation and continued editing. Reuse the native textarea,
React refs, existing command/shell/model queues, clipboard utilities and core media
policy. Do not add a state framework, queue service, dependency or runtime change.
Vim, general editing/history search, external editor, voice, IME and accessibility
remain separately tracked; this delivery does not claim complete input parity.
Global Ctrl+C and exit-handler ordering are not accepted in this batch. U2B
will establish a product baseline against current Ink; this delivery does not
claim to fix or fully align cancellation and exit keys.

## Integration with main input provenance

The [clipboard/source lifecycle batch](2026-10-24-opentui-clipboard-source-lifetime.md) extends this existing ownership transaction with shared Ink model framing, raw human text, Linux offered-text fallback and source-aware joined queue restoration. A pending text paste keeps the claimed draft's captured map while the successor receives a distinct map. The batch remains under implementation and has separate candidate verification; earlier results below are historical.

The normal merge with fixed main `8545558a25db342683cb84a6814e591c6fcf6c67`
retains #14876's workflow opt-out, human-input descriptor, display/recall split
and paste expansion snapshots. Metadata travels with the existing structured
submission through the composer, shell deferral, live queue and cancellation
restore; there is no second queue or ambient popped-text fallback. Claim text,
source and paste maps before waiting for images. A successor draft cannot change
that snapshot. Unchanged mixed restores retain only the original known human
members; editing unknown-source text does not grant human origin. Queue return
preserves images and renames colliding placeholders using the existing helper.

Session rotation invalidates pending images, claimed admissions and cancellation
callbacks. A mounted editor retains synchronous visible text, paste mappings and
unknown-source eligibility, as main's regression cases require. A reset settlement
only clears the cancellation latch: it cannot pop queues or restore old content.
Fresh combined validation is pending; previous branch results do not cover this
merge. Keep both parents' regression cases and add pending-image/successor,
rejected-admission and session-rotation source checks before accepting it.

## Baseline decisions

Real Node+Ink and Bun+Ink PTYs on the exact U1 artifact established:

| Input                                 | U2A decision                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ctrl+Q idle / streaming               | Admit once immediately when idle; otherwise defer until turn end, excluding tool-boundary steering.                                                                                                     |
| Image-only Enter                      | Keep Ink's no-op and retain chips.                                                                                                                                                                      |
| Image plus `/help`                    | Send to the model, preserving the observed Ink route. Completion submit-on-accept shares that route; its Ink linkage is source evidence.                                                                |
| Image plus shell mode                 | Reject and retain the draft. Ink attempts to execute the prefixed image path; this witnessed defect is an explicit exception.                                                                           |
| Valid plus missing pasted image paths | Promote only if every copy succeeds; otherwise retain the entire original text, attach no partial set and report failure. Ink silently loses the missing token; this is the second witnessed exception. |

Ink's existing `@` image overview transforms the 69-byte PNG fixture into a stable
268-byte JPEG. OpenTUI's structured route preserves its PNG. Check the expected
hash, MIME and length for each route; do not change media policy to force equal
wire encodings. The global 0.23.0 dry-run is historical comparison only.

## Admission and draft ownership

Enter, Ctrl+Q and completion submit-on-accept share one transaction. Read live
native text, expand placeholders, capture images and raw submitted provenance,
and claim synchronously before any await. Repeated activation cannot claim the
same draft. A boolean acknowledgement means that the command dispatcher, shell
queue, live queue or turn has taken ownership, not that the model has responded.
Missing wiring, gateway rejection, a thrown admission error or attachment read
failure cannot acknowledge success.

Clear the claimed editor draft immediately so later typing has a separate owner.
Keep the snapshot until acknowledgement. On rejection restore expanded text and
images ahead of later input, using the existing blank-line aggregation convention.
Keep a restored display placeholder paired with its captured expansion map.
Preserve provenance for an unchanged retry,
and recompute it when combined or edited. Release the claim in `finally`.
Completion/chip reset affects the claimed draft only. Session rotation or unmount
invalidates late restoration and paste completion.

Attachment refs are synchronous payload owners; React state renders them. Each
async paste captures its draft before awaiting. Backend work may overlap, but
results apply in arrival order. Submission waits for already-claimed pastes;
subsequent typing/pastes belong to its successor. After Enter claims a draft,
Ctrl+C clears only that editable successor; it does not cancel the claimed
submission while its paste/admission is pending. A cleared/disposed owner ignores
late results. Pure image paths are classified before large-paste collapsing and
copied into the existing owned clipboard directory. Mixed text remains text.
Clipboard unavailability uses the existing translated callback once; an ordinary
text clipboard stays silent. Errors remain visible.

Up from the first composer row selects a chip; Left/Right move selection;
Delete/Backspace remove; Down/Enter/Escape return to editing. Deleting the final
chip exits selection. Other keys exit selection and continue normal input dispatch,
including typing and Ctrl+Q. Queue restoration
returns both text and images. The early-input get/set handle remains compatible.

## Queue and delivery ownership

The existing live queue holds structured submissions: text, image paths, raw
provenance and `deferUntilIdle`. Its private payload retains admitted image bytes
and generated content/options. Read images before admission and reject the entire
draft if any read/format fails. Accepted queue payloads do not depend on later
source-file mutation. Visible rows remain a text projection and count submissions.
Generated prompts keep their invocation echo and per-turn options and defer rather
than entering steering that cannot apply those options.

| Boundary                         | Required result                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter while a turn runs          | Queue one steerable submission with its full image payload.                                                                                                                                    |
| Tool boundary                    | Drain eligible entries in order; leave Ctrl+Q/generated entries queued.                                                                                                                        |
| Abort during steering resolution | Restore the original structured batch once ahead of later arrivals.                                                                                                                            |
| Continuation settlement          | Use core's existing `SteerInput` ownership callbacks; commit echoes/recordings only on acceptance and restore on rejection. An arbitrary first stream event is not a delivery acknowledgement. |
| Turn end                         | Existing follow-on drain admits the next entry, including deferred submissions.                                                                                                                |
| Pop-back                         | Remove and return composer entries with images/provenance; generated payloads retain their execution owner.                                                                                    |
| Session reset/quit               | Invalidate old work and discard closing-session queues.                                                                                                                                        |

Core acceptance here means this request has taken ownership in chat history, not
HTTP success or a model response. Respect that callback even when a later stream
event reports an error; never infer ownership from the event type. The sole
live-turn caller supplies its current generation predicate: a late accept from a
reset/unmounted turn cannot write a successor recording or echo. A same-generation
interrupt does not revoke history that core already accepted.

The shell deferred queue keeps its existing command ordering and shell-intent tag.
Image-bearing plain prompts blocked behind shell execution retain options and
images. If the later live owner rejects, leave the entry available for pop-back
and retry instead of dropping it or creating an automatic retry loop.

Fresh and steered typed `@` references resolve before the existing vision bridge
without discarding accompanying image Parts. Existing explicit `@` read
decline/timeout and vision-bridge null outcomes still report their notice and
consume the submission, matching Ink; they do not create a parked retry queue.
Their failure cards/notices publish on completed resolution even if core later
restores the valid entries in that batch; successful cards/echoes wait for accept.
Thus this delivery does not promise retention for every pre-send refusal. Core
media limits, oversize notices and provider contracts remain unchanged.

## Production changes and consumers

| Seam                     | Producers and all affected consumers                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission result/options | Input Enter/completion/Ctrl+Q → app-shell gateway → unchanged start forwarding → live-turn submit; shell deferred prompt drain also consumes the result.                          |
| Structured payload       | `input-submission.ts`; composer restore; live-turn push/drain/restore/pop/reset/follow-on; live-session resolution and continuation ownership; shell pop-back/display projection. |
| Paste/chips              | Input clipboard/path handlers, selection/removal, raw Backspace, placeholder expansion and disposal. The pure path classifier is shared with Ink without changing Ink behavior.   |
| Presentation/session     | Existing queue display/footer count, input queueLength, session rotation and early-input injection; every new field has an actual producer and consumer.                          |
| Regression               | Existing input/app-shell/live-turn/live-session suites; real native input script; U1's PTY/xterm and localhost fake-model infrastructure; existing three-leg CI loop.             |

Do not introduce a live-session → live-turn import cycle. Review overlap with
#14287 (busy admission), #14172/#6829 (clipboard), #7957 (Windows paths) and
#12227 (Ink activity). Do not import #13606's broader provider/media architecture
or #12228's Vim work. Rebase on U1's merged result before promoting the stacked PR.

## Validation and completion

Use isolated HOME/QWEN_HOME/runtime/workspace and a local fake model; never modify
the user's clipboard or contact a paid provider. Controlled component promises
prove ordering but are not native/OS clipboard E2E. Native tests use the actual
textarea/input decoder and label injected clipboard backends. Product tests use
real path paste and inspect HTTP payloads. Missing native assets or fallback is
not PASS.

Cover rejection/throw plus later typing, same-batch CJK/emoji+Enter, two pastes
finishing in reverse order, clear/unmount/session reset, image-only no-op, chip
keys, Ctrl+Q versus steering, queued images, pop-back, mixed `@`+image success and
explicit decline, partial path copy, and continuation accept/restore exactly once.
Check 100×30, 80×12, 40×10 and resize/restore; assert count, order, MIME, decoded
length and expected hash, not merely an image field or screenshot.

Before completion run build/typecheck, focused unit suites, native regression,
and Node+Ink/Bun+Ink/Bun+strict OpenTUI product legs on the final artifact. Record
source/bundle/fixture/runtime identity, raw inputs, viewports, requests and cleanup
outcomes under `.qwen/e2e-tests/`. Inspect the whole diff and challenge each oracle
in two consecutive clean self-audits after fixes. The parent coordinates one heavy
operation lease. macOS results do not establish Linux/Windows clipboard or IME
coverage; retain those cells in the broader migration inventory.

Local acceptance on macOS arm64 passed full build/typecheck, 313 focused cases
and four existing classifier cases, the pinned native regression, and six formal
product tests across Node 24.19.0+Ink / Bun 1.3.14+Ink / Bun 1.3.14+strict OpenTUI.
Independent acceptance passed 24 ownership cases, nine native cases and 14 product
scenarios; four witnessed Ink exception cells remain explicit skips. Its corrected
image scenario verifies typed file expansion plus two distinct images through
Enter steering and Ctrl+Q deferral against each route's idle byte oracle.

The independent before/after snapshot matched all 17 source files and 1,453 built
files; all 17 PTY invocations, including retained failed fixture attempts, completed
cleanup. Original fixture failures remain evidence: held-stream idle quiescence,
a clipped Ink title colon and Enter being consumed by active path completion.
Only fixture assumptions changed; product source and bundle stayed frozen. Two
clean full-diff self-audits and the independent review are recorded with the
candidate manifest and raw reports under `.qwen/`. These local results do not
replace the remaining platform gates or establish complete Ink parity.
