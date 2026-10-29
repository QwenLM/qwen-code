# Managed Agent Reference Deployment

[English](managed-agent-reference-deployment.md) | [简体中文](managed-agent-reference-deployment.zh-CN.md)

The Managed Agent reference distribution is experimental. Its accepted initial topology is one Java control plane and its embedded Runtime Broker on one trusted Linux host, one MySQL database, and one compatible Qwen Hosted Harness. The compatibility manifest in each release is authoritative for that release.

## Verify and extract

Download the archive, its detached manifest, and `SHA256SUMS.txt` from the same GitHub prerelease. Verify them before extraction:

```bash
sha256sum --check SHA256SUMS.txt
tar -xzf qwen-managed-agent-reference-<version>.tar.gz
cd qwen-managed-agent-reference-<version>
sha256sum --check SHA256SUMS
```

Inspect `manifest.json`. Confirm that `source.revision` is the reviewed revision, `compatibility.qwenCodeVersion` matches the CLI/Harness installation, and `compatibility.databaseSchema.latestMigrationVersion` is acceptable for the target database. The release is invalid if any checksum or compatibility check fails.

## Prerequisites

- Linux on the trusted application host.
- JDK 21 or later.
- Node.js matching `compatibility.node` and Qwen Code matching `compatibility.qwenCodeVersion`.
- MySQL 8 with an empty database or a database previously managed by an older compatible reference distribution.
- Private, persistent directories for Runtime state and the authorized Workspace.
- Stable database credentials, Runtime credential key ring, and Harness token stored outside the archive.

The Java archive does not contain the npm CLI. Install or build the exact compatible Qwen Code revision separately and locate its `dist/cli.js` for Runtime workers.

## Start the Hosted Harness

Choose one token and capability digest and give the same values to the Harness and Java service:

```bash
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:<64-hex-digest>'

QWEN_SERVER_TOKEN="$QWEN_MANAGED_AGENT_HARNESS_TOKEN" \
QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST="$QWEN_MANAGED_AGENT_CAPABILITY_DIGEST" \
qwen serve --profile hosted-harness --port 4170 --hostname 127.0.0.1 --no-web
```

Keep the Harness on loopback. The Hosted Harness profile does not move to another port: when `--port` is in use, the Harness fails to start, naming the port.

## Start the Java control plane

In another terminal, configure the same Harness, the database and an existing Workspace directory:

```bash
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='<private-password>'
export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'
export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4170'
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:<64-hex-digest>'
export QWEN_MANAGED_AGENT_WORKSPACE_CWD='/srv/qwen-workspace'

bin/qwen-managed-agent-server
```

Settings that cannot be expressed as environment variables, such as the Runtime credential key ring, belong in `config/application.yml`. Start from the bundled template and keep the file private:

```bash
cp config/application.example.yml config/application.yml
chmod 600 config/application.yml
```

Both launchers load that file automatically when it exists. The launcher uses the server JAR in this archive. Spring Flyway applies forward database migrations before the service becomes ready. Wait for:

```bash
curl --fail http://127.0.0.1:8080/actuator/health
```

The enabled Harness turns on the Managed Session Store. The Store's base URL defaults to this server's plaintext loopback listener. Its workspace ID defaults to the one the Runtime Broker derives from `QWEN_MANAGED_AGENT_WORKSPACE_CWD`, so the identity stays the same when the tool path below is enabled. A deployment that already set `QWEN_MANAGED_AGENT_WORKSPACE_ID` must keep it: unbound Sessions resolve their Store scope from that ID. Set `QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` only when the Harness reaches this server through another address, or when the listener serves TLS.

This base configuration supports text-only Hosted Sessions. Keep the listener on loopback unless a signed or authenticated ingress is configured. The complete authentication, API, and capability configuration is bundled as `docs/server-reference.md`.

## Bootstrap credentials

`bin/qwen-managed-agent-bootstrap` generates the shared Harness token and capability digest, the broker token, the Runtime credential key and the database password. It writes `config/harness.env`, `config/server.env`, `config/application.yml` and `config/mysql-setup.sql` with mode 0600, refuses to overwrite existing files unless `--force` is given, and prints paths only:

```bash
bin/qwen-managed-agent-bootstrap
```

The token and digest, and the Broker URL and token for the tool path, are written only to `harness.env`: `server.env` names that file through `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`, and the control plane reads them from it. It refuses to start when the file is set together with `QWEN_MANAGED_AGENT_HARNESS_TOKEN` or `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST`, or when the file's Broker token is set together with `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN`, so a rotation changes one file. The generated `harness.env` and `server.env` are shell-sourceable and also valid systemd `EnvironmentFile`s.

`mysql-setup.sql` creates the `qwen_managed_agent` database and the `qwen` account that `server.env` names, for both `localhost` and `127.0.0.1`, with the `performance_schema` grant Flyway needs. Run it once as a MySQL administrator, for example `mysql -u root < config/mysql-setup.sql`, then delete it; `server.env` keeps the password. It stops at the first statement that fails, so it never changes an existing database or account. A MySQL in a container sees the gateway address rather than `127.0.0.1`; create the account for that host instead.

For the systemd layout, run it as root with `--directory /etc/qwen-managed-agent --service-user qwen-managed-agent`. The account then owns `harness.env` and `application.yml`, `server.env` is `0640 root:qwen-managed-agent`, a new directory is `0750 root:qwen-managed-agent`, and `mysql-setup.sql` stays root's. The bootstrap refuses an account that does not exist, or a directory the account cannot enter. `server.env` also records `QWEN_MANAGED_AGENT_SERVICE_USER`, so the preflight checks file access as that account even when it runs as root.

## Preflight check

Run the bundled launcher with `--check` before the first start and after installing each new artifact. It binds the same configuration (`config/application.yml` plus the environment), starts no listener, and prints one row per input:

```bash
bin/qwen-managed-agent-server --check
```

It covers the JDK, the service account, the configuration file and its permissions, the credential key ring, the startup property validation, the auth/bind combination, the Harness, the Workspace files and Shell cross-settings (including the mount, creation-root or SSH-node requirement), broker credentials and directories, the Workspace `cwd`, free ports, Runtime workers an earlier run left alive, and MySQL connectivity, the `performance_schema` grant and the Flyway version against `manifest.json`. `WARN` and `SKIP` do not fail; any `FAIL` exits 1.

The `harness` row negotiates with a single configured Harness as the first Session does; with a Harness pool it skips the pool's endpoints once the Session Store is enabled with a binding key, and fails until then. It fails when the capability digest differs, the protocol or a required feature is missing, or the Harness lacks the lifecycle a configured Workspace profile needs. It warns when the Harness runs another Qwen Code version than `manifest.json` names, or does not say which. The port checks bind the configured addresses the way the server does, so a port the stopped server left in `TIME_WAIT` counts as free, and the `workers` row warns about workers still running in the Runtime state directory, so stop the service first. While it runs, add `--online`: the port rows then check that something listens, and the `workers` row reports only workers a stopped server left behind, or is skipped for a durable Broker, which adopts them. The command does not verify the native Workspace storage registration.

The `database` row warns when the database's Flyway version is older than `manifest.json` names: that is an upgraded database before the first start of the new release, which migrates it. It fails when the database is newer. At the version `manifest.json` names, it validates the schema as the server does at startup, and fails when the database does not match, as when an experimental release changed its schema baseline in place.

## Maintenance commands

`bin/qwen-managed-agent-admin <command> [arguments]` runs the offline maintenance entry points, such as `storage-registration`, `workspace-migration` and the CSI commands, from the server jar through Spring Boot's `PropertiesLauncher`. Run it without arguments to list the commands, and run a command without arguments for its usage. Like the server launcher, it uses `config/application.yml` when that file exists and `SPRING_CONFIG_ADDITIONAL_LOCATION` is not set. Most commands that open the database take their own credentials rather than `server.env`'s `SPRING_DATASOURCE_*`: the Workspace commands read `W1_JDBC_URL`, `W1_JDBC_USER` and `W1_JDBC_PASSWORD`, and the CSI commands read `K2_JDBC_URL`, `K2_JDBC_USER` and `K2_JDBC_PASSWORD`. Two are exceptions: `operator-recovery` and `resident-retirement` start the server's Spring configuration and use its datasource, so they read `SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME` and `SPRING_DATASOURCE_PASSWORD`, together with the other control-plane settings, from the environment and `config/application.yml`; run them with `server.env` loaded. `csi-protection` opens no database, and neither does `resolved-configuration`, which prints the Runtime state directory, auth mode and trusted actor header that the server's configuration resolves to in the environment it runs in; the upgrade command runs it the same way to find the Runtime state. Each command is an offline procedure with its own preconditions, documented with it; meet them before running it. `bin/qwen-managed-agent-operator-recovery` remains the entry for the Hosted Shell recovery procedure, and `bin/qwen-managed-agent-admin operator-recovery` runs the same command.

## systemd

The distribution includes `systemd/` unit and environment templates for the accepted single-host topology. The control-plane unit uses `KillMode=process` so Runtime workers survive a Broker restart; the Harness unit uses `KillMode=mixed` so its tool processes terminate with it. Follow `systemd/README.md` to install them.

## Enable the accepted local-process tool path

Tool execution requires the existing fail-closed Runtime and Workspace setup. On top of the base configuration, at minimum, configure:

```bash
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED='true'
# Omit when harness.env carries QWEN_MANAGED_RUNTIME_BROKER_TOKEN, as the bootstrap's does.
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID='reference-v1'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY='<base64-encoded-32-byte-key>'
export QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY='/var/lib/qwen-managed-agent/runtime'
export QWEN_MANAGED_AGENT_NODE_EXECUTABLE='/usr/bin/node'
export QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY='/opt/qwen-code/dist/cli.js'
export QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED='true'
```

The Hosted Harness reaches the same Broker through its own environment, not its command line and not the control plane's variables above: set `QWEN_MANAGED_RUNTIME_BROKER_URL='http://127.0.0.1:4182'` and `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` to the Broker token in `harness.env`, or in whatever environment starts the Harness. `qwen serve` removes both from its environment once read, so no process the Harness starts inherits the token, and the control plane keeps the `QWEN_MANAGED_RUNTIME_BROKER_` variables out of Runtime workers. With the bootstrap's files, `harness.env` already holds both, and the control plane takes its Broker token from that file, so leave `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` unset; setting both copies refuses startup. Set the two Harness lines together or not at all, each as a plain `KEY=value` line: startup refuses a file with only one of them or with either one empty, which the Harness also refuses, and a line such as `export KEY=value`, which systemd ignores. The preflight `broker-url` row reads the file's URL the way the Harness's URL parser does, so `http://127.1:4182` counts as `http://127.0.0.1:4182`. It passes when that URL names the Broker's own listener over `http`. It fails when the Harness would refuse the URL, which must be an `http` or `https` origin and may use plain `http` only on the loopback interface, and when it names the listener over `https`, which the plain-HTTP Broker cannot accept. It warns when the URL names another address or port, which only a proxy could forward; a Broker bound to a specific address outside loopback, which needs `QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK=true`, is always reached that way. A Broker bound to `0.0.0.0` needs that setting too, but still serves loopback, where the Harness dials it directly at `http://127.0.0.1:4182` and the row passes. An IPv6 URL such as `http://[::1]:4182` warns there, because that bind takes IPv6 only when the control plane's JVM listens on both families, which it does not under `-Djava.net.preferIPv4Stack=true`. It also warns when the file has no Broker URL, which is what a Harness given the pair through its own environment or command line looks like to preflight; there the warning is expected, and moving the pair into the file means deleting `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` from `server.env`.

Before admitting file, Shell, or child Git work, complete the native storage registration and mount-identity verification described under “Verified physical Workspace recovery” in `docs/server-reference.md`. An unregistered or ambiguous mount must remain unavailable. Public Shell execution remains disabled by default. Shell lifecycle v2 is advertised by default; an explicit lifecycle list replaces the default, and an empty list disables it. MCP lifecycle still requires explicit inclusion. Capability advertisement does not establish deployment qualification.

## Upgrade

On the systemd layout, the new distribution's `bin/qwen-managed-agent-upgrade` runs the upgrade in phases. Run each as root from the extracted and verified archive:

```bash
cd qwen-managed-agent-reference-<new-version>
# Pass check the options backup gets, such as --skip-database.
bin/qwen-managed-agent-upgrade check
# Stop new ingress and let admitted work settle.
bin/qwen-managed-agent-upgrade stop
bin/qwen-managed-agent-upgrade backup --to /var/backups/qwen-managed-agent/<date>
bin/qwen-managed-agent-upgrade install --backup /var/backups/qwen-managed-agent/<date>
# The manual steps check printed, such as installing Qwen Code for the Harness.
bin/qwen-managed-agent-upgrade start
bin/qwen-managed-agent-upgrade verify --tenant <tenant> --turn
# Reopen ingress.
```

Each phase reads the units, their environment files and the installed release again, and refuses unless the previous phase left them as it expects, so an interrupted upgrade resumes at the phase that failed. `--server-unit` and `--harness-unit` name units other than `qwen-managed-agent-server` and `qwen-hosted-harness`; the command finds the installed release, the environment files and the service account through them.

- `check` changes nothing. It verifies the new distribution against its `SHA256SUMS`, compares both releases (version, the Flyway scripts in the server jars, Java, Node.js and Qwen Code), and reads the Harness Broker settings, the unit templates, operator files in the installed `config/` and the release layout. Its `backup-tools` and `runtime-state` rows tell whether `backup` will run with the options given, so pass `check` the backup options too; the plan it prints repeats them. It prints one row per input and a plan with the manual steps where they fall, and exits 1 on any FAIL. The `database` row fails when the new release changed or removed a script the installed database ran: until the first formal release, a release may rewrite its schema baseline in place, and such a release cannot start on the existing database. It also fails when the release adds a versioned script that does not sort after the newest one the installed database ran, which Flyway refuses to apply.
- `stop` repeats the checks above `backup-tools` and stops nothing unless they pass. The `backup-tools` and `runtime-state` rows gate only `backup`, so settle them with `check` before `stop`. It stops the control plane, stops the Runtime workers that `KillMode=process` leaves in its cgroup and waits for them (`--timeout`, 60 seconds by default), then stops the Harness. It counts the workers in the cgroup systemd names, in the unified hierarchy or on cgroup v1 in systemd's own, and refuses when it cannot read that cgroup. Once the new release is installed, `stop` skips the checks, so it also stops a control plane that `start` left running. The JVM exits 143 on `SIGTERM`, so a control-plane unit installed without the template's `SuccessExitStatus=143` shows as `failed` after the stop; `stop` says so, and once the template's change is carried over, `systemctl reset-failed` clears the state.
- `backup --to <new empty directory>` needs both units stopped and no worker left. It writes `database.sql` with `mysqldump`, passing the unit's `SPRING_DATASOURCE_*` credentials through an option file in a temporary directory outside the backup rather than on the command line. It writes `runtime-state.tar` of the Runtime state directory, `configuration.tar` of the unit files, their environment files, the Harness credentials file and the `SPRING_CONFIG_ADDITIONAL_LOCATION` files, and `release-config.tar` of the installed `config/` and any of those files that live in the release, recorded by their path in the release. Every file is `0600` in a `0700` directory, and `backup.json`, written last, records their checksums, the database the dump is of, and where `install` leaves the previous release. `--mysqldump <path>` names another client, and `--skip-database` skips the dump when the database is backed up another way. A failed backup removes what it wrote.
  - `check` and `backup` take the Runtime state directory from the server's own configuration. They run the new release's server jar as the control-plane unit runs the server: with its account, working directory and environment, and the launcher's default `config/application.yml` when `SPRING_CONFIG_ADDITIONAL_LOCATION` is unset or empty. The jar prepares Spring's environment the way the server does, so every configuration file, import and profile counts, as do `SPRING_APPLICATION_JSON`, system properties from `JAVA_TOOL_OPTIONS` and relaxed names, and a relative directory is resolved in the unit's working directory. It starts nothing and opens no connection. When it cannot resolve the configuration, or the unit passes the launcher arguments, which `systemctl` does not print exactly, `backup` refuses until `--runtime-state <directory>` names the directory the server uses, or `--runtime-state none` says it keeps none. Without a configured directory, as on a deployment without the tool path, `backup` archives no Runtime state and says so.
- `install --backup <directory>` refuses a backup of another release, a backup file that changed, a backup the control plane has started since, and a backup of another database than the unit's `SPRING_DATASOURCE_URL` names. It copies the release to `<distribution>-releases/<version>`, such as `/opt/qwen-managed-agent-releases/<version>` (`--releases` names another directory; pass the same one to every phase), copies operator files from the installed `config/` with their owner and mode, and points the distribution path at the new release with one rename. The first run moves the installed directory to `<releases>/<old version>` and puts a link in its place, so the units keep their paths. The previous release stays where it is. An existing `<releases>/<version>` is used only when its `SHA256SUMS` is the new distribution's and its files match it, and a copy that fails is removed. A crash between the first run's two renames leaves `<distribution>.upgrade-<suffix>` beside the missing distribution path; every phase then names the `mv -T` that finishes the install. Run again once the release is installed, as after an interrupted session, `install` says so and points at `start`; do not take another backup then, because its `from.release` would name the new release.
- `start` refuses before `install`, and while the Harness Broker settings still need step 5 below. It starts the Harness, runs `bin/qwen-managed-agent-server --check` as the service account with the unit's environment, starts the control plane only when that passes, and waits for a healthy actuator (`--timeout`, 300 seconds by default; one probe waits at most 5 seconds). Flyway migrates the schema during this start. A control plane that fails is reported as failed. One that is still not healthy at the timeout keeps running; read its journal, then run `verify`, or `stop` and `start` again.
- `verify` runs `--check --online` the same way and reads the actuator, waiting up to `--timeout` (300 seconds by default) for its answer. With `--tenant <id>`, it reads the tenant's most recent Session and its Items, before `--turn` creates one; `--turn` creates a Session and waits for one Turn, which calls the model, polling past a `5xx` answer or a dropped connection. No request outlasts `--timeout`. A request without an actor lists only Sessions outside Workspaces; `--actor <id>` sends one through the header `QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER` names. `verify` reads the auth mode the way `backup` reads the Runtime state directory, and signed authentication skips both reads; read a Session through the ingress instead.

The command starts and stops units only. It never stops ingress, installs Qwen Code, edits environment or unit files, or deletes a release. When `check` warns that a unit template changed, carry the change over to the installed unit and run `systemctl daemon-reload` before `start`.

### Manual procedure

Other layouts follow these steps. On the systemd layout the command runs `stop`, `backup`, `install`, `start` and `verify`, and `check` prints the steps it leaves to the operator where they fall: stopping and reopening ingress, installing Qwen Code and editing `harness.env` in step 5, and carrying changed unit templates over.

1. Download and verify the new archive and read both manifests. Confirm the new Qwen Code/Harness, Java, protocol, and database requirements before touching the running deployment.
2. Stop new ingress. Wait for admitted work to settle according to the deployment's existing drain procedure.
3. Back up MySQL, the Runtime state directory, the complete Runtime credential key ring, the operator-owned `server.env` and `harness.env`, and the exact old distribution. Do not rotate the credential key during the distribution upgrade. With `server.env` loaded, `bin/qwen-managed-agent-admin resolved-configuration` prints the Runtime state directory the configuration resolves to.
4. Stop the Java service and Hosted Harness. Preserve the Workspace and durable Runtime state. The shipped control-plane unit uses `KillMode=process`, so `systemctl stop` leaves Runtime workers running; reap them with `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server` before starting the new version.
5. Install the manifest-compatible Qwen Code/Harness and start it with the existing token and capability digest. On a tool-path host, first replace any `QWEN_HOSTED_HARNESS_BROKER_ARGS` line in `harness.env` with `QWEN_MANAGED_RUNTIME_BROKER_URL` and `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`: nothing reads that line any more, so without them the Harness starts with no Broker. When `server.env` enables the Harness and names `harness.env` as its credentials file, as the bootstrap's files do, also delete `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` from `server.env`; the control plane then takes the token from `harness.env`, and keeping both copies refuses startup. The previous distribution reads neither new line and refuses to start its Broker without the deleted token, so a rollback to it restores both files from the step 3 backup. The new distribution's `--check` now lists any surviving worker in its `workers` row; run it here, offline, with the service still stopped and the Harness up, because online a durable Broker makes that row skip.
6. Start the new `bin/qwen-managed-agent-server` with the same database and durable settings. Flyway migrates the schema forward.
7. Require a healthy actuator response, read an existing Session and history, then complete one new no-tool Turn before reopening ingress. Requalify any optional tool capability before enabling it.

Database downgrade is unsupported. If startup or validation fails before traffic resumes, correct the configuration and retry the same artifact. To return to a version whose manifest has an older schema range, restore the pre-upgrade database and Runtime-state backup together before accepting any new write; never run an older server against a migrated database by assumption. Any return to the previous distribution also restores `server.env` and `harness.env` from the same backup, because step 5 rewrites them for the new version.

With the command's backup, return to the previous release with both units stopped. The names in angle brackets are fields of `<backup>/backup.json`. Run the `mysql` lines as the administrator that applied `config/mysql-setup.sql`: on the database host as shown, or for a remote database with `-h <datasource.host> -P <datasource.port>` and that account's credentials. Skip the line of an archive that its `files` list does not name, and both `mysql` lines when its `database` is `skipped`; then restore the database the way it was backed up.

```bash
mysql -u root -e 'DROP DATABASE <datasource.database>'
mysql -u root < <backup>/database.sql   # recreates the database
tar -C <runtimeState> --numeric-owner -xpf <backup>/runtime-state.tar
tar -C / --numeric-owner -xpf <backup>/configuration.tar
tar -C <from.release> --numeric-owner -xpf <backup>/release-config.tar
ln -sfn <from.release> <distribution>
systemctl daemon-reload
systemctl start <harness.unit> <server.unit>
```

Empty the Runtime state directory before extracting into it. `release-config.tar` goes into the previous release itself rather than through `<distribution>`, which still links to the new release until the `ln` line. When the new control plane refused to start because the database did not match its schema, it migrated nothing, and the link and the files alone go back.

## Rotate the Runtime credential key

Rotate the credential key separately from a distribution upgrade. Back up the database and current keys, then configure the new active pair and retain the old pair under `previous-credential-keys`:

```yaml
qwen:
  managed-agent:
    runtime-broker:
      credential-key-id: reference-v2
      credential-key: <base64-encoded-32-byte-v2-key>
      previous-credential-keys:
        '[reference-v1]': <base64-encoded-32-byte-v1-key>
```

Wrap every map key in `[ ... ]`. Spring's relaxed binder normalises plain keys — an ID such as `legacy/v1`, `legacy:v1` or `legacy v1` binds as `legacyv1` whether it is quoted in the YAML or not — so the ring then never matches the persisted key ID and rows written under that ID stay unreadable even though the key is configured. The bracket form preserves the exact ID.

Restart the single Java control plane, verify that existing bindings load, and verify that new binding rows record `reference-v2`. New secrets use only the active key; old rows remain encrypted under their recorded key ID. The server does not re-encrypt old rows on read, and removing a still-referenced key makes those rows unreadable.

Retire `reference-v1` only when no persisted row references it. `ma_runtime_binding.credential_key_id` and `ma_runtime_binding.runtime_credential_key_id` are the only persisted references; both store UTF-8 bytes. Select them without `CONVERT` so the deduplication stays byte-exact, the way key selection is: a converted value carries the character set's default collation and would merge two IDs that differ only in case or accent, hiding a key that rows still reference.

```sql
SELECT DISTINCT credential_key_id AS key_id
FROM ma_runtime_binding WHERE credential_key_id IS NOT NULL
UNION
SELECT DISTINCT runtime_credential_key_id AS key_id
FROM ma_runtime_binding WHERE runtime_credential_key_id IS NOT NULL;
```

The result lists the key IDs that persisted rows still require: expect the active ID (`reference-v2`) only. While `reference-v1` appears, that key must stay configured.

The key ring is a map and cannot be supplied through a `QWEN_MANAGED_AGENT_*` environment variable: relaxed binding silently resolves an env-var form to an empty or mis-keyed ring, with no startup error. Configure `previous-credential-keys` in `config/application.yml`. The distribution ships `config/application.example.yml`, and both launchers export `SPRING_CONFIG_ADDITIONAL_LOCATION=file:<distribution-root>/config/application.yml` when that file exists, so the location no longer depends on the process working directory and no option is added to the command's positional arguments. When the variable is already set, the launchers leave it in effect instead. A deployment that relies on environment variables alone starts with an empty ring, so rotating `credential-key-id` without configuration of the previous key makes rows written under it unreadable. An explicit `--spring.config.additional-location` command-line argument outranks this environment default; when both are present, the command-line value wins and the bundled `config/application.yml` is not loaded.

The operator-recovery entry reads the same active pair and `previous-credential-keys` map as the server. Its launcher loads `config/application.yml` the same way; when the file lives elsewhere, set `SPRING_CONFIG_ADDITIONAL_LOCATION=file:<absolute-path>/application.yml`. Keep the new key active while retaining every key still referenced by a binding. The CSI/migration maintenance mains, including the CSI Hosted probe, still read a single credential key pair; launch those entries with the key that encrypted their target binding as the active pair.

After successful key-ring configuration, the server and recovery entry log the resolved active ID and configured IDs once per protector instance. These IDs are non-secret identifiers already stored beside ciphertext; diagnostics JSON-escape controls and non-ASCII characters, preserve spaces and case, and never include key material, ciphertext or tokens. Compare the configured IDs with the exact IDs returned by the retirement query before using the rotated deployment. An unavailable-key error names the requested, active and configured IDs, so a silently normalised or mistyped mapping can be located without exposing secrets. This diagnostic does not prove that every stored row can be decrypted.

## Operator recovery

`bin/qwen-managed-agent-operator-recovery` starts the separately packaged recovery entry point. It is disabled unless the recovery-specific environment is set and does not start the HTTP service or worker. Follow `docs/hosted-workspace-recovery.md`; never infer physical stop or delete durable rows to clear a safety fence.

## Scope boundary

This distribution does not certify multiple Java control planes, cross-host takeover, public CSI, Kubernetes retirement, public Shell, v2 advertisement, or stable production support. Those capabilities require separate release evidence.
