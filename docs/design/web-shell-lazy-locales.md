# Load Web Shell locales on demand

[English](web-shell-lazy-locales.md) | [简体中文](web-shell-lazy-locales.zh-CN.md)

## Current behavior

The Web Shell startup graph evaluates the English, Simplified Chinese, Traditional Chinese, and Russian catalogs together. Each page pays for all four catalogs even when it displays a single language.

## Design

- Keep English available synchronously for initial rendering and missing-key fallback. Load the Simplified Chinese, Traditional Chinese, Russian, and Arabic main catalogs through explicit dynamic imports. Feature modules that already group messages across languages can still share code with the initial JavaScript.
- For the standalone shell, start loading the initial locale resolved from the URL, stored preference, or browser while the authentication bootstrap runs. Render once that locale is available. A later daemon preference or language change loads its own catalog. React subscribers update with the requested catalog when it arrives, and use English while it is pending. Concurrent requests for a locale share a promise, and loaded catalogs are reused for the life of the page.
- The transcript renderer uses static catalogs and existing transcript stubs. It embeds the Arabic strings needed to render an RTL transcript locally, so opening a transcript with the renderer available needs no separate locale request.

## Verification

Inspect the production JavaScript requested by a cold page in each of the five languages. Check that its localized UI appears and that only its selected non-English main catalog is requested. Check that Arabic sets RTL on the shell and portal roots. Switch between languages and check that a late response cannot replace the current locale. Verify English fallback for missing translations and failed chunk loads. Check that the transcript renderer embeds the Arabic strings used by the transcript and omits interactive-only Arabic strings.
