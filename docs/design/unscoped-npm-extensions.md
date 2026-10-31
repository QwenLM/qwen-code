# Unscoped npm extension sources

[English](unscoped-npm-extensions.md) | [简体中文](unscoped-npm-extensions.zh-CN.md)

## Problem and scope

Extension installation and update parsing currently require `@scope/name`.
Support `name`, `name@version`, and `name@tag` through the same npm delivery
path, including CLI and daemon installation. Do not add npm aliases, change
version-selection policy, or change runtime ownership.

## Design

- Extend npm parsing and add a general source predicate. Keep the exported
  scoped-only predicate compatible.
- Preserve existing local-file/directory precedence, URL handling, and
  `owner/repo` GitHub shorthand. Explicit paths must not become npm sources.
  A missing bare filename that is also a valid package name is an npm source;
  use an explicit path when a local file is intended.
- Unscoped packages use an explicit registry override, default `.npmrc`
  registry, or npmjs. They never select a scoped registry. Persist the registry
  and source as before so updates use the same package and registry.
- Extend daemon preflight for bare npm sources while preserving existing scoped
  marketplace selectors and URL validation. Unscoped marketplace selectors over
  daemon routes remain outside this change. Route ownership is unchanged:
  the global mutation flow keeps its existing preparation/commit context;
  selected-workspace routes keep their resolved runtime.
- Update CLI help and user-facing npm documentation.

## Consumers and affected files

The core npm and marketplace modules serve CLI install, TUI extension actions,
Web Shell discovery/source registration, and daemon install routes. Extension
manager installation/update preparation downloads npm packages; the shared
update dispatcher serves CLI/TUI updates and background checks. The daemon
preflight in `workspace-extensions.ts` also needs the general predicate.
Managed-package preparation also consumes the shared parser and npm downloader.
Collocated core tests and daemon server tests cover the changed boundaries.

## Validation and acceptance

Use an isolated fixture npm registry and harmless package with a root extension
manifest. Verify scoped control, unscoped bare/latest installation and upgrade,
exact-version pinning, beta-tag upgrades, repeated up-to-date checks, and no npm
requests for explicit missing paths. Unit tests cover source classification,
registry resolution, download URLs, and daemon preflight. Run build, typecheck,
bundle, focused tests, and two self-audit passes. Baseline and E2E evidence live
in `.qwen/e2e-tests/unscoped-npm-extensions.md`.

## Risks and open questions

Bare package names can overlap local filenames; existing local entries keep
priority. Existing relative-path/GitHub shorthand ambiguity is outside this
change. No open design questions remain.
