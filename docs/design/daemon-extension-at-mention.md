# Daemon @extension Mention Support

## Goal

Daemon WebShell should match the CLI extension mention behavior for active extensions. Users can discover active extensions from `@` completion, select a canonical `@ext:<name>` mention, and have the daemon inject that extension's context into the model turn without changing the visible prompt text.

## Design

- WebShell `@` completion combines active extension entries from workspace extension status with existing workspace file matches. Bare `@` shows extensions first, `@bro` filters extensions and files, and `@ext:` switches to extension-only completion.
- Extension completion inserts `@ext:<extension.name> ` so the daemon receives a stable reference independent of display text.
- Daemon extension status includes an optional `description` field populated from installed extension config. The field is additive for older clients.
- ACP session prompt resolution scans text prompt blocks for `@ext:<name>` tokens, matches only active extensions from session config, dedupes repeated mentions, and silently skips unknown or inactive names.
- The user-visible text is preserved exactly. Resolved extension context is appended as extra model text parts after the user's text.
- CLI and daemon share extension mention helpers for parsing, sanitizing display text, formatting capabilities, and reading context files with subpath and size guards.

## Bounds

Context file reads are limited per file and by aggregate extension context budget. Files outside the installed extension directory are skipped, unreadable files are skipped with debug output, and repeated mentions consume budget once.

## Verification

Targeted tests cover WebShell completion modes, daemon ACP context injection, repeated and unknown mentions, bounded context files, and the existing CLI extension mention processors. Final verification runs the repository build and typecheck.
