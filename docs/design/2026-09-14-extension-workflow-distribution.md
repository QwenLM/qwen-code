# Extension workflow distribution

[中文](./2026-09-14-extension-workflow-distribution.zh-CN.md)

Tracking issue: #11013, item 12 (distribution half); #8105 PR 15.

## Problem

Saved workflows could only live in a project (`.qwen/workflows`) or in the user's home (`~/.qwen/workflows`), so there was no way to hand a reusable workflow to someone else. Claude Code plugins already ship workflows through a `workflows` manifest field and a default `workflows/` directory. Extensions are Qwen Code's distribution unit, but extension files are third-party code, so the feature has to widen distribution without widening what a workflow run can read.

## Decisions

### A third saved-workflow tier

Active extensions contribute a third tier to `workflow-saved.ts`, the module that already owns project and user workflows. Every consumer — the `/<name>` slash commands, `workflow('<name>')` inside a script, and the ACP saved-workflow list, detail and run-saved surfaces — reads that one module, so none of them grew a separate extension path.

An extension workflow is always addressed as `<extension name>:<meta.name>`, the same shape as extension skills and Claude Code plugin workflows. The name comes from the script's static `export const meta`, so a file name may differ. Project and user names are file stems matching `^[a-z][a-z0-9-]{0,40}$`, which cannot contain `:`, so the tiers cannot shadow each other; precedence is still written project over user over extension. If one extension ships a skill and a workflow with the same name, `CommandService` renames the workflow command to `<extension>.<name>`, as it does for any colliding extension command, and the command keeps its documented name for `slashCommands.disabled` matching: the skill stays on every surface, including headless, ACP and the model's command list, and one denylist entry written with the documented name removes both. A user or project custom command of the same name loads last and keeps the slash command; the workflow stays reachable through `workflow()`, the ACP saved-workflow surfaces and the web-shell Workflows page.

### Discovery

`workflow-extension.ts` reads the default `workflows/` directory, or exactly the directories and `.js` files the manifest lists (`null` means undeclared). It reads one directory level, refuses paths that resolve outside the extension, refuses symlinks, caps each file at 256 KiB, and parses `meta` with the existing static parser without executing the script. `meta.description` is shortened to 500 characters because it reaches the consent prompt, the command list and the approval dialog. A bad file, or a declared directory that cannot be read, is skipped with a warning and never fails the extension load or drops the paths declared after it.

### The read boundary

A workflow `{ scriptPath }` load is checked by `readWorkflowFileSecurely`, which proves a file sits under a trusted root but does not check that it is a workflow script. Extension directories are therefore **not** added as roots: a root is a grant over every file beneath it, and an extension declaring `"workflows": "."` would expose its `.env` settings file. Instead, a discovered extension file is readable by its exact real path, recorded at load. A file swapped for a symlink after load resolves elsewhere and stops matching. Only `getActiveExtensions()` contributes, so disabling an extension removes its workflows from every surface at once.

### Consent

The install and update consent prompt lists each workflow's name and description, and an update re-prompts when that list changes. Consent discovery resolves environment variables in `workflows` the way loading does. A copied install replaces each symlink with the file it points to, so consent discovery for a copied install follows symlinks and checks containment on the path as spelled; a linked extension loads its source as-is, so its consent uses the runtime rules. Like skill and subagent discovery, consent reads through a symlink whose target lies outside the package, because the copy materializes that target; whether copying should skip such links for every resource type is a repository-wide question left to a follow-up. A change to a script's code alone does not re-prompt, and a path-scoped "always allow" survives an update; both are documented.

### Surfaces and gates

Extension workflows reuse the existing gates: the Workflows feature flag, bare mode and folder trust for slash commands, and the ACP workflow-control check. The slash command carries the extension's owner label as its source badge and is not model-invocable. The Workflow tool's description, parameter description, approval dialog and resume advice name an extension workflow as such. `/reload-plugins`, `qwen extensions list` and the extension detail views report what the extension ships, like their command, skill and agent siblings.

### Claude Code plugin conversion

The converter copies declared workflow files at their relative paths and lists them in the converted manifest, so same-named files in different directories stay distinct. Only the listed files are discovered; a plugin that declares no `workflows` keeps its `workflows/` directory as the default. A marketplace entry's `workflows` overrides the plugin's own. A symlink inside a declared directory is copied as a regular file when its target stays inside the plugin. Agent Plugins v1 packages contribute no workflows, because that schema defines none.

### Published contract

The saved-workflow `source` union in the ACP bridge status types and the TypeScript daemon SDK gains `'extension'`. `listSavedWorkflows` returns extension entries, so the runtime already emits that value on those surfaces; keeping the published type narrower than the data would mislead consumers. Consumers with an exhaustive switch over `'project' | 'user'` need a third branch.

## Not in scope

- `Workflow({ name, args })` invocation and per-name `Workflow(name:...)` permission rules that can pin a script's content.
- A bundled workflow tier and a name-only lock.
- Workflow counts in the serve extension capability payload.
- Running workflow slash commands in headless or ACP modes.
