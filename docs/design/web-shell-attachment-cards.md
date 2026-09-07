# Web Shell attachment and file reference cards

Attachments currently render as single-line chips. Render pending and sent file
attachments as rounded cards with an inset file-type icon and a filename/type
stack, matching the supplied reference. Workspace upload progress retains its
status and cancel action. Completed uploads still insert ordinary file references.

File references remain compact icon-and-title chips in the composer and sent
messages, sharing the existing FileTypeIcon mapping used by artifacts. Preserve
custom renderers/icons, directory semantics, full-path serialization, preview,
removal, keyboard access, image thumbnails, and theme isolation.

Changes are confined to Web Shell presentation, shared attachment content, and
focused regression tests. No daemon, transport, or artifact behavior changes.

Artifact SVG artwork is brought in by merging the local
`codex/web-shell-artifact-icons-main` branch. FileTypeIcon now shares that
component's format resolver and URL map; formats without specific artwork keep
the existing Lucide fallback. The outer SVG preserves existing sizing, CSS and
ARIA props while referencing the same asset as artifact cards.
