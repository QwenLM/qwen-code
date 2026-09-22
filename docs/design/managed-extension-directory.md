# Managed extension directory

[English](managed-extension-directory.md) | [简体中文](managed-extension-directory.zh-CN.md)

## Problem and scope

Immutable images, shared installations, and managed runtimes need to supply the
same Qwen Code extensions to multiple users and workspaces. Requiring an install
or link step in each user's home couples extension discovery to mutable,
per-user setup, even when the packages are already available on disk.

An optional `--managed-extensions <root>` lets CLI and serve load those packages
directly, including with a fresh user home. Package contents remain owned by the
deployment, while activation preferences and runtime state remain writable in
user storage. Each direct child uses the existing `qwen-extension.json` format
and contribution loaders, so extension authors do not need a second package
format.

The option selects one collection root at process startup. No recursive scan,
additional public environment variable/settings option, watcher, package format,
marketplace, state-format migration, or deployment-specific packaging is introduced.

## Launcher authorization

The explicit process-start option authorizes loading the deployment-maintained source, including later packages and versions delivered through it. For personal use, the launcher is the user. In a hosted product, the operator supplies the source as part of the Agent runtime. Session metadata, project settings, and project environment files cannot select or replace it. There is no new public environment variable in this initial interface; the normalized startup value is carried explicitly through existing process launch arguments.

Managed describes package ownership, not Qwen authorship or execution isolation. Hosts should identify their provider and customization. Existing workspace trust, safe/bare modes, and tool permissions retain their individual controls; source authorization does not imply that every hook or MCP startup passes through a tool-call confirmation. Users retain default and workspace activation controls. The consent model and same-name precedence remain policy decisions for review in issue [#12147](https://github.com/QwenLM/qwen-code/issues/12147).

## Discovery and state

The CLI resolves the root against its startup cwd once. A missing, non-directory,
unreadable, or symbolic-link explicit root is a configuration error; an empty root
is valid. The accepted root is pinned to its canonical path at startup so later
relinking cannot move the boundary consumers validated.
ExtensionManager receives `managedExtensionsDir` separately from the writable
ExtensionStore. A container sandbox (docker/podman) mounts the resolved root
read-only and forwards the flag with the container path; the bwrap and seatbelt
backends already expose the host filesystem for reads. Reject overlaps (including symlink and filesystem case aliases) with writable
extension/state directories to preserve the read-only boundary. Discovery and lookup share the same resolver: validate managed
names using existing rules, reject duplicate managed names case-insensitively,
then give managed precedence over user packages and diagnose shadowing. Resolve
ownership before activation so disabling managed never activates a shadowed copy.
An individual invalid manifest uses the existing diagnostics. The daemon catalog uses the same source precedence and identities while reading manifests only. Re-reading an unchanged catalog preserves existing policies and store generation without hydrating extension contributions.

Loaded extensions expose `source` (`managed` or `user`). Managed identity is derived
from normalized name, not version or deployment path. Manageds default enabled;
explicit activation and workspace preferences remain in the user state store and
survive version changes. Existing same-name user preferences are inherited through
the store’s existing name-based policy migration. Trust, safe mode, name filters (`-e/--extensions`), and tool
approval retain their existing, contribution-specific behavior. No install metadata is required or followed for managed.

For managed packages, CLI User-scope enable/disable changes the stored default
activation across all workspaces, including workspaces outside the user home.
Explicit managed User-scope actions and management API default-activation changes
(including batches) clear inherited legacy path rules so they
cannot silently override the action. Exact workspace overrides retain their
existing precedence. A stored default makes a user's explicit choice apply
consistently to deployment-managed packages across workspaces. User-installed
packages keep their legacy home-path scope behavior for compatibility.

Discovery passes each extension's source to the state store. An optional `managed: true` marker in the existing V2 policy distinguishes externally discovered packages from installer-owned artifacts without relocating state or changing its version. Existing activation preferences and inherited artifact bookkeeping remain intact. Batch activation checks for missing user artifacts only for non-managed policies; rediscovering a user package or completing an install/update clears the marker. Promoting a managed preference-only declaration does not manufacture an installer generation. This keeps batch and single activation consistent even after an old user copy is removed, without relying on a later refresh to repair state.

## Contributions and refresh

Reuse extension skills, subagents, hooks, MCP, context, commands, and the existing runtime
refresh chain. Substitute existing root variables in memory against the actual
extension directory, including content previously rewritten during installation.
Subagent YAML is parsed before recursively substituting structured string values;
the existing final configuration validation remains after substitution. This
preserves backslashes and quotes in deployment paths without YAML reinterpretation.
Never rewrite managed content. Source fingerprints include managed manifest metadata and membership as the
existing revalidation safety net; explicit full refresh rereads contributions,
including content-only changes, replacement, and removal. Refresh invalidates a loaded skill’s current-name cache when its body changes,
is disabled, or disappears, including version rollback. Unchanged skill bodies retain the existing deduplication.
Historical conversation records and context accounting remain intact. Repeat refresh
must not duplicate contributions; disabled or removed content is withdrawn using
the existing refresh semantics. Managed roots are not added to the user-extension file watcher; use explicit refresh or restart after deployment changes.

## CLI, daemon, and API

Both normal parsing and serve's fast path accept the same string option and pass
one absolute value to runtime creation. Every workspace and every ACP child
creation, load/resume, or replacement path inherits it through existing launch
configuration/arguments. Session requests cannot override this process-level
choice. Existing selected-workspace management and active-session reconciliation
refresh actual agents, not just the parent's cache. The existing channel worker and standalone channel
ACP launch paths receive the same root; channel lifecycle/reload behavior is
unchanged. `-e/--extensions` remains a normal-CLI name filter; serve does not gain
a separate filter option.

Management CLI, daemon status, and existing extension UI expose source and manifest
version. The API adds an optional `extensionSource` discriminator while retaining
its existing `source` URL field. Core operations reject managed uninstall, update,
and replacement independently of permissions/UI. Update-all skips managed with a
clear result and continues user updates. Configuration and activation still write
only user state. The Web UI hides managed package paths and the unsupported
artifact-actions menu; context files use relative display names. Activation
controls remain available. CLI/API paths remain available for diagnostics.

## Implementation areas

- CLI config/extension commands, serve parser/options/runtime creation/ACP args.
- Core ExtensionManager discovery, identity, fingerprint, mutation guards; shared
  ExtensionStore activation storage with managed-specific default handling.
- Contribution readers where installation-time text rewriting was previously
  required; runtime substitution remains read-only.
- Daemon extension status and SDK types; existing management UI and list output.
- Collocated tests, integration tests, and extension usage documentation.

## Validation and acceptance

Use independent dependencies, temporary homes/workspaces, random loopback ports,
a fake model and HTTP MCP server. Verify read-only roots by permissions AND a
before/after file-content inventory. Exercise actual skill reads, hooks, MCP tool
calls, context/commands, CLI/fast-path equivalence, new/resumed/multiple-workspace
ACP sessions, active refresh, conflicts, persisted disable/re-enable, duplicate
names, invalid roots, and protected mutations. Run build, typecheck, focused tests,
and full preflight. Compare any failures to the exact unmodified base under the
same conditions; report incomplete checks rather than exempting historical failures.

## Risks and follow-up

Managed precedence keeps the deployment-selected package authoritative when a
user package has the same name. The shadowing warning makes that conflict visible;
disabling the managed package does not select a different implementation. Users
who need both packages must give them distinct names.

Name-based identity preserves activation preferences when a package is upgraded
or its root moves. It also means a different package reusing the same name
inherits those preferences. Deployment owners should keep names stable and avoid
reusing them for unrelated extensions.

After a managed package is removed from its source, an explicit user installation of the same name can adopt its retained activation and resource preferences when no user package is already installed. Installation checks the managed source again immediately before commit, including for a prepared installation; a filtered discovery result does not establish removal. The store transfers the policy atomically to the user identity and removes the managed marker. A previously installed shadowed user package is rediscovered normally. An obsolete managed identity cannot uninstall the replacement user package. A settings-only directory at the installation destination can be adopted when it is empty or contains only a regular `.env` file. Existing values are retained and explicitly prepared values take precedence. Unknown contents, symlinks, existing packages and secret-selector metadata remain conflicts; failed commits restore the original directory and policy.

Read-only loading does not make deployment changes atomic, and no watcher is
added. Deployment tooling remains responsible for publishing complete package
contents and explicitly refreshing affected workspaces or restarting the process.
Package distribution and automatic deployment updates are outside this design.
