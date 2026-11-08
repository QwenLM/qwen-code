# AskUser details: one-click HTML preview and UI-language output

[中文](2026-11-07-ask-details-preview-and-ui-language.zh-CN.md)

Status: draft. Follow-up to the merged details side task (#16458, squash
`61aef512e7`). Two friction points surfaced in real use:

1. The HTML explanation the details side task writes to `.qwen/tmp/` is
   inconvenient to view: the user reports having to open the file and then
   trigger a preview, rather than seeing the rendered explanation directly.
2. The generated HTML is not reliably in the reader's language. The whole point
   of the details task is to let the user quickly understand the pending
   question; a language mismatch defeats that.

## Problem 1 — one-click preview on the HTML artifact card

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

The reported multi-step experience comes from the side-task context: the child
pane is a nested right panel, and opening an artifact from it goes through the
nested right-panel wiring rather than landing the user directly on a rendered
preview. The card also labels the action generically ("Open"), which does not
signal that the HTML can be viewed rendered.

### Proposed change

Give the HTML artifact card an explicit, primary **Preview** action that opens
the rendered HTML directly, reusing the existing artifact-tab preview path
(no new preview renderer, no new tab kind):

- `ArtifactCard` renders a `Preview` button for artifacts that render as HTML
  (`isRenderedArtifact` / HTML mime/extension), alongside the existing `Open`
  and `Download` actions. The button dispatches the same artifact open request
  the card already uses, which lands on the rendered preview tab.
- The action is only offered when the artifact can actually be opened
  (`canOpenWorkspaceArtifact`, no external URL), mirroring the existing `Open`
  guard, so a missing or blocked artifact never shows a dead Preview button.
- i18n: reuse `common.preview` if present, otherwise add a localized label
  (en/zh-CN).

The change is additive and scoped to the card affordance and its open request;
the preview renderer, sandbox/CSP, and large-document gate are unchanged.

### Files affected

- `packages/web-shell/client/components/artifacts/TurnOutputs.tsx`
  (`ArtifactCard`, the artifact open request).
- `packages/web-shell/client/i18n.tsx` (Preview label, if not reused).
- Tests: `TurnOutputs.dom.test.tsx` (Preview button appears for HTML artifacts,
  dispatches the open request, absent/disabled for non-openable artifacts).

### Verification point

Confirm in a real details side task that clicking Preview lands directly on the
rendered HTML (single action), including the nested right-panel routing. If the
nested routing still introduces an intermediate pane, route the Preview request
so the rendered preview tab is activated directly.

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
- No auto-open of the preview on generation (the user chose an explicit
  one-click Preview action, not automatic opening).

## Open questions

- Whether the nested side-task right-panel routing needs an explicit adjustment
  to activate the rendered preview tab in one action (resolved during
  verification).
