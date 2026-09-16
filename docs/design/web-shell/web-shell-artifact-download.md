# Web Shell artifact downloads

## Goal

Let users download every kind of available workspace artifact from its transcript
card and download HTML or Markdown files beside the existing preview action in
review.

## Design

Reuse the workspace byte-reading API and browser-native Blob downloads. Keep the
download action scoped to the workspace actions that own the artifact or review
tab, and do not add a daemon route or dependency. Blob downloads retain the
existing 100 MiB safety limit; larger files fail before byte reads begin. Buttons
are disabled while downloading, and failures use the existing Web Shell error
toast channel.

All artifact kinds use the same download path. Only available workspace artifacts
expose the transcript download action because managed artifacts do not provide
downloadable bytes and published or external artifacts may only expose navigation
URLs. Review downloads are limited to HTML and Markdown, matching the requested
preview formats.
