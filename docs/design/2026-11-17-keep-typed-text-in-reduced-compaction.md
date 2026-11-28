# Keeping the typed text in a reduced compaction request

[English](2026-11-17-keep-typed-text-in-reduced-compaction.md) | [简体中文](2026-11-17-keep-typed-text-in-reduced-compaction.zh-CN.md)

## Problem

When a compaction request does not fit its window, it is reduced as the [compression request admission](2026-10-19-compression-request-admission.md) design describes: every text part longer than 4,000 characters is cut to its first 4,000. That includes what the user typed. The summary prompt asks the model to quote the user's exact phrasing where intent is at stake and to list all user messages, so a long request, such as a pasted spec or a log with the instruction after it, reaches the summary without everything past its first 4,000 characters.

## Current state before this change

- The reduction cannot tell what a person typed from what rides the same user turn. The layout differs by front end: the CLI puts the prompt first and attachments after it, while ACP puts attachments first and the prompt last. Other text rides user turns too: recalled memory, the IDE context, CLI notices, task notifications, a previous summary and restored files.
- A rule by position (the parts before the first attachment header are typed) was tried in #14953. It misread most of the cases above.
- The CLI front ends already pass `humanInput`, the text a person submitted, with their prompt, for workflow-keyword detection. Ink and OpenTUI set it only for a person's prompt: not for a slash command, a Mod's prompt, shell mode or a `/btw` query. Headless sets it only for a user message sent as stream-json input whose origin is a person; a plain `-p` prompt carries none.

## Goals

- Keep what a person typed in a reduced request, as far as the summary's budget allows: today about 14,000 characters for one message.
- Refuse locally no request the plain reduction would send, and get no request rejected for the text it keeps where the plain reduction would be accepted, at any density up to one token per character.
- Cut text that is not marked as typed exactly as before.

## Non-goals

- Marking every way a person's text reaches a user turn. A plain `-p` prompt, slash-command expansions, scheduled prompts, mid-turn messages, hosted input queued while a turn runs, and hosted prompts a hook rewrote or extended stay unmarked and are cut as before.
- Keeping the end of a long message. A message the budget cannot keep is cut like any other, keeping its start.
- Condensing older turns to the user's messages (#14953).
- The retry after a rejection and the payload-overflow path, which keep sending the plain reduction.

## Design

### The mark

A part that holds what a person typed carries `partMetadata['qwen-code:typed-prompt'] = true`, set where the request is built. `partMetadata` is client-side bookkeeping: the native generator deletes it before the SDK sees it (Vertex AI rejects the field), and the OpenAI, Anthropic and Responses converters never serialize it. On the CLI path the session file keeps it, so a resumed session still has it. ACP and hosted serve record a turn from its unmarked text, so after a resume or a history rebuild their earlier turns are cut as before.

Two checks drop a completed local command's input from resumed history only when its part has a lone `text` key: the history accumulator and its mirror in the serve prompt ledger. Both accept a part whose only metadata is the mark (`isBareTextPart`).

### Where it is set

- **Core, for the CLI front ends.** When `sendMessageStream` receives `humanInput` with a person's prompt, and the prompt is not a Mod's, the first text part of the request is marked. These front ends put the person's text first. A plain `-p` prompt carries no `humanInput`, so it is not marked. Pasted text is sent framed in `<clipboard-paste>` with a line of framing prose after it, and that part is marked whole. A request that already holds a marked part is left as it is. A caller that sends `humanInput` must therefore put the person's text first or mark it itself: ACP, which puts the instruction last and passes `humanInput` on the shared agent loop, marks its own.
- **ACP.** In a prompt a person wrote, the parts built from their text blocks are marked, and so is the instruction part that joins them with pointers to the attached resources. A model-only prompt, a runtime Goal continuation, a mid-turn message, a slash command (including text that starts with a slash but names no command) and a prompt that holds only attachments mark nothing.
- **Hosted.** The prompt the session's user sent, the input memory recall reads, is marked when it reaches the model as written. One a hook rewrote or extended, or that recalled memory was joined to, is left unmarked.

Text spliced into a marked part later inherits the mark. The IDE context is the one text put in front of a marked part after it is marked: `prependToFirstTextPart`, which puts it there, adds the characters it put in front to `partMetadata['qwen-code:typed-prompt-prefix']`, and compaction reads that run as not typed. The session file records the prompt before the IDE context is merged in, so a resumed part has neither. A part with no prefix recorded is typed from its start, so a prompt that opens with a reminder block of its own is kept as typed (#9455 R3-1). The interactive CLI joins its worktree notice and workflow size note into the prompt before it is marked, so they count as typed; each is a few lines, under the cut, so the part is kept the same either way. A recorded prefix the text does not bear out, one that does not end a run of whole envelopes and the whitespace after them, is not trusted, and the run of envelopes leading the text is read as not typed instead.

Core marks a `UserQuery` only, so a retry is not marked on its own. The CLI's Ctrl+Y retry re-sends the prompt as it first sent it, and core first drops the entry the failed send left in history. When that entry held the same text marked, with its recorded prefix set aside, the retry is marked too (`markRetriedPrompt`). The live history then matches the session file, which keeps the failed send's marked record and records no retry. A send that failed before its entry reached history leaves nothing to take the mark from. The four errors raised there (a blocked managed session, a sign-in required, a changed model route, a prompt still too large after the hard-tier compaction) leave the retry unmarked, while a resumed session reads the record, marked.

### Keeping it in a reduced request

`slimCompactionInput(history, modalities, { maxTextChars, keepTypedText: true })` keeps a marked part of a user turn up to `TYPED_TEXT_MAX_CHARS` (32,000 characters). The recorded prefix is cut to `maxTextChars` like other text, and the envelope the cut lands in is closed again. Past 32,000 characters the typed text is cut there, by the rule any cut text follows. Every other part is cut as before. The budget rule below keeps the text well under this cap today, about 14,000 characters at most, so the cap only applies if that budget grows.

### When the kept request is sent

Only on the first send, after the plain reduction made the request smaller. The kept request asks for no more in all than the plain request: its input is larger by the characters it keeps, each counted as a whole token, and its output budget is smaller by as many. It replaces the plain request only when that budget is still at least half of the plain request's, and at least the summary's minimum. If the server rejects it, the one retry sends the plain reduction. If its reply has no output count and its summary no closed `<state_snapshot>`, the truncation check would drop that summary for the smaller budget, so the plain reduction is sent once instead. The payload-overflow path never sends it: its input is the plain cut from the start.

## Decisions and rationale

- **Mark at the source, keep only marked text.** Text with no mark falls back to the plain cut, so a producer that is missed costs the improvement and not correctness. The rule by position failed the other way: it kept text that was not typed.
- **`humanInput` as the gate in core.** The front ends have already decided which sends are a person's prompt, and one place covers three front ends.
- **The first text part, not an exact match with `humanInput`.** The CLI frames pastes and joins notices into the prompt before sending, so an exact match would fail on the main case, a pasted request.
- **A token per character, within the plain request's total.** The estimate reads four characters to a token, and CJK text runs far denser. Counting each kept character as a token and taking it out of the output budget means a request the server accepts in its plain form is accepted with the text kept, at any density up to one token per character. The cost is a smaller output budget when much text is kept.
- **At most half of the summary's budget.** Every token the kept text takes from the output budget is room a long summary may need; a summary longer than the kept budget is dropped as truncated where the plain request would have fit it, and the drop counts toward the failure breaker. Keeping at least half of the plain budget bounds that cost.
- **Head-only cuts.** A message past the cap, or one the budget cannot keep, keeps its start. Eliding the middle would create cut shapes that the closing rule for cut text was never measured on.

## Risks

- Some characters, such as rare CJK characters and emoji, take more than one token. Above one token per character the guarantee does not hold; a kept request the server rejects is retried with the plain cut.
- The summary's output budget shrinks by the characters kept, by at most half. A summary longer than that budget, which the plain request would have fit, is dropped as truncated.
- When the plain request's budget is the 20,000-token cap, keeping more than 10,000 characters beyond the plain cut would take more than half of it, so a request longer than about 14,000 characters is cut as before. In a tighter window the limit is lower.
- A kept request the server rejects is retried with the plain cut. Where the plain request would have been rejected too, the two flows then differ: the plain flow retries with a smaller budget or gives up, and the kept flow sends the plain cut once.
- The text after a marked part's recorded prefix is kept whole as typed. In the CLI that includes the paste-framing prose and a prompt a `UserPromptSubmit` hook rewrote, since `humanInput` follows the rewrite.
- Core marks the first text part, so a caller that sends `humanInput` with another part first, and marks nothing itself, gets that other part marked. Headless mode does this on a first turn that carries a startup-worktree or recovered-agents notice: the notice goes in its own part ahead of the person's text, so the notice is marked and kept as typed, a few lines either way, and that turn's text is cut as before.
- Sessions recorded before this change have no marks, and are cut as before.
- This change does not measure whether keeping the text improves task outcomes.

## Validation

- Unit tests for the mark: its shape, its absence from the request on the native, OpenAI-compatible, Anthropic and Responses routes, its survival through the session file, and the two local-command checks.
- Unit tests for each place it is set, including every exclusion: no `humanInput`, internal send types, a Mod's prompt, a side query, an empty first text part; ACP's model-only prompts, runtime Goal continuations and attachment-only prompts; hosted prompts that are not new user input, were rewritten or extended, or had memory joined.
- Unit tests for `keepTypedText`: a recorded prefix, a run of envelopes in it, one recorded over two prepends, a prompt that opens with a reminder block with and without a prefix, a prefix the text does not bear out, a lone opening tag the person typed, the 32,000-character cap and a block it cuts inside.
- Unit tests for the prefix: `prependToFirstTextPart` records it on a marked part and on no other, and the client sends it on the prompt it merges the IDE context into while the session file records the prompt without it.
- Unit and client tests for the retry: it is marked when a dropped entry marked the same text, with the IDE prefix set aside, and left as it is when nothing was dropped, the dropped text was unmarked or different, the marked entry was not a user entry, or the retry was already marked.
- Service tests: the budget is smaller by exactly the characters kept; the kept request is used at exactly half of the plain budget and not one character past it; the plain cut is sent when the kept request would leave the summary under its minimum, on the retry and on the payload-overflow path; CJK text billed at 2.4 times the estimate is kept without a rejection; a kept reply that counts its output only as total less prompt, carries a closed snapshot, or is only analysis is not followed by the plain cut; and a sweep over 5 session shapes, 6 request lengths and ASCII or CJK text in which, wherever the plain request is accepted in one send, the kept request is too.
- A mutant for each guard, checked to fail its tests: 38 in all.
- A request-level comparison on a mock backend: 5 session shapes, requests of 3,000 to 40,000 characters with 5 sentences spread evenly through each. The sentences that reached the summary request rose from 15, 10 and 10 of 25 to 23, 19 and 16 of 25 at 6,000, 9,000 and 12,000 characters, for ASCII and CJK alike. At 3,000 characters nothing is cut; from 18,000 characters on the kept request is not used.

## Acceptance criteria

- A reduced request keeps a marked request whole whenever the summary is still left half of its budget and its minimum under the rule above: up to about 14,000 characters for one message at the 20,000-token cap. Otherwise it is cut as before.
- Turns with no mark are cut exactly as before.
- No new local refusal, and no rejection caused by the kept text at densities up to one token per character.

## Follow-ups

- Mark the remaining producers: a plain `-p` prompt; slash-command expansions, keeping the files and shell output they inject unmarked; mid-turn messages; hosted input queued while a turn runs.
- Record the mark in ACP's and hosted serve's turn records, so it survives a resume.
- Keep as much of a long message as the budget allows, rather than all of it or none.
- Keep the end of a long message as well as its start.
- Condense older turns to the user's messages when cutting is not enough (#14953).
