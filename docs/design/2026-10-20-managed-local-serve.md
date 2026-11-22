# Managed local serve

[English](2026-10-20-managed-local-serve.md) | [简体中文](2026-10-20-managed-local-serve.zh-CN.md)

Status: local serve, first-use JAR download, and release integration implemented; production publication pending.
Date: 2026-10-21.

## Problem and current state

Hosted Managed Sessions already have a Java control plane with an embedded
Runtime Broker, a private Node Hosted Harness, and native local tool workers.
The reference deployment requires a separately configured MySQL server,
Harness, credentials, and production WebShell integration. The development
launcher relies on a source checkout, Maven, and Vite. Neither is a local
application users can start with one command.

H2 in MySQL mode already exercises the canonical Flyway schema and JDBC stores
in tests. Native workers support Linux and macOS; macOS supports same-boot
adoption, not trusted whole-host reboot recovery. systemd is an optional
operator deployment choice.

## Goals and scope

Managed local runs `qwen serve --managed --open` without MySQL, Docker, systemd,
Maven, or a source checkout. The default first-use installer downloads only the
matching server JAR and requires local Java 21. A separately installed managed-runtime
archive can supply both the matching Java server JAR and Java 21 runtime. It reuses
the installed Qwen CLI, its Node process, Hosted Harness, native worker entry,
and built WebShell assets. An optional complete standalone distribution includes
all components. A lightweight archive omits Java and requires an installed
Java 21. The initial targets are native Linux and macOS on x64 and
arm64. Windows and Bun are outside this delivery.

This is one trusted user's loopback application with one Java control plane
per private data directory. It retains SQL ownership, leases, fencing,
idempotency, original Runtime routing, and unknown-result semantics. MySQL
reference deployments keep their existing defaults. Public multi-user hosting,
HA, SSH/Kubernetes setup, and automatic repair of recovery facts are outside
scope.

The initial Workspace is application-owned. Users can explicitly import an
existing local project by absolute path through Workspace → Choose existing
directory. The launcher enables the existing [local directory import](2026-10-21-managed-local-directory-import.md)
capability under loopback signed authentication. Its registration, OWNER grant,
physical identity checks and recovery remain authoritative. Files stay in place
and the maintenance marker stays outside Git worktrees. The launch directory is
not automatically imported.

## Proposed components

| Component                      | Responsibility                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI managed launcher           | Resolve packaged runtime, lock private data, retain secrets, start and supervise children, wait for readiness, bootstrap through existing APIs, expose the browser URL |
| `managed-local` Spring profile | Persistent embedded H2, loopback and private-data validation, canonical migrations, local process settings                                                             |
| Ordinary daemon front door     | Serve packaged assets and ordinary daemon APIs/transports, authenticate the browser, proxy the Java WebShell API using server-owned signed identity                    |
| Unified standalone WebShell    | Read authenticated boot options, instantiate the existing Java provider, use shared workspace/session navigation at the current origin                                 |
| Managed distribution builder   | Package JAR and JRE separately, or add them to a complete standalone distribution; record versions and checksums and retain runtime licenses                           |

### Startup and persistence

`--managed` is an opt-in application launcher, lazily loaded. It starts the
ordinary daemon alongside Java and the private Harness, rejecting conflicting
execution profiles and flags. The ordinary daemon owns the public loopback-only
listener, which always uses a bearer token. See the
[unified WebShell design](2026-10-21-managed-daemon-web-shell.md).
`--port`, `--open`, and `--open-with-auth` retain their usual meanings.
`--managed-data-dir` optionally selects the private state directory; the
default is beneath the user's Qwen home. Concurrent launchers for the same
directory refuse admission.

The private directory contains stable installation identity, separate public,
Harness, Broker, signature, writer-binding and Runtime-credential secrets,
file database, Runtime state, durable worker file history, application-owned
Workspace creation root, and service logs. Directories are owner-only and
credential files are owner-readable/writable only. Startup never rotates
credentials or removes persisted facts. A corrupt or incomplete credential file
fails closed. No secret is passed in process command arguments or browser boot
options.

Start the private Hosted Harness and Java processes with loopback listeners.
The current Qwen process supplies its canonical CLI entry and Node executable
to both the Harness and workers; no second CLI is discovered through PATH.
The runtime archive must match that CLI version exactly. The Harness keeps the
user's normal Qwen model configuration; workers retain tool execution only.
Enable files and Shell with the existing `default` approval mode. Explicitly
enable the existing `hosted-workspace-shell/1` lifecycle profile and require it
in the authenticated Harness capability check so Session close can settle Shell
resources. The public front door opens only after Java readiness and these
capability checks succeed. The built-in `qwen-code` agent uses the user's configured model.
A stable bootstrap idempotency key creates the default Workspace through the
existing signed API. Retries replay that receipt; they do not manufacture
replacement identities. The private legacy Workspace ID remains the existing
hash of its canonical directory; application-owned Workspace IDs are generated
by the existing API.

The H2 URL is a private file database using MySQL mode,
`DATABASE_TO_LOWER=TRUE`, `DB_CLOSE_ON_EXIT=FALSE`, and `WRITE_DELAY=0`.
There is no TCP server, `AUTO_SERVER`, or Web console. H2's file lock provides
an additional single-control-plane guard. Keep the existing fresh-catalog,
Flyway, and shared schema checks; foreign, partial, history-only, or unsupported
catalogs remain refused. Existing resource kind names are retained because they
are persisted protocol identifiers, even when inline bytes reside in H2.

Control-plane mutations lock the Session row before reading its event stream
counters with a separate locking query. An H2 outer join can retain counters
from before a lock wait even after refreshing the Session row. A fresh stream
read keeps event allocation and mutation-attempt boundaries current; no batch
may move the committed stream counter backwards.

### Browser and API ownership

The server places a public Managed-mode marker in the HTML. The browser obtains
boot options from authenticated `GET /managed/boot`: `mode`, `productScope`,
`agentId`, and Workspace binding options. This configuration contains no tenant,
actor, private endpoint, or credential. Managed mode ignores `?daemon=` and
fanout targets and fixes the provider to the page's origin.

`GET /capabilities` is the authenticated process-global browser auth probe and
returns the ordinary daemon's real capabilities and Workspaces. Authenticated
boot constructs the Java provider and supplies it to the normal standalone
WebShell's shared Projects navigation without execution-mode tabs. Local sessions use the launch
directory; this does not import that directory into Managed storage.
`/api/agent/web-shell/v1/**` and exact artifact-content GET/HEAD requests at
`/v1/agents/sessions/:sessionId/artifacts/:artifactId/content` are the proxied
API surface; the latter is required by the existing Java client. The front door
strips caller identity/private auth headers and signs the exact bounded raw
request bytes with a fixed server-owned tenant and actor. Java retains
persisted-Workspace and live-Session authorization. SSE responses stream with
backpressure and abort on client disconnect. Internal writer, Runtime Broker,
maintenance, and general Java routes are not exposed by the front door.

### Lifecycle and failures

The launcher tracks only children it created and owns process signals, with
embedded daemon signal handlers disabled. SIGINT/SIGTERM stop admission and
close the daemon and its transports, then stop Java and Harness with bounded graceful waits.
Both children use separate process groups so terminal signals reach the launcher
first. Forced shutdown targets Java itself and the Harness's process group;
durable workers keep their existing ownership. Startup rechecks child failure
and interruption after the public listener binds before reporting success.
Startup failure unwinds created children and releases its lock; unrelated
processes and private data are never deleted. An unexpected child exit closes
the application with a nonzero status. There is no blind restart or replay of
unknown side effects. Original durable workers and SQL recovery retain their
existing ownership rules. macOS explicitly disables trusted reboot recovery.

Restarting a Session may wait for the previous SQL writer lease to expire
(60 seconds by default); process exit does not release or shorten that lease.
A missing storage marker does not prevent UI bootstrap or replay of its
Workspace-creation receipt. Runtime admission for the affected bound tool turn
fails with `workspace_unavailable`, without recreating the marker or executing
the tool elsewhere.

This delivery does not claim immunity to laptop sleep or automatic login-time
startup. Keeping a terminal open is sufficient for normal foreground use;
operators may choose their own service manager later.

### Distribution and runtime resolution

The separate `qwen-code-managed-runtime-<target>.tar.gz` contains only
`managed-runtime/<cli-version>/<target>/manifest.json`, `server.jar`, and
`jre/`. It includes Java licenses and contains no Node, CLI, Hosted Harness,
worker copy, or WebShell assets. Extract it into the user's Qwen home; the
installed `qwen serve --managed --open` discovers its exact version/target
directory. Users still configure their model through the installed CLI.

The lightweight `qwen-code-managed-runtime-lite-<target>.tar.gz` contains only
the same `manifest.json` and `server.jar`. Builders select it explicitly with
`--without-jre`, mutually exclusive with `--jre-home`. It installs in the same
version/target directory; users choose one edition rather than overlaying both.
The manifest records `javaSource: system` for lightweight delivery and
`javaSource: bundled` for complete delivery. Older manifests without this field
retain bundled semantics. Unknown values are refused.

For lightweight delivery, a nonempty `JAVA_HOME` selects `bin/java` exclusively;
otherwise resolve the first executable `java` on PATH to its canonical path.
Probe that executable with a bounded Java properties/version command and require
`java.specification.version=21` before creating application state or service
children. Missing, unlaunchable or incompatible Java produces an actionable
error. Java itself is not installed or downloaded, and another Java version is not searched for.
Bundled delivery still requires its own runtime; a missing or corrupt JRE never
switches to system Java. The service launches the exact verified executable.

The manifest binds CLI version, target, Java source, Java major version, and server digest.
An explicit `QWEN_MANAGED_LOCAL_RUNTIME_DIR` selects one payload. Without it,
the launcher uses a colocated `managed-runtime` directory when present, then
the versioned installation under Qwen home when the colocated directory is
absent. A selected invalid or incomplete payload fails closed without trying
another location. Compatibility is validated before private state or children
are created. When neither a selected payload nor the versioned cache exists,
the launcher verifies local Java 21 before installing the matching server JAR.
Older Qwen releases without this launcher require a CLI upgrade;
installing only the runtime cannot add missing CLI behavior.

The existing complete Managed standalone builder keeps its optional JAR/JRE
inputs and `lib/managed-runtime/` layout. Both builders use the same payload
copy/validation logic. A separate runtime build does not require built CLI
assets or a Node archive. Its archives are written outside the CLI asset tree
by default. Missing payload errors identify the expected version,
target and installation path. Offline users can preinstall either archive or
select an explicit runtime directory. Publishing archives or npm packages remains
a separate release operation.

### First-use download and publication

Ordinary CLI packages contain no Java payload. Only `qwen serve --managed`
downloads a missing default runtime. The versioned release asset is
`qwen-managed-agent-server-<cli-version>.jar` with a matching `.sha256` file.
The installer tries the existing official Aliyun OSS release prefix first and
the same GitHub Release tag second. It never selects `latest`, resolves Maven
dependencies, or downloads Java. Both sources must provide the exact CLI version.

A per-version/target installation lock serializes downloads across processes.
The installer streams into a private temporary sibling directory with a bounded
download time and size, validates the JAR SHA-256 and ZIP signature, writes the
existing `javaSource: system` manifest, and atomically renames the completed
directory into the cache. A failed or interrupted download cannot publish a
partial runtime. A later invocation can retry. Existing explicit, colocated,
or installed payloads remain authoritative: invalid content is refused instead
of being silently replaced or causing a download. Cached startup requires no
network access. Installation occurs before application credentials, data, or
service children are created.

A dedicated protected release workflow builds from an existing CLI release tag,
checks its package version, and verifies the Java SDK and server using Java 21.
After full verification, the executable server JAR and checksum are attached to the
CLI GitHub Release and copied to the existing versioned OSS prefix, outside the
standalone archive allowlist. The workflow selects the `-exec.jar` build output
when present and falls back to the main JAR for older tags; the public versioned
JAR name stays unchanged. The workflow verifies both public channels against
the staged bytes. Runtime distribution does not check for the server coordinate
on Maven Central, publish it there, or wait for that publication. Central
publishing authorization and artifact synchronization no longer gate delivery
to the channels the installer actually uses. It needs OSS credentials and GitHub
release access, without loading Central publishing credentials or a GPG private key.

Java compilation and normal Maven dependency resolution, the complete SDK/server
verification, test-fork isolation and the existing `central-release` build profile
remain unchanged. GPG signing is
skipped during verification; the profile does not publish anything before the
Maven deploy phase. Independent signed publication of
`com.alibaba:qwen-managed-agent-server:<cli-version>` remains available through
that Maven profile when needed for Maven consumers, including sources and
Javadoc and excluding auxiliary operator JARs. It is a separate release
operation, with no dependency edge in the runtime distribution workflow.

Reproducible timestamps and checksum comparisons prevent a retry from replacing
an existing version with different bytes. Dry runs build and verify without
publishing. Production credentials and publication remain protected by the
existing `production-release` environment.

Maven Central is a Java artifact publication channel, not the CLI's startup
download dependency. The distribution follows [Sonatype's guidance for runtime
artifacts](https://central.sonatype.org/faq/429-operational-dependencies/) by using the project's own OSS/GitHub channels. A new CLI release must
have matching runtime assets published before its Managed first-use path can
succeed; release availability failures name the required version and preserve
the offline installation option.

## Affected files

- `packages/cli/src/serve/managed-local-download.ts` and focused installation tests; `.github/workflows/release-managed-runtime.yml`, `scripts/managed-runtime-release.js`, and publication contract tests.

- `packages/cli/src/commands/serve.ts` and new managed local launcher/front-door
  modules and focused tests.
- `packages/cli/src/serve/web-shell-static.ts` and related tests.
- `packages/web-shell/client/main.tsx`, Managed standalone bootstrap, and tests.
- `packages/managed-agent-server/pom.xml`, a local Spring profile/configuration,
  fresh Session stream locking reads, and persistent file-database/concurrency tests.
- `scripts/create-standalone-package.js`, a runtime-only builder, managed packaging helpers/tests,
  and bilingual usage documentation.

## Validation and acceptance

Baseline the globally installed `qwen` before edits. Verify the local bundle
after implementation, including a packaged layout outside the repository.
Acceptance requires parameter handling, absent/mismatched runtime refusal,
single-directory locking, secret permissions and persistence, private listener
authentication, production UI bootstrap, Workspace creation, one real local
worker file/Shell turn and a second turn in the same Session, graceful restart
with retained history, and failure cleanup. Use a deterministic model fixture
when provider credentials are unavailable and label that evidence precisely.

Run focused CLI/WebShell tests, root build/typecheck/bundle, Java `mvn verify`,
and persistent H2 restart/lock/rollback/schema-refusal tests. Preserve MySQL
integration regression coverage where available and do not report H2 as MySQL
validation. Linux/macOS qualification is separate; this machine can validate
only its native target. Record actual results and limitations in the E2E plan.

For the split distribution, verify archive contents and checksum without a Node
or CLI build input, automatic discovery under an isolated Qwen home, explicit
and colocated precedence, and refusal of selected invalid payloads before
state or children are created. Run a real native-worker Session from an
ordinary installed Qwen outside the source tree; prove Java comes from the
separate runtime while Harness, workers and WebShell use that local Qwen.
Verify that a Harness batch waiting behind a committed event cannot reuse or
decrease its sequence, with and without a public projection, and retain MySQL
store regressions for the shared locking change.

For lightweight delivery, verify a JAR/manifest-only archive, both JAVA_HOME
and PATH selection, refusal of absent/wrong Java before application state,
and no system-Java fallback for broken bundled payloads. Repeat the installed
CLI lifecycle test with external Java 21 and measure actual archive/payload
bytes against the bundled runtime. Existing Java server behavior is unchanged.

The separate runtime passed this lifecycle plan with an ordinary npm CLI 0.25.3
installation and the existing Node 22.14.0 outside the source tree. Automatic
Qwen-home discovery and selected-payload refusal passed. Process paths confirm
Java comes from the separate runtime while Harness and workers use that Node
and npm CLI; served WebShell bytes match the npm installation. H2 and MySQL 8.4
concurrency regressions passed for the Session/stream locking change.

The macOS arm64 archive passed the complete local lifecycle plan outside the
source tree with no Java on PATH: file and Shell approval, streaming, subsequent
turns, restart with retained context, cancellation, Session close, child-failure
cleanup, and missing-marker refusal. A browser check confirmed production
Managed UI bootstrap and same-origin routing. The model was a deterministic
OpenAI-compatible fixture; tools used real native workers. Real-provider
inference and other platform targets remain unqualified.

The lightweight macOS arm64 archive passed the installed-CLI lifecycle with
external Java 21 and the same deterministic model fixture. Fifteen selection
checks passed, including JAVA_HOME/PATH success, wrong/missing Java refusal,
preservation of existing state, and no system fallback for broken bundled or
legacy payloads. The ordinary npm package contains no JAR or JRE. The lightweight
archive measures 78,299,321 bytes compressed and 86,278,025 payload-file bytes;
the bundled runtime measures 278,836,538 and 437,061,513 bytes respectively.
This change reuses the previously verified server JAR without Java source changes.

In the original local-delivery trial, root build/typecheck/bundle, focused
CLI/WebShell/packaging tests, persistent H2 tests, Java unit tests, and SpotBugs
passed. That trial's full Maven verification was blocked by two MySQL integration
assertions and six Checkstyle violations in unchanged files on its original
base. Those baseline failures remain recorded separately from local acceptance;
they do not describe the current main branch. The results above belong to the
pre-split trial. Current split-head verification and limitations are recorded
in the PR test report.

The first-use download path passed fourteen built-bundle scenarios with the real Java 21 server and Hosted Harness: initial installation, offline restart, OSS-to-GitHub fallback, interrupted-download retry, and refusal of invalid downloads or selected payloads. Transport was intercepted at the exact production URLs to serve the locally built JAR; public production assets have not been published or validated. The release profile builds the primary executable JAR, sources, and Javadoc locally. The runtime-distribution change still requires a protected GitHub/OSS release run and clean first-install acceptance; signed Central publication is independent.

## Open questions

No blocking design decision remains for this delivery. Future release automation
may download verified JRE archives at build time. Local project import uses the
existing explicit registration workflow; startup does not import a project
without a user selection.
