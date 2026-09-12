# Focus editable combo boxes on semantic click

[English](osworld-editable-combo-focus.md) | [简体中文](osworld-editable-combo-focus.zh-CN.md)

## Problem and evidence

OSWorld cases 44, 45 and 50 repeatedly attempt to click Excel's Name Box. The historical case 44 Qwen run fails with AXPress error -25206, followed by about 159.5 seconds of selection recovery (calls 6–23). This interval includes model decisions and is not all SDK dispatch time. An independent real MCP reproduction on native 94eb59d2 confirms the same failed dispatch in 1185.18 ms.

The Name Box exposes AXComboBox and advertises AXShowMenu/AXConfirm, but not AXPress. Independently setting AXFocused succeeds without changing AXValue; focus moves to an AXTextField whose direct AXParent is the exact same combo, as checked with CFEqual. Subsequent foreground text and Enter select the intended cell. These controls establish a candidate semantic operation, not a full-task speedup.

## Change

For an unmodified AXPress on an AXComboBox that has writable AXValue and does not advertise AXPress, set AXFocused instead. Require a readable value before delivery, a successful focus write, a fresh focused element equal to the combo or its direct AXTextField child, and the same readable AXValue afterward. Return a confirmed accessibility read-back only when these conditions hold. A failed write or read-back returns an error without dispatching a second action.

This uses the existing per-call foreground or background targeting and focus policy. It introduces no global input, coordinate fallback, title matching, value write or new public option. Explicit menu/confirm actions, advertised AXPress, non-editable combos, other roles and modifier handling retain their existing paths. Focus confirmation is evidence of focus, not proof that a later typed value was submitted.

## Verification and limits

Run the existing click tests and build the native library. An independent test engineer must verify the actual local MCP path: successful Name Box focus with the value preserved, subsequent cell selection, another focused field rejected as proof, explicit menu/confirm compatibility, and the existing stale/wrong-window refusal. Record hashes and timings.

Before the combined fix, Excel reported an incomplete AX tree and the facade consequently removed tokens. Raw legacy token tests must be labelled as such; they cannot establish that the facade model path is available. The separate filter fix below was required before verifying the facade path. Full task timing uses the historical task prompt, pristine input, setup and scoring rules. The target is at most 1.5× baseline; no full-case success is claimed from this patch alone.

## Empty Help search child and observation completeness

A second independent reproduction localized the incomplete capture to a child of AXTextField/AXSearchField in the application Help menu, outside the workbook subtree. AXRole returns NoValue (-25212), AXSize is exactly zero, AXChildren is a successful empty array, all content is absent, AXValue/AXFocused are not writable, and AXFocused is false. This node was already omitted from the rendered tree but its missing role cleared every real element token. The old d8dd and 94eb builds both exhibit the symptom.

The walker now omits only a directly verified empty search-field child before declaring a missing required role. It requires a fresh exact NoValue role result, the observed parent role/subrole, typed zero size, a successful typed empty children array, absent title/description/value/placeholder/help, no actions under the existing stable-error classifier, non-writable value/focus and a false focused state. Null-success, transient errors, unknown types, visible/nonempty nodes, editable/focused nodes and other parents retain the incomplete path. No app name or Help title is matched; top-level role checks and the facade's token clearing remain unchanged. The residual diagnostic now says the required role is unavailable, not that the raw API necessarily returned success.

Independent verification must preserve the same live empty child, compare old/new native, confirm the full facade tree and real Name Box token are available, and show that parent search controls/menu content survive. This additional fix is not considered verified by the existing native unit suite alone.

## Verified local build

Final native47e2d968 passed355 library tests and the release build. Independent real MCP verification on the same Book1 and retained empty leaf confirms two complete/stable facade observations (662.45/243.43ms; second selected no-change text81bytes), preservation of Help/search controls, and a real facade Name Box click1359.15ms from AXLayoutArea to its direct text editor with the originalA2 value preserved. Text B2 (1481.43ms) plus Enter (1359.14ms) selectedB2, checked by independent AX and the actual PNG. After closing only the owned workbook, its old token refused stale lineage in0.485ms. The candidate hash was unchanged and all verifier MCP processes exited.

The independent review found the missing AXPlaceholderValue guard, which was added before final build and verification. Tests/build and two clean self-audits were repeated; final review has no findings. At the 47e2d968 verification stage, explicit menu invocation did not establish a visible popup, and model connectivity blocked whole-case validation. Later case44, case45 and case50 runs exercised the combined fixes; the ordinary-text-field verification below separately established a visible menu. Full 20-task efficiency acceptance remains pending. Evidence: `.qwen/investigations/excel-facade-verified-47e2d968/`.

## Ordinary editable text fields

Case50R2 independently reproduces the same unsupported AXPress on Colors' hex AXTextField. Moving focus away with Tab, then setting AXFocused, changes the actual focused element back to that exact field (CFEqual), preserves FFFFFF and selects the six characters. The candidate extends the semantic focus path only to AXTextField, also requiring writable AXFocused. Only combos may verify their direct child editor; an ordinary text field must match exactly. Other roles, explicit actions and modifiers retain their paths.

Candidate343979eb passed357 native tests and release build. Independent facade testing confirms a non-hex starting focus moves to hex, preserves its value, and returns confirmed instead of -25206; NameBox plus typing B2 and explicit confirm also works. The click still costs1076.307ms, including the unchanged one-second observation; this fixes an invalid action, not the main waiting cost. All15 independent checks passed, including a visible explicit context menu and rejection after closing the owned window; that rejection verifies window identity first, not an independent token-lifetime check. The final narrow code review reports no findings. Evidence: `.qwen/issues/osworld-colors-textfield-focus.md`.
