# External Workspace content child agents

[English](2026-11-16-external-content-child-agents.md) | [简体中文](2026-11-16-external-content-child-agents.zh-CN.md)

## Status and baseline

Implemented locally for #17247; integration acceptance is pending. The development baseline is #16023 at `bd8c5c76011ad3c9011ef3a265a6eea44a86a935`, which supplies Workspace-isolated external bindings, independent Runtime members, shared dispatch fences and storage-owned retirement. That prerequisite is not merged into main. This increment does not merge or replace it. No deployment acceptance is claimed.

## Goal and supported surface

Add the exact Hosted profile `hosted-workspace-external-files/2`: ordinary external file reading, writing, editing and globbing, static package Skills and commands, package references and one-level public child agents. Support foreground and background children on an existing Workspace-shared worker. Preserve `/1` as the existing four-file-tool contract. Do not add Shell, MCP, Hooks, executable command interpolation, secret settings, child Workspaces, snapshots, nesting, teams or workflows. Static command argument substitution uses the existing content path; `!{` and `@{` preprocessing are refused. Session working-directory mutation is outside this slice; parent and child use the same saved context.

Admission requires the explicit, default-off `harness.workspaceContentAgentsEnabled` setting and positive negotiation of the exact profile, public children and Harness lifecycle V2. The existing Workspace files and child-agent settings and extension catalog must also be enabled, with Workspace isolation and process extension execution disabled. Turning the admission flag off permits restart with that catalog configuration and preserves saved `/2` recovery. Content support does not enable the process extension execution profile. Keep `public_child_agents_version=1` as the existing public-child contract; profile eligibility is separate from the public-shell predicate.

## Content configuration and resources

Use the existing `config_install` chain with `kind=hosted-extension-config` and `formatVersion=2` for content-only configuration. Keep operation identities, revision checks, predecessor references and prepare/commit/active transitions. Version 1 retains the original Runtime/Harness two-party process activation. Version 2 requires one real Harness content acknowledgement at each stage and never invents a Runtime acknowledgement or process owner.

Content bundles and roots use an explicit body version 2 and `executionMode=content-only`, preserving the existing resource envelope schema version 1. Pin package digests, contributions and immutable archive/assets. A content root binds the Session definition and Workspace identity rather than a process Runtime owner. Retain the complete referenced resource closure when a parent updates configuration or a child inherits it.

Serve `extension://` reads and glob through the pinned content source, with existing bounded archive extraction, digest and membership checks. Package resources are read-only and do not enter Workspace file history. Ordinary file access always uses the resolved external worker. Neither route falls back to Harness cwd, user extensions or another package. Unsupported enabled package components and explicit tools fail before activation or child minting.

The first content slice snapshots at most 256 files and 8 MiB of asset bytes per package, using 64 KiB resource parts and paged indexes. Text reads require valid UTF-8; unsupported binary references and excess capacity fail explicitly. Aggregate configuration references remain subject to the existing Session Store transaction limits. The internal writer-authenticated `content-package:query` and `content-package:read` operations deliver only an exact configuration-owned manifest/archive, never settings; public HTTP routes do not change.

## Launch identity, model and approval

Use the existing public launch envelope and package descriptor pins. A child inherits the parent's model configuration under its own encrypted identity. Reject a different explicit model before launch; no wildcard provider or ambient fallback is introduced.

Under the locked parent row, verify the snapshot's source approval revision and effective mode, then copy the complete permission rules into the child's immutable initial policy. A child with nonempty rules starts its own approval revision at 1; otherwise retain revision 0. Restore the child's own saved policy. Later parent policy changes do not alter it.

After identity and scope authorization, match an existing creation receipt by request digest and committed child lineage before mutable new-mint checks. A replay returns the original child and pins even if the parent has since changed configuration or policy. A genuinely new mint still validates the current parent configuration, policy, open state and execution authority.

## Shared Runtime, relay and cleanup

Reuse #16023's ordinary Workspace capability digest and binding-generation-owned physical holder. Root and child keep their own Harness identity, prompt-derived Runtime identity, context and credentials. Verify committed lineage and identical tenant, Workspace generation, storage and child cwd; resolve execution authority from that child's root owner, never an unrelated Workspace member.

Register durable cleanup debt before eager acquire. Establish a real READY member/context before model execution, including plain-text and Skill-only children; keep file-history initialization and file access lazy. Track actual Runtime membership independently from file initialization so every exit cleans up. Ordinary Workspace workers multiplex contexts; execution fences cover unresolved tool executions rather than model waits. No extra Runtime state or synthetic member is needed.

Resolve relay identity from the original creation receipt's child Session and turn, then its exact prompt and historical Runtime member. Do not choose first/latest turn or latest Workspace binding. Warm reads require matching READY identities. Historical dispatch repair uses the original association and original turn's durable dispatch/terminal facts without reactivating a released or LOST binding. Pre-admission child failure reaches the parent promptly.

Child cancellation and close stop and release only that child's work and members. Parent-turn cancellation uses the existing source-prompt stop barrier. Closing root A cascades its children and releases its members without draining root B's shared worker. Only storage retirement stops the worker and clears the physical holder using original generation and stop receipts. Permanent structural recovery refusal follows #17273's terminal decline; unreachable services remain transient. Unknown file effects are not replayed or treated as stop proof.

## Delivery, verification and rollout

Deliver content configuration/resource support first with admission closed, then connect profile gates, child policy/model inheritance, eager membership, exact relay and lifecycle paths. Update both language versions and the E2E report together. Reuse existing public/WebShell routes and capability fields; no public HTTP endpoints are added. The Java SDK's existing lifecycle V2 selector also admits the exact `/2` profile.

Verify the `/1` regression boundary; immutable content/digest/path and cross-tenant refusals; parent read → foreground child Skill/reference/write/read → parent reread; plain-text and Skill-only children; background completion after the parent turn; one provision for independent roots and children; child/root close isolation; parent updates and idempotent replay; restart and acquire/attach/release lost replies; stale generations and UNKNOWN writes.

Run focused TypeScript and Java checks, root build/typecheck/bundle, and the applicable real MySQL/worker/Hosted paths within the module's shared local verification budget. Full CI/fault and pre-release suite acceptance remain separate evidence. Record actual component revisions. Deploy compatible components before opting new Sessions into `/2`; disable new admission without rewriting existing pins. Settle existing `/2` Sessions before rolling back to binaries that do not understand them.

## Implementation and evidence

The implementation spans `packages/cli/src/serve/` for profile admission, content activation and child tools; `packages/core/src/managed-runtime/` for configuration contracts, immutable assets and HTTP storage; the Managed Agent server modules for admission, authorization, retained resources, exact member identity and lifecycle; and the Java SDK's existing Hosted lifecycle selector. There is no schema migration or new public API.

Local evidence includes 301 Core tests, 19 targeted CLI cases, 3 Java SDK phase variants and 24 packaged-Harness HTTP negotiation/admission checks. Additional Java component checks and selected real MySQL ownership/locking cases passed. The final Java production modules compiled and passed Checkstyle, but the corrected deny-policy inheritance and original-bootstrap MySQL regression methods did not rerun before the shared 600-second budget was reached (597.473 seconds consumed). The refined Java ACK-count test also remains pending CI.

These checks do not establish the complete Spring/MySQL/Harness/external-worker flow. Real parent-to-child file effects, background delivery, independent-root close isolation and restart/fault recovery still need integration evidence. The existing full CI gates and an appropriate external-worker fixture/environment are required; keep admission disabled until that acceptance is complete.

## Open decisions

None for the agreed first slice. Implementation and test evidence below must distinguish verified behavior from pending acceptance.
