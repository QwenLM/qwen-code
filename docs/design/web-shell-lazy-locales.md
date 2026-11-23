# Load Web Shell locales on demand

[English](web-shell-lazy-locales.md) | [简体中文](web-shell-lazy-locales.zh-CN.md)

## Current behavior

The Web Shell startup graph evaluates the English, Simplified Chinese, Traditional Chinese, and Russian catalogs together. Each page pays for all four catalogs even when it displays a single language.

## Design

- Keep English available synchronously for initial rendering and missing-key fallback. Move the other three main catalogs behind explicit dynamic imports. Feature modules that already group messages across languages can still share code with the initial JavaScript.
- For the standalone shell, start loading the initial locale resolved from the URL, stored preference, or browser while the authentication bootstrap runs. Render once that locale is available. A later daemon preference or language change loads its own catalog. React subscribers update with the requested catalog when it arrives, and use English while it is pending. Concurrent requests for a locale share a promise, and loaded catalogs are reused for the life of the page.
- Keep the transcript build synchronous and self-contained by selecting static catalogs with the existing transcript stubs. This preserves its existing language coverage and allows exported HTML to open offline.

## Verification

Inspect the production JavaScript requested by a cold page in each of the four languages. Check that its localized UI appears and that only its selected non-English main catalog is requested. Switch between languages and check that a late response cannot replace the current locale. Verify English fallback for missing translations and failed chunk loads, and verify that the standalone transcript bundle still contains the expected translations.
