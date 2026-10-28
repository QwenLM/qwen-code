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
- Sharing the Runtime Broker token. The [Hosted Harness Broker environment design](2026-10-21-hosted-harness-broker-environment.md) builds that on this file.
- Removing the existing direct settings, which remain valid on their own.

## Design

### Setting

`qwen.managed-agent.harness.credentials-file` (`QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`) names the Harness environment file. When it is set and the Harness is enabled, startup validation reads the file once and assigns:

- `QWEN_SERVER_TOKEN` to `harness.token`;
- `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` to `harness.capability-digest`.

An optional `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` supplies `runtime-broker.token`, and preflight compares an optional `QWEN_MANAGED_RUNTIME_BROKER_URL` with the Broker's address, as described in the [Hosted Harness Broker environment design](2026-10-21-hosted-harness-broker-environment.md). Other keys, such as an old `QWEN_HOSTED_HARNESS_BROKER_ARGS`, are ignored. The values are held only in the bound configuration and are never logged.

Both systemd and a shell `source` read this file for the Harness, so the control plane accepts only the lines both readers take literally and refuses the rest instead of reading a different value. A line containing a carriage return is refused, comments included, because a shell keeps it in the value; a file saved with CRLF endings therefore fails at its first line. Each line is then trimmed. A line ending in `\` is refused, comments included, because both readers continue it on the next line. A line starting with `;` is refused wherever it falls: systemd skips it as a comment, but a shell refuses it and stops reading the file at that line. Lines starting with `#`, and lines without `=`, are otherwise skipped. A line is split at its first `=`. A key that still contains whitespace is refused for every key: systemd ignores `export KEY=value`, which a shell assigns, and a shell runs `NAME KEY=value` as a command. For the keys the Harness reads, the token and digest and the optional Broker URL and token, whitespace on either side of the `=` is refused, because a shell runs such a line as a command instead of an assignment; other keys are trimmed. A value may be enclosed in one matching pair of single or double quotes. An opening quote without its closing quote, text after the closing quote, and a backslash inside double quotes are refused. A value for one of these keys may contain only letters, digits and `._:/+=-`, which both readers take literally; the Broker URL may also use `[` and `]` to bracket an IPv6 literal. This rules out escapes, expansions, command substitution and the shell's other operators, such as `;`, `&` and `~`. A later assignment replaces an earlier one, as in systemd. A refusal names the file, the line number and the construct, never the line's content. The control plane does not read the other keys' lines as a shell would, so a shell may still lose one. A shell runs `KEY = value` as a command and drops that key. It stops at a line it cannot parse, such as an unquoted `(` in a value: bash keeps the assignments above that line and loses every line below it, while dash exits before starting the Harness. The `harness` row's probe sends the token, then negotiates with the configured `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST`, so `--check` also fails on a lost or altered digest; another lost key shows up only in the Harness's own behaviour. Write the other keys as `KEY=value` too, and quote values a shell would parse.

### Failure semantics

- The file is set together with a non-blank `harness.token` or `harness.capability-digest`: startup fails and asks for one source.
- The file sets `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` while `runtime-broker.token` is also set: startup fails and asks for one source.
- The file sets only one of `QWEN_MANAGED_RUNTIME_BROKER_URL` and `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`: startup fails, because the Harness takes them together or not at all.
- The file sets either Broker key to an empty value: startup fails, naming the key, because the Harness takes an empty value as set and then refuses to start without the other half.
- The file cannot be read: startup fails, naming the path and the exception type.
- A line uses a refused construct: startup fails, naming the path and the line.
- A required key is missing or blank: startup fails, naming the key and the path.
- In each of these cases nothing from the file is bound.
- The Harness is disabled: the file is not read.

The resolution runs in the same startup validation that preflight calls, so `--check` reports these failures in its `validation` row before any listener starts. The existing `harness` row then checks the resolved token and digest as before. When startup refused the file, so its credentials were never bound, the `harness` row reports `SKIP` and points at the `validation` row instead of probing with whatever is left bound. It also fails a token that still carries the shipped templates' `replace-` placeholder, which the Harness would accept. A new `credentials` row reports `SKIP` while the Harness is disabled or no file is set. It reports `FAIL` with a `chown` fix when the service account cannot read the file, and `WARN` with a `chmod 600` fix when the file is group- or world-readable, the same policy and wording the `config` row applies to `application.yml`. Otherwise it reports `PASS`.

### Templates, bootstrap and systemd

- `server.env.example` and the bootstrap's `server.env` set `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` to the `harness.env` beside them and no longer carry the token or digest.
- `harness.env.example` says that the control plane reads the file.
- The systemd README installs `harness.env` owned by the service account with mode `0600`. The control plane reads it as that account, and systemd reads environment files as root regardless of their mode.
- The reference deployment guide (English and Chinese) and the server README describe the setting.

## Compatibility and risks

- Deployments that set the token and digest directly start as before. One preflight change applies to them too: the `harness` row now fails a token that still carries the shipped `replace-` placeholder, which earlier passed `--check`.
- A deployment that adds the file while keeping the direct values fails at startup until one source is removed. This is intentional: two sources that can drift are the problem being solved.
- The file must be readable by the service account. A Shell-enabled Runtime worker runs as the same account and can read it, as it already can read `config/application.yml`; file isolation still depends on the operating system.

## Validation plan

- Unit tests on `ManagedAgentProperties`: both keys resolve from a file in the shipped format with comments, quotes, an ignored extra key, a repeated key and a value containing `=`; each refused construct, including a carriage return, whitespace around `=` for either key and a character outside the allowed set, fails with the line and without the value; every allowed character is accepted; a refused file binds neither credential; a missing file, a missing key and a blank key each fail with the path and key; a direct token or digest together with the file fails; a disabled Harness ignores the file; a second validation pass is a no-op; no file leaves the direct values untouched; `application.yml` binds `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`.
- Preflight tests: the `credentials` row reports `SKIP`, `PASS` for mode `0600`, `WARN` for group- and world-readable files and an unusable path, and `FAIL` for an unreadable file. The `harness` row sends the token the validation read from the file, skips the probe when startup refused the file, and fails the template placeholder. `run()` lists the `credentials` row after the `harness` row. File-aware fixes cover the 401 branch.
- Template tests: the bootstrap's `server.env` and `server.env.example` reference `harness.env` and carry neither credential, and `harness.env.example` starts both keys at the beginning of a line.
- End-to-end: generate the files with the bootstrap, start the real Harness from `harness.env`, start the packaged server from `server.env`, run `--check`, and complete one Turn. Repeat with a conflicting direct token, a missing key, a `$` in the token, whitespace around the digest's `=` and CRLF line endings to observe the refusals.

## Acceptance criteria

- With the bootstrap's files, the token and digest appear in exactly one file, and the control plane and Harness connect and complete a Turn.
- Each failure above stops startup with a message naming the file or key.
- Direct configuration behaves as before.

## Follow-up work

- Implemented by the [Hosted Harness Broker environment design](2026-10-21-hosted-harness-broker-environment.md): the Broker token shares this file, and the Hosted Harness profile fails on an occupied port instead of moving.
