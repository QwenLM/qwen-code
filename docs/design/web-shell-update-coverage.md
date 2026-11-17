# Web Shell update coverage

[English](web-shell-update-coverage.md) | [简体中文](web-shell-update-coverage.zh-CN.md)

This increment extends [Web Shell update](web-shell-update.md). The route
shape, activation order, and restart semantics defined there are unchanged.

## Problem and scope

One-click update (background prepare plus explicit restart) is offered only to
standalone installations and global npm installations whose global prefix is
writable. Two gaps follow:

1. The managed staging machinery is package-manager agnostic, yet the route
   gates it on `packageManager === npm` plus a writable prefix. Global
   installations detected as pnpm, yarn, or bun, and npm installations whose
   global prefix requires sudo, are excluded even though nothing in staging or
   activation touches the global prefix: the staged release is installed with
   npm into a user-scoped isolated prefix under the Qwen home directory, and
   the shared `cli-entry.js` launcher — identical in every published package
   regardless of the installing package manager — resolves the `active.json`
   pointer on the next start.
2. When an update exists but one-click is not possible (`canInstall: false`),
   the API already returns manual `instructions`, but the Web Shell renders
   nothing: the update control only appears in the `ready` state. Users of
   Homebrew, npx, and local installations see a stale version with no
   guidance. (Windows and development-mode daemons report `unavailable`
   rather than `available`, so they show nothing before and after this
   change.)

This increment closes both gaps. It does not add Windows process replacement,
embedded-host restart, or any new route.

## Design

### Server: widen managed staging eligibility

The update controller offers managed staging when the installation is global
and its detected package manager is npm, pnpm, yarn, or bun. The writable-prefix
condition (`updateCommand` present) is dropped: staging installs into the
user-scoped update root with an isolated npm prefix and never writes to the
global prefix, so a root-owned prefix is not a barrier. Homebrew stays manual;
its formula owns the installation lifecycle.

The identity gate is unchanged and remains the real safety boundary:
`QWEN_CODE_CLI` plus `QWEN_CODE_MANAGED_NPM_PIN` must resolve to the same
`cli-entry.js`, whose adjacent manifest must be the published
`@qwen-code/qwen-code` package. Installations launched any other way (dev
trees, embedded hosts, repackaged binaries) keep `canInstall: false`.

Staging, activation, locking, smoke tests, and cleanup reuse
`managed-npm-update.ts` without modification. An explicit install by any
package manager still changes the base manifest or launcher ctime and
supersedes the managed pointer, exactly as today.

### Client: manual instructions instead of silence

When the status is `available` with `canInstall: false` and non-empty
`instructions`, the update control renders the same version-adjacent button
(icon-only when the sidebar is collapsed). Clicking it opens a popover instead
of restarting: the target version, a one-line explanation that this
installation cannot be updated from the Web Shell, and the instruction lines
in a monospace block. The popover uses the shared Popover primitive, which
portals into the Web Shell portal root. The button never calls prepare or
restart in this state.

All other states keep their current behavior: silent check and prepare,
button only when `ready`, explicit restart with downtime tolerance and
return-to-URL. Strings are added to both locales.

The affordance covers installations whose check reports an `available` update
with manual instructions, such as Homebrew, npx, and local installs. Windows
daemons have no restart callback and development-mode checks are skipped, so
both report `unavailable` and intentionally keep showing nothing; this
increment does not change those exclusions.

In the rail layout the manual panel opens from inside the More menu. Its
focus and pointer interactions are exempted from the More popover's
outside-interaction dismissal, alongside the existing local-files and
desktop-relay panels, so both layers stay open while the user reads or
selects the instructions.

## Ownership and impact surface

Both changes stay process-global to the daemon, with the existing
authentication, primary-listener, and operator-settings gates. No SDK type
changes: `instructions` is already part of `DaemonUpdateStatus`. Consumers are
the daemon update route and the Web Shell sidebar; the protocol reference is
updated to describe the widened eligibility and the manual-instructions
affordance.

## Validation and acceptance

Unit tests cover the widened eligibility (pnpm/yarn/bun global and sudo-npm
installations with a valid launcher stamp offer `canInstall: true`; Homebrew
and non-global installations keep manual instructions; a missing or foreign
launcher stamp still refuses), and the client affordance (button appears only
with instructions, opens the popover, never prepares or restarts, collapsed
and Chinese variants). The browser regression adds a manual-instructions
scenario alongside the existing one-click scenarios.

Acceptance: a global pnpm/yarn/bun or root-owned npm installation with the
published launcher gets the same one-click flow as a writable npm
installation; an installation whose check returns an available update with
manual instructions shows those steps next to its version instead of nothing,
and in the rail layout both the More menu and the manual panel stay open while
the instructions are read or selected; installations without instructions and
all non-`available` states — including Windows and development-mode daemons —
render exactly as before.

## Open questions

None.
