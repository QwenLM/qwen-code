# Managed Skills and MCP Self-Service

[English](2026-11-07-managed-skills-mcp-self-service.md) | [简体中文](2026-11-07-managed-skills-mcp-self-service.zh-CN.md)

## Status and delivery scope

Approved design, 2026-11-07; delivery split updated 2026-11-08. PR #16500 delivers archive uploads, ordinary MCP configuration forms, and explicit Session installation, update and restoration. Runtime Skill snapshots and personal HTTP MCP OAuth are separate dependent deliveries. Implementation does not establish deployment acceptance.

The complete implementation before this split is preserved at `4736349cbe5d60f39251a148ef17df5f764a03bb`. The split preserves the accepted design and applicable review fixes. Each resulting head requires its own validation; previous whole-branch checks are reference evidence only. The shared local Java verification budget remains exhausted across all three deliveries.

## Problem and existing foundations

Managed users should be able to install a Skill with scripts and resource files and configure an MCP connection without a local daemon. Existing extension packages already provide resources, encrypted Workspace settings, immutable revisions and `config_install`. Reuse those authorities rather than creating another installer or configuration history.

A Skill bundled into the original static Session snapshot remains immutable. Installing an extension does not modify that snapshot or promote a files-only Session to Shell. Native automatic discovery, directory watching, Git/npm acquisition, dependency installation and setup scripts are outside this delivery.

## Package model and normalization

A standalone Skill archive contains exactly one `SKILL.md`, either at its root or inside one wrapper directory. Normalize it into `qwen-extension.json` and `skills/<name>/...`, preserving supported metadata, scripts and resources. A multi-Skill distribution uses an ordinary extension archive. Preserve qualified names and conflict rules; never silently replace a same-named static Skill.

Use the shared Skill compatibility parser and MCP recipe validator during preparation and execution. Reject unsupported hooks, permission declarations, argument processing, model overrides, unknown MCP fields, mixed transports and invalid parameters rather than dropping them. Support stdio, Streamable HTTP and SSE. Enter the executable and arguments separately; a command string is not implicitly a Shell program.

One standalone MCP connection is a minimal extension with one authored server and settings declarations. Its identity remains `extensionId:authoredName`. Editing publishes a new revision of the same extension. Manage a composite extension as a package and provide navigation from its component view.

Package and compiler versions remain 1. Inputs and published archives contain no personal OAuth declarations. Resources retain `extension://` and `$QWEN_EXTENSION_ROOT`; execution keeps the Session working directory and does not install dependencies.

## Session-free preparation

Expose the process-global Hosted capability `managed-package-preparation/1`. Java authenticates the actor, checks Workspace grants and the deployment allowlist, bounds the input and delegates parsing, normalization and compilation to TypeScript. The Java host needs neither Node.js nor a shared Hosted filesystem.

In pool mode choose an accepting capable instance without requesting Session placement. Preparation creates no Session, initializes no model, connects no MCP server and executes no hook or user setup. Bind temporary archives to the selected instance and boot ID; only the control plane reads the internal handle and streams the result into the existing publisher.

Retain the limits of 100 MiB compressed input, 1 GiB expanded data and 100,000 archive entries. Reject links, special files and path traversal. Bound concurrent preparations and aggregate temporary disk use, enforce a ten-minute preparation deadline and expire temporary output after fifteen minutes. Retain an explicit in-flight operation until asynchronous work and cleanup settle, including after a disconnected HTTP response.

Identical input, target and compiler version produce repeatable package bytes. Use `sourceType: snapshot` and the source digest as `sourceRevision`; omit temporary names and timestamps from canonical content. Updates retain the existing `extensionId` and namespace.

## Credentials and inspection

MCP secret fields use settings placeholders. Save their values through the existing encrypted settings API and label them **Workspace service credentials**: authorized Workspace execution can use them. Keep secrets out of archives, browser persistence, receipts, logs and metrics.

When credentials do not change, reuse the exact `settingsRevision`. A change submits the complete settings collection; required values must be entered again. Inspection is digest-pinned and operator-only, returning components, files and editable non-secret configuration. It does not widen ordinary MCP inventory visibility.

## Public contracts

The Workspace base is `/v1/agents/workspaces/{workspaceId}/extensions`; the Session base is `/v1/agents/sessions/{sessionId}/extensions`.

| Scope and operation                                                  | Authority                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Workspace `POST /imports/preview`                                    | Pure normalization and inspection before confirmation                            |
| Workspace `POST /imports`                                            | Stream original input, normalize and publish through existing package operations |
| Workspace `GET /{extensionId}/packages/{packageRevision}/inspection` | Inspect the exact published digest                                               |
| Workspace `POST /operations/lookup`                                  | Find publication/settings receipts by kind and idempotency key                   |
| Session `POST /operations/lookup`                                    | Find the original apply operation by idempotency key                             |
| Existing settings, apply, query, continue and recover-previous       | Remain authoritative for credentials and Session configuration                   |

Metadata binds source kind, target, digest and compiler version, with an optional update target `extensionId`. MCP form input is non-secret JSON. Do not accept arbitrary download URLs or control-plane filesystem paths. Catalog and Session query distinguish service support, publication permission and current apply eligibility; the server rechecks every operation.

Public apply retains `expectedConfigRevision` and the full `extensions` pin selection. Keep OpenAPI, WebShell provider/generated types, Java SDK, SurfaceRegistry and contract witnesses synchronized. Personal binding fields and a new apply protocol are reserved for the separate OAuth delivery.

## One-confirmation installation and recovery

1. Read the current configuration and check permissions, profile, idle state and target compatibility.
2. Preview names, source, resources, components, connection configuration, credential purpose and affected Session.
3. The user confirms **Install into current Session** once.
4. Publish the package and save settings when required.
5. Merge its pin into the confirmed complete selection and apply using `expectedConfigRevision`.
6. Show installed only after the exact selection receives an `active` receipt.

Use stable idempotency keys per stage. Persist only actor-scoped identifiers, stage, public pins, keys and expected revisions. Uploaded bytes, drafts and secrets stay in memory. A refresh before publication requires the original input again; a lost publication response first queries its existing receipt instead of creating a new revision.

If settings fail, show that the package is saved and credentials are incomplete. If the Session becomes busy or its revision changes, retain publication and request an explicit fresh review; never queue an automatic apply. A failure before configuration submission leaves the active configuration usable.

A submitted apply with an unknown outcome retains its operation barrier. Query or continue the original operation and original owner; do not replay on another worker. A definitive failed apply or proven pre-admission `invalid_request` / `extension_config_revision_conflict` may enter explicit review only after looking up the original key and reading a fresh settled snapshot. Rotate only the apply key; retain publication/settings receipts and keys.

Publishing v2 does not update Sessions pinned to v1. Apply updates explicitly to eligible idle Sessions. Restore older package/settings pins by creating a newer configuration revision; configuration history does not move backwards. Updating Session A leaves Session B unchanged. Restoration concerns extension configuration, not past external tool effects.

## Verification and rollout

Cover deterministic ZIP/tar.gz preparation without daemon or Session placement, resource use, ordinary MCP calls, encrypted settings and replay-safe operation lookup. Cover two Sessions on different package revisions, updating only one, and restoring previous content while retaining unrelated extensions, independent MCP connections and base hooks.

Exercise preparation, stage, commit, drain, enable, response loss and worker replacement. Reject unsupported providers, static-snapshot replacement, files-only profile promotion and read-only child Session mutation. Run affected TypeScript builds/typechecks/tests and the public API contract gates. Real MySQL, browser-to-Java-to-Runtime and process-fault acceptance require their own evidence. No local Java validation is resumed by this split; CI owns the remaining Java gates.

Self-service installation is default-off behind `qwen.managed-agent.extensions.self-service-enabled`. Pool members must support a homogeneous capability contract. Disabling installation preserves already installed packages. Record operation, phase, outcome, latency, capacity refusal and recovery conflicts with existing tracing, without source content or credentials.

## Separate follow-up deliveries

**Runtime Skill import** depends on this installation chain. It adds selected-Workspace candidate discovery, original owner/generation fencing, source-change detection and immutable snapshot import. It adds no watcher or automatic Session updates.

**Personal HTTP MCP OAuth** also depends on this chain and is independent of Runtime discovery. It carries encrypted grants/attempts, PKCE authorization, versioned personal bindings, execution actor enforcement and the HTTP token/refresh/revocation adapter together. It remains default-off until deployment isolation and identity/recovery acceptance are proven. Existing Workspace history visibility remains unchanged.
