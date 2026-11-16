# Web Shell image URL paste

[English](web-shell-image-url-paste.md) | [简体中文](web-shell-image-url-paste.zh-CN.md)

## Problem

Issue [#16088](https://github.com/QwenLM/qwen-code/issues/16088) describes two
silent image-paste paths: nonempty plain text bypasses image ingestion, and a
clipboard advertising `Files` without exposing file objects is not claimed.
Text priority was introduced for editable PowerPoint content in
[#11334](https://github.com/QwenLM/qwen-code/pull/11334), so reversing priority
for every mixed clipboard would regress that behavior.

## Decision

Prefer the image only when a paste targets the editor, the composer is enabled,
attachments are enabled, shell mode is off, the draft does not start with `/` or
`!` after leading whitespace, and the clipboard contains exactly
one image file candidate, no other file candidates or rejected items, and
plain text consisting of one HTTP(S) URL after trimming surrounding whitespace.
Use the existing attachment queue and consume the event. All other mixed
text/file pastes retain text priority, including multiline PPT text. Apply the
same rule to desktop, collapsed touch, and expanded touch editors. Other text
controls on the composer surface keep their own paste behavior.

Use the existing file-payload predicate for both paste and drop ownership. When
a paste without plain text advertises files but exposes no candidates or rejected
items, record one unavailable item so the existing ingestion notice explains the
skipped payload.
Ordinary text and HTML-only pastes do not gain a warning. Drop notices are
unchanged.

## Constraints and risks

The URL rule is a heuristic: a literal URL copied from an office document with
one bitmap will also prefer the image. Clipboard shapes alone cannot reliably
identify the user's intent. Captions, non-HTTP(S) URIs, multiple images, and
unavailable images retain text priority. No clipboard permission, asynchronous
clipboard API, daemon change, or dependency is introduced.

## Validation and acceptance

- URL plus one image attaches the image without inserting its URL.
- PPT text plus a bitmap remains editable text without an image attachment.
- Image-only paste works; a plain URL without an image remains text.
- Disabled attachments, shell mode, command drafts, and other text controls retain
  text behavior, including URL arguments accompanied by a bitmap.
- Advertised but unavailable file paste emits the existing warning once.
- Utility and desktop/touch DOM regressions cover the decisions above. Browser
  E2E uses synthetic clipboard events and a mock daemon; it does not establish
  actual Linux, browser, or office-system clipboard formats.
- Run the full build, bundle, repository typecheck, and focused tests.
