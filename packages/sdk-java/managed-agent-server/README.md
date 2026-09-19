# Qwen Managed Agent Server

Standalone Spring Boot control plane for the Qwen Code Hosted Harness. It has
no DataWorks dependency and no end-user authentication layer. A trusted
upstream must send `X-Qwen-Tenant-Id`; the server uses that value on every
database read and write.

设计说明：[English](../../../docs/design/2026-09-19-managed-agent-spring-server.md) |
[简体中文](../../../docs/design/2026-09-19-managed-agent-spring-server.zh-CN.md)

## Prerequisites

- Java 21
- MySQL 8
- a running `qwen serve --profile hosted-harness`

Install the two sibling libraries once when building this module outside a
Maven reactor:

```bash
mvn -f ../qwencode/pom.xml -DskipTests -Dgpg.skip=true install
mvn -f ../runtime-broker/pom.xml -DskipTests install
```

Configure and start the server:

```bash
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='replace-me'
export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'
export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4170'
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='replace-me'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:replace-with-64-hex-characters'

mvn spring-boot:run
```

Create a Session:

```bash
curl -sS http://127.0.0.1:8080/v1/agents/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: create-1' \
  -d '{"agent_id":"qwen-code","input":[{"type":"text","text":"hello"}]}'
```

The public listener intentionally ignores end-user `Authorization`. The
optional Runtime Broker listener still requires a separate machine bearer and
must remain private.

## Embedded Runtime Broker

The Broker starts before the first Hosted Harness connection, so the supported
startup order is Spring/Broker first, Hosted Harness second, traffic last. The
Harness SDK handshake is lazy and occurs on the first admitted Turn.

For the single-node local-process provisioner, also set:

```bash
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED='true'
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN='replace-me'
export QWEN_MANAGED_AGENT_WORKSPACE_CWD='/absolute/authorized/workspace'
export QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY='/absolute/private/state'
export QWEN_MANAGED_AGENT_NODE_EXECUTABLE='/absolute/path/to/node'
export QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY='/absolute/path/to/dist/managed-runtime-worker.js'
export QWEN_MANAGED_AGENT_CLI_ENTRY='/absolute/path/to/dist/cli.js'
```

When `QWEN_MANAGED_AGENT_WORKSPACE_ID` is omitted, the server derives the same
16-character SHA-256 workspace ID that Qwen Code uses from the canonical
workspace path. An explicitly configured ID must match that value or startup
fails before traffic is accepted.

Point `qwen serve --profile hosted-harness` at
`http://127.0.0.1:4190` with the same Broker bearer. This first embedded path
uses the Runtime Broker's in-memory repositories and is therefore a
single-control-plane-node development topology. MySQL-backed Broker
repositories and a tenant-authorized environment registry remain production
gates; the public Session, Turn, command, and Event state is already durable in
MySQL.

Build the container from the repository root:

```bash
docker build -f packages/sdk-java/managed-agent-server/Dockerfile .
```

The stock image contains the Java control plane only. Use the static Runtime
provisioner, or provide a derived image/mount with Node.js and the Qwen worker
artifacts, before enabling the local-process provisioner in a container.

## Real-model end-to-end check

The repository includes a local full-chain check that starts an isolated
MySQL instance, this Spring application, the Hosted Harness, and a local Tool
Runtime. It uses the selected model from an existing Qwen settings file, then
verifies that the same Turn completes a real `write_file` call, idempotent
Session replay, tenant isolation, and durable Event storage.

Build the required artifacts first, then run:

```bash
npm run build && npm run bundle
mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
mvn -f packages/sdk-java/runtime-broker/pom.xml -DskipTests install
mvn -f packages/sdk-java/managed-agent-server/pom.xml clean package
npm run test:e2e:managed-agent-server -- --model moonshot/kimi-k3
```

The default zero-delay run is the stable real-model integration gate. To also
observe resident model output while the Tool Runtime is unavailable, add a
controlled cold-start delay:

```bash
npm run test:e2e:managed-agent-server -- \
  --model moonshot/kimi-k3 \
  --runtime-delay-ms 45000
```

That run additionally requires the first model event to precede Runtime
readiness. Real provider TTFT varies, so the deterministic CI proof of the same
ordering remains `npx tsx scripts/run-managed-hosted-runtime-e2e.ts`, which
uses a controlled model server and a 15-second Runtime delay.

The real-model check extracts only the selected model provider, its referenced
environment credential, the selected model, and the authentication policy
from the supplied settings file into a private temporary Qwen home. It does
not copy hooks, MCP servers, extensions, tools, permissions, or other provider
credentials. The runner removes that file, the MySQL data directory,
workspaces, and child processes on exit. Override the source with
`--settings /path/to/settings.json`; credentials are never printed by the
runner.
