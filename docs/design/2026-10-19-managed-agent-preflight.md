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

The command binds the same inputs Spring would load:

- the classpath `application.yml` that maps `QWEN_MANAGED_AGENT_*` variables;
- the command line (`--server.address=...`, `--qwen.managed-agent.*`), which
  keeps Spring's precedence;
- the external YAML named by `--spring.config.additional-location` (which an
  operator can pass) or by `SPRING_CONFIG_ADDITIONAL_LOCATION` (which the
  launcher sets when `config/application.yml` exists);
- the process environment, which keeps precedence over both files.

## Checks

| Check        | Passing condition                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java`       | Runtime feature version is 21 or later.                                                                                                                          |
| `config`     | The external YAML exists and is readable; a file containing secrets is not group- or world-readable.                                                             |
| `key-ring`   | At least an active key ID is configured; previous key IDs are reported.                                                                                          |
| `validation` | The startup property validations accept the bound configuration.                                                                                                 |
| `auth`       | A non-loopback bind does not use `auto`; signed mode has a signing key; insecure bind is reported.                                                               |
| `harness`    | Enabled Harness has a token, a well-formed digest, and answers `GET /capabilities` with 200.                                                                     |
| `tool-path`  | Workspace files and Shell enablement, the isolation class, and the mount, creation-root or SSH-node requirement match the startup rules.                         |
| `broker`     | Token, active and previous credential keys decode to 32 bytes, the state directory is writable, and the provisioner's Node/worker or static endpoint is present. |
| `workspace`  | The configured Workspace `cwd` exists and is writable.                                                                                                           |
| `*-port`     | The server port and the enabled broker port can be bound.                                                                                                        |
| `database`   | MySQL answers `SELECT 1`, the `performance_schema` grant works, and the Flyway version matches the release manifest when that manifest is present.               |

`WARN` and `SKIP` do not fail the command. Any `FAIL` makes the exit code 1.
The port checks bind the configured addresses, so run the command while the
service is stopped.

## Non-goals

- It does not verify the Harness capability digest. That value is only
  observable on an authenticated Hosted Session request, so the command
  reports reachability and leaves the digest to the first Turn.
- It does not verify Workspace mount registration or storage identity; those
  remain the "Verified physical Workspace recovery" procedure's responsibility.
- It does not compare the installed Qwen Code version with the manifest.
- It never repairs, migrates or writes. Read-only probes only.

## Implementation

`ManagedAgentServerApplication` intercepts `--check` before
`SpringApplication.run`, so no listener, scheduler, datasource pool or worker
starts. A `StandardEnvironment` receives the external and packaged YAML
property sources, `Binder` produces `ManagedAgentProperties`, the Harness probe
uses the JDK HTTP client, and the database probe uses JDBC with a five-second
connect and socket timeout.

## Acceptance

- The unit suite covers the digest and key validators, config-location
  precedence, auth verdicts, the Harness probe against a local HTTP server, and
  the broker and tool-path checks.
- `mvn verify` passes both Checkstyle executions and SpotBugs.
- The packaged jar run without a database prints the table, reports the
  connection failure, and exits 1. A deployment with every dependency present
  is expected to exit 0; that path is not covered by this change's local
  verification because no MySQL instance was available.
