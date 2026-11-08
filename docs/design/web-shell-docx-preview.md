# DOCX previews in Web Shell

[English](web-shell-docx-preview.md) | [简体中文](web-shell-docx-preview.zh-CN.md)

## Problem and current state

Word files are download-only. Attachments, @ references, Files inline and standalone previews, and workspace artifacts cannot display DOCX content. PDF and XLSX already share workspace-aware binary loading.

## Proposed solution

Add one lazy DOCX preview component using the pinned `docx-preview` package. Supplied attachment Blobs stay local; workspace files use `readWorkspaceFileAsBlob` and the resolved workspace actions. Recognize the literal filename extension, including `#` and `?`; use normalized DOCX MIME only when no extension exists. Do not interpret generic `kind: document` as DOCX. Enable the existing Files Preview action and preserve unavailable artifact status gates. Sources reuse the same routing without a separate loader. Sources attachments retain `source.title` as their download name; their attachment identifier remains the read locator. Workspace files keep their actual filename.

## Rendering and isolation

Render into a dedicated iframe with a fixed `srcDoc`, `sandbox="allow-same-origin"`, and no `allow-scripts`. Same-origin access lets trusted parent code populate the document while the sandbox blocks document scripts. Its CSP denies network resources, nested frames, forms and base URLs; only inline styles and data images/fonts are allowed. Set `renderAltChunks: false` and `useBase64URL: true`. Remove external hyperlink navigation before showing the result. For internal bookmark links, trusted parent handlers prevent default navigation and scroll to the matching element within the iframe. Native fragment navigation is not allowed because `srcDoc` inherits the parent page's base URL. The document has its own light canvas and cannot inject styles into the shell.

Each rendering attempt owns a new container and styles. Hide the frame with visibility while loading so layout remains measurable; cancelled work may finish only in its discarded container. Preserve the paper width in a horizontally scrollable wrapper so narrow panels do not clip its left edge. Reload on file, version, workspace, Blob or retry changes. Release the original-download Blob URL when replaced or unmounted. This is DOM/script isolation, not a CPU or ZIP decompression sandbox.

After the original Blob is loaded, a 30-second watchdog covers byte conversion, renderer import and rendering. A timeout discards the attempt's container, ignores late success/failure, and shows retry while retaining original download. Clear the timer on completion or cleanup. This only bounds asynchronous waiting while the event loop can run; it cannot interrupt synchronous work blocking the main thread.

## Limits and fallback

Limit DOCX preview input to 10 MiB, checked before workspace byte reads and before rendering supplied Blobs. Retain binary chunking, stat consistency and workspace authority checks. Show read/parse errors with retry and keep original-file download available, including after invalid or oversized input. Compression can expand beyond the input limit; large or pathological documents remain a browser resource risk. Native Word pagination and complex layout fidelity are not guaranteed.

## Scope and affected files

Change only Web Shell preview classification, panel routing, the Files menu, a dedicated DOCX component, localized messages, package dependency/lockfile/notices, and focused tests. Keep `.doc`, `.docm`, other Office formats, PDF and XLSX behavior. No daemon routes, processes, external conversion service, editor, OCR, custom pagination, or generic viewer framework.

## Validation and acceptance criteria

Run a baseline dry-run, then test actual DOCX text, tables and embedded images through draft/persisted attachments, @ references, Files inline/standalone and artifacts. Check generic MIME, uppercase and literal-character paths, exact binary-only workspace reads, attachment isolation, correct download bytes/names, error/retry, size/status gates, cancellation while a newer render remains pending, timeout/late completion, version/workspace changes and URL cleanup. Verify scripts/altChunks, external resources, external hyperlinks and document styles cannot affect the shell; internal bookmarks scroll without navigating either document. Include Sources and existing PDF/XLSX regressions. Capture and visually inspect real browser states; identify simulated daemon evidence explicitly. Run focused unit tests, build, root typecheck, bundle, lint/format checks, two clean self-audit passes and code review.

## Open questions

None for this scope. Exact Word pagination and protection against all compressed-document resource exhaustion require a different rendering architecture.
