# Managed Agent Preflight Command

[English](2026-10-19-managed-agent-preflight.md) | [简体中文](2026-10-19-managed-agent-preflight.zh-CN.md)

Status: implemented in this change.

## Problem

The reference distribution states its prerequisites in prose, but the server
only evaluates them when it starts or when the first Turn runs. A missing
`performance_schema` grant, an empty credential key ring, `auth mode=auto` on a
non-loopback bind, an unreachable Harness, an undersized credential key, an
unwritable Runtime state directory or an occupied port each surface as a
separate failure, and some of them appear only after a Session has been
created. Operators discover the deployment's state one failure at a time.

## Scope

`bin/qwen-managed-agent-server --check` (equivalently
`java -jar qwen-managed-agent-server-<version>.jar --check`) runs the
preflight and exits. It uses the existing server artifact, so the reference
distribution needs no additional component.

The command reads the configuration the server reads, prepared as
`SpringApplication` prepares it before it creates a context, so every input
keeps Spring's precedence:

- the command line (`--server.address=...`, `--qwen.managed-agent.*`);
- the process environment, `SPRING_APPLICATION_JSON` included;
- the configuration files Spring Boot reads: those named by
  `spring.config.location`, `spring.config.additional-location` or
  `spring.config.import`, as an argument or a `SPRING_CONFIG_*` variable (the
  launcher sets `SPRING_CONFIG_ADDITIONAL_LOCATION` when
  `config/application.yml` exists, and the systemd unit's `server.env` names
  `/etc/qwen-managed-agent/application.yml`); those at its default locations
  `./`, `./config/` and `./config/*/`, unless `spring.config.location`
  replaces them; as `.yml`, `.yaml` or `.properties`, under
  `spring.config.name`; their profile variants, the files they import and
  config trees;
- the classpath `application.yml` that maps `QWEN_MANAGED_AGENT_*` variables.

Relative locations, the default ones among them, are read in the working
directory, as the server reads them, so the command runs in the server's
working directory: the distribution root, or the unit's `WorkingDirectory`.
Before [#16057](https://github.com/QwenLM/qwen-code/issues/16057) it read only
the file the launcher or `server.env` named, and missed a `server.port` the
server read from `config/application.yml` in its working directory.

## Checks

| Check        | Passing condition                                                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java`       | Runtime feature version is 21 or later.                                                                                                                                                                                                                                                              |
| `config`     | One row per file the server reads: readable by the service account, not group- or world-readable when it holds a secret; WARN for none. FAIL where Spring would not start: a named file that does not exist, a file this process cannot read, or a YAML error, with its file and line.               |
| `key-ring`   | At least an active key ID is configured; previous key IDs are reported.                                                                                                                                                                                                                              |
| `validation` | The startup property validations accept the bound configuration.                                                                                                                                                                                                                                     |
| `auth`       | A non-loopback bind does not use `auto`; signed mode has a signing key; insecure bind is reported.                                                                                                                                                                                                   |
| `harness`    | Enabled Harness has a token and a well-formed digest, answers `GET /capabilities` with 200, and negotiates as the first Session does, including the capability digest and each Workspace profile's lifecycle; another Qwen Code version than the manifest's warns. A Harness pool is not negotiated. |
| `tool-path`  | Workspace files and Shell enablement, the isolation class, and the mount, creation-root or SSH-node requirement match the startup rules.                                                                                                                                                             |
| `broker`     | Token, active and previous credential keys decode to 32 bytes, the state directory is writable, and the provisioner's Node/worker or static endpoint is present.                                                                                                                                     |
| `workspace`  | The configured Workspace `cwd` exists and is writable.                                                                                                                                                                                                                                               |
| `*-port`     | The server port and the enabled broker port can be bound, or, with `--online`, accept a connection.                                                                                                                                                                                                  |
| `workers`    | No Runtime worker of an earlier run is alive in the local-process state directory.                                                                                                                                                                                                                   |
| `database`   | MySQL answers `SELECT 1`, the `performance_schema` grant works, and the Flyway version matches the release manifest when that manifest is present.                                                                                                                                                   |

`WARN` and `SKIP` do not fail the command. Any `FAIL` makes the exit code 1.
The port checks bind the configured addresses, so run the command while the
service is stopped, or pass `--online` against a running service.
[2026-10-23-managed-agent-preflight-harness-workers-online.md](2026-10-23-managed-agent-preflight-harness-workers-online.md)
describes the Harness negotiation, the `workers` row and `--online`.

## Non-goals

- It does not negotiate with each endpoint of a Harness pool. With
  `harness.pool.enabled`, the `harness` row skips a pool's endpoints once the
  Session Store is enabled with a binding key, and fails until then, mirroring
  the startup guard.
- It does not verify Workspace mount registration or storage identity; those
  remain the "Verified physical Workspace recovery" procedure's responsibility.
- It never repairs, migrates or writes. Read-only probes only.

## Implementation

`ManagedAgentServerApplication` intercepts `--check` before
`SpringApplication.run`, so no listener, scheduler, datasource pool or worker
starts. `ServerEnvironment` prepares a servlet environment as
`SpringApplication` does: the arguments, the process environment, then every
environment post-processor on the class path through
`EnvironmentPostProcessorApplicationListener`, and relaxed binding. It starts
no context, and `ResolvedConfiguration`, which the upgrade command reads its
settings through, prepares the same environment. The `config` rows name the
files the prepared property sources came from, then the files Spring read at a
location without finding a setting. When the preparation throws, the row
names what Spring refused: the file, read as missing or unreadable, or the
YAML error's file and line, found among the files Spring looks for, since
Spring's error names neither; a file this process cannot read names the
service account when that cannot read it either, and otherwise says to run the
check as that account. The other rows then read the arguments, the process
environment and the packaged defaults. `Binder` produces
`ManagedAgentProperties`, the Harness probe uses the JDK HTTP client, and the
database probe uses JDBC with a five-second connect and socket timeout.

## Acceptance

- The unit suite covers the digest and key validators, config-location
  precedence, auth verdicts, the Harness probe against a local HTTP server, and
  the broker and tool-path checks.
- `mvn verify` passes both Checkstyle executions and SpotBugs.
- The packaged jar run without a database prints the table, reports the
  connection failure, and exits 1. A deployment with every dependency present
  is expected to exit 0; that path is not covered by this change's local
  verification because no MySQL instance was available.
