# ACP Skill management module

## Context

The ACP agent currently owns remote Skill source validation, GitHub download and archive extraction, local installation, deletion, and enablement inside the same file as session and workspace control. The Skill logic is cohesive but its implementation is spread between top-level helpers, private agent methods, and three extension-method branches.

## Goals and non-goals

This refactor gives Skill source acquisition and managed Skill mutation dedicated modules while preserving the existing extension-method interface, validation, filesystem safety, cache refresh ordering, responses, and errors.

It does not change Skill discovery or status projection, add new scopes or source hosts, alter session Skill refresh, or change any Web Shell, bridge, or SDK contract.

## Module seams

The source module owns HTTPS and GitHub host validation, redirect validation, download limits, GitHub directory traversal, archive fallback, and tar extraction. Its primary interface resolves one source URL into the manifest content and files to install.

The management module owns request validation, global and project Skill resolution, frontmatter enablement, atomic installation, guarded deletion, and cache refresh. The ACP agent delegates install, delete, and set-enabled requests without interpreting their payloads.

The filesystem and network implementations remain direct dependencies. Tests use temporary directories and stubbed fetch responses; no new adapter layer is introduced.

## Preserved invariants

- Installation and deletion remain global-only; enablement retains global and project scopes.
- Skill slugs reject traversal and path separators.
- Remote sources remain HTTPS-only and limited to the existing GitHub host set.
- Redirect, compressed-size, decompressed-size, directory-depth, file-count, and cumulative-size guards remain unchanged.
- Installation validates the parsed Skill name, stages every file in a sibling directory, and refreshes the cache only after the swap succeeds.
- Deletion only removes a dedicated directory containing the validated `SKILL.md` and never removes a filesystem root or the global Qwen directory.
- Enablement edits only the top-level `disable-model-invocation` field and preserves comments, nested frontmatter, and body content.
- Extension-method response shapes, error types, error text, and requested working-directory behavior remain unchanged.

## Verification

Focused tests cover source and archive safety, global and project mutations, frontmatter preservation, route delegation, and the existing ACP integration behavior. The CLI package tests run alongside the repository build and typecheck.
