# Managed Runtime provider plugins

[English](2026-10-31-managed-runtime-provider-plugins.md) | [简体中文](2026-10-31-managed-runtime-provider-plugins.zh-CN.md)

Status: initial Local/External design, implemented locally; final acceptance awaits CI. Investigation baseline: `5f5664e596`. This document records that first increment. The [backend module design](2026-10-31-managed-runtime-backend-modules.md) now extends and supersedes its module/assembly scope with all five backends and the revised dependency SPI.

## Problem and scope

The Maven boundaries introduced by #15871 separate orchestration from adapters, but the server still constructs Local and External providers directly. Provider selection, validation, preflight, and offline maintenance know their implementation classes. The single adapters artifact also brings unrelated Harness, OSS, and RocketMQ dependencies to a provider consumer.

This change makes Local and External implementations independently consumable plugins. The server discovers factories from installed JARs and creates only the configured provider. A compatible additional provider must be usable through a new JAR and configuration without another server selection branch. Existing SSH routing, resident CSI assembly, and the static provider remain supported through their existing paths. Their own plugin extraction is a follow-up.

This is startup discovery and selective initialization. It does not implement live JAR replacement, automatic downloads, a general plugin framework, or first-tool-only worker startup. Existing Session/Turn warmup, protocol, HTTP surfaces, credentials, database schema, durable provider kinds, and recovery algorithms remain authoritative.

## Module boundaries

Use flat reactor siblings to retain the existing build, cache, and publication conventions. All artifacts inherit the same parent version.

| Module             | Ownership                                                                                                    | Internal dependencies                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `contracts`        | Existing Runtime SPI, factory contract, plugin diagnostics, operator-recovery capability, read-only settings | None                                                                                                  |
| `runtime-http`     | Existing HTTP Runtime transport, including bounded response handling                                         | `contracts`                                                                                           |
| `runtime-host`     | Native host identity and private Runtime state-file validation shared by Local and Workspace recovery        | `contracts`                                                                                           |
| `runtime-local`    | Local process provider, durable local registry, Local factory and registration                               | `contracts`, `runtime-http`, `runtime-host`                                                           |
| `runtime-external` | External scratch/workspace providers, provider HTTP client, External factory and registration                | `contracts`, `runtime-http`                                                                           |
| `adapters`         | Remaining Harness, SSH, CSI, static, OSS, MQ, Git, and filesystem adapters                                   | `contracts`, `runtime-http`, `runtime-host`                                                           |
| `server`           | Discovery, configured selection, common security/Workspace wiring and maintenance entry points               | Existing implementation modules and shared adapters; Local/External are optional runtime dependencies |
| `verification`     | Existing and new tests, independent classpaths, packaging and aggregate coverage                             | All production modules directly; unpublished                                                          |

The two shared modules contain already-shared I/O, not a generic utility bucket. No I/O is moved into contracts. Move Local and External Java classes into distinct provider packages, and move package-private tests with them. Each production package has exactly one artifact owner. The server must compile without the Local/External implementation classes.

## Discovery, configuration and creation

Use the JDK service-provider mechanism with a small `RuntimeProviderFactory` contract and per-JAR registration. Factories expose the exact persisted kinds they support, validate settings, return preflight diagnostics, and create a provider. Discovery constructs only lightweight factories; it must not open clients, probe hosts, create directories, launch workers, or allocate executor pools.

The server registry rejects duplicate kinds and reports a missing configured provider explicitly. Selection uses the existing `runtime-broker.provisioner` key. Built-in factories retain existing configuration keys and defaults through the read-only settings view. A `runtime-broker.provider-options` string map provides plugin-owned additional configuration without introducing server fields for each new provider. Plugins validate and interpret their own entries; secrets must not be printed in diagnostics.

Only the selected factory validates and constructs an implementation. A disabled Runtime Broker requires neither plugin. An installed but unselected Local plugin must not require Node, a local state directory, or host probes; an unselected External plugin must not require provider credentials. Factory validation must also be reusable by preflight without creating a provider.

Local owns its launch command, durable state-directory checks, managed-extension client configuration, and shutdown behavior. External owns its endpoint/client configuration and existing scratch/workspace restrictions. The server supplies the existing External storage-registry port where needed, retaining the original JDBC authority. Compatible providers still speak the existing Runtime HTTP protocol; adding a different execution protocol is outside this increment.

## Lifecycle, maintenance and durable identity

The Broker remains the single owner of the selected provider and closes it through the existing ownership chain. Factory creation failures must release any partially created resources. SSH routing must continue closing each selected delegate once; plugin discovery must not add a second close owner.

Offline operator recovery and migration retirement must use the selected Local factory rather than import the Local class. A narrowly scoped operator-recovery capability carries the existing registration verification and stop-attestation operations. A separate maintenance creation path retains the non-launching worker command and the original state-directory and trusted-reboot settings; maintenance must never turn into normal provisioning.

Saved binding kinds, resource handles, identity bytes, storage registration, writer/generation checks, and recovery refusal remain unchanged. A missing or mismatched provider must not fall back to another provider. Discovery or configuration validity is not proof that a provider can recover a saved resource; the existing durable checks still decide that.

## Preflight and embedding

Provider-specific validation and diagnostics belong to the plugin. Remove the preflight whitelist that rejects a newly registered kind. Preserve common listener, credential, Workspace grant, and retention checks. A provider reports whether its Workspace paths refer to the local host so preflight does not require local directories for a remote provider.

Keep the existing External workspace-prerequisite warning and Local executable/state checks. The ordinary server dependency does not transitively install Local/External plugins; embedding hosts opt in to the chosen provider. The default executable distribution includes both through optional runtime dependencies. This boundary must be exercised with genuinely absent plugin classes and metadata, not only a mocked disabled flag.

## Build, consumers and implementation order

Update reactor modules, dependency management, per-module Checkstyle/SpotBugs, direct verification dependencies, and the bytecode dependency matrix together. Update fixed-version Maven cache purge/write-back lists and their workflow meta-tests. Preserve all current Java profiles, aggregate coverage, executable/operator classifiers, embedding fixtures, and service registration resources in nested JARs.

Implement in this order: define the contracts and registry; extract shared I/O and the two providers; migrate normal construction, preflight and maintenance; update packaging and consumers; verify and review. Keep the plugin implementation scope separate from unrelated large-class cleanup.

## Verification and acceptance

The E2E plan is `.qwen/e2e-tests/runtime-provider-plugins.md`. Baseline uses the global CLI where it exposes the managed worker; factory loading itself requires a Java integration fixture because the CLI cannot inject a Java provider into the server.

Required evidence:

- Independent production compilation and bytecode checks enforce the new module matrix and unique package ownership.
- A provider JAR can be omitted, selected alone, or replaced by an independent test provider using its own options. Missing and duplicate kinds fail explicitly. Discovery and preflight do not initialize unused providers.
- Existing Local/External provider, routing, configuration, preflight, and maintenance tests retain their behavioral assertions. Selected resources close exactly once, and incompatible saved identities remain refused.
- A real local worker path and an HTTP External-provider path retain their behavior, including startup and cleanup. Existing MySQL/Hosted/fault profiles remain required in CI; focused local evidence does not substitute for them.
- Executable/operator packaging contains the intended provider JARs and registration files; the independent embedding fixture exercises optional dependencies; aggregate coverage includes the new modules.
- Workflow/cache meta-tests, formatting, reference checks, two consecutive clean self-audits, and independent review complete the change.

Local Java setup, compilation, tests, and retries share the module's ten-minute budget. Record exact commands, source state, results, and unresolved gates. New commits or review rounds do not reset that budget. Final acceptance remains pending until the required CI gates run on the accepted revision.

## Decisions and remaining work

Use the existing trusted application classpath. Plugin discovery is not isolation for untrusted code. Keep same-version internal artifacts, existing configuration compatibility, and the existing worker warmup behavior. Dynamic JAR loading and first-tool-only worker startup remain separate follow-ups. SSH/CSI/Static extraction is implemented in the subsequent backend increment. There are no user decisions blocking this increment.

The complete backend extraction and selectable distributions are specified in the [backend module design](2026-10-31-managed-runtime-backend-modules.md). Its implementation is now in the same working tree. Earlier focused Local/External results do not certify the revised SPI or artifact variants; acceptance of that revision remains pending.
