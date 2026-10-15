# Folding oversized pasted text into an attachment

[English](web-shell-paste-as-attachment.md) | [简体中文](web-shell-paste-as-attachment.zh-CN.md)

## Problem

The Web Shell composer intercepts pasted images and files, but never text. A
paste that carries `text/plain` falls through to the editor and is inserted
inline at any size, so a long paste becomes a wall of text in the input box: the
user cannot review or edit it, and their own words are pushed out of view.

Three limits make oversized inline text fail later with nothing said at paste
time. The daemon rejects a prompt body above 10 MB, so the send fails outright.
A mid-turn insertion carries at most 16,384 characters, so a long queued prompt
cannot be inserted into the running turn. The per-session draft keeps only text,
and its storage failures are swallowed, so an oversized paste silently stops
being restorable across a reload.

Folding does not reduce what the model sees. An uploaded attachment is resolved
back into prompt text before the turn is built, so the content reaches the model
either way. The gain is in composing and transport, not in context.

## Behavior

A paste is folded into an attachment card when the pasted fragment alone is at
least 200 lines or at least 8,000 characters, and its UTF-8 size is within the
attachment upload limit. Shorter pastes are inserted inline exactly as today.
The two conditions are measured on the pasted fragment, not on the resulting
draft: characters are counted as string length and lines as newline count plus
one.

Two states keep a paste inline whatever its size: a disabled composer, and a
shell command being composed. Neither has a prompt to attach to — shell mode
in particular would silently drop the `!` prefix and send the script to the
model instead of running it — so both behave exactly as they do today. A host
with attachments turned off is a third exemption, for the same reason: there is
no card to fold into.

The 8,000-character condition is deliberate rather than incidental. A fragment
left inline stays under the 16,384-character mid-turn insertion limit, so it can
still be inserted into a running turn. That limit bounds one queued message, not
the draft as a whole — several sub-threshold pastes, or one plus typing, can
still exceed it — so the guarantee is about the fragment, and the wording here
says no more than that. The line condition is what makes the rule legible to a
user ("two hundred lines is too long"); the character condition is the floor
that keeps it honest, since a single minified line can carry megabytes.

A paste above the attachment upload limit is not folded, because an attachment
that large cannot be sent: folding it would turn a payload the shell accepts
today into one that fails at send time. The ceiling is the same one the dropped
file path already applies, so a paste and a file of identical size now fail the
same way — by staying inline rather than by becoming a card that cannot upload.

The card is the existing attachment chip, widened for text and rendered
alongside pasted images and files above the input box. It is titled by the
beginning of the paste itself — line breaks and runs of whitespace collapse to
single spaces, characters a file name cannot carry become spaces too, and the
result is clipped short — because that title is also the attachment's name, and
a paste whose first line is one word still gets a title that reads. The card's
one action leads the second line and the size follows it: **Show inline**.
Choosing that action removes the card and inserts the full text at the caret as
a single undoable edit on the CodeMirror editor; the card does not come back.
Submitting without choosing it sends the content as an attachment. The card also
keeps the existing attachment preview (on its title) and removal.

Content stays in the user's control: the card is a default, not a decision made
for them, and the text is one click away in either direction of the submit.

A paste that replaces selected text stays inline to preserve replacement and undo behavior. Command detection checks both the existing and resulting draft: shell (`!`) and slash (`/`) commands stay inline, whether pasted in full, given pasted arguments, or preceded by pasted text, so folding cannot change command routing or discard arguments. A folded card also outranks a pending follow-up suggestion: folding leaves the draft empty, which is the state a suggestion is submitted from, so the paste is what submitting sends. Expanding a card is isolated from adjacent CodeMirror undo steps.

## Design

Folding produces an ordinary pasted file: name, media type, and text, placed in
the same attachment list that pasted images and files already use. Chip
rendering, removal, preview, upload at submit, rollback on failure, and the
optimistic user-message echo are existing behavior and are reused unchanged; the
wire format is untouched.

A folded paste is named after its own title, with a `.txt` extension and the
`text/plain` media type, so the message that goes out shows the string the card
showed. The suffix is load-bearing rather than cosmetic: the bridge re-derives a
stored attachment's type from its stored name, so a name without it resolves the
content as an opaque blob instead of text. The title is built to survive the
attachment-name sanitizer for the same reason — a character a file name cannot
carry becomes a space, and an astral character the title window cuts in half is
dropped, because the attachment token carries the name through
`encodeURIComponent`.

Text-drop is deliberately not covered. A drag that carries text from inside the
composer is indistinguishable from one that carries text from another window,
and folding the former would leave the original text in place and add a card for
a copy of it. Paste is the gesture this increment promises.

Only a paste aimed at the composer's editor is folded. The handlers that carry
this rule sit on the composer surface, which also contains controls that take
text of their own — the history search box today, a host-provided footer
tomorrow — and those must keep receiving their own pastes.

When a clipboard carries both text and an image, text keeps today's precedence:
the text is folded (or inserted) and the image is not ingested. The fold never
changes which representation wins.

These thresholds are deliberately larger than the terminal UI's own large-paste
thresholds, which fold a paste into a text placeholder inside a single-line
prompt. The two surfaces optimize different things and neither can import the
other's module, so each owns its numbers; the divergence is recorded here so a
future tuning pass does not read it as drift.

There is no daemon capability gate. Every daemon the Web Shell talks to today
serves attachment upload, and a gate would add a branch that cannot be exercised
by any supported deployment. The accepted consequence is recorded under Risks.

### Retention and the draft

What happens to folded content depends on how far the user got, and only the
middle case needs code.

Once a prompt is submitted, the attachment is already uploaded and stored by the
daemon, so a reload or a session re-entry recovers it from the daemon side.

If a send fails or is rejected, the existing restore path returns the prompt
content to the input box and keeps the attachment on the failed message row for
retry. A folded card is the same kind of object and inherits both behaviors.

Before a send, the card lives in composer memory exactly as pasted images and
files do today. This increment does not add persistent storage for the text:
the per-session draft is text-only, and durable attachment storage exists on the
daemon side already.

Nothing guards an unsubmitted card against a reload, and an inline paste of the
same size used to survive one through the composer draft — so for a paste up to
the draft's quota this is a real reduction in recoverability, not only an
edge case for oversized input. A `beforeunload` confirmation was considered and
rejected: it would fire for every unsubmitted attachment rather than for folded
pastes alone, and the shell has programmatic reload paths of its own that such a
prompt can interrupt. The loss stays bounded because the content was pasted and
is usually still on the clipboard, and because a reload only discards an unsent
draft — never content the daemon already holds.

Showing the card's text in the editor must not re-encode or re-upload anything:
the card and the expanded text share one in-memory copy.

## Scope and non-goals

In scope: the fold predicate and its two thresholds, the card's title and size
display, and the one action that moves content into the editor.

Not in scope: folding for a text drag; persistent storage for unsubmitted folded
text; a reload guard; content-hash deduplication of repeated pastes; extension
sniffing; folding for pasted text inside other dialogs (a scheduled-task prompt
keeps its own editor and its own limits); and changes to the mid-turn insertion
route.

The mid-turn insertion affordance is unchanged. A queued prompt that carries an
attachment already hides Insert, so a folded paste simply removes that
affordance instead of failing when the user presses it. Teaching insertion to
carry attachments is a separate increment, and it must also address the
child-side 100,000-character resource limit, which drops an oversized inserted
resource silently.

## Risks

- **No capability gate.** On a daemon without attachment upload, sending a
  folded paste fails instead of degrading. Accepted deliberately: no supported
  deployment is in that state, and an unreachable branch is worse than a
  documented one.
- **Folded text is session-scoped.** The attachment lives with the session and
  is released with it, so a restored conversation shows the attachment token
  rather than the body. Inline text does not have this property, which is why
  the one-way move into the editor has to stay prominent and cheap.
- **No context saving.** Both forms reach the model. A user expecting the fold
  to protect the context window will be surprised.
- **Threshold perception.** A dense 150-line paste folds at the character
  condition even though it is under the line condition. The card's
  content-derived title and its size keep that legible: the title names what was
  folded, and the size says how much.
- **An unsubmitted card does not survive a reload.** The composer keeps it in
  memory, like a pasted image or file, and nothing warns before the reload
  discards it.
- **An undo after showing the text discards the paste.** The card is already
  gone when the text is inserted, so undoing that one edit leaves the content in
  neither place. The alternative — tracking the insert so an undo restores the
  card — is machinery this increment does not pay for; the content came from the
  clipboard, and pasting again costs one gesture.
- **The single-undo promise covers the editor backend only.** On the touch
  textarea the insert is an ordinary controlled-value write with no app-level
  undo step, and the native stack's behavior there was not verified. The card is
  removed either way, so the paste can end up in neither place.
- **A shell command submit discards the card.** A card folded in chat mode
  survives into shell mode, and the shell path carries no attachments, so
  submitting a command clears the card without sending it and without a word.
  Pasted images and dropped files already behave this way, so the increment
  neither introduces nor fixes the loss; it is recorded because folded content
  is what a user would least want dropped silently.

## Affected components and validation

- `packages/web-shell/client/hooks/useComposerCore.ts`: the paste predicate, the
  folded-card state, and the move-into-editor transaction.
- A new small composer-side helper module: thresholds, the fold predicate, the
  attachment ceiling, and card construction (name, media type, text).
- `packages/web-shell/client/components/ChatEditor.tsx`: the card's title, size,
  and action, alongside the existing chip.
- `packages/web-shell/client/utils/imageIngestion.ts`: reuse of the existing
  attachment-name sanitization, deduplication, and size ceiling.
- `packages/web-shell/client/i18n.tsx`: the new card action label, in both
  languages.
- Collocated unit tests beside each changed file, and a browser spec tagged for
  the pull-request gate.

Validation: unit tests for the predicate boundaries (199/200 lines, 7,999/8,000
characters, a single very long line, text with no trailing newline, a paste at
and above the attachment ceiling), for card construction and naming (including
a second folded paste), for a paste aimed at another control on the composer
surface, for selected-text replacement and `!`/`/` command detection, for the
shell-mode, disabled-composer, and disabled-attachment exemptions, for a folded
card winning over a pending follow-up suggestion, for the move-into-editor edit
being a single undo, for the card's size label (a card without a size shows
none), for the fold and the move on the touch textarea backend, and for a folded
card reaching the submit payload as an attachment. Browser verification covers the paste-to-card path, the inline
default, and the move into the editor; the send path is verified at the actions
layer, because the browser mock daemon has no attachment store. See `.qwen/e2e-tests/web-shell-paste-as-attachment.md` for
the commands and the results.

No open design questions. The follow-up recorded above (attachment-carrying
mid-turn insertion) is a deliberate exclusion, not an unresolved decision.
