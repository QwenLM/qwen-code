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
- Stable database credentials, Runtime credential key, and Harness token stored outside the archive.

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

Keep the Harness on loopback. Record the port it reports; `--port` may advance when the requested port is already occupied.

## Start the Java control plane

In another terminal, configure the same Harness and the database:

```bash
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='<private-password>'
export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'
export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4170'
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:<64-hex-digest>'

bin/qwen-managed-agent-server
```

The launcher uses the server JAR in this archive. Spring Flyway applies forward database migrations before the service becomes ready. Wait for:

```bash
curl --fail http://127.0.0.1:8080/actuator/health
```

This base configuration supports text-only Hosted Sessions. Keep the listener on loopback unless a signed or authenticated ingress is configured. The complete authentication, API, and capability configuration is bundled as `docs/server-reference.md`.

## Enable the accepted local-process tool path

Tool execution requires the existing fail-closed Runtime and Workspace setup. At minimum, configure:

```bash
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED='true'
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID='reference-v1'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY='<base64-encoded-32-byte-key>'
export QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY='/var/lib/qwen-managed-agent/runtime'
export QWEN_MANAGED_AGENT_NODE_EXECUTABLE='/usr/bin/node'
export QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY='/opt/qwen-code/dist/cli.js'
export QWEN_MANAGED_AGENT_WORKSPACE_ID='reference-workspace'
export QWEN_MANAGED_AGENT_WORKSPACE_CWD='/srv/qwen-workspace'
export QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED='true'
```

Before admitting file, Shell, or child Git work, complete the native storage registration and mount-identity verification described under “Verified physical Workspace recovery” in `docs/server-reference.md`. An unregistered or ambiguous mount must remain unavailable. Public Shell and v2 capability advertisement stay disabled until their separate qualification completes.

## Upgrade

1. Download and verify the new archive and read both manifests. Confirm the new Qwen Code/Harness, Java, protocol, and database requirements before touching the running deployment.
2. Stop new ingress. Wait for admitted work to settle according to the deployment's existing drain procedure.
3. Back up MySQL, `QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`, the Runtime credential key, and the exact old distribution. Do not rotate the credential key during the upgrade.
4. Stop the Java service and Hosted Harness. Preserve the Workspace and durable Runtime state.
5. Install the manifest-compatible Qwen Code/Harness and start it with the existing token and capability digest.
6. Start the new `bin/qwen-managed-agent-server` with the same database and durable settings. Flyway migrates the schema forward.
7. Require a healthy actuator response, read an existing Session and history, then complete one new no-tool Turn before reopening ingress. Requalify any optional tool capability before enabling it.

Database downgrade is unsupported. If startup or validation fails before traffic resumes, correct the configuration and retry the same artifact. To return to a version whose manifest has an older schema range, restore the pre-upgrade database and Runtime-state backup together before accepting any new write; never run an older server against a migrated database by assumption.

## Operator recovery

`bin/qwen-managed-agent-operator-recovery` starts the separately packaged recovery entry point. It is disabled unless the recovery-specific environment is set and does not start the HTTP service or worker. Follow `docs/hosted-workspace-recovery.md`; never infer physical stop or delete durable rows to clear a safety fence.

## Scope boundary

This distribution does not certify multiple Java control planes, cross-host takeover, public CSI, Kubernetes retirement, public Shell, v2 advertisement, or stable production support. Those capabilities require separate release evidence.
