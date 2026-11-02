# Web Shell Files follow-up fixes

[English](web-shell-files-followups.md) | [简体中文](web-shell-files-followups.zh-CN.md)

## Problem

This refines the [Files browser design](web-shell-file-browser.md).

The merged Files browser still displays control characters in Pierre-owned rows,
ships the full highlighter grammar/theme graph, omits an inlined layout dependency
from its license seeds, and has no action to close only the inline preview.

## Decisions

- Add a pinned `patch-package` patch exposing a render-only `formatItemName` hook
  in Pierre Trees. Use a filename-specific formatter removing ANSI, control and
  Unicode format characters and the combining grapheme joiner, while
  preserving legal spaces, including repeated, leading/trailing and nonbreaking
  spaces. Search matches both this per-segment display projection and raw paths.
  Apply the formatter to ordinary,
  flattened and sticky rows and their accessible names; never mutate model paths.
  Raw paths continue to identify reads, downloads, references and clipboard copies.
  Two names with the same cleaned display remain distinct files. Remove the patch
  when the upstream package supplies an equivalent supported hook. Modified files
  carry banners and the patched package NOTICE feeds generated distribution notices.
  After changing the patch, reapply it and restart development with
  `npm run dev -- --force` from `packages/web-shell` to invalidate Vite prebundles.
- Give Pierre a dedicated Shiki 4 build entry with explicit lazy loaders for common
  languages and only `github-light` / `github-dark`. Scope resolution to Pierre so
  existing Shiki 1 consumers keep their behavior. Unsupported languages fall back
  to readable plain text before rendering; retain existing large-file limits.
  Apply the same resource selection in development and app/library production
  builds. Exclude Pierre from Vite dependency prebundling so development uses
  the same adapter. `pierre-resources.ts` defines 33 allowed language keys;
  normalize `yml` to `yaml` and `kts` to `kotlin`. Guard rendered module code
  in this resource graph with a 4 MiB budget, excluding unrelated code in shared
  chunks, including redirected Shiki subpaths. Fail the budget check if Pierre is
  bundled without the curated adapters; transcript builds legitimately omit Pierre.
  Vitest applies the same adapter with Pierre dependencies inlined. Internal adapter
  declarations are not a public package surface; published declarations may depend
  only on declared runtime/peer packages or their declared type packages.
  Verify cold loading, common grammars, theme changes and fallback behavior.
- Keep `react-resizable-panels` external in the published library, matching the
  existing UI dependencies. The npm dependency then supplies its own license;
  it is no longer an unattributed copy inside the library bundle.
- Add Close file preview to the Files toolbar. Clear the selected file and restore
  a full-width tree even when it was hidden. Preserve loaded directories, expansion,
  filtering and tree state; selecting the same file again reopens it. Return
  keyboard focus to the filter only after the tree becomes visible.

## Scope

No Git integration, file editing, filesystem mutation, clipboard shell escaping or
changes to the general Markdown/source renderers. Existing source paths remain the
operation contract; copied paths are not shell commands. UI E2E uses a simulated
daemon and does not establish real filesystem or Git backend behavior.

## Validation

Use actual browser rows to check cleaned visible/accessible labels, original reads
and clipboard values, colliding cleaned names, directory expansion and virtualization.
Close the inline view with the tree visible and hidden, then reopen the same file.
Exercise common syntax and unsupported-language fallback on cold load and switch
between light/dark themes. Compare published library JavaScript footprint against
the merged baseline, enforce the highlighter budget, regenerate notices, and run
build, typecheck and targeted unit/browser tests. Audit the entire diff twice.
