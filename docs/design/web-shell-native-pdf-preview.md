# Native PDF previews in Web Shell

[English](web-shell-native-pdf-preview.md) | [简体中文](web-shell-native-pdf-preview.zh-CN.md)

## Problem and current state

PDF attachments with a PDF MIME type already use the browser viewer through a Blob URL and iframe. Workspace PDF files opened from @ references or the Files extension instead reach the text reader, while PDF artifacts are classified as download-only.

## Proposed solution

Recognize PDF by its `.pdf` extension, normalized `application/pdf` MIME type, or artifact `kind: pdf`. Preview routing extracts the extension from the literal workspace filename, preserving `#` and `?` in filenames and directories. Excel classification and download-only gates use the same filesystem parsing so a directory such as `reports.xlsx#approved` cannot override a PDF filename. Existing URL-aware type labels remain unchanged. Preserve the existing SVG and other download-only format gates before allowing PDF metadata to opt an artifact into preview. Route all four entry points through the existing native viewer. Supplied attachment Blobs stay local; workspace files use the existing `readWorkspaceFileAsBlob` helper and their resolved workspace actions. Pass PDF artifact kind information through the preview MIME type. Unavailable artifacts retain the existing unavailable/download presentation.

## Decisions and scope

Change only Web Shell preview classification and rendering, plus tests. Reuse the attachment viewer and existing download UI; do not add PDF.js, server routes, public APIs, editing, OCR, or custom viewer controls. Read workspace PDFs as binary, retain the 100 MiB limit and 256 KiB chunks, and preserve stat consistency and workspace authority checks. Reload on file/version/owner changes, ignore cancelled reads, and revoke Blob URLs when replaced or unmounted. Provide download fallback when the browser reports no inline PDF support, and show read errors with retry.

## Affected files

- `packages/web-shell/client/components/artifacts/artifactUtils.ts` and its tests: shared classification.
- `packages/web-shell/client/components/artifacts/ArtifactPanel.tsx` and its tests: workspace loading and reuse of the native attachment viewer.
- `packages/web-shell/client/components/artifacts/WorkspaceFileBrowser.tsx`: enable PDF in the existing standalone preview menu.
- `packages/web-shell/client/e2e/web-shell.pdf-preview.spec.ts`: browser coverage for the four entry points.

## Constraints and risks

The browser owns the PDF toolbar, password prompts, and rendering errors. Inline support detection cannot establish that a particular PDF rendered successfully. Host CSP must permit Blob frames. Complete-file loading uses memory and can delay large previews; the existing size limit remains. Simulated-daemon browser tests verify UI integration, not real daemon filesystem operations.

## Validation and acceptance criteria

Attachments, @ references, the Files extension, and artifacts show valid PDF pages in a full Chromium browser. Uppercase extensions, generic attachment MIME, normalized PDF MIME, kind-only PDF artifacts, and literal `#`/`?` paths (including directories with misleading extensions) are covered. Sources PDF previews retain their previous support for these literal paths. Workspace PDFs never use text reads, and supplied Blobs never trigger workspace reads. Download bytes remain correct. Version changes replace the preview, unmount releases its URL, read failures allow retry, unavailable artifacts do not read, and workspace ownership checks remain effective. Run focused unit and browser tests, build, typecheck, bundle, and two clean self-audit passes. Capture and visually inspect browser screenshots, identifying simulated-daemon evidence explicitly.

## Open questions

None for this scope. Cross-browser viewer controls and large-file streaming are outside this change.
