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
relinking cannot move the boundary consumers validated. A root that later becomes unavailable or is redirected remains configured for ownership and state-separation checks. If an already-pinned filesystem root is offline, separation uses resolved literal paths until it is reachable; startup validation and managed reads still require a live verified directory. Both managed discovery and read-permission exemptions require the pinned directory to pass verification again; failed verification is not proof of withdrawal. Source revalidation invalidates the managed cache when the root loses verification, including a relink to packages with unchanged manifest metadata.
ExtensionManager receives `managedExtensionsDir` separately from the writable
ExtensionStore. A container sandbox (docker/podman) mounts the resolved root
read-only at its translated container path, launch spelling, and every alias exposed by a generated read-write ancestor mount, including `/home/node/.qwen`. Settings and runtime state remain writable outside those protected subdirectories. A writable mount sourced from the managed root or one of its descendants, or an incompatible mount at a required read-only destination or anywhere below it, fails sandbox startup; the guard never silently preserves a conflicting writable mount. Readonly subtree overlays must resolve to the corresponding deployed subtree; writable ancestors covered by the managed read-only child remain supported. Advanced operator overrides through `SANDBOX_FLAGS` remain outside this generated-mount guard. The sandbox forwards the flag unchanged —
raw argv carries user content in value positions, so the flag is never
rewritten; the child's startup validation applies the same container
translation to the flag value. macOS Seatbelt (`sandbox-exec`) is unsupported when a managed root is configured, for both built-in and custom profiles. Startup refuses this combination before preparing or launching Seatbelt; use Docker or Podman instead. A path-based write denial alone cannot preserve the deployment boundary when an enclosing directory moves. Seatbelt without managed extensions keeps its existing behavior. Reject overlaps (including symlink and filesystem case aliases) with writable
extension/state directories to preserve the read-only boundary. Discovery and lookup share the same resolver: validate managed
names using existing rules, reject duplicate managed names case-insensitively,
then give managed precedence over user packages and diagnose shadowing. Resolve
ownership before activation so disabling managed never activates a shadowed copy.
An individual invalid managed manifest reserves its declared name when the manifest still yields one, and otherwise its directory name, with an stderr warning, so a same-name user package cannot silently take its place; for an unreadable manifest the reservation covers only the directory name, so deployments should name package directories after their packages. The daemon catalog uses the same source precedence and identities while reading manifests only. Re-reading an unchanged catalog preserves existing policies and store generation without hydrating extension contributions.

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

Managed scope and default-activation changes preserve late-imported legacy path rules when no earlier stash exists. An existing pre-managed activation snapshot remains authoritative at hand-back; managed-era writes do not replace it.

Activation changes first reconcile a configured managed source. Once withdrawal is proven, the returning user package receives the change after hand-back. If that user copy still has retained managed ownership because the source is unconfigured, unavailable or ambiguous, the change fails with a conflict instead of reporting a success that a later hand-back would erase. This applies to single/bulk defaults, workspace activation, scope changes and skill overrides. Store writes check the selected source against the current ownership under the lock; a still-deployed managed package continues to change only its managed-era activation, preserving the user baseline.

Discovery passes each extension's source to the state store. An optional `managed: true` marker in the existing V2 policy distinguishes externally discovered packages from installer-owned artifacts without relocating state or changing its version. Existing activation preferences and inherited artifact bookkeeping remain intact. Batch activation checks for missing user artifacts only for non-managed policies; normal runtime rediscovery after proven withdrawal or an eligible install/update clears the marker. Promoting a managed preference-only declaration does not manufacture an installer generation. This keeps batch and single activation consistent even after an old user copy is removed, without relying on a later refresh to repair state.

Successful managed discovery also remembers the package's direct-child directory and exact name spellings. A directory without a governing manifest cannot be reliably attributed: it may be an auxiliary directory or a package relocated to a never-observed directory. It does not reserve a discovery name, but it makes withdrawal unproven for all retained managed policies, so automatic hand-back, its read projection, and destructive release wait until the directory is removed or a complete manifest is published. Asset and staging directories without manifests have the same conservative effect. An empty collection still establishes absence; deployments should stage outside the collection and publish complete packages, because this feature does not make deployment changes atomic. Explicit release reloads current deployment evidence under the policy-store lock immediately before removal, including a same-directory package that reappeared while the operation waited. This narrows the stale pre-lock window; external deployment is not serialized with the store transaction. A successful discovery at a new directory updates the association; the relative directory name remains valid when the collection root moves. Credential probes and cleanup cover all recorded spellings, including intermediate case changes, without changing the existing credential service-name format. A retained managed record cannot be renamed to a different case-insensitive name until its ownership transition completes. Older records learn directory evidence on the next successful discovery and retain their known name spellings; already-lost directory associations or historical spellings cannot be reconstructed.

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
its existing `source` URL field. `extensionSource` describes the represented
package's source, not retained managed policy or permission to mutate; even a
`user` entry can be refused with `extension_managed_read_only` while that policy
is retained. Core operations reject managed uninstall, update,
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

Directory listing, file reading and image zoom normalize validated absolute paths before permission checks and filesystem access. Both stages use the same normalized path, so a symlink followed by `..` cannot classify one target but open another. Existing symlink targets are resolved by the filesystem, preserving physical traversal inside the target. The managed root alone does not authorize reads through links resolving outside it.

Managed precedence keeps the deployment-selected package authoritative when a
user package has the same name. The shadowing warning makes that conflict visible;
disabling the managed package does not select a different implementation. Users
who need both packages must give them distinct names.

Name-based identity preserves activation preferences when a package is upgraded
or its root moves. It also means a different package reusing the same name
inherits those preferences. Deployment owners should keep names stable and avoid
reusing them for unrelated extensions.

After a managed package is removed from its source, an explicit user installation of the same name can adopt its retained activation and resource preferences when no user package is already installed. Installation checks the managed source again immediately before commit, including for a prepared installation; a filtered discovery result does not establish removal. The store transfers the policy atomically to the user identity and removes the managed marker. A previously installed shadowed user package is rediscovered normally. After automatic hand-back, a restored user declaration without an artifact remains eligible for a later installation to retain its pre-managed activation preferences; this eligibility is restored at hand-back, not at the initial managed claim. Explicit release clears settings-only directories and name-keyed preferences for all recorded spellings only when no surviving user ownership is known for that name, including a retained user policy or cached user package. Fresh manifest inspection covers nonstandard child directories; uncertain user artifacts or an unreadable listing conservatively retain shared settings and preferences. An obsolete managed identity cannot uninstall the replacement user package. If a queued refresh moves that policy to a user identity, uninstalling the old id reports a conflict or retained-managed refusal instead of a successful removal. A settings-only directory at the installation destination can be adopted when it is empty or contains only a regular `.env` file. Existing values are retained and explicitly prepared values take precedence. Unknown contents, symlinks, existing packages and secret-selector metadata remain conflicts; failed commits restore the original directory and policy.

**Proposed decision — pending maintainer confirmation (R3-1):** Keep the implemented default of adopting retained preferences when a user explicitly installs a same-name package after managed withdrawal, without an additional opt-in. The eligible installation retains managed-era default/workspace activation and per-workspace skill overrides, preserving continuity for the same extension name. The same name can belong to a different publisher; accepting that continuity is the tradeoff requiring a maintainer decision in [this review](https://github.com/QwenLM/qwen-code/pull/12183#pullrequestreview-5347007520). Withdrawal must remain proven, detected stored credentials block adoption, and the settings-only directory rules above still apply. An explicit opt-in remains the alternative if maintainers prefer separate consent to preference reuse.

Read-only CLI extension/MCP listings, TUI installed/source tab loading, settings and marketplace inspection, channel discovery, MCP reconnect discovery, transcript replay, daemon catalog, extension-state and skill/status queries, and both legacy and queued V2 update checks retain the managed marker, preserved preferences and managed secrets after a deployment withdraws a package. These reads, including the temporary Config initialized for MCP reconnect, do not perform the automatic hand-back. Auxiliary workspace MCP discovery and temporary source-copy initialization also retain ownership and credentials; the copy operation still persists its requested target metadata, and ordinary daemon/session initialization keeps its normal reconciliation behavior. A returning user package is shown with its preserved activation and skill preferences without consuming them. An explicit release operation or the normal runtime refresh completes that transition; reading a page alone cannot delete credentials. Editing an extension setting also does not hand back unrelated packages. Sensitive workspace-setting writes first record the exact extension name, identity and writer cwd in private, non-secret metadata under the current Qwen home. Each cwd has an atomic record, retained independently of the policy and after cleanup. The inventory directory participates in managed-source/state separation, including when the extension store uses custom directories. Secret probes and cleanup share the union of these recorded paths, caller-supplied paths and their resolved filesystem paths, so a later process in workspace A can find credentials written in B without daemon registration. Existing credential service names are unchanged. Credential probing or cleanup fails on invalid or unreadable inventory; failure to persist the inventory prevents storing a new workspace secret.

Older unindexed credentials in unknown workspaces cannot be reconstructed from the keychain API; known workspace paths remain fallback hints. The inventory covers writers sharing the same Qwen home. It does not add cross-home keychain namespace isolation or serialize settings writes with ownership transitions. A missing optional native keychain module leaves file-only operation supported. If the module is loadable but its backend is unavailable, the probe cannot prove credential absence and blocks adoption. Explicit cleanup attempts other backends and coordinates before reporting incomplete cleanup through the existing warning path; post-transition cleanup remains best-effort. Historical native values cannot be detected when the module itself is no longer loadable. The inventory preserves coordinates for a later explicit probe or cleanup.

Read-only loading does not make deployment changes atomic, and no watcher is
added. Deployment tooling remains responsible for publishing complete package
contents and explicitly refreshing affected workspaces or restarting the process.
Package distribution and automatic deployment updates are outside this design.

Update checks and bulk updates apply the same ownership guard as a single update. A refused or failed candidate receives its own terminal status and does not discard successful sibling results. The CLI reports failed and skipped entries alongside successful updates.

Performance follow-up (deferred): a name-filtered refresh still discovers and loads packages from both sources before selecting the requested names. Reducing that work remains outside this change.
