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

The `harness` row negotiates with a single configured Harness as the first Session does; with a Harness pool it skips the pool's endpoints once the Session Store is enabled with a binding key, and fails until then. It fails when the capability digest differs, the protocol or a required feature is missing, or the Harness lacks the lifecycle a configured Workspace profile needs. It warns when the Harness runs another Qwen Code version than `manifest.json` names, or does not say which. The port checks bind the configured addresses, and the `workers` row warns about workers still running in the Runtime state directory, so stop the service first. While it runs, add `--online`: the port rows then check that something listens, and the `workers` row reports only workers a stopped server left behind, or is skipped for a durable Broker, which adopts them. The command does not verify the native Workspace storage registration.

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

1. Download and verify the new archive and read both manifests. Confirm the new Qwen Code/Harness, Java, protocol, and database requirements before touching the running deployment.
2. Stop new ingress. Wait for admitted work to settle according to the deployment's existing drain procedure.
3. Back up MySQL, `QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`, the complete Runtime credential key ring, the operator-owned `server.env` and `harness.env`, and the exact old distribution. Do not rotate the credential key during the distribution upgrade.
4. Stop the Java service and Hosted Harness. Preserve the Workspace and durable Runtime state. The shipped control-plane unit uses `KillMode=process`, so `systemctl stop` leaves Runtime workers running; reap them with `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server` before starting the new version.
5. Install the manifest-compatible Qwen Code/Harness and start it with the existing token and capability digest. On a tool-path host, first replace any `QWEN_HOSTED_HARNESS_BROKER_ARGS` line in `harness.env` with `QWEN_MANAGED_RUNTIME_BROKER_URL` and `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`: nothing reads that line any more, so without them the Harness starts with no Broker. When `server.env` enables the Harness and names `harness.env` as its credentials file, as the bootstrap's files do, also delete `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` from `server.env`; the control plane then takes the token from `harness.env`, and keeping both copies refuses startup. The previous distribution reads neither new line and refuses to start its Broker without the deleted token, so a rollback to it restores both files from the step 3 backup. The new distribution's `--check` now lists any surviving worker in its `workers` row; run it here, offline, with the service still stopped and the Harness up, because online a durable Broker makes that row skip.
6. Start the new `bin/qwen-managed-agent-server` with the same database and durable settings. Flyway migrates the schema forward.
7. Require a healthy actuator response, read an existing Session and history, then complete one new no-tool Turn before reopening ingress. Requalify any optional tool capability before enabling it.

Database downgrade is unsupported. If startup or validation fails before traffic resumes, correct the configuration and retry the same artifact. To return to a version whose manifest has an older schema range, restore the pre-upgrade database and Runtime-state backup together before accepting any new write; never run an older server against a migrated database by assumption. Any return to the previous distribution also restores `server.env` and `harness.env` from the same backup, because step 5 rewrites them for the new version.

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
