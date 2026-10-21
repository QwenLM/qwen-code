# Run Managed Sessions locally

[English](managed-local-serve.md) | [简体中文](managed-local-serve.zh-CN.md)

Managed local uses a persistent embedded H2 database. Install a matching
managed-runtime archive containing the Java control plane, optionally with
Java 21, alongside your normal Qwen installation. It reuses the Node executable running Qwen,
its Hosted Harness, native worker entry and production WebShell. Users do not install
MySQL, Docker, Maven, or systemd. The bundled runtime includes Java; the
lightweight edition requires Java 21 already installed on the machine.

This mode is experimental. The implementation supports native macOS and Linux
on arm64 and x64. Platform acceptance results are recorded separately; providing
a packaging target does not establish that platform has passed E2E validation.
Managed runtime archives are built explicitly as described below; ordinary CLI
packages do not contain the Java payload. An optional complete Managed
standalone archive bundles all components.

## Start and stop

Use a Qwen version that includes Managed local support. Older releases need a
CLI upgrade; installing the runtime alone cannot add the launcher. Download a
matching `qwen-code-managed-runtime-<platform>-<arch>.tar.gz` and its `.sha256`
file. Verify the checksum, then extract it into Qwen home:

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

For a smaller download, choose `qwen-code-managed-runtime-lite-<platform>-<arch>.tar.gz`
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
Java produces an installation/configuration error; Qwen does not download it.
The bundled edition always uses its own Java and does not fall back to the
machine's Java if its payload is damaged.

The optional complete `qwen-code-managed-local-<platform>-<arch>.tar.gz` also
works: extract it and run `./qwen-code/bin/qwen serve --managed --open`.

The application binds to `127.0.0.1:4170`. Use `--port 0` for an available
port, or select a fixed port. Keep the terminal open; Ctrl+C shuts down the
front door, Java service, and Harness. systemd is optional for operator-managed
deployments and is not used by this command.

The terminal prints a browser URL with a token fragment. Treat it as a local
password. The browser uses the token to authenticate every API request; Java
signing keys and internal credentials never reach the browser. The listener is
loopback-only. For a headless machine, omit `--open` and open the printed URL
on that machine, or use an authenticated tunnel you manage.

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
through the existing idempotent Workspace API. The Managed UI can create more
Workspaces and select project subdirectories. This command does not import the
directory from which it was run. `--workspace` is rejected in Managed local
mode: existing external Git checkout import requires a separate registration
workflow. Keep projects in subdirectories of the created Workspace so the
`.qwen-managed-storage.json` maintenance marker stays outside Git worktrees.
Do not edit, delete, stash, or commit that marker.

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
A missing payload, wrong CLI version, target,
Java major version or server checksum fails before children start. No Maven
execution or network runtime download occurs during application startup.

See the bilingual [design](../design/2026-10-20-managed-local-serve.md) for
ownership boundaries and validation criteria, and the
[Java server reference](../../packages/managed-agent-server/README.md) for
operator-oriented MySQL deployments.
