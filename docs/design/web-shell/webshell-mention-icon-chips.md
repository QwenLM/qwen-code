# Web Shell mention icon chips

## Problem

The custom @ mention menu can insert extension, file, and MCP references, but accepted items were rendered as plain text in the composer. A previous composer path rendered these references as icon chips. The current custom mention architecture also needs a way for host-defined mention items, such as tables, to use the same chip rendering.

## Design

- Keep the @ mention menu responsible for choosing and inserting text.
- Let mention items optionally provide a `composerTag` that describes the inserted reference.
- Continue to auto-create composer tags for built-in file, extension, and MCP providers so existing built-in mentions regain icon chips without host changes.
- Add a `composerTagIcons` prop on `WebShell` so hosts can register icon URLs by `composerTag.kind`.
- Resolve icons at composer rendering time through one helper that checks custom icons first and falls back to built-in icons.
- Store resolved icon URLs only in the internal inline decoration data and strip them from public composer tag values.

## Scope

This change covers composer tag icon registration and rendering for accepted @ mention items and programmatically inserted inline tags. It does not change the visible @ mention picker rows or add a new provider registration API beyond the existing `atProviders` surface.

## Risks

- Custom icon URLs are applied through CSS masks, so URL values must be escaped before writing CSS custom properties.
- Existing inline decorations need to refresh if `composerTagIcons` changes while text remains in the editor.
