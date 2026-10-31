# OpenTUI dialog editing and Permissions forms

[English](2026-10-30-opentui-dialog-editing.md) | [简体中文](2026-10-30-opentui-dialog-editing.zh-CN.md)

## Status and problem

Implemented on this branch: Ctrl+K/U, word editing, Permissions rule/path editing and directory completion, undo/redo, numeric-input history handling, and empty caret-segment layout correction. This document describes that batch's decisions and validation methods. It does not establish final migration or platform acceptance; the complete migration remains unfinished. Local source validation has passed build, typecheck, lint and bundle, affected unit suites, and the two public scenarios below on Node+Ink, Bun+Ink and strict Bun+OpenTUI. Candidate-specific results belong in the accompanying PR validation report; these source results do not qualify installed packages or additional platforms.

Before this change, OpenTUI's TextInput-class dialog fields omitted word movement, forward-word deletion, and undo/redo. Its Permissions rule and workspace-directory forms manually appended text and removed UTF16 units. Ink uses TextInput for both forms. OpenTUI advertised directory completion without implementing it.

## Scope and owners

The shared editing model and Permissions forms live in `line-edit.ts` and `dialogs-permissions.tsx`. Numeric input normalization and its dedicated Space behavior live in `dialogs-auth.tsx`. Tests are collocated. The display-only empty-segment correction covers Sources, Discover, Acquisition, auth, confirmation and Permissions fields. No Core changes, new configuration, new optional parameters, default switch, publishing or Ink removal.

Do not replace Discover's manual type-to-search/tab-navigation contract or Acquisition's password clear-all contract with TextInput behavior. Shared-hook changes must retain these exceptions. Existing failures and results stay immutable.

## Shared word editing

Use the existing exported `offsetToLogicalPos`, `getWordMovePosition`, and `applyWordDeletion` from the Ink buffer module. Adapt the flat code-point caret to logical row/column, apply the existing operation, then flatten the returned caret. Keep Ctrl+B/F character-move precedence even if Meta is also reported.

Bindings are Ctrl/Alt+Left/Right, Alt+B/F, Alt+D, and Ctrl/Alt+Delete. The original helper determines punctuation, CJK segmentation, supplementary characters, and newline behavior. No second word-segmentation algorithm is introduced. Pure `LineState` keeps exactly `text` and `cursor`.

## Permissions forms and completions

Route rule/path editing and bracketed paste through `useLineEdit`. Preserve original rule parsing, workspace validation and mutation callbacks. Paint the logical caret line with `windowLineAtCaret`; sanitize terminal text and constrain it to the input's actual width. Empty or invalid submissions keep the field active. Successful submissions settle the field before changing view. Directory submission settles only after its synchronous save callback returns successfully; a thrown callback must leave editing and Escape available.

Reuse the existing batch-safe view state. A handler from a previous painted view must not edit or submit the successor view. Esc settles the leaving field. Tab completion settles the old field for the remainder of that stdin read and remounts it at the completed path on the next render; a same-read Tab+Enter cannot submit the pre-completion path.

Match Ink's completion behavior: expand `~`, preserve relative paths, inspect directory entries, exclude files and hidden names, match the prefix, keep the first 6 matches in filesystem enumeration order, display the candidates, select with Up/Down and apply with Tab plus `/`. Reset selection after text edits. Charge candidate rows against the actual available height; never select a hidden row. Keep the existing realpath/existence/overlap validation.

## Undo/redo and real owner contracts

Undo/redo is implemented with the following owner contract. Use private text/caret snapshot stacks inside `useLineEdit`, limited to 100 entries like Ink. Reuse the current controlled mirror, not the full TextBufferState's viewport/layout/selection machinery. No public history fields, configurable normalizer or new optional parameter is needed. Ctrl+Z/Shift+Ctrl+Z read the actual `shift` property; the pure reducer/password path retains its existing ownership.

Every production owner was checked. Sources passes raw `setInput`; Discover passes raw `setQuery`. Base URL/API-key onChange callbacks store exact text; API-key trimming occurs only on successful submit when the field settles. The custom model field stores exact custom text before separately normalizing model IDs. Model search stores raw text. Ask-user custom answers store exact text and update a separate check marker. Permissions fields store raw text and validate on submit.

The only actual filtering onChange is context-window size: `changeContextWindowSize` in `useProviderSetupFlow.ts` removes non-digits; initialization and start/reset write only an empty value. Normalize keyboard/paste text immediately before the two actual `ctxField.insert` calls with the same `/[^0-9]/g` rule; keep the existing flow filter as an idempotent backstop. Invalid input becomes a no-op and does not alter history; mixed paste records accepted digits as one edit. Continue consuming a nonempty paste even when its digit-only result is empty. The dedicated Space branch also consumes Space without calling insert on the context-window row; other rows retain their toggle behavior. Space must not create a rejected history entry. No auth-flow module or generic callback API changes.

The existing auth test explicitly records a controlled-field divergence from Ink: Ink's internal buffer can retain a rejected letter while its parent value is filtered; OpenTUI keeps the accepted digit value and caret. Preserve that tested OpenTUI numeric contract. Compare normalized, accepted edit sequences and final persisted contextWindowSize to Ink; do not claim raw invalid-input internal states are identical.

## History transactions and observability

A text-changing commit records the preceding text/code-point caret and clears redo. Cursor moves and no-ops do not record edits. A paste is one edit. Undo/Redo restore both text and caret synchronously before notifying the existing owner. A new edit after Undo invalidates redo; moving the caret does not. A settled field ignores editing and history commands; mountKey change/unmount starts a new field history.

Keep a private acknowledged checkpoint containing the last rendered accepted LineState and references to immutable undo/redo arrays. Normal exact acceptance retains every current per-key operation, including edit → Undo → Redo in one stdin read. On a detectable rejection, restore the checkpoint's stacks and accepted state, removing only unconfirmed proposals. If the owner instead supplies a detectable filtered value different from both the proposal and checkpoint, preserve the checkpoint's older undo entries and record that accepted replacement once from the previous accepted state; clear redo as for an ordinary new edit. An external replacement in the same field follows this explicit replace-edit rule. A real field remount resets history.

A void onChange and one final rendered value cannot reconstruct arbitrary stateful callback decisions for intermediate proposals in the same read. A checkpoint does not supply missing acknowledgements. Do not claim that generic reconstruction or introduce an acknowledgement API for hypothetical callbacks. The real numeric owner is normalized before proposal creation, and every other current onChange accepts exact text, so this ambiguity is removed for the production paths being qualified. New conditional-reject owners must define their actual normalization/acknowledgement before inheriting that claim.

Required counterexamples are: accepted 1 → 12 → 123 followed by refused x still Undoes to12 and Redoes to123; mixed paste `1,024` retains older accepted history; invalid-only paste preserves redo; same-read edit → invalid numeric input → Undo → Redo; accepted12 → edit3 → Space → Undo → Enter submits12 with a digits-only owner trace; two accepted edits and history in one read; caret move between Undo and Redo; new edit after Undo; detectable filtered replacement; external replacement; mount reset; settled trailing paste/history; and the 100-entry cap. Test both the real Ink reducer for accepted edit sequences and the actual numeric dialog path. These cases remain acceptance requirements for the implemented history behavior, not waivers.

## Native caret-segment layout

An empty independent OpenTUI 0.5.10 text node can still occupy one column. Mount sanitized before/after segments only when their displayed string is nonempty. Apply this consistently to Sources, Discover, Acquisition, auth, confirmation and Permissions fields. Keep the caret cell itself, inactive characters, password masking, placeholders, `caretInside` conditions and clipping unchanged. Exact input-row assertions and native empty/nonempty transitions are layout regressions; whitespace normalization must not hide an extra column. Native geometry checks complement public CLI scenarios and do not independently qualify the full CLI.

## Validation

Record the tested candidate, runtime and renderer. Use a recorded global CLI Ink run as a comparison baseline, with its observed version, runtime and execution date; mark unavailable product provenance as unknown. Use Bun 1.4.4 and OpenTUI 0.5.10 for this migration target.

From the repository root, run `npm run build && npm run typecheck`, `npm run lint`, and the formatter check for changed files. Run affected whole unit files from `packages/cli`, including the shared editing/history model and all six display consumers:

```sh
cd packages/cli
npx vitest run src/ui/opentui/line-edit.test.ts src/ui/opentui/line-edit-history.test.ts src/ui/opentui/ExtensionSourcesTab.test.tsx src/ui/opentui/ExtensionDiscoverTab.test.tsx src/ui/opentui/ExtensionAcquisition.test.tsx src/ui/opentui/ExtensionAcquisition.widgets.test.tsx src/ui/opentui/dialogs-auth.test.tsx src/ui/opentui/dialogs-confirm.test.tsx src/ui/opentui/dialogs-permissions.test.ts src/ui/opentui/dialogs-permissions.test.tsx src/ui/opentui/dialogs-permissions.burst.test.tsx
```

Build the bundle with `npm run build && npm run bundle` before interactive integration tests. From `integration-tests`, the focused runtime checks are below. Each leg gets an empty owned harness home/runtime/temp, preventing host configuration carry-over, and files run serially:

```sh
dialog_test_root=$(mktemp -d)
failed=0
for leg in node:ink bun:ink bun:opentui; do
  dialog_leg_root="$dialog_test_root/${leg%%:*}-${leg#*:}"
  mkdir -p "$dialog_leg_root/home" "$dialog_leg_root/runtime" "$dialog_leg_root/tmp"
  QWEN_HOME="$dialog_leg_root/home" QWEN_RUNTIME_DIR="$dialog_leg_root/runtime" \
    TMPDIR="$dialog_leg_root/tmp" TMP="$dialog_leg_root/tmp" TEMP="$dialog_leg_root/tmp" \
    QWEN_E2E_RUNTIME="${leg%%:*}" QWEN_E2E_RENDERER="${leg#*:}" QWEN_SANDBOX=false \
    npx vitest run interactive/tui-editor-parity.test.ts interactive/tui-extension-acquisition.test.ts \
      --testNamePattern='^(permissions-edits-and-completes-without-model|acquires a real source through Discover and cold reload on .*)$' \
      --retry=0 --fileParallelism=false --maxWorkers=1 --minWorkers=1 \
      --dangerouslyIgnoreUnhandledErrors=false || failed=1
done
exit "$failed"
```

These two scenarios are wired into `.github/workflows/tui-parity.yml` through their existing test files: Permissions edits/paste, persisted rule, visible directory completion and cancellation; Source editing/undo/redo before real acquisition and cold reload. The renderer matrix requires strict Bun+OpenTUI, separating it from Node+Ink and Bun+Ink. Record each leg independently; a pending leg or a successful native micro-test does not imply all three passed. The controlled fixtures need no external model account or device permission.

Unit tests cover same-read keys/paste, rejected submissions, save-callback failure, low-height/width ownership, numeric filtering and history. Native checks must also cover empty → nonempty → empty caret segments and exact row geometry; mocked text flattening cannot prove terminal column layout.

## Acceptance and remaining work

Word-edit results must match the actual Ink reducer, including Ctrl+Meta precedence and code-point offsets across newlines. Both Permissions forms must support editing/paste without changing submitted intent; the directory footer must correspond to working visible completions. Hidden candidates cannot be selected. Invalid input stays editable and view changes prevent stale-handler mutations.

The current batch is implemented; its validation must remain scoped to the actual candidate, commands and recorded runtime results. Remaining dialog work includes Ctrl+C field-clear/global-exit ownership and Ctrl+X external-editor lifecycle. IME/a11y and complete platform/install qualification, including Windows PowerShell and supported native/runtime combinations, remain migration requirements. This batch does not authorize a default switch or Ink removal and does not promote historical failures to passing results.
