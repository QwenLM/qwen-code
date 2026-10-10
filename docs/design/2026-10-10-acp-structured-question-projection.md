# ACP structured question projection for `ask_user_question`

[English](2026-10-10-acp-structured-question-projection.md) | [简体中文](2026-10-10-acp-structured-question-projection.zh-CN.md)

## Status

Implemented. Resolves [#11361](https://github.com/QwenLM/qwen-code/issues/11361).
Supersedes the ACP-level non-goal in
`docs/design/2026-07-25-channel-interaction-presentation-contract.md`.

## Problem

`ask_user_question` is projected onto ACP's `session/request_permission` as a
generic two-button approval. The real per-question choices travel only in a
Qwen-proprietary `_meta.qwenQuestions` key, and ACP instructs conforming clients
to ignore `_meta` values they do not understand. A standard client such as Zed
therefore sees a `title`, `kind: 'think'`, and a raw JSON `rawInput`, which is
the "Raw Input" card reported in #11361.

The gap is not cosmetic. Answers are read back from a top-level `answers`
sibling of `outcome`, but ACP's `RequestPermissionResponse` defines only
`outcome` (`cancelled` | `selected{optionId}`) plus `_meta`. A conforming client
never sends `answers`, so selecting "Submit" yields `userAnswers = {}` and the
tool falls through to `"No valid answers were provided."`. Structured questions
are therefore unanswerable through any ACP host that does not implement Qwen's
private contract.

## Goals

1. A conforming ACP client can render selectable choices for the common shape
   (one question, 2–4 options) and return a valid answer.
2. Qwen-owned surfaces that consume `_meta.qwenQuestions` and the private
   `answers` field (VS Code companion, web shell, Feishu/DingTalk cards, the
   daemon bridge, channel loop) do not regress.
3. Answers are recoverable from the standard ACP response channel, not only
   from a Qwen-proprietary field.
4. Core's `ask_user_question` schema (`Question`, `QuestionOption`,
   `multiSelect`) stays unchanged.

## Non-goals

- Changing Core's question schema or the model-facing tool contract.
- Adding a new ACP JSON-RPC method or modifying the ACP specification itself.
- Capturing free-text "Other" input beyond what a `PermissionOption` can carry.
- Redesigning the daemon's out-of-band answer re-injection.

## Design

Four cooperating changes.

### 1. Always project question text into `toolCall.content`

`buildPermissionRequestContent` gains an `ask_user_question` branch that emits
one `text` block per question: the `header`, the full `question`, and each
option's `label` + `description`. This is strictly additive and is the correct
fallback for shapes the option layer cannot represent. Any client — including
Zed — renders readable questions instead of a raw JSON dump. It does not by
itself let the user select an option.

### 2. Capability-gated option flattening

For clients that do **not** advertise Qwen structured-question support,
`toPermissionOptions` emits real per-choice `PermissionOption`s instead of
`Submit`/`Cancel`:

- **Single question.** One option per choice, `name` = `option.label`,
  `kind: 'allow_once'`. Append one synthetic `Other…` option
  (`kind: 'allow_once'`) and keep `Cancel` (`kind: 'reject_once'`).
- **`optionId` encoding.** Each option carries an opaque id that encodes the
  question index and the choice index, e.g. `ask:q0:o2`, plus `ask:q0:other` for
  the synthetic choice. The label is recoverable from the request, so the id
  only needs to be a stable token.
- **Multi-question (2–4).** ACP has no multi-form primitive, and interleaving
  choices from different questions in one select is ambiguous. Multi-question
  requests therefore keep the generic `Submit`/`Cancel` pair and rely on the
  content projection plus `_meta` — a documented limitation until a
  sequential-request shape is validated.
- **`multiSelect: true`.** ACP is single-select. A lone multi-select question
  degrades to single-select over the option set plus `Other…`, and the
  limitation is documented.

For clients that **do** advertise support, the rich path is preserved:
`_meta.qwenInteractionKind = 'user_question'` + `_meta.qwenQuestions`, and the
private `answers` response field continues to work.

### 3. Capability negotiation

The agent reads a vendor `_meta` key on the client's `initialize` capabilities,
`clientCapabilities._meta['qwen.askUserQuestion'] === true`, mirroring the
existing `qwen.goalProposals` flag. The flag is stored on the per-session
`Config` (`setAskUserQuestionHostSupported` / `getAskUserQuestionHostSupported`)
so the session layer can read it. Absence means "flatten".

In-repo Qwen surfaces advertise the key during `initialize`: the daemon/channel
bridge handshake, the VS Code companion, the channel-loop ACP bridge, and the
Qwen Live voice client. Qwen Live advertises it not because it renders the rich
payload but because its vote is only allow/cancel and it picks the
least-escalating proceed option — flat per-choice options would silently record
the first choice, so it keeps the generic pair.

### 4. Answer recovery

`resolvePermissionOutcome` currently rejects any `optionId` that is not a member
of `ToolConfirmationOutcome`. A flattened `ask:q0:o2` id is offered but is not a
`ToolConfirmationOutcome`, so it fails that check. The design introduces an
`ask_user_question`-specific path:

1. Validate the selected id against the **offered set** only.
2. For `ask_user_question` confirmations, an id that parses as
   `ask:q<questionIndex>:<choiceToken>` resolves to `ProceedOnce`.
3. `resolveAskUserQuestionAnswers` parses the id back into
   `{ [questionIndex]: selectedLabel }` and hands that to the tool as
   `payload.answers`.

The existing enum check remains for every other confirmation type. Answers are
taken from the private top-level `answers` sibling when present, then from an
opt-in `_meta.qwenAnswers`, then reconstructed from the selected option id.

## Design decisions

1. **Capability key and handshake.** A vendor `_meta` key on `initialize`
   (`qwen.askUserQuestion`) is sufficient and consistent with
   `qwen.goalProposals`. No first-class `clientCapabilities` field is added.
2. **Sequential permission requests for multi-question.** Not implemented. No
   real ACP client is verified to accept more than one
   `session/request_permission` for the same `toolCall`, so multi-question stays
   content-only on standard clients.
3. **`multiSelect` semantics.** A lone multi-select question degrades to
   single-select; the answer carries one selected label.
4. **`Other…` answer encoding.** Selecting `Other…` returns the sentinel
   `'(Other)'` so the model can distinguish "the user wanted something else"
   from a concrete choice.
5. **Answer key vs. index.** Flattened answers are keyed by the question index
   as a string (`'0'`), matching Core's existing `parseAnswerQuestionIndex`.

## Compatibility and rollout

- **Capability-gated.** Flattening is enabled only when the client does not
  advertise `qwen.askUserQuestion`. Qwen-owned surfaces keep the current payload
  byte-for-byte.
- **Content projection is always on.** It is additive; a Qwen surface that
  renders its own question card from `_meta` ignores the extra text block.
- **Docs.** The limitation and the capability contract are recorded here and in
  `docs/users/integration-zed.md` and `packages/zed-extension/README.md`.

## Validation

- Unit tests on `toPermissionOptions` for `ask_user_question`: single-select
  flattening produces one option per choice + `Other…` + `Cancel`; the
  capability-on case preserves `Submit`/`Cancel`; multi-question does not
  flatten.
- Unit tests on `resolveAskUserQuestionAnswers` and `resolvePermissionOutcome`:
  an offered `ask:q0:o1` resolves to the correct `answers` entry; an encoded id
  without the flag still throws; an unoffered id still throws.
- `buildPermissionRequestContent` test asserting question text and choices
  appear for `ask_user_question`.
- A Session test driving `requestPermission` with an encoded option id and
  asserting the recovered `answers`; an acpAgent test asserting
  `setAskUserQuestionHostSupported` is called only when the capability is
  advertised.

## Open questions

- **Multi-question on standard clients.** Whether a future phase can issue
  sequential `session/request_permission` calls, one per question, reusing the
  same `toolCall`, is still unvalidated against Zed and the VS Code companion.
- **`multiSelect` fidelity.** A future phase could issue one yes/no confirmation
  per option instead of degrading to single-select.

## References

- Issue [#11361](https://github.com/QwenLM/qwen-code/issues/11361) and its
  triage root-cause walk.
- `packages/cli/src/acp-integration/session/permissionUtils.ts` —
  `toPermissionOptions`, `resolvePermissionOutcome`,
  `buildPermissionRequestContent`, `interactionMetaFields`.
- `packages/cli/src/acp-integration/session/Session.ts` — permission parameter
  construction and answer read-back.
- `packages/core/src/tools/askUserQuestion.ts` — `getConfirmationDetails`,
  `onConfirm`, answer formatting.
- Precedents: `docs/design/2026-08-25-acp-workspace-event-capability.md`,
  `docs/design/2026-08-05-feishu-ask-user-question-cards.md`,
  `docs/design/2026-09-09-web-shell-question-message.md`.
