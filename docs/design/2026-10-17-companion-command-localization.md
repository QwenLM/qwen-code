# Companion command-title localization

[English](2026-10-17-companion-command-localization.md) | [简体中文](2026-10-17-companion-command-localization.zh-CN.md)

## Problem and scope

Issue #13967 asks for broader Companion localization. The maintainer explicitly welcomes a standalone manifest contribution: nine of twelve command titles are hardcoded English, while the three copy commands already use native VS Code NLS keys.

This change covers command titles in the existing English and Simplified Chinese catalogs, plus delivery of those catalogs in the extension package. Notifications, configuration descriptions, other locales, webview strings, language precedence and shared CLI translation sources remain follow-up work.

## Approach and constraints

Reuse the existing `<command>.title` key convention and `%key%` manifest references. Keep every command ID, English fallback title, menu, keybinding and activation event unchanged. VS Code resolves manifest NLS using its display language; no runtime translation layer or CLI setting is involved.

The installed vsce 3.9.2 file listing excludes both catalogs under the current whitelist. Explicitly include `package.nls*.json` in `.vscodeignore`; verify the actual package rather than relying on the pattern alone.

Affected files are the Companion manifest, two NLS catalogs, packaging whitelist, existing manifest tests and the VS Code integration guide. No dependency changes or public API changes are required. Missing catalogs or mismatched keys are the main risk; fallback English remains unchanged for other languages. There is no migration.

## Validation and acceptance

- All twelve command-title references resolve to non-empty English and Simplified Chinese entries; the English titles match the baseline.
- Both NLS catalogs appear in the vsce file list and generated VSIX archive.
- Focused manifest tests preserve the focus-chat semantic assertion and existing visibility checks.
- Attempt isolated VS Code display-language validation; distinguish real-host evidence from package-level checks if a language pack or host is unavailable.
- Run repository build, typecheck and bundle, companion checks, formatting and full-diff review. Record unexecuted or blocked checks explicitly.

Command Palette evidence: [before](../verification/issue-13967/before-zh.png) and [after](../verification/issue-13967/after-zh.png). These are real VS Code 1.142.0 windows using isolated copies of the manifest and catalogs with no-op activation. They demonstrate command-label localization, not full Companion activation or command execution.

## Open questions

None for this slice. Language precedence and shared translation ownership remain maintainer decisions outside it.
