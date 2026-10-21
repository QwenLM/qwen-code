# Managed Agent Harness Credentials File

[English](2026-10-21-managed-agent-harness-credentials-file.md) | [简体中文](2026-10-21-managed-agent-harness-credentials-file.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

The Hosted Harness and the Java control plane must share one bearer token and one capability digest. The Harness reads them as `QWEN_SERVER_TOKEN` and `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST`; the control plane reads them as `QWEN_MANAGED_AGENT_HARNESS_TOKEN` and `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST`. The reference distribution therefore stores each value twice, in `harness.env` and in `server.env`, and every rotation or hand edit must change both files identically. A mismatch surfaces only as a `401` from the Harness or a digest refusal at the first Session.

Making the control plane read the Harness's variable names from its own environment, for example by loading `harness.env` into the control-plane unit, would remove the duplication but put `QWEN_SERVER_TOKEN` into the Java process environment. Every process that environment reaches would then receive a variable that `qwen serve` treats as its own bearer token.

## Goals

- One file holds the Harness token and capability digest for both processes.
- The values reach the control plane's configuration without entering its process environment.
- An inconsistent or incomplete configuration fails before traffic, naming the file and the missing key.
- The shipped templates, bootstrap and systemd instructions use the single file.

## Non-goals

- Changing how the Harness reads its credentials, or adding a file option to the CLI.
- Changing the Runtime Broker token, which still has no environment source in the CLI.
- Removing the existing direct settings, which remain valid on their own.

## Design

### Setting

`qwen.managed-agent.harness.credentials-file` (`QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`) names the Harness environment file. When it is set, startup validation reads the file and assigns:

- `QWEN_SERVER_TOKEN` to `harness.token`;
- `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` to `harness.capability-digest`.

Other keys, such as `QWEN_HOSTED_HARNESS_BROKER_ARGS`, are ignored. The values are held only in the bound configuration and are never logged.

The file uses the subset of the systemd `EnvironmentFile` syntax that the shipped files use. Each line is trimmed and split at its first `=`; lines without one are ignored, and a comment line never names one of the two keys. Both sides are trimmed, and a value enclosed in a matching pair of single or double quotes loses them. There is no variable expansion, and a later assignment replaces an earlier one, as in systemd.

### Failure semantics

- The file is set together with a non-blank `harness.token` or `harness.capability-digest`: startup fails and asks for one source.
- The file cannot be read: startup fails, naming the path.
- A required key is missing or blank: startup fails, naming the key and the path.

The resolution runs in the same startup validation that preflight calls, so `--check` reports these failures in its `validation` row before any listener starts. The existing `harness` row then checks the resolved token and digest as before. A new `credentials` row reports `SKIP` without a file, `WARN` with a `chmod 600` fix when the file is group- or world-readable, and `PASS` otherwise.

### Templates, bootstrap and systemd

- `server.env.example` and the bootstrap's `server.env` set `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` to the `harness.env` beside them and no longer carry the token or digest.
- `harness.env.example` says that the control plane reads the file.
- The systemd README installs `harness.env` owned by the service account with mode `0600`. The control plane reads it as that account, and systemd reads environment files as root regardless of their mode.
- The reference deployment guide (English and Chinese) and the server README describe the setting.

## Compatibility and risks

- Deployments that set the token and digest directly are unchanged.
- A deployment that adds the file while keeping the direct values fails at startup until one source is removed. This is intentional: two sources that can drift are the problem being solved.
- The file must be readable by the service account. A Shell-enabled Runtime worker runs as the same account and can read it, as it already can read `config/application.yml`; file isolation still depends on the operating system.

## Validation plan

- Unit tests on `ManagedAgentProperties`: both keys resolve from a file in the shipped format with comments, quotes, an ignored extra key and a repeated key; a missing file, a missing key and a blank key each fail with the path and key; a direct token or digest together with the file fails; no file leaves the direct values untouched; `application.yml` binds `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`.
- Preflight tests: the `credentials` row reports `SKIP`, `PASS` for mode `0600` and `WARN` for a group-readable file.
- Template tests: the bootstrap's `server.env` and `server.env.example` reference `harness.env` and carry neither credential.
- End-to-end: generate the files with the bootstrap, start the real Harness from `harness.env`, start the packaged server from `server.env`, run `--check`, and complete one Turn. Repeat with a conflicting direct token and with a missing key to observe the refusals.

## Acceptance criteria

- With the bootstrap's files, the token and digest appear in exactly one file, and the control plane and Harness connect and complete a Turn.
- Each failure above stops startup with a message naming the file or key.
- Direct configuration behaves as before.

## Follow-up work

- Give the CLI's Runtime Broker URL and token an environment or file source, and make the Hosted Harness profile fail on an occupied port instead of moving.
