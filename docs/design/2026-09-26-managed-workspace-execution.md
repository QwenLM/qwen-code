# Managed Workspace Execution Wiring (W0c-3)

[English](2026-09-26-managed-workspace-execution.md) | [简体中文](2026-09-26-managed-workspace-execution.zh-CN.md)

Status: draft implementation, based on W0c-2 #12730 at `5e443797` and the merged worker follow-ups #12747. Part of #12724 and proposal #12380.

## Problem and current state

W0b persists a Session's Workspace binding and configuration references. W0c-1 installs a directory in the worker. W0c-2 provisions boot v2 and verifies context receipts. The embedded server still resolves one global directory and rejects bound Sessions. Its HTTP transport cannot acquire or release a Runtime Session. No current Java lease serializes two Sessions sharing files.

The worker currently constructs its four ordinary tools with a fixed preapproved configuration. A directory receipt does not prove arbitrary frozen configuration has been installed. The Hosted provider also needs manifest, prepare, approval and history controls that the worker does not implement. Opening the public Turn gate would therefore claim a larger feature than directory wiring can deliver.

## Scope and acceptance

This slice connects persisted bound Sessions to the private Broker's acquire, execute, status, cancel and release path. It proves real Read/Write/Edit/foreground Shell execution in two Workspaces and child directories, and serializes tool turns sharing storage. Public bound Turn/lifecycle gates, Hosted model/tool orchestration, file-history settlement, WebShell selection, W0e recovery enablement, Kubernetes and arbitrary configuration loading remain outside this slice. `workspace_context` remains unadvertised.

The initial deployment is a single local-process host with shared SQL authority and trusted administrator-managed directories. Neither the process provider nor the current file tools confine access to the mount root: Read/Write/Edit and Shell can reach other paths allowed by the worker's host permissions, including another configured Workspace. Deployment isolation is required before untrusted product use. Multiple Broker processes on that host use the same durable storage lease; expiry never authorizes replacement of an unknown writer.

## Trusted Session and storage resolution

The resolver reads the original Session, validates its complete binding, and requires ACTIVE status. It checks the current Registry's exact tenant, Workspace ID, generation, storage identity and ACTIVE state. It uses the actor in the original creation receipt and rechecks that actor's read/create grant at acquisition and every new execution. Private Broker credentials identify a trusted service; they do not supply a browser actor. Product support for a different acting user needs its own authorization admission.

Administrator configuration supplies a list of tenant/storage ID/local-root mappings. Roots must be canonical existing directories; duplicate or overlapping roots are refused, including aliases across tenants. A missing mapping or changed Registry identity returns `workspace_unavailable`. No client path, default Workspace or current Registry configuration substitutes for the recorded binding. The mount root enters Runtime placement; `cwdRelative` stays in the Session context. Managed execution initially requires Session-isolated local processes. Legacy unbound placement keeps its existing protocol and directory.

Set `qwen.managed-agent.runtime-broker.workspace-mounts` to a list of objects with `tenant-id`, `storage-id` and `root`. An empty list admits no bound Session. All Brokers sharing the database must use the same administrator-controlled physical mapping. The resolver snapshots canonical paths and filesystem identities at startup and refuses replacement roots. Provisioning does not create directories.

## Frozen configuration and activation

Support one explicit immutable profile: configuration reference `managed-runtime-tools/1` and policy reference `preapproved-workspace-tools/1`. It admits Read, Write, Edit and foreground Shell with no project configuration, MCP, Hooks, checkpointing or background-tool mode. Foreground Shell can still create detached descendants; this slice serializes admitted invocation lifetimes and does not certify that arbitrary shell-created daemons have stopped. Such commands require a killable isolation domain before production enablement. Only `qwen-code` Sessions with that exact frozen pair are eligible. The existing W0b SHA-256 derivation must match `contextConfigRef`. A separate fixed capability digest identifies this worker profile; the ordinary Harness digest is not substituted for it.

The worker gains a bounded, authenticated activation route separate from the closed directory-installation envelope. Requests bind the Runtime Session ID, original context digest, frozen configuration reference and profile. Receipts additionally bind the Runtime identity, incarnation and epoch. Under the profile capability digest, directory installation alone cannot run tools: activation must validate the supported frozen profile and the installed binding. Old workers refuse the new route, so acquisition fails before any execute call. Other existing directory-only protocol fixtures keep their original capability identity.

Activation is immutable and idempotent per Runtime Session. Release closes the gate only after that Session's journal has no running invocation. A released Session cannot be activated again; a later tool turn uses a new Runtime Session ID. Status and cancellation of the original invocation remain possible after authorization or directory loss. Tools start in the verified Session directory; passing the mount root through `includeDirectories` does not enforce a file-access boundary in this profile. Shared process cwd is never changed.

## Workspace turn ownership

Add a SQL ownership row keyed by tenant and storage ID, rather than cwd or Workspace generation. The holder names the Runtime binding/generation and Runtime Session. Acquisition is transactional and idempotent for the same holder; another holder receives retryable `workspace_busy`. Holding the entire Runtime Session serializes its tool turn, including reads that establish the write baseline. Independent storage proceeds concurrently.

The row has no automatic takeover deadline. A Broker crash, failed installation, ambiguous execute, or unknown physical outcome leaves it held. Retrying the original Runtime Session can reconcile its evidence; a new Session cannot assume that a timer stopped the old process. Recovery/administrative cleanup requires physical stop evidence and belongs to W0e.

Release first asks the original worker to close the activation gate and report that no admitted invocation remains active, then conditionally clears the same SQL holder. Failed or stale release cannot clear another holder. The Broker's existing execution journal additionally prevents releasing unresolved calls. A lost release response is retried against the same closed gate. Full Hosted turns must extend ownership through their history commit before this path can be advertised for product use.

The existing Broker can mark an unavailable/LOST Runtime Session released locally without reaching the transport. That does not clear storage ownership. Revocation still permits cleanup through an already acquired local route; adopting a route after restart requires current authority. When adoption is no longer possible, the retained row needs W0e recovery rather than an unverified unlock.

## Wiring and consumers

The embedded server injects a bound-Session resolver and a transport adapter. The local provisioner receives explicit managed placement requests for eligible Sessions and retains boot v1 for legacy requests. The adapter resolves the exact persisted Runtime binding, acquires storage ownership, installs directory context, and verifies activation before acquire succeeds. Every new execute rechecks current Session/Registry authorization, scope and storage ownership. Observation and cancellation use saved identities so revocation cannot strand physical cleanup.

The private Broker HTTP routes retain their current request shapes and service authentication. Their owner is the resolved persisted Session and selected Runtime; they never use the primary/global directory for a bound Session. Public API and WebShell reads retain W0b behavior. No bound public Turn gate is removed by this PR.

Affected components: the server's embedded Broker, configuration and Registry/store adapter; a SQL ownership migration; HTTP transport activation support; the worker's activation gate and tool configuration; focused Java/TypeScript tests and real-process verification. The migration also makes the unused preview-era placement columns nullable so the merged Broker repositories can insert into the server's Flyway schema without fabricating placement authority.

## Validation

- Baseline the global CLI, then run the final private Broker-to-worker flow using the built local bundle.
- Use actual W0b SQL creation receipts and persisted bindings. Change defaults and Registry configuration references after creation; execution must keep its original pair or reject it.
- Exercise real Read/Write/Edit/Shell in two roots and nested directories; same-storage Sessions must serialize while different storage can progress.
- Refuse unknown profiles, missing roots, symlinks, wrong storage/generation, revoked grants, deleted Sessions and foreign activation receipts before new execution.
- Test two SQL clients contending for one storage row, stale release, retained ownership after ambiguous execution, release retry and original status/cancel after directory loss.
- Keep legacy tests green. Run build, typecheck, bundle, Java verification/Checkstyle, focused worker tests, independent E2E and two clean self-audit passes.

## Open boundaries

No arbitrary frozen configuration is accepted. Richer profiles need their own versioned configuration contract. Physical cross-host mount identity, expired-owner recovery, product authentication, full Hosted tool controls and history commit remain explicit subsequent work. This draft proves the scoped private execution path; it is not a production activation signal.
