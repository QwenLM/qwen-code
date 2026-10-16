# Managed Agent Reference Distribution

[English](2026-10-14-managed-agent-reference-distribution.md) | [简体中文](2026-10-14-managed-agent-reference-distribution.zh-CN.md)

Status: proposed for implementation in #14157.

## Problem

The repository builds `qwen-managed-agent-server`, including its Runtime Broker sources, but the protected Java SDK release publishes only `qwencode-sdk`. Hosted acceptance therefore needs an application distribution. An operator must be able to download a reviewed server artifact, verify its source revision, determine its compatible Harness and schema, and follow a defined upgrade path.

## Goals

- Publish an experimental reference distribution independently of the npm CLI release.
- Tie every distribution to one exact source revision and explicit compatibility metadata.
- Make the same artifact buildable in pull-request CI and a non-publishing manual dry run.
- Provide a complete first-release deployment and upgrade procedure for one Java control plane on one trusted Linux host.
- Include the embedded Broker in the versioned server component.

## Non-goals

- Enabling public Shell, v2 capability advertisement, Automation, Channels, or retention defaults.
- Publishing a container image or choosing a long-term container registry.
- Supporting multiple surviving Java control planes, cross-host takeover, public CSI, or a stable support tier.
- Bundling the npm CLI or Hosted Harness into the Java archive.

## Distribution format

The release asset is `qwen-managed-agent-reference-<version>.tar.gz`. It contains one top-level directory with:

```text
bin/qwen-managed-agent-server
bin/qwen-managed-agent-operator-recovery
lib/qwen-managed-agent-server-<component-version>.jar
lib/qwen-managed-agent-server-<component-version>-operator-recovery.jar
docs/deployment.md
docs/deployment.zh-CN.md
docs/server-reference.md
docs/hosted-workspace-recovery.md
docs/hosted-workspace-recovery.zh-CN.md
manifest.json
SHA256SUMS
LICENSE
```

The launchers use bundle-relative JAR paths and pass arguments unchanged to Java. The server JAR includes Broker classes and resources; no separate Broker artifact or process is introduced.

The release also publishes a detached copy of `manifest.json` and `SHA256SUMS.txt`. The detached checksum file covers the archive and detached manifest. The in-bundle checksum file covers every payload file and `manifest.json`.

## Manifest contract

`manifest.json` has schema version `1` and records:

- distribution name, version, experimental status, repository, and exact Git revision;
- each component's Maven version, bundle path, byte size, and SHA-256 digest;
- the exact Qwen Code version and Hosted Harness profile from the same source tree;
- the Serve protocol, Runtime Broker protocol, public API, Java, Node.js, and Flyway migration compatibility read from the same source tree;
- the accepted one-control-plane, trusted-Linux, embedded-Broker topology;
- explicit `false` values for public Shell and v2 advertisement defaults;
- the bundled deployment and recovery documentation paths.

Packaging fails when a required artifact or compatibility source is absent or ambiguous. It does not guess a value or publish a partially described artifact.

## Release workflow

Pull requests that change the distribution inputs run the packaging unit test, build the Java SDK and combined server module, assemble the real bundle, verify its checksums, and upload it as a short-lived Actions artifact.

A manual dispatch accepts an experimental SemVer such as `0.1.0-alpha.1` and a `dry_run` flag. Dry runs perform the same build and verification without GitHub mutations. A non-dry run is accepted only from `main`: it creates a hidden draft, uploads and verifies the exact asset set, atomically creates the tag at the manifest revision, and only then publishes the prerelease. An existing tag or release, a concurrent tag race, or an incomplete upload fails closed. Assets are never replaced in place, and an incomplete draft is not public.

The distribution version is independent of the Maven component versions. The manifest records both so an experimental distribution can be revised without pretending that the embedded components changed identity.

## Deployment and upgrade

The operator verifies `SHA256SUMS.txt`, extracts the archive, reads `manifest.json`, installs the exact compatible Qwen CLI/Harness, configures MySQL and the existing server environment, starts `qwen serve --profile hosted-harness`, then starts the bundled server launcher. `/actuator/health` is the startup gate.

Upgrade uses one stopped admission window on the accepted single-control-plane topology: retain the database, Runtime credential key, and durable Runtime state; back them up; stop ingress, server, and Harness; verify the new artifact and compatibility manifest; start the matching Harness; then start the new server and allow Flyway to migrate forward. Traffic resumes only after health and a new no-tool Turn succeed. Database downgrade is not supported; rollback after a migration requires restoring the pre-upgrade database and state backup before accepting new writes.

## Failure semantics

- A mismatched, missing, or duplicate component fails packaging.
- A malformed version or source revision fails before Maven or publication work.
- A checksum or manifest mismatch fails the build and publication is skipped.
- A production dispatch from a non-`main` ref fails.
- An existing tag or release, a tag-creation race, or an incomplete upload fails closed; the workflow never overwrites it or publishes a partial draft.
- Missing compatibility evidence remains a release blocker rather than an `unknown` field.

## Validation plan

1. Run the packaging unit test with synthetic component artifacts and inspect the extracted archive.
2. Build the actual SDK and server JARs, create the bundle, and verify both checksum layers.
3. Extract the exact archive, start it against MySQL with a matching Hosted Harness, and check health plus one no-tool Session/Turn.
4. Restart the same deployment from the extracted bundle and confirm the existing Session remains readable and a subsequent Turn succeeds.
5. Review the full branch diff, run the ponytail simplification pass, and validate the workflow syntax and affected Java build gates.

## Acceptance criteria

- CI and a manual dry run produce the same named release assets without publishing.
- The manifest identifies the exact source and every declared compatibility boundary.
- A consumer can verify and extract the artifact without a repository checkout.
- The bundled server and operator-recovery launchers use only bundle-relative files.
- The exact extracted server can start and complete the reference smoke path.
- The production workflow publishes only an immutable experimental prerelease from `main`.
- Public Shell and v2 advertisement remain disabled by default.

## Follow-up work

The exact landed bundle will be used for the final public Shell qualification. Container publication, formal support, broader topologies, and stable release promotion require their own decisions and acceptance evidence.
