# Generated UI copy and download

[English](generated-ui-copy-download.md) | [简体中文](generated-ui-copy-download.zh-CN.md)

Status: in progress. Step 1 (card runtime and host) is implemented by the PR
that adds this document. Step 2 (skill and evaluation) is not implemented yet.

## Problem

A Generated UI card cannot hand its current result to the user outside the
card. Its JavaScript runs in a QuickJS Worker without DOM, clipboard or
download access, and the view frame's sandbox allows neither. The #14019
acceptance evaluation (#16811) fails two checks for this reason, with both the
reference documents and the gating model:

- `bill.copies-current`: copying the bill splitter's current split puts
  nothing on the clipboard.
- `comparator.exports-current-csv`: exporting the comparator's current plans
  starts no download.

The plan in #14019 assigns both to stage 8: the host performs copy and
download for the card. This document covers that first half of stage 8. Card
revisions, the other half, follow separately.

## Goals and non-goals

Goals:

- A card can copy text and download a small text file from a click handler,
  using the values of that click.
- The host, not generated code, performs the effect, validates what it is
  given, and shows the outcome outside the card.
- Copy still works when the browser refuses a delayed clipboard write.

Non-goals:

- Reading the clipboard, binary or linked downloads, and file pickers.
- Copy or download for MCP Apps other than the bundled Generated UI card.
- Effects without a click, such as a copy at initialization or on input.
- Telling the model what was copied or downloaded.

## Card API

```js
ui.copy(text);
ui.download(filename, mimeType, text);
```

- `text` is a non-empty string: at most 16 KiB of UTF-8 for `ui.copy` and
  64 KiB for `ui.download`.
- `mimeType` is one of `text/csv`, `text/plain`, `application/json` and
  `text/markdown`.
- `filename` is a non-empty string of at most 100 characters. The host
  sanitizes it and sets the extension from the MIME type (`.csv`, `.txt`,
  `.json`, `.md`).
- Both return `undefined`. The host shows the outcome; the card cannot read
  it.

The guest rejects a call it can already tell is invalid, with an error the
card can catch, like `ui.state.set`:

- a wrong type, an empty value or an unsupported MIME type throws a
  `TypeError`;
- a value over its size limit throws a `RangeError`;
- a call outside a round that handles a `click` event, or a second effect in
  the same round, throws an `Error`.

A call during initialization therefore throws. Uncaught, it ends the
activation, and the server's pre-display check reports it as a `VIEW_ERROR`.

## Which rounds perform an effect

The App performs a round's effect only when all of these hold:

1. The App's own in-flight request for that round is an event of type
   `click`. The Worker's response cannot change this.
2. The round's patches applied. A round with no patches applies too, which is
   the usual case for a copy or export button.
3. The round was dispatched with the current input revision, so the display
   and the effect both use the values the user sees. This is the condition the
   App already uses to report an update as applied.

Otherwise the App drops the effect and shows its own notice that nothing was
copied or downloaded because the values changed, and that a new click will
retry. This differs from saved state on purpose. State is saved for every
validated round, superseded ones included, because the Worker's data has
already changed. A copy or export of values the user no longer sees is wrong.

## Wire contract

The Worker's round result gains one optional field:

```ts
effect?:
  | { kind: 'copy'; text: string }
  | { kind: 'download'; filename: string; mimeType: string; text: string };
```

The App sends an accepted effect to the host:

- **Copy:** the private request `qwen-code/generated-ui-copy/write` with
  `{ text }`. The host advertises it as the experimental capability
  `qwen-code/generated-ui-copy`.
- **Download:** the standard MCP Apps request `ui/download-file` with exactly
  one embedded resource `{ uri: "file:///<filename>", mimeType, text }`. The
  host advertises `downloadFile` only to the bundled Generated UI card.

Like view state, neither request names a card: the host answers for the card
it mounted. When the host lacks the capability, the App shows a notice that
this host cannot copy or download, and the guest call still does not throw.

## Host behavior

Web Shell validates every request itself and does not rely on the App's
checks. It refuses a request when:

- the card is not the bundled Generated UI card, the page is the static
  transcript view, the card is hidden or unmounted, or another effect of the
  card is still being performed;
- the download carries anything other than one embedded text resource, such
  as a `resource_link` or a `blob`;
- a size or MIME rule above is broken.

Unmounting aborts a pending request.

**Copy.** The host calls `navigator.clipboard.writeText` in the Web Shell
page. The click in the view frame gives the page transient activation, which
browsers propagate to ancestor frames. When the write is refused, for example
because the activation expired while the round was queued, the bar keeps the
text and shows a host-owned **Copy** button. A click on it copies from the bar's
own click. The kept text is discarded on the next effect, on reset, on reopen
and on unmount.

**Download.** The host builds a `Blob` of the text, clicks a temporary link
with the sanitized filename, and revokes the object URL afterwards. The browser
may still ask or block, so the outcome says the download started, not that the
file was saved.

**Outcome.** The bar shows each outcome in a `role="status"` element. Its
`data-generated-ui-effect` attribute is one of `copied`, `copy-pending`
(waiting for the bar's Copy button), `downloaded` and `refused`. A
`data-generated-ui-effect-count` attribute increases with every outcome,
including one from the bar's Copy button, so a repeated outcome, such as two
`copied` in a row, is still a new observation. The save status keeps its own
`data-generated-ui-save` attribute.
The bar now renders whenever a card has an effect outcome, not only when it is
retained or saves state, and the host installs its request handler for the
bundled card whether or not it has a card id.

## Limits

| Limit                      | Value                                                         |
| -------------------------- | ------------------------------------------------------------- |
| Copied text                | 16 KiB UTF-8                                                  |
| Downloaded text            | 64 KiB UTF-8                                                  |
| Filename                   | 100 characters before sanitizing                              |
| MIME types                 | `text/csv`, `text/plain`, `application/json`, `text/markdown` |
| Effects per round          | 1, from a `click` round only                                  |
| Effects in flight per card | 1                                                             |

## Rollout

1. **Runtime and host** (this PR): `ui.copy` and `ui.download` in the guest,
   the `effect` round field, the App's round rule, notices and requests, and
   Web Shell's validation, copy, download, fallback button and outcome
   attributes, in every locale.
2. **Skill and evaluation:** teach both calls in the Generated UI skill and
   tool description, give the reference bill splitter and comparator a copy and
   an export through them, and flip `bill.copies-current` and
   `comparator.exports-current-csv` to pass.

## Risks

- **Clipboard overwrite.** Generated code can replace the user's clipboard.
  Only a click can do so, once per click, with text the user's own values
  produced, and the host shows every outcome.
- **Unwanted downloads.** One per click, text only, size capped, with a
  forced extension so a file cannot pose as an executable.
- **Activation timing.** In a local experiment with three origins and the
  same frame nesting, WebKit allowed a clipboard write after a click with a
  300 ms relay delay and refused it after 1.2 s or without a click. A queued
  click can therefore lose the activation; the bar's Copy button covers that.
  Headless Chromium refused writes without a granted permission, so its
  activation rule was not measured; downloads started in both engines without
  a click.
- **Other hosts.** A host without either capability shows the App's notice
  instead; MCP hosts that implement `ui/download-file` but not the private copy
  request get download only.

## Validation

Step 1:

- Runtime tests: argument errors are catchable, a call outside a `click` round
  or a second effect throws, and the round result carries the effect.
- Server check tests: an uncaught call at initialization is a `VIEW_ERROR`.
- App tests: an effect is sent only for an applied click round on the current
  input revision; superseded and outdated rounds show the notice; a host
  without the capability shows the unavailable notice.
- Host tests: every refusal above, copy success, the fallback button after a
  refused write, the download link and filename, the increasing count, the
  refusal for hidden cards and in the transcript view.
- A browser check on a real daemon in Chromium: a hand-written card copies
  its current value and downloads a CSV with the sanitized name, each outcome
  raises the count, and with the clipboard permission revoked the refused write
  offers the bar's Copy button, which copies once the write is allowed. WebKit
  is covered by the activation experiment above: in a WebKit page on the real
  daemon, Playwright input reached neither the view nor the App, which is
  unrelated to this change.

Step 2:

- Replay: `bill.copies-current` and `comparator.exports-current-csv` pass and
  every other pin is unchanged.
- A live run of the bill splitter and comparator cases with the gating model,
  reported in the PR.

## Acceptance criteria

- A click handler can copy its current text and download a small text file in
  Web Shell, and the host shows the outcome outside the card.
- Initialization, input and change handlers, superseded or outdated rounds,
  hidden cards, other MCP Apps and the transcript view cannot trigger either
  effect.
- A refused clipboard write leaves a working Copy button in the bar.
- After step 2, both acceptance checks pass in replay and in a live run.
