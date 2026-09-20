# Session artifacts for `/export` in the Web Shell

[English](web-shell-export-artifact.md) | [简体中文](web-shell-export-artifact.zh-CN.md)

Status: implemented with repository regression tests. Browser verification records are local working evidence, not included in this repository.

## Goal and compatibility

After `/export md|html|json|jsonl`, the Web Shell must show the exported file in the command's turn, with the existing artifact preview and download controls. Keep the CLI's argument parsing, path validation, formatting, file permissions, output location, and success/error text unchanged. Interactive and non-interactive CLI invocations return the original result without artifact metadata; only ACP invocations add descriptors after a successful write.

The sidebar export action and HTTP export routes remain unchanged. No new storage kind, filesystem writer, command implementation, daemon route, or dependency is needed.

## Reassessment of the initial implementation

The original approach correctly reused workspace artifacts and carried structured descriptors rather than parsing success text. However, registering an artifact did not make it discoverable: the turn-output selector only associated artifacts with tool calls, while `/export` has no tool call. A real local daemon reproduced this: its catalog contained an available HTML artifact, but the browser offered no card or preview entry.

The original text-pagination design was also incorrect. A capped text read can return `truncated: true`, `hasMore: true`, and no cursor, including for a long HTML line. Text windows are not a lossless byte stream; concatenating them cannot promise the original document. Treating the missing cursor as completion silently truncated the preview. The fake paging test did not model that contract.

A browser E2E check exposed a third incompatibility: exported HTML loads its renderer and stylesheet from a versioned CDN, while the generic artifact sandbox intentionally blocks external resources. A visible card alone therefore did not make a real chat export previewable.

Other gaps were missing metadata in recorded command results, registration mounted only in the main view, and failed registration only becoming eligible again after a session change; the current implementation also permits another attempt after reconnecting.

## Design

### Export and transport

The existing export command writes exactly the same UTF-8 file. In ACP mode, it additionally returns its title, format kind, canonical workspace-relative path, MIME type, and byte size. Markdown, JSON, and JSONL are explicit exports, so they do not use the narrower extension allowlist intended for automatic tool artifacts.

The non-interactive command dispatcher forwards the descriptor. The ACP message emitter includes it under `_meta.sessionArtifacts` with `source: slash_command`. The key is separate from `_meta.artifacts`, which the bridge reserves for ingestion from terminal tool updates. No fake tool call is emitted and the existing ingestion or publication trust rules are not widened.

The ACP result recorder stores `sessionArtifacts` in the existing command output-history item. The shared replay projector restores the same metadata, so the client can associate the saved artifact with its command after history reload, including daemon restart. Other command records continue to replay unchanged. Only the ordinary message-result path is required: `/export` does not return streamed command messages.

### Registration and visible output

A shared parser accepts only slash-command descriptors for workspace files of kind `file` or `html`. It rejects malformed descriptors, absolute paths, parent traversal in either slash convention, and alternative locators. Literal backslashes in POSIX directory names are preserved. Drive-like prefixes such as a POSIX directory named `c:` are conservatively rejected by the cross-platform descriptor parser. The daemon's artifact API remains authoritative for path validation, workspace ownership, quotas, and persistence.

Registration runs with the existing session-artifact hook, including split panes. It waits for the session catalog and transcript catch-up, skips paths already registered, and binds asynchronous results to the captured session owner. This avoids rewriting an existing artifact's client ownership when another browser opens the session. Concurrent registration by another client can return `403 session_artifact_forbidden`. Refresh the current owner's catalog and treat the conflict as success only when it contains the exported workspace path; all other failures retain a localized error toast. Overlapping successful refreshes can confirm registration without overwriting a newer catalog response. StrictMode effect replay does not submit the same path twice. A failed path remains marked attempted for the current owner/session/connection, so subsequent transcript updates do not repeatedly submit it or show repeated error toasts. Reconnecting or remounting allows another attempt. There is no polling loop or background retry service.

The transcript presentation adapter retains reported artifact references on assistant messages. Output carrying valid export descriptors stays literal instead of entering insight-JSON segmentation, including when an export directory name resembles insight metadata. Other commands such as `/insight` retain their existing progress/report rendering. The turn-output selector matches those workspace paths against the actual catalog and attaches the existing `TurnOutputs` cards to the slash-command turn. An advisory descriptor alone cannot create a clickable card: the catalog must contain the artifact. Preview, download, workspace selection, and sandboxed HTML rendering continue through the shared artifact components.

### Complete previews

Keep the daemon text reader for small files and its encoding detection. Request an explicit 256 KiB window. If the result is truncated, reuse `readWorkspaceFileAsBlob`, the existing byte-download reader, and decode the complete bytes with the encoding reported by the daemon.

This preserves long lines, Unicode, BOM handling, and newline boundaries. It reuses the download reader's 100 MiB ceiling, cancellation checks, workspace-owner guard, and file size/mtime consistency checks. Oversized or changing files show an error rather than a partial HTML document presented as complete; failed reads stop showing the loading placeholder. Download continues to return the original bytes. No text cursors are concatenated.

Preview and download share sequential 256 KiB byte windows, matching the existing endpoint limit (previously the client requested 100 KiB). No server limit or concurrency change is required.

### HTML chat-export compatibility

All HTML previews, including chat exports, use the original document in an opaque sandboxed iframe. There is no host transcript reconstruction. The trusted outer frame continues to block child navigation; neither frame receives `allow-same-origin`.

For documents with `script#transcript-document[type="application/json"]`, the trusted Web Shell loader reads only the expected renderer/stylesheet elements. Their URLs must exactly match `https://unpkg.com/@qwen-code/qwen-code@<current-web-shell-version>/export-transcript-document.js` and `.css`, without queries or fragments, and include SHA-384 integrity metadata. The build version is trusted application configuration, not document input: arbitrary version paths cannot carry document data to the CDN. Exports targeting another version do not automatically render; original files and downloads remain unchanged. Large exports retain the default source preview.

The parent page fetches these two resources using the original SRI values, omitted credentials, no referrer, and redirect rejection. Browser integrity verification must succeed before bytes are embedded as data URLs. The iframe receives no CDN allowlist: its policy permits inline/data scripts and styles while network requests remain blocked. A second external element or dynamically created request therefore gains no network permission. Loading failures produce an error rather than a perpetually loading preview. The original export and downloaded bytes are not rewritten.

Production Web Shell headers permit data scripts/styles and parent fetches to the Qwen package namespace. The child policy does not inherit that network allowance as an effective permission because its own `default-src 'none'` further restricts it. Vite retains its original CSP. Fixing chat-export HTML rendering in development is deferred; this version does not claim support for it. Embedded hosts need compatible parent policies. The header change affects Web Shell serving, not interactive CLI export logic.

The added parent-page permissions apply to the entire shell, not only this loader, and require explicit maintainer acceptance. The child sandbox does not remove that parent-page tradeoff. This implementation reuses the original export asset URLs and SRI; same-origin resources are an alternative, not ruled out by the library build. Although the package ships renderer files beside the Web Shell directory, the current static middleware does not expose them. A same-origin approach needs an explicit resource-serving contract for daemon and embedded hosts, and must still account for exported integrity/renderer identity; a matching package version alone does not guarantee matching bytes. Inlining verified assets could remove the added data-script/style permissions, but would not remove CDN fetch permission while assets still come from the CDN.

Source builds can reference unpublished renderer hashes despite using a published package version. Such exports fail SRI both in an iframe and when downloaded and opened directly: the package version alone does not identify the local build's bytes. The existing export build supports explicit delegation via `QWEN_EXPORT_RENDERER_IDENTITY`, `QWEN_EXPORT_RENDERER_INTEGRITY`, and `QWEN_EXPORT_RENDERER_CSS_INTEGRITY`. Changing renderer publication or build selection is outside this artifact integration. No new build command, automatic delegation, SRI bypass, or rewriting of old files is included. Download returns original bytes. A running daemon/session process can retain its imported template after disk outputs change; frontend reload alone does not reload that backend template.

Markdown renders directly with the existing Markdown component and styles in the host page, preserving image handling, footnote preview cards, and interactive controls. It does not serialize React markup or use a Markdown iframe. HTML retains its sandboxed iframe. Large Markdown files default to source before the Markdown component mounts; explicit full rendering still runs on the main thread.

### Large-file rendering

Chunked reads do not make rendering incremental: after reading the complete file, the old preview still parsed and mounted the entire document. The actual 1.9 MiB chat export mounted 757 message rows and roughly 40,000 DOM nodes; the actual 4.5 MB Markdown blocked browser interaction.

HTML and Markdown use one byte-size rule: files above 1 MiB (1,048,576 bytes) default to complete read-only source. Files exactly at the limit retain rendered preview. Workspace files use the daemon's reported file size, or the full downloaded blob's size; attachments retain the original blob size before decoding, and content-only previews without file metadata use their UTF-8 byte size. Character and line-count heuristics are removed.

The guard applies before HTML parsing, including CSP wrapping and Markdown conversion. A button at the right edge of the localized notice allows full rendered preview and switching back to source. Ordinary HTML retains its existing sandbox. Chat-export HTML retains the existing document renderer when rendering is requested; no new chat virtualizer or transcript scrolling behavior is introduced. The source preview reuses the existing CodeMirror editor in a bounded viewport. This rendering rule applies to HTML/Markdown from ordinary artifacts, attachments, and slash-command exports. JSON, JSONL, and other text formats already use the same read-only source editor; they have no separate rendered view to switch off. Download is unchanged.

## Constraints and risks

- Registration still requires a connected Web Shell client. The file is written by the CLI regardless; other ACP clients can ignore the advisory metadata. This is intentionally a Web Shell integration, not a new daemon artifact producer.
- Files outside the bound workspace cannot be represented as workspace artifacts. The CLI export behavior remains unchanged in that case, and no descriptor is advertised. Worktree/runtime mapping must not fall back to the primary workspace.
- Existing artifact retention, capacity, deletion, and missing-file behavior remain authoritative. Export descriptors can be replayed, so an unregistered path can be registered again when the history is reopened; explicit durable removal semantics are not added here.
- Complete byte fallback applies to all workspace text previews, including JSON/JSONL and ordinary source files. This changes large-file behavior from a rejected unwindowed text read to automatic complete loading up to the existing 100 MiB download ceiling. The 1 MiB rendering rule runs after loading and is not a read, decode, or memory budget, including for HTML/Markdown. A source/render toggle would not limit this cost. Any future automatic-read limit must be enforced before full byte loading. Unsupported encodings and file changes surface as errors; byte download remains independent of text rendering.
- The 1 MiB threshold is a product rule, not a rendering budget. Smaller complex documents and explicit full previews can still block the page; iframe sandboxing is a security boundary, not CPU isolation.
- Reading both a text prefix and the full bytes costs one extra request for large files. This reuses existing encoding detection rather than adding another decoder or endpoint.

## Validation and acceptance

1. On a real local daemon, `/export html` creates one file and one visible card in the same turn. Opening it renders the exported session; download bytes match the workspace file.
2. Repeat for Markdown, JSON, and JSONL, using each format's existing preview and download behavior.
3. Test a large export above 256 KiB, including a long line, Unicode, and content near the document end. Verify the preview is complete and the download matches the original.
4. Refresh and reload persisted history: no duplicate artifact, and the card still belongs to its original turn.
5. Verify subdirectory exports and rejection of paths outside cwd. Verify secondary workspace routing and split-pane registration through the shared owner-bound paths.
6. Verify ordinary interactive and non-interactive CLI exports retain their original result and file-writing behavior.
7. Run package-scoped regressions, build, and typecheck. Record actual browser results and screenshots separately from mocked unit coverage; do not claim untested behavior as verified.
8. With a template targeting published renderer assets, export through a real daemon and verify both the artifact iframe and the unchanged downloaded file opened directly against genuine CDN responses. Record the renderer configuration; do not present this as proof that unpublished source builds are publicly available.
9. Verify HTML and Markdown render at exactly 1 MiB and default to source above it, including constructed large chat-export HTML. Verify source content reaches both ends, the localized toggle sits at the right edge, HTML renders inside its sandboxed iframe while Markdown uses the existing host component with working same-origin images and footnotes, and downloads remain byte-identical.

The local E2E report and screenshots are under `.qwen/e2e-tests/web-shell-export-artifact/`. The 1 MiB source-default policy and direct Markdown rendering supersede the earlier 10 MiB Markdown iframe checks; retain historical reports as evidence of their original scope only. Published-renderer verification used explicit build-time delegation and genuine CDN responses. The development-build helper used in that experiment was subsequently removed at the user's request; those results demonstrate preview/download compatibility under matching asset configuration, not an automatic source-build fix. Older mismatched exports remain unchanged. Split-pane and secondary-workspace browser flows were not exercised in this run.

Follow-up fix verification is recorded in the local `final-read-race/` report: actual UI with a mock daemon covers HTML/Markdown above 1 MiB with truncated text responses, complete byte reads, source tails, byte-identical downloads, and failed chunks without residual loading placeholders. Actual hook/store integration covers duplicate-client registration, catalog convergence, and other 403 errors remaining visible; this does not claim real browser split-pane or real daemon filesystem verification.

Security follow-up: repository tests cover exact resource selection and dispatcher metadata forwarding. Local browser evidence under `export-artifact-csp-probe/fixed/` verifies SRI failures, offline child frames, blocked duplicate/dynamic external scripts, and actual preview success/error UI using simulated CDN responses and the production parent CSP. These local records are not repository-accessible evidence; attach reviewable evidence to a future PR.
