# Explicit trust for repository execution

[English](2026-11-03-project-execution-trust.md) | [简体中文](2026-11-03-project-execution-trust.zh-CN.md)

Status: implemented, 2026-11-03.

## Problem and scope

Issue #14746 identifies that disabled folder trust makes every directory implicitly trusted. PR #14748 gates settings-file hooks separately, but project skill/subagent frontmatter hooks and workspace `.lsp.json` commands still accept that implicit trust. Project skills can also grant automatic tool permissions through the same gate.

This change closes those remaining execution paths. It does not change the default folder-trust setting, add another approval store or dialog, or modify the settings-file hook approval work in #14748.

## Decision

Add `Config.isExplicitlyTrustedFolder()`: an affirmative IDE workspace trust signal, or enabled folder trust with a trusted directory, authorizes repository execution. An IDE denial takes precedence. Missing trust, and disabled folder trust without an IDE decision, deny execution. Keep the existing `isTrustedFolder()` semantics for unrelated consumers.

Project skill side effects and subagent hooks use this predicate both at registration and at execution. Skill permission grants use the same live predicate so losing an IDE trust signal cannot leave grants active through the legacy default. Skill/agent instructions remain available. User, extension and bundled skill/agent side effects are unchanged.

The LSP loader records whether each configuration came from the workspace file or an extension. Only the loader chooses this source; JSON cannot override it. Workspace LSP configurations require explicit trust during service admission and again before any command probe, connection or process startup. This covers initial discovery, hot reload and restart. Existing extension admission and `requireTrustedWorkspace` behavior remain unchanged.

## Compatibility and risks

Users of project frontmatter hooks, project skill permission grants or workspace LSP configurations must enable `security.folderTrust.enabled` in user settings and trust their directory, or use an IDE that explicitly trusts it. Disabled folder trust no longer authorizes these executable paths, including YOLO sessions. Warnings and feature documentation explain this migration. The existing trust dialog and trust-file persistence provide the approval flow.

Trust-file edits still take effect after the existing restart boundary; IDE decisions remain live. This is directory-level trust, not a hash approval of every script or hook. It does not make an explicitly trusted malicious repository safe. Settings-file hook approval, per-skill approval and LSP-specific approval dialogs remain separate work.

## Validation and acceptance

- Reproduce both paths with fresh user settings and harmless markers before changing source.
- Default-disabled folder trust must suppress project skill hooks/grants, project subagent hooks and workspace LSP startup, including executable availability probes.
- Enabling trust and granting it, or receiving affirmative IDE trust, restores these paths. IDE denial suspends project hook/grant execution; with folder trust disabled, losing the IDE signal also suspends them.
- Workspace JSON cannot set an extension source or disable its own trust requirement. Extension LSP configurations and non-project skills/agents retain their existing behavior.
- Run focused core unit tests, build, bundle and typecheck; verify the built CLI against isolated marker fixtures. Self-audit the full diff and review the final change.
