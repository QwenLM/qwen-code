# AskUser details: Preview affordance on the HTML artifact card and UI-language output

[中文](2026-11-07-ask-details-preview-and-ui-language.zh-CN.md)

Status: implemented (follow-up PR #16587). Follow-up to the merged details side
task (#16458, squash `61aef512e7`). Two friction points surfaced in real use:

1. The HTML explanation the details side task writes to `.qwen/tmp/` is
   inconvenient to discover as a rendered view: the artifact card labelled the
   action generically ("Open"), which did not signal that the HTML opens
   rendered. The user described it as having to open the file and then preview;
   the verification below finds the routing already renders in one action, so
   the friction is discoverability, not step count.
2. The generated HTML is not reliably in the reader's language. The whole point
   of the details task is to let the user quickly understand the pending
   question; a language mismatch defeats that.

## Problem 1 — Preview affordance on the HTML artifact card

### Current state

The details child writes a self-contained HTML file and replies with its path.
The file surfaces in the child transcript as an artifact card
(`ArtifactCard` in `components/artifacts/TurnOutputs.tsx`). The card's `Open`
action dispatches a `{kind:'artifact'}` tab request; `App.tsx`
`handleTurnOutputOpen` routes a workspace HTML artifact to an `artifact` tab,
which `ArtifactPanel.tsx` renders through `ArtifactDetail` →
`WorkspaceFilePreview` (`previewKind:'html'`) → `HtmlArtifactPreview` →
`RenderedHtmlPreview` (a sandboxed `srcdoc` iframe). For a normal-sized document
this renders directly; only documents over the large-document threshold fall
back to a source-first "render full preview" gate.

Tracing the open path shows the click already lands on the rendered preview in
one action: the card's `Open` dispatches the same `{kind:'artifact'}` request,
and the nested side-task pane routes through the same `handleTurnOutputOpen`
(`onNestedRightPanelOpen`), so it inherits the identical artifact-tab preview
path. The only source-first gate on that path is `LargeDocumentPreview`
(>1 MiB), which a self-contained details explanation does not reach. The gap is
therefore discoverability: the generic "Open" label (with an external-link
icon) did not signal that the HTML opens rendered. This is a static code trace,
not a live click inside the nested pane; the visuals capture exercises the card
in a session transcript against a mock daemon.

### Proposed change

Give the HTML artifact card an explicit, primary **Preview** action that opens
the rendered HTML directly, reusing the existing artifact-tab preview path
(no new preview renderer, no new tab kind):

- `ArtifactCard` relabels its single open action to **Preview** (with an eye
  icon) for rendered artifacts (`isRenderedArtifact`: HTML, Markdown, images).
  It _replaces_ the generic `Open` label on those artifacts — one button with a
  conditional icon and label, not an extra button alongside `Open`; `Download`
  is unchanged. The click handler is byte-identical to before: it dispatches the
  same artifact open request, which already lands on the rendered preview tab.
- The action is only offered when the artifact can actually be opened
  (`canOpenWorkspaceArtifact`, no external URL), mirroring the existing `Open`
  guard, so a missing or blocked artifact never shows a dead Preview button.
- i18n: reuse the existing `turnOutputs.preview` key (already defined in en/zh
  and used by `ArtifactPanel`); no new i18n key is added.

The change is scoped to the card affordance (label + icon); the click dispatch,
preview renderer, sandbox/CSP, and large-document gate are unchanged.

**Blast radius.** The relabel keys off `isRenderedArtifact`, so every HTML,
Markdown, and image artifact card in every session reads "Preview", not only the
ask-details card. This is intentional for consistency: those artifacts all open
in a rendered preview tab. Non-rendered artifacts (e.g. CSV, PPTX) and external
link artifacts keep "Open". `isRenderedArtifact` mirrors the panel's own rendered
predicates — it normalises mime parameters (`text/html; charset=utf-8` →
`text/html`) and honours `image/*` mime even without a path extension
(`getArtifactImageMimeType`) — so a card never says "Open" for an artifact the
panel would render. Both shapes are reachable via model-supplied `record_artifact`
input and are pinned by fixtures.

### Files affected

- `packages/web-shell/client/components/artifacts/TurnOutputs.tsx`
  (`ArtifactCard`, conditional icon/label).
- `packages/web-shell/client/i18n.tsx` (no new key; reuses `turnOutputs.preview`).
- Tests: `TurnOutputs.dom.test.tsx` (Preview label for HTML artifacts, Open kept
  for non-rendered, Preview disabled for non-openable artifacts).

### Verification (resolved)

The nested-routing open question is closed by code trace: the nested side-task
pane uses the same `handleTurnOutputOpen` as the main transcript, and a workspace
HTML artifact routes to the rendered preview tab with no source-first gate below
1 MiB, so the click already lands on the rendered HTML in one action. The PR
therefore fixes the labelling (discoverability), not the step count. A visuals
capture (real Chromium, mock daemon) shows the card before ("Open") and after
("Preview"); the click dispatch is unchanged. This is a static trace plus a
mock-daemon capture, not a live click inside a real nested side-task pane; if a
future report still shows extra steps on the latest build, the nested routing
would need a separate live investigation.

## Problem 2 — reliably follow the UI language

### Current state

`askUser.detailsPrompt` (en + zh-CN in `i18n.tsx`) leads with the question
snapshot (so first-prompt naming yields a question-derived title) and buries the
output-language instruction mid-paragraph ("…in English" / "…用中文写作").
In practice the model does not reliably honor a language directive buried in a
long instruction, so the HTML can come out in the wrong language.

### Proposed change

Make the language requirement a prominent, explicit, emphatic instruction that
covers the whole page, while keeping the question snapshot first (naming) and
keeping the `ASD-STE100` and `.qwen/tmp/` tokens (existing content tests):

- en: a dedicated requirement that the entire page — every heading, body
  sentence, list item, and label — is written in English, with no mixing.
- zh-CN: 整页必须用简体中文写作——每个标题、正文句子、列表项和标签都用中文，
  不要混用其他语言。

The output language continues to follow the Web Shell UI language (the en
template targets English, the zh-CN template targets Chinese); this change
strengthens adherence, it does not change the language source.

### Files affected

- `packages/web-shell/client/i18n.tsx` (both `askUser.detailsPrompt` templates).
- Tests: a regression asserting each template carries the strong whole-page
  language requirement (en + zh-CN), alongside the existing naming test
  (`SideTaskPanel.test.tsx`) and content assertions (`App.test.tsx`).

## Scope boundaries

- No change to the preview renderer, sandbox/CSP, large-document gate, artifact
  registration, or the side-task creation flow.
- No change to the language source (still UI language); no daemon
  output-language coupling.
- No auto-open of the preview on generation (the user chose an explicit Preview
  action, not automatic opening).
- No routing change: the click dispatch is identical to the previous "Open".

## Open questions

- None outstanding for the affordance change. The nested-routing question is
  resolved by code trace (see Verification above).
- Whether the strengthened whole-page directive moves model output language in
  practice is inherently probabilistic; the tests pin the prompt string, not
  model adherence. A language _setting_ (mechanism) would be the stronger lever
  but is deliberately out of scope here.
