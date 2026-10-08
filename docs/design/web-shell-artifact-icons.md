# Web Shell artifact icons

Artifact cards and artifact panel tabs use one shared icon renderer. Built-in
SVGs are selected from the artifact file extension first, then its MIME type or
kind. Existing Lucide icons cover artifact kinds without bundled artwork, with
the generic file icon as the final fallback.

Hosts can provide `artifact.renderImage`. It receives the complete artifact
record and may return a replacement React node; a nullish or false result keeps
the built-in icon. The artifact namespace leaves room for title and description
renderers without adding them before they are needed.
