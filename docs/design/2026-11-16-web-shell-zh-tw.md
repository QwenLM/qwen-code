# Web Shell Traditional Chinese

[English](2026-11-16-web-shell-zh-tw.md) | [简体中文](2026-11-16-web-shell-zh-tw.zh-CN.md)

## Problem

The CLI already ships a complete `zh-TW` interface. Web Shell did not. A
Traditional Chinese setting or browser locale (`zh-TW`, `zh-HK`, `zh-Hant`,
`zh-MO`) stayed on English in the shell, and the VS Code companion chrome
treated every `zh*` tag as Simplified Chinese.

## Goals

- Selecting `zh-TW`, or opening the shell with a Traditional Chinese locale,
  shows Traditional Chinese.
- `zh` and `zh-CN` stay Simplified Chinese.
- Exported HTML does not take a second full Chinese catalog.

## Non-goals

- New catalogs for `de`, `ja`, `pt`, `fr`, or `ca`.
- Hand-editing every CLI string again. The CLI `zh-TW` pack stays the
  hand-maintained terminal catalog.
- Changing model output language. That remains a separate setting.

## Proposal

Web Shell gains a `zh-TW` catalog bootstrapped from the existing Simplified
catalog with OpenCC (`cn` → `twp`) and the Taiwan vocabulary fixes already
used for the CLI locale (`伺服器`, `參數`, `週額度`, `實例`, `系統`, `帳號`).
The language picker lists it as `繁體中文 [zh-TW]`. Saving the choice writes
`general.language` as `zh-TW`, which the CLI already accepts.

The catalog lives in its own module. The transcript build replaces that
module with an empty table, so exported HTML falls back to English for
`zh-TW` instead of growing past the document-renderer budget. The interactive
shell and the VS Code companion chrome use the full table.

`zh-HK` and `zh-MO` resolve to this same Taiwan catalog. They do not get a
separate Hong Kong or Macau vocabulary.

## Decisions

- Do not alias `zh-TW` to `zh-CN`. Simplified copy is the bug, not an
  acceptable fallback for a locale the CLI already treats as strict-parity.
- Do not convert strings in the browser. The OpenCC dictionary would ship in
  the client, and the export budget cannot absorb another full catalog.
- Keep the generated file as the source of truth. Later wording fixes land in
  that file; a fresh conversion would wipe them.

## Constraints

- `zh` / `zh-CN` / `中文` continue to mean Simplified Chinese.
- Missing `zh-TW` keys still fall back to English, same as the other catalogs.
- Companion chrome and loading phrases follow the same tag split.

## Risks

OpenCC plus the vocabulary pass is mechanical. Some lines will still read as
translated Simplified rather than copy a Taiwan editor would write. That is
the same bootstrap the CLI locale started from. The risk of leaving `zh-TW`
on English or Simplified is worse.

The Simplified and Traditional catalogs can drift when a new Simplified
string is added without a Traditional entry. The unit test pins key behavior
for the credit and file strings; a missing key falls back to English rather
than Simplified.

## Validation

- `normalizeLanguage('zh-TW' | 'zh_TW' | 'zh-Hant' | 'zh-HK')` is `zh-TW`.
- `normalizeLanguage('zh' | 'zh-CN')` stays `zh-CN`.
- `getTranslator('zh-TW')` returns Traditional strings that differ from
  `zh-CN` for the same key (`檔案` vs `文件`, `週額度`).
- The transcript stub exports an empty table.

## Acceptance criteria

- The Web Shell language list includes `zh-TW`.
- A `general.language` value of `zh-TW` renders Traditional Chinese in the
  interactive shell.
- VS Code companion chrome uses Traditional Chinese for `zh-TW` and
  Simplified Chinese for `zh-CN`.
- The HTML export bundle does not embed the Traditional catalog.

## Follow-up

Other CLI locales that Web Shell still lacks (`de`, `ja`, `pt`, `fr`, `ca`)
are separate work. So is a pass that replaces remaining awkward OpenCC
wording after review.
