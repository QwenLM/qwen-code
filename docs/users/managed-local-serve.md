# Run Managed Sessions locally

[English](managed-local-serve.md) | [简体中文](managed-local-serve.zh-CN.md)

Managed local uses a persistent embedded H2 database. With local Java 21 installed,
the first Managed launch downloads the matching Java server JAR automatically.
It reuses the Node executable running Qwen,
its Hosted Harness, native worker entry and production WebShell. Users do not install
MySQL, Docker, Maven, or systemd. An optional preinstalled bundled runtime includes
Java; the default download and lightweight edition require local Java 21.

This mode is experimental. The implementation supports native macOS and Linux
on arm64 and x64. Platform acceptance results are recorded separately; providing
a packaging target does not establish that platform has passed E2E validation.
Managed runtime archives are built explicitly as described below; ordinary CLI
packages do not contain the Java payload. An optional complete Managed
standalone archive bundles all components.

## Start and stop

Use a Qwen version that includes Managed local support. Older releases need a
CLI upgrade; installing the runtime alone cannot add the launcher. Install Java 21
and set `JAVA_HOME` to its home, or put its executable on PATH, then run:

```sh
qwen serve --managed --open
```

Before creating application data or starting services, Qwen checks Java 21 and
downloads `qwen-managed-agent-server-<cli-version>.jar` plus its checksum from
the official Aliyun OSS release mirror, with the same GitHub Release as fallback.
It verifies the checksum and installs a complete runtime atomically under
`<Qwen home>/managed-runtime/<cli-version>/<platform>-<arch>/`. Later launches
reuse that cache without networking. Ordinary Qwen commands do not download it.
Only the service JAR is downloaded; Qwen does not install Java or run Maven.
If the matching release is unavailable or a download fails, no application data
or service children are created. Retry later or preinstall a matching runtime.

For offline use or bundled Java, obtain a matching
`qwen-code-managed-runtime-<platform>-<arch>.tar.gz` and its `.sha256` file from
your distribution builder. Verify and extract it before starting:

```sh
shasum -a 256 -c qwen-code-managed-runtime-darwin-arm64.tar.gz.sha256
mkdir -p "${QWEN_HOME:-$HOME/.qwen}"
tar -xzf qwen-code-managed-runtime-darwin-arm64.tar.gz -C "${QWEN_HOME:-$HOME/.qwen}"
qwen serve --managed --open
```

The archive installs under
`<Qwen home>/managed-runtime/<cli-version>/<platform>-<arch>/`. Qwen discovers
the directory for its exact version and platform automatically. The runtime
does not include another Node, CLI, Harness, worker or WebShell installation.

For a smaller offline payload, choose `qwen-code-managed-runtime-lite-<platform>-<arch>.tar.gz`
and verify/extract it in the same way. It contains only the server JAR and
manifest. Install one edition in a fresh version/target directory; do not
overlay lightweight and bundled archives. The lightweight launcher uses
`JAVA_HOME/bin/java` when JAVA_HOME is nonempty, otherwise the first executable
`java` on PATH. It requires Java 21 specifically and checks the executable
before creating application state. An incorrect JAVA_HOME is an error even if
PATH contains another working Java. For example:

```sh
JAVA_HOME=/absolute/java-21-home qwen serve --managed --open
```

On macOS, JAVA_HOME typically ends in `Contents/Home`. Missing or incompatible
Java produces an installation/configuration error before downloading the JAR; Qwen does not download Java.
The bundled edition always uses its own Java and does not fall back to the
machine's Java if its payload is damaged.

The optional complete `qwen-code-managed-local-<platform>-<arch>.tar.gz` also
works: extract it and run `./qwen-code/bin/qwen serve --managed --open`.

The application binds to `127.0.0.1:4170`. Use `--port 0` for an available
port, or select a fixed port. Keep the terminal open; Ctrl+C shuts down the
ordinary daemon, Java service, and Harness. systemd is optional for operator-managed
deployments and is not used by this command.
An occupied public port follows the ordinary daemon's bounded nearby-port
retry; use the browser address printed by the launcher.

This one command starts both the ordinary daemon and Managed Agent. The same
WebShell lists ordinary and Managed workspaces and sessions together under Projects, with a Managed label on Managed workspaces and no execution-mode tabs. New task follows the selected workspace or conversation. Local sessions use
the directory where you ran the command, while Managed sessions use their
application-created Workspaces or explicitly imported local projects. Both use
the same authenticated browser origin;
you do not need a second daemon command or browser page.

In **Add workspace**, choose **Local (daemon)** or **Managed (Managed Agent)**
before submitting. The choice defaults to the current conversation's service.
Workspace rows and **New task** show that service, and new tasks inherit the
selected workspace. The daemon's existing SSH workspace support remains
available; Managed SSH registration is not integrated into this shared dialog.

The terminal prints a browser URL with a token fragment. Treat it as a local
password. The browser uses the token to authenticate every API request; Java
signing keys and internal credentials never reach the browser. The listener is
loopback-only. For a headless machine, omit `--open` and open the printed URL
on that machine, or use an authenticated tunnel you manage.

The unified application currently supports the local loopback page. The full
shell's existing Mobile access / Local Control entry is not integrated with
Managed boot: a paired LAN listener cannot open this unified page. Mobile
sharing needs a separate integration; the ordinary daemon retains its existing
Local Control behavior.

The Harness uses normal Qwen model configuration and provider credentials.
Configure a model using the usual Qwen CLI setup before sending your first
prompt. Files and Shell use the `default` approval mode; the Managed UI asks
for approval before an action that requires it.

After a restart, continuing an existing Session may wait for its previous SQL
writer lease to expire (60 seconds by default). Keep the original data directory
and retry after that interval; restarting processes does not clear ownership.

## Workspaces and persistent data

The default private data directory is `<Qwen home>/managed-local`, normally
`~/.qwen/managed-local`. Override it with:

```sh
qwen serve --managed --managed-data-dir /absolute/private/data --open
```

The directory must be outside every Git worktree. One launcher may use it at
a time; Java also holds an exclusive database file lock. Private service ports
and credentials remain stable across restarts. A private port occupied by
another application causes startup to fail; choose a different fresh data
directory or stop the conflicting service rather than editing persisted facts.

Startup creates an application-owned default Workspace and its OWNER grant
through the existing idempotent Workspace API. To use an existing local project,
open **Workspace → Choose existing directory**, browse or enter its absolute
path, then add the folder. The service registers its parent and grants OWNER
access automatically, keeping existing files in place. New tasks start in the
selected project. You can also create an empty Workspace.

The launch directory remains available to Local sessions and is not imported
automatically. `--workspace` remains unsupported in Managed local mode; select
the project in the UI. The `.qwen-managed-storage.json` maintenance marker is
kept outside Git worktrees; do not edit, delete, stash or commit it. Imported
project files stay outside the private Managed data directory and require their
own backup.

Local session history continues to use ordinary Qwen storage. It is separate
from the Managed data directory and is not included in a Managed-only backup.

Preserve the complete data directory together, including `state.json`,
`database/`, `runtime/`, `worker-home/`, and `workspaces/`. Settle or cancel
active work, close its Sessions, then stop the application before making a
filesystem backup. Durable original workers can outlive a control-plane exit;
confirm all Workspace writers have stopped. An unknown execution needs the
existing original-owner recovery procedure before an offline backup.
Credentials, database, worker history and Workspace identity belong to the same
installation. Restoring only a subset
can close recovery admission. Startup does not recreate a missing marker or
replace corrupt credentials. Service diagnostics are in `logs/`.

macOS supports native workers and same-boot durable adoption. Trusted whole-host
reboot recovery remains disabled in the local launcher. Unknown tool outcomes
retain existing original-owner recovery rules and are never blindly replayed.
This mode does not add automatic login-time startup or prevent laptop sleep.

## Build a distribution

These commands are for release builders, not end users. Build the CLI and Java
server from the same checkout with Node 22+, Java 21, and Maven 3.8.9+:

```sh
corepack pnpm install --frozen-lockfile
npm run build
npm run typecheck
npm run bundle
npm run prepare:package
mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
mvn -f packages/managed-agent-server/pom.xml verify
npm run package:managed-runtime -- \
  --target darwin-arm64 \
  --server-jar packages/managed-agent-server/target/qwen-managed-agent-server-0.1.0-alpha.jar \
  --jre-home /verified/java-21-home \
  --out-dir /output/managed-runtime
```

The runtime builder only needs the matching server JAR, Java runtime and CLI
version from this checkout. It does not require built CLI assets or a Node
archive. By default it writes to
`packages/managed-agent-server/target/managed-runtime`, outside the CLI's
`dist/` assets. It emits the runtime archive and a per-archive `.sha256` file. The
normal CLI is built/released separately.

Build the lightweight runtime using the same server JAR with `--without-jre`
instead of `--jre-home`:

```sh
npm run package:managed-runtime -- \
  --target darwin-arm64 \
  --server-jar packages/managed-agent-server/target/qwen-managed-agent-server-0.1.0-alpha.jar \
  --without-jre \
  --out-dir /output/managed-runtime
```

This emits `qwen-code-managed-runtime-lite-darwin-arm64.tar.gz` and its checksum.
The lightweight builder needs no Java input. For an optional complete distribution:

```sh
npm run package:standalone -- \
  --target darwin-arm64 \
  --node-archive /verified/node-v22-darwin-arm64.tar.gz \
  --managed-server-jar packages/managed-agent-server/target/qwen-managed-agent-server-0.1.0-alpha.jar \
  --managed-jre-home /verified/java-21-home \
  --out-dir /output/managed-local
```

Use the complete extracted runtime home containing `bin/java`, `lib/modules`,
`release`, and `legal/`. A macOS JRE may place this under `Contents/Home`.
The builder checks Java major version, OS and architecture, includes its
licenses, and records the server SHA-256 and matching CLI version in
the payload manifest. The complete standalone uses `lib/managed-runtime/` and
emits `SHA256SUMS`. Verify publisher checksums of runtime inputs before building.
Windows and Bun managed execution is refused; the launcher requires Node 22+.

For an explicit runtime location,
`QWEN_MANAGED_LOCAL_RUNTIME_DIR=/absolute/managed-runtime` points the local
CLI directly at a directory containing `manifest.json` and `server.jar`
(plus `jre/` for the bundled edition).
It takes precedence over the colocated payload and versioned Qwen-home install.
An existing colocated payload takes precedence over the Qwen-home install.
A selected invalid or incomplete payload is never replaced by a different one.
A missing explicitly selected payload, wrong CLI version, target,
Java major version or server checksum fails before children start. Only a missing
default cache triggers JAR installation; existing damaged payloads are not replaced.
Maven is never run during application startup.

## Publish the first-use JAR

The `Release Managed server runtime` workflow builds from an already published
CLI release tag, using the SDK and server from that exact source revision. A
manual run must be dispatched from `main` and defaults to a dry run. It verifies
the CLI and Java module, builds the `central-release` profile, and retains the
JAR and checksum as workflow artifacts without changing public repositories.

After verifying the dry run, release operators can run the same tag with
`dry_run=false` through the protected `production-release` environment. The
workflow sets the server artifact version to the CLI version, publishes
`com.alibaba:qwen-managed-agent-server:<cli-version>` to Maven Central with
sources, Javadoc and signatures, and distributes the same primary JAR plus its
`.sha256` through that GitHub Release and the existing versioned OSS mirror.
Auxiliary operator JARs are not attached to the Central publication. Existing
assets are compared byte-for-byte and never replaced with different content.
Published CLI release events also run this workflow automatically.

The CLI downloads from OSS/GitHub, not Maven Central. It does not resolve the
SDK as a separate user dependency: the executable server JAR includes its Java
dependencies. Runtime assets must exist for the exact CLI release before the
first-use download succeeds. This PR's local validation does not publish those
assets or bypass the production release environment.

See the bilingual [design](../design/2026-10-20-managed-local-serve.md) for
ownership boundaries and validation criteria, and the
[Java server reference](../../packages/managed-agent-server/README.md) for
operator-oriented MySQL deployments.
