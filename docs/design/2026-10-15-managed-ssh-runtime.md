# Managed Agent SSH Tool Runtime

[English](2026-10-15-managed-ssh-runtime.md) | [简体中文](2026-10-15-managed-ssh-runtime.zh-CN.md)

Status: implemented in the working tree, disabled by default; platform and deployment acceptance remains incomplete as recorded below. This design extends the existing Broker and HTTP worker protocol. It builds on #14254 without depending on the idle retirement or Workspace sharing slices of #14211.

## Goals and boundaries

Allow an authorized user to register an existing directory on an administrator-configured Linux or macOS machine and execute ordinary Managed Agent tools there. Node.js 22+ and the matching qwen-code installation are prerequisites; qwen-code need not already be running. SSH starts one detached worker per Session-isolated binding generation. Turns of the same Session reuse that worker. Different Sessions never share a worker, and one host may run multiple independent workers.

Normal Session close drains and stops its original worker. An open Session retains its worker indefinitely. There is no idle timer, worker pool, generation rotation, keep-warm, Session-create prewarm, service manager, or resident remote supervisor. Abnormal worker exit never triggers a replacement, and execution with an unknown outcome is never replayed. Reconnection may only adopt the original, still-live worker. Cross-machine recovery is excluded.

The remote tool profile admits ordinary files and foreground Shell under existing public capability gates. It rejects background Shell, Monitor, MCP, Hooks and child Workspaces. Native host execution assumes a trusted operating account; process-group evidence is not OS containment of arbitrary escaped external daemons.

SSH Session admission accepts only the qualified `hosted-workspace-files/1` and `hosted-workspace-shell/1` profiles, including empty Sessions and stored AgentDefinitions. Later Turns recheck that boundary. A registered SSH directory satisfies placement without a local mount; it never bypasses the files/Shell deployment flags. Local definitions and child Workspaces retain their existing gates.

The control plane derives the private Harness `foregroundOnly` flag from trusted SSH storage metadata on every attachment. The Harness persists it in the Session definition, retains it on cold and resident loads, and rejects an explicit change. Such Sessions create no background, Monitor, MCP, Hook or child orchestrators. Their model declarations omit Monitor and background Shell, and actual tool admission rejects those operations even if a caller supplies them directly. Foreground Shell keeps the existing publication, capture and approval path. Ordinary local Harness Sessions omit this flag and retain their capabilities.

Main's resident Workspace files path (#14340) remains a separate, explicitly configured CSI mode. SSH keeps Session isolation, its original capability digest, per-Session worker ownership and physical retirement on normal close. Resident CSI mappings and SSH nodes cannot share the same Broker configuration. Ordinary local and resident CSI admission, logical release and capability gates keep their existing behavior; neither path may reinterpret SSH storage or replace its stop proof.

## Components and communication

The Java server owns a static node catalog, SSH connections, Workspace registration, authorization and placement. A node contains its ID and label, SSH host alias, absolute Node and CLI entry paths, private state directory, allowed existing directory roots, fixed remote publication port and allowed tenant/actor pairs. SSH credentials and known_hosts stay server-side. Host key verification is mandatory, forwarding listeners bind loopback, and commands receive structured JSON over stdin rather than interpolated user paths or tokens.

`SshRuntimeProvisioner` persists kind `ssh-process` and a versioned immutable resource handle before startup. Routing selects the actual provider from trusted Workspace storage metadata and dispatches later operations by the saved identity. Unknown kinds, nodes or mismatched registrations never fall back to local execution. Kind ownership checks remain identity checks; stop and original-resource recovery capabilities are checked for the selected binding.

`SshConnectionManager` reuses a node connection, creates per-worker local forwarding (`-L`) and node-wide reverse publication forwarding (`-R`). Existing authenticated HTTP v2/v3 calls traverse the local forward. Existing Tool Publication HTTP traverses the reverse forward, with its trusted service URL selected for the execution's saved node. The persisted lease retains the original remote endpoint; `HttpRuntimeTransport` resolves the current local forwarding address when sending. Tunnels can change without changing lease identity. Stable private control state and an OS file lock allow a replacement Broker process on the same control-plane host and publication origin to adopt its original SSH master after a crash. Adoption verifies the saved node and forwarding configuration; unknown listeners or changed configuration fail closed. Normal shutdown waits for in-flight commands before giving up ownership. Keep this local control state while Sessions exist; this does not add cross-host control-plane takeover.

The private `qwen managed-runtime-bootstrap` entry runs one operation and exits. Its versioned JSON protocol supports environment/directory probe, idempotent storage registration, generation ensure, read-only observe and strict stop. Responses contain either a result or a typed error; credentials are not logged. Remote generation state and logs are private to the configured account.

Bootstrap subprocesses run outside the node's exclusive forwarding lock, so one slow operation does not stall an existing worker's HTTP requests on that node. A shared in-flight barrier still makes shutdown wait before releasing the controller file lock. Provisioner control work is bounded to four threads and 64 queued operations; overload returns a retryable `ssh_runtime_busy` failure. Forgetting the last lease for a node/endpoint cancels its local forward and removes its cached address. A failed cancellation retains the route until the listener is confirmed absent. Other workers keep their forwards and the shared publication connection. Direct-provider registrations are also removed after matching retirement or a release that definitively makes the delegate's lease unusable. Releasing a still-usable durable lease retains routing because a fenced observer may share that lease with the winning observer.

Each node also keeps a private, atomically replaced forwarding inventory, synced before SSH creates a listener. A confirmed entry survives Broker crashes and retains its original local address when the live master is adopted. An unconfirmed entry is cancelled before a new address can be assigned, including when the forward succeeded but its reply was lost. Final lease retirement reads and cancels that original entry even without first resolving the lease; it removes the entry only after cancellation or confirmed listener absence. A live master with missing or invalid inventory cannot be adopted. This control state adds no worker replacement or remote recovery authority.

## Workspace registration and storage

Add POST endpoints below `/api/agent/web-shell/v1`:

| Endpoint                      | Behavior                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `/runtime-nodes/query`        | List IDs and labels of authorized, enabled nodes.                                         |
| `/workspaces/check-directory` | Probe `nodeId/path` and return the canonical existing directory and compatibility result. |
| `/workspaces/register`        | Admit an idempotent registration operation for name, node and path.                       |
| `/workspaces/operations/get`  | Return that actor's registration status and successful Workspace ID.                      |

The public OpenAPI contract is version `1.52.0`; four additive endpoints and seven schemas generate the WebShell client types. SSH registration uses `/workspaces/register` with `WebShellWorkspaceRegisterRequest` and returns a durable operation (202). The independently shipped `/workspaces/create` continues to create a local empty Workspace and returns its summary (200); the two workflows keep separate authorization, idempotency and browser draft identities. Local creation strictly rejects unknown fields, including null remote location fields, so an older SSH request cannot allocate a local directory. Existing API paths and schemas retain their contracts. Node queries and creation are disabled by default; operation reads remain actor- and tenant-scoped.

WebShell adds an optional registration dialog to the existing Workspace selector. It checks a directory, starts registration, preserves the idempotency key and operation across retries, then selects the new Workspace for the ordinary Session-create flow. Preview does not authorize creation: creation repeats authorization and the remote identity check.

Registration translations are included in the interactive WebShell entry and omitted from the read-only transcript entry, preserving its existing bundle budget.

Use `SSH_LOCAL` in the existing storage/physical-owner records and `WORKSPACE_CREATE` in the existing operation journal. Workspace creation and granting OWNER to its creator commit together. No node database or worker-pool tables are added. Network operations happen outside SQL transactions; transactions recheck the registration revision and physical ownership. A shared host guard serializes local and SSH registration, refusing parent/child roots as well as physical aliases across nodes and tenants. Expired registration claims cannot write success or failure; a subsequent query can reclaim the original operation. Existing actor-scoped idempotency keys replay before checking new-admission settings. Append the next schema migration and update initializer/catalog checks without rewriting historical migrations.

Identity combines canonical directory, stable host identity, device, inode, trustworthy birth time and the registration marker. Linux matches the existing local physical-key algorithm; macOS supplies a native platform identity. Missing trustworthy identity fails closed. SSH aliases for one physical directory must not bypass ownership. A worker pins its storage/root registration, and context installation and subsequent tool calls verify it. Session `cwdRelative` stays within the registered root. The ordinary storage holder continues to serialize same-storage turns.

Before acquiring that holder, SSH performs the existing bootstrap directory probe for the candidate `cwdRelative` and verifies the registered identity and marker outside a SQL transaction. A deterministic invalid directory or failed probe leaves the holder untouched. The worker still validates again when installing context; an uncertain installation after a successful claim retains ownership because its HTTP response does not prove whether installation occurred.

The registration journal follows the shared schema's `gmt_create`/`gmt_modified` columns and database-derived millisecond clock for claim deadlines and completion. Physical keys reuse the local storage ownership algorithm, and server-owned registration marker fields take precedence over probed identity fields.

## Lifecycle

Startup persists the seed and deterministic handle, then calls bootstrap ensure. Bootstrap atomically claims one launch for that generation, starts with detached process lifetime, private file-backed logs and no IPC, and persists PID/ready information. The Broker observes that same resource for up to 60 seconds while it starts, establishes forwarding and attests the original incarnation before committing READY. Waiting never launches again. Private JSON records are fully written and synced before atomic no-overwrite publication, and launch claims and their parent directory entries are synced before spawning. A repeated ensure returns that original resource. An ambiguous launch claim never spawns again, and a retirement marker permanently excludes delayed startup.

Launch and never-started retirement claims share the atomic no-overwrite JSON publication primitive. If the launcher knows that opening logs or spawning failed before any child was created, it persists matching failed-launch evidence and reports `FAILED`; this generation can only be retired, never launched again. If that evidence cannot be persisted, the claim stays blocked. Once a child has spawned, launcher metadata failures cannot produce never-started proof: the original worker also publishes the same immutable PID before opening HTTP admission or publishing ready. A close racing startup returns retryable pending without writing the startup fence. An unlaunched close must first win the launch claim; otherwise it re-observes the winner and waits for its original worker to become ready before requesting authenticated retirement. An interrupted never-started retirement can resume from its matching claim.

A released tool-turn Runtime Session does not stop its Session's worker. SSH loss may rebuild forwarding and re-attest only that worker. Broker shutdown closes local connections, not remote workers. Broker startup observes saved registrations; missing records, dead workers, changed host boot or mismatched identities stay blocked. It never changes hosts, recreates the original generation or replays unknown work.

If all Runtime Sessions were already released before a Broker restart, close still reconciles and attests the original handle and lease to restore forwarding before retrying ACK. If that worker has already exited with a complete matching remote clean proof, strict stop verifies the proof and rebuilds the missing SQL receipt without calling the exited HTTP endpoint. Identity conflicts never use stop as a fallback.

Normal close fences admission, settles execution/results/ACK, releases Runtime Sessions and retires the original binding. A private authenticated SSH retirement route closes worker admission, verifies no unsettled calls, pending starts or publication, sweeps registered Shell process groups, writes a generation-specific clean proof and exits. Bootstrap must match the original generation, seed, handle and retirement ID and observe the original process absent before Java produces `RuntimeDrainReceipt`. No holder vacancy, timeout, missing PID or bare kill is itself a receipt. Keep the binding/storage retirement fence until proof commits.

For an SSH Shell v3 call durably settled as `not_started` with explicit `capture:null`, the Broker may acknowledge only the original execution with `committed`, `manifest:null` and `historyRevision:null`. Both direct and deferred references retain their original wire identity, and a lost ACK can be retried after Runtime Session release. A reserved SQL publication must first be closed through `close_not_started`: its state becomes `NOT_STARTED`, its producer phase remains `OPEN`, and lifecycle checks still reject quarantine, terminal output or changed execution identity. Ordinary captured results keep their existing publication receipt requirements.

This requires shared lifecycle settlement to recognize a reserved publication that is definitively closed without starting, including for existing local and CSI Sessions. The receipt wire parser accepts the explicit no-capture shape; it does not establish commitment authority. The Broker verifies the saved SSH binding and exact original execution before issuing that ACK. Captured-result publication and worker ACK validation retain their existing manifest/history requirements, and CSI retirement still requires its original stop evidence.

Every SSH managed-context worker receives the POSIX ledger; local managed-context workers also use a ledger when supplied by their launcher. Foreground Shell v3 registers its process group and uses group-exit evidence for cancellation. Before any SSH foreground Shell result settles, the worker clears remaining members of that call’s registered process group and proves it gone, including after normal leader exit. Other concurrent groups remain untouched; failed evidence leaves the execution UNKNOWN and retains its holder. This does not cover descendants that escape with `setsid`. Ledger registration/write/cleanup failures permanently disqualify that incarnation from producing a clean proof. Best-effort `close()` and the stricter CSI-specific drain gate cannot be used as SSH proof. Existing CSI retirement criteria stay unchanged.

## Operator configuration and rollout

Add the node catalog to an existing Managed Agent deployment with the Session Store, Hosted Harness, Session-isolated `local-process` Broker and Workspace files enabled. The following Spring configuration fragment leaves new SSH admission disabled. Replace paths, aliases, versions and grants with the actual administrator-owned configuration; `qwen-entry` points to the executable JavaScript CLI entry and the version must match the installed CLI. SSH reads its configured account, keys and known_hosts from the server's OpenSSH configuration.

```json
{
  "qwen": {
    "managed-agent": {
      "runtime-broker": {
        "ssh": {
          "enabled": false,
          "nodes": [
            {
              "node-id": "build-mac",
              "display-name": "Build Mac",
              "ssh-host": "qwen-build-mac",
              "node-executable": "/opt/qwen/node",
              "qwen-entry": "/opt/qwen/cli.js",
              "qwen-version": "0.25.1",
              "state-directory": "/var/tmp/qwen-managed-runtime",
              "allowed-roots": ["/workspaces"],
              "publication-port": 41270,
              "access": [{ "tenant-id": "tenant-a", "actor-id": "actor-a" }]
            }
          ]
        }
      }
    }
  }
}
```

The existing `qwen.managed-agent.tool-publication.service-base-url` must be an HTTP origin reachable from the Broker, for example `http://127.0.0.1:8080`. The node's `publication-port` is reserved for its loopback reverse forward. Configure distinct reverse ports when separate node entries reach the same SSH host. Node access is an exact tenant/actor allowlist. Set `qwen.managed-agent.runtime-broker.ssh.enabled=true` only for the intended rollout cohort. Foreground Shell additionally requires the existing Shell profile and approval gates; the SSH flag grants no extra tools.

Keep node IDs, installation paths, Workspace markers and remote state records while their Sessions exist. Setting `ssh.enabled=false` closes directory registration and new SSH Session admission, while original operation queries, lost-response retries, settlement and close remain available. Removing a node definition is not an alternative to draining its workers. A terminally blocked registration may be dismissed in WebShell to start a different registration; dismissal removes only the browser draft and cannot release its original physical reservation.

The bootstrap stdin protocol is `protocolVersion=1`. `ensure` with `launch=false` durably creates the immutable generation intent, which Java references in its SQL handle before `launch=true`. `expectedQwenVersion` pins a new launch. `observe` and `stop` may inspect or retire an existing generation after an installation update without starting a replacement. The authenticated `/internal/managed-runtime/v3/retire` route is private to SSH bootstrap and is not a user-facing force-unlock interface.

## Delivery and validation

Deliver bootstrap/strict retirement, storage registration, Broker/HTTP integration and WebShell in independently testable slices. The new feature is disabled by default. Disabling admission does not remove the ability to settle or close existing SSH Sessions; retain their node configuration until retirement.

Before implementation, record a baseline against the global CLI. Run focused Node/Java/UI tests, full build/typecheck/bundle, relevant Java Maven checks and two clean diff audits. Validate real processes on Linux and native macOS, distinguishing local bootstrap verification from a complete real SSH/control-plane/MySQL acceptance run.

Acceptance covers one PID per generation under duplicate/lost startup responses, cross-Turn reuse, independent same-host workers, same-storage serialization, files and foreground Shell results/cancel/ACK, normal close with clean proof and no registered survivors, original-worker reconnect after tunnel/Broker failure, and failure-closed behavior after kill, reboot, directory replacement, ledger faults and unknown execution. Local, static and CSI regressions remain gated. An untested remote platform is reported as unvalidated rather than accepted.

### Initial implementation validation, 2026-10-15 to 2026-10-16

The initial implementation on native macOS arm64 with Node.js v24.12.0 and JDK 21.0.8 passed the CLI process suites, the complete 741-case Harness/tool-turn regression and 126 focused WebShell cases. Expanded Java unit/H2 runs covered the SDK (249 cases, 9 skipped), Broker (984 cases, 2 skipped) and server (2,911 cases, 7 skipped). Test-only schema expectations, recovery fixtures and audit pins were corrected and the affected classes reverified in a 132-case source-reactor run. Maven verification, Checkstyle and SpotBugs passed. All 72 integration cases passed on MySQL 8.4.11, covering V3-to-V4 migration, registration, same-storage holders, recovery and lifecycle publication/stop evidence; earlier focused runs also passed against the local Homebrew server reporting 26.7.0. Two clean self-audit passes and independent reviews covered that initial implementation. These counts precede the subsequent merge of main and review fixes.

The final full `npm run build`, `npm run typecheck` and `npm run bundle` passed. A smoke test against the freshly bundled `dist/cli.js` passed directory probe/registration, immutable intent, first startup, duplicate ensure with the same PID, and clean stop with matching proof.

Seven real loopback SSH cases on native macOS use a task-owned sshd, temporary credentials and known_hosts, and high loopback ports. They cover live worker reuse, bidirectional forwarding, original-master adoption after Broker JVM halt, original-worker loss, exact direct/deferred no-start ACK retry after Runtime Session release, and SQL stop-receipt reconstruction from an existing clean proof. Their publication counterpart is a bounded HTTP test stub. WebShell desktop/mobile smoke uses mocked HTTP responses.

### Review follow-up validation, 2026-10-16

After merging main, independent native OpenSSH red/green verification passed six transport/lifecycle cases: same-node traffic during bootstrap, repeated forward cleanup, ephemeral direct routing cleanup, shared-forward lifetime, cancellation response loss and shutdown ownership fencing. These use isolated SSH infrastructure and HTTP stubs, not the complete Qwen worker/SQL chain. An independent control-queue reproduction found eight abandoned futures after `shutdownNow`; with orderly shutdown, all eight complete exceptionally. The committed regression also covers queued-request completion.

The environment-access inventory passed all three cases, and the complete WebShell artifact suite passed all 34 cases. Transcript JavaScript measures 1,331,210 UTF-16 units against its unchanged 1,331,500 budget. Full build, typecheck, bundle and affected TypeScript lint passed.

The source reactor completed SDK 249 unit cases (9 skipped), Broker 1,005 cases (9 skipped), and server 2,937 unit/H2 cases (7 skipped) with zero failures. All 72 MySQL 8.4.11 integration cases passed. The final gate exposed import/switch-indentation errors inherited from main's CSI integration fixture. After an import/indentation-only repair, with the import set and non-import line content unchanged, a `-DskipTests verify checkstyle:check` continuation passed Checkstyle and SpotBugs across all three modules. The completed test suites were not repeated for that formatting-only change.

A subsequent merge of main preserves its child-Turn cancellation behavior and adapts the SSH-specific lifecycle fixture to its added dependency. Eight inherited SQL fixture inserts now use canonical timestamp columns, including the database millisecond clock for the journal. The merged tree passed 247 focused Java unit/H2 cases, all 72 MySQL 8.4 integration cases, Checkstyle and SpotBugs. Its full build, typecheck and bundle passed, along with 54 model/prompt/environment cases, 21 native bootstrap/directory-storage cases and 34 WebShell artifact cases.

The full SDK Java CI then exposed stale fault-gate expectations inherited from main: removed SQL timestamp columns, SSE evidence reading the old timestamp field, a lease probe comparing epoch milliseconds to SQL dates, and a team-close fixture expecting a child to complete naturally. The follow-up at `8f98bac` changes only these test fixtures. It preserves exact SSE projection comparisons, uses the shared database millisecond clock, and requires the child Turn to be cancelled and its Session closed while the model response is still held. Native macOS checks are reported separately from full Linux lifecycle and multi-node CI; the existing local-process capability checks are unchanged.

At `8f98bac`, Linux SDK Java CI passed all 46 Hosted process integration cases without skips, the admission and Runtime Broker fault gates, and the EventTransport multi-node gate. The server MySQL/MariaDB job and the Java 21 jobs on Linux, native macOS and Windows also passed. The O4 step subsequently failed in its ordinary unit/H2 suite before reaching the O4 integration scenarios; that is not an O4 integration result.

The H2 failure was reproduced deterministically by recompiling the actual latest-environment query after parameter binding. H2 did not infer binary types for the Session/Turn row parameters, so bound strings failed comparison with the schema's binary IDs. The query now binds those two identities with the existing canonical UTF-8 encoder, without changing its SQL or tenant predicates. The existing admission-order regression forces recompilation and retains its original behavior assertions.

The corrected tree passes the eight focused recompilation cases and the complete 2,944-case server unit/H2 suite, with seven existing skips. Nine independent actual-store controls pass on MySQL 8.4.11, covering batch reads, admission order, missing events, late older-Turn events, tenant separation and Unicode/case-sensitive identities. The full MySQL profile passes all 76 Broker cases and completes 611 server cases with one error in an existing publication fixture using a two-second claim; that full verification run fails. The unchanged failing method passes a focused verification continuation, including Checkstyle and SpotBugs. This is not a clean 611-case pass; the original failure and narrower successful retry remain separately recorded.

### Consolidated server integration, 2026-10-16

The integration of #14277 moves the Broker, Server and SSH additions into `packages/managed-agent-server`, while the Java SDK remains under `packages/sdk-java/qwencode`. Main now includes #14316's V4 Workspace-creation receipt namespace, V5 model-selection schema and V6 approval selection; SSH appends V7 without rewriting any published migration resource. The initializer and catalog recognize all published V1–V6 catalogs before V7. The public API advances from main's 1.51.0 to 1.52.0, retaining local Workspace creation and model/approval controls. Drain older preview Sessions with their original build before recreating disposable preview catalogs; no Flyway history is rewritten or repaired. Dynamically created local roots and registered SSH storage retain their respective identity checks, and SSH lifecycle-v2 retirement keeps its strict proof requirement alongside main's legacy held-Runtime inventory. The browser uses a separate SSH registration draft key so local creation cannot consume a remote registration receipt, including after refresh, and hides remote registration dialogs while Managed mode is inactive.

On the preceding head `7521696`, Linux CI passes all 56 O4 integration cases without skips, including the capacity probes. Its Hosted process profile still fails one of 46 cases: the `resident-expiry` fixture's initial Turn remains RUNNING after the Harness logs a recovery-blocking HTTP invalid-argument response, before the deletion cut. The available artifact does not identify the rejected route or field. This is not classified as an infrastructure flake, and neither a longer wait nor an automatic retry establishes a fix. Only this synthetic Linux fixture enables two narrow Spring DEBUG loggers with request-detail masking to expose the request path, status and exception in future failure artifacts. An independent real DispatcherServlet probe verifies that configuration without exposing its header/body/parameter sentinels; raw queries and exception messages remain visible, so it is not a production logging setting.

The consolidated source reactor passes all 77 selected SDK cases, 3,956 combined unit/H2 cases with 16 existing or opt-in skips, and 148 selected MySQL 8.4.11 cases with no skips (76 Broker and 72 SSH/Workspace cases). Checkstyle and SpotBugs pass. Nine independent actual-store MySQL controls also pass.

The broad workflow/script selection completes 1,284 passing, 27 skipped and one failed autofix timeout-handoff case; the original 600ms test then passes unchanged in a one-case focused run. The failed broad run remains recorded and is not represented as an entirely passing suite.

The opt-in SSH process fixture requires two relative-path corrections for the new module location. Independent execution first reproduces the failing setup before SSH startup; after the root correction, six cases pass and the seventh exposes the publication-fixture path. Correcting that second path yields all seven real native macOS loopback SSH cases passing without skips, including deferred no-start ACK retirement, followed by successful Checkstyle and SpotBugs. All test sources are recompiled in that final focused verification; the earlier failed run is retained separately.

The merged tree also passes the complete root build, typecheck and bundle, all 1,024 selected CLI cases across Harness, tool-turn, Broker, native bootstrap and Workspace binding, and all 34 WebShell build-artifact cases. Regenerating the public API types from the new server location produces byte-identical output. These component checks do not replace the pending Linux/deployed acceptance.

The original durable local-process host-identity gate rejects native macOS. The blocked fixture is not counted as locally validated, and no OS spoof or capability opt-out is used. The Hosted HTTP failure remains pending Linux diagnosis.

SSH Runtime acceptance on Linux and across physical machines has not run. A complete deployed WebShell → Java → MySQL → remote Shell publication flow has not run; the participating components were verified separately. No production node was configured or modified. These gaps prevent claiming production acceptance.
