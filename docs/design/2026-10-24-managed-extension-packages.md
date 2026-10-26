# Managed extension packages

[English](2026-10-24-managed-extension-packages.md) | [简体中文](2026-10-24-managed-extension-packages.zh-CN.md)

## Status and baseline

Implementation based on `101b3d416de4b7a7dca094afd475549013d8b7d5`.
The code is under verification. This document describes the accepted design,
not completed runtime qualification.

## Problem and scope

Managed Sessions can load published static Skills, MCP pins and Hook catalogs,
but cannot install, distribute and explicitly apply a complete extension package.
An ordinary installed directory is not portable: loaders expand host paths and
environment variables, converters can rewrite plugin roots, and release selection
uses the installer's platform. Copying it would move the wrong bytes or secrets.

The first profile supports static Skills and assets, commands, declarative agents,
context, MCP, Hooks and versioned settings. It rejects dynamic Skill permissions,
Hooks, model overrides and path activation, agent-private MCP/Hooks, executors,
LSP, channels and workflows before lossy conversion. It does not build dependencies.
The execution targets are local Linux, SSH Linux and opt-in native macOS developer
process-group supervision. This is not full ordinary-CLI semantic compatibility.

## Package and settings ownership

Prepare original Git/npm/directory/archive inputs with existing acquisition,
conversion and parsing primitives, explicit target platform and explicit roots.
Never initialize Config or mutate process environment/cwd during preparation.
Keep placeholders until compilation on the target Runtime. Imported installed
extensions must be prepared again from their original source.

Canonical archives are tar.gz with a root manifest. The package digest is SHA-256
of archive bytes; metadata records the source revision, target and compiler version.
Enforce the existing 100 MiB compressed, 1 GiB expanded and 100,000-entry ceilings
for every source. Reject escaping resources and unsupported archive links.
External interpreters remain target dependencies, not package resources.

The control plane owns immutable archives in a configured durable artifact
directory and SQL metadata, operations and references scoped to tenant/Workspace.
Use bounded binary streams, not base64 archives in JSON or Session resources.
Production replicas need shared durable storage. Runtime private-state directories
are verified caches, never the only recovery source. Retain installed versions,
Session/child pins, pending recovery and history references before collecting data.

Settings are immutable encrypted revisions. Reuse SecretProtector/key rotation;
bind encryption context to tenant, Workspace, extension and settings revision.
Do not copy source Keychain selectors, .env or credential sidecars. Deliver exact
settings only to the selected Runtime and extension subprocess. Public responses,
journals and browser persistence contain references/configured keys, never values.

Publishing and Runtime execution are separate disabled-by-default settings. The
control plane requires a configured durable artifact directory and permitted actor;
the Workspace OPERATOR grant remains mandatory. Runtime execution additionally
selects the platform supervision profile and private cache directory. Published
versions and settings are retained; this increment does not run GC.
See the [deployment configuration](../../packages/managed-agent-server/distribution/config/application.example.yml).

## Session configuration and recovery

Keep AgentDefinition identity and the base tool profile immutable. An effective
configuration combines the base definition, independent MCP selections, mandatory
base Hooks and selected package contributions. Create/load/resume/recovery use the
same binding; package pins cannot masquerade as definition pins or upgrade a profile.

Session creation accepts optional `extensionPins`. Omission or null preserves the
legacy path; an explicit empty array selects an empty package configuration.
Include the exact pins in the creation idempotency digest and authorize package
membership and deployment policy before creating the Session.
Initial pins, including an explicit empty selection, require the supported Shell/1
or MCP/1 profile with negotiated lifecycle v2 before a Session or creation receipt is persisted. Version 2 of the
existing creation receipt keeps immutable `initialSelection` beside the optional
static Skills snapshot; version 1 retains its meaning. No installation ledger or
schema column is added. Private create/load carries that same expected-revision-0
command. Bootstrap through normal config_install before the first model submission,
and reject a different command or any bootstrap after the initial Turn was submitted.
An incomplete bootstrap keeps inference blocked and recovery targets its original owner.
Before that first submission, the exact initial command may also recover its previous
content as revision 2 under the normal successor checks. Child Sessions accept only
continuation or explicit recovery of their original bootstrap operation; an operator
cannot replace their package selection. Cold management loads stay passive so a failed
bootstrap can be repaired without admitting inference.

SSH child execution requires a newly persisted public-child contract and the enabled
extension execution profile. Deployment changes do not promote an older Session.
Parent and child retain their own Runtime owners and credentials. A package launch
checks the parent's original READY binding, generation and active slot under lock;
remote worktree and snapshot children remain unavailable.

Evolve the existing config_install domain with a closed tagged body, retaining
managed-config_install/1 and old MCP records. Sessions without packages keep the
old path. The first apply imports independent MCP/base Hooks; subsequent MCP writes
use the unified adapter, even after all packages are removed. Journal phase,
effective configuration and MCP component revisions are distinct counters.

Apply is deliberately stop-and-reconfigure: prepare, stage immutable inputs and
verify both stage ACKs; atomically commit config_install/config.bound and an admission
barrier; drain changed Session-owned components; enable replacements; verify both
enable ACKs; publish active. Staging does not connect MCP or execute Hooks. A stage
failure leaves the old configuration usable. After commit, reconcile the original
operation/owner; unknown results retain the barrier and cannot be replayed elsewhere.

Explicit recovery to previous content first proves replacement owners stopped,
then compiles that content into new effective catalog/configuration revisions.
Runtime reconciliation accepts the exact original prepared, pending or active operation,
including after a restart, and refuses to stop a newer configuration.
Never decrement Hook/MCP revisions, erase history, reset base once consumption or
re-run SessionStart. A Session update must not close/seal/retire the whole Runtime.

## Component and platform wiring

Keep source provenance and native naming/conflict rules for Skills. Legacy static
Skills with ambiguous origin conflict explicitly instead of being guessed/replaced.
Expose pinned package assets through a read-only source namespace, not widened
Workspace paths or file history. Shell extension context supplies target package
roots while retaining Session cwd. Cache drift refuses use and permits reconstruction.
Product read-only access does not establish a new same-UID Shell sandbox.

The model-facing tool schema enumerates selected public package pins. Read and
Glob accept a package-relative path or `extension://<extensionId>/<path>` with the
matching explicit source; instruction roots use that logical namespace. Shell
receives `QWEN_EXTENSION_ROOT` through its explicit extension context. No private
cache path or settings value is added to instruction text. Upgrading a selected
package preserves its exact settings revision; users may explicitly reuse the
latest saved settings revision without reading its values.

Commands reuse parsers and injection/escaping rules. File/Shell expansion uses
stable Runtime invocations with Hooks, approval and durable receipts. Save expansion
before inference; recovery must not execute it twice. User order is
UserPromptSubmit, expansion, UserPromptExpansion, inference. Model command calls
dispatch through skill in their own batch; static Skills retain instruction-only
behavior. Child launch snapshots pin the parent binding, agent descriptor, tool
restrictions and configured model route; Java validates membership before creation.
Keep depth/quota/cancellation/relay contracts and never widen parent permissions.

Target dependency preflight checks directly resolvable commands and interpreters
without running Hooks or connecting MCP. Authored complex Shell expressions remain
subject to the real approved invocation. Argument placeholders in nested Shell
substitutions, backticks and heredocs are explicitly refused rather than inserted
with an unproven escaping context.

Linux owner shutdown uses process-tree evidence; SSH needs actual startup, scoped
configuration, drain, retirement and recovery implementations, not a boolean flip.
Native macOS developer mode is off by default and only proves registered process
groups stopped. Persist the supervision mode in registration and receipts. Old
proofs cannot certify new owners, and production verifiers reject developer proofs.
Only an original Runtime negotiating the new contract may apply packages.

## Interfaces, rollout and verification

Add Workspace package publication/catalog/settings/operation APIs and Session
selection/query/apply/recovery APIs to public/WebShell/SDK surfaces. Publication
requires Workspace OPERATOR and deployment source/actor/execution policy. Commands
use stable idempotency keys and expected configuration revisions. Status is read-only:
it never creates Sessions, cold-loads Harnesses or resubmits work. Reuse the manager
UI with a distinct Managed provider and abort stale target requests.
The unified Plugins → Extensions tab receives the current Managed provider,
Workspace and Session, including before a Session is selected, so it never
falls back to the daemon extension catalog in Managed mode.
Catalogs contain at most 256 packages; a Session may select at most 32.
Only the explicit pre-admission `extension_config_revision_conflict` response
clears a pending apply and refreshes its configuration revision. Generic conflicts
and unknown outcomes retain the original selection and idempotency key.

Implement protocol/storage, local execution, SSH/macOS profiles, then fault gates.
Test cross-platform source preparation, secrets/root isolation, cache reconstruction,
all seven components, apply/disable/remove/recovery, independent Sessions, preserved
base MCP/Hook state, commit/drain/enable/ACK loss, permissions and old logs/profiles.
Use real MySQL/process/SSH evidence and distinguish Linux cleanup from macOS scope.
Follow affected-package checks and the Java module's shared ten-minute local budget;
CI owns complete platform/fault matrices. Evidence lives in
`.qwen/e2e-tests/managed-extension-packages.md`; incomplete gates stay explicit.

## Implementation and qualification

The implementation includes the raw compiler, durable archive/settings APIs,
unified configuration ledger and barriers, Runtime component/asset wiring,
public child snapshots, SDKs and Managed WebShell provider. Both publication and
execution remain opt-in. A missing or drifted private cache is refused by ordinary
tools; explicit apply can verify the authoritative archive and reconstruct the
same private path without widening Workspace access.

Focused TypeScript tests include two extensions whose real MCP/Hook subprocesses
consume identically named settings without seeing the other extension's values.
The native macOS worker HTTP slice exercises attestation, upload, activation,
read-only assets, file-history isolation and Shell. These tests do not establish
Linux process-tree or SSH cleanup.

A real MySQL/control-plane/Hosted Harness/native macOS run reached initial active
revision 1, passed context and static Skill delivery, a real MCP effect, Hook
invocation and public approval. Its allotted Java window ended during command
expansion; command completion, child invocation, update, compensation and restart
non-replay remain unqualified by that run. It also exposed missing Hook setting
injection, subsequently fixed and verified by the isolated real-process test above.
Selected MySQL configuration/creation cases passed; a new child-admission case
reached an invalid test policy, which was corrected but not rerun locally.

The module's shared local Java verification used approximately 596 seconds of its
600-second budget. Complete Java/SpotBugs/MySQL, seven-component execution,
Linux/SSH/macOS cleanup, permission revocation and commit/drain/start/ACK/response
fault matrices remain required CI gates. A Harness/control-plane restart may
reconnect a surviving original Runtime; this increment does not claim transparent
replacement of a lost Runtime process or recovery after host reboot. Lost original
owners keep their existing fail-closed recovery rules and must never replay work.

The existing CI collects the new unit/contract/MySQL test classes, but does not yet
automate the complete package platform/fault matrix. The existing static
`HostedExtensionsIT` cannot substitute for that remaining qualification.

## Open decisions

None for the accepted first profile. Unsupported dynamic semantics require a
separate activation contract rather than silently expanding this profile.
