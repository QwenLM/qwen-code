# Harden `/verify-pr` round-input handoff

[English](2026-11-25-verify-pr-round-input-hardening.md) | [简体中文](2026-11-25-verify-pr-round-input-hardening.zh-CN.md)

**Status: implemented and locally validated (27 focused tests, plus build, typecheck, and bundle) on macOS arm64 with Node 24.18.1. Revalidated on the same toolchain against `aa027f065eb3c26bee55739fdbf9220428f11cc6` on 2026-11-26. Hardware transport verification remains outside this change's scope. Date: 2026-11-25.**

## 1. Motivation

The NIC-less microVM channel implements `verify-pr-input-v1` in `scripts/verify-pr-vm-runner.mjs`, `scripts/verify-pr-vm-channel.mjs`, and `scripts/verify-pr-vm-guest-vsock.py`. A host preflight probe established two concrete wiring gaps:

- The JavaScript API accepts a caller-supplied `roundInput.entropyHex`, but the JSON `run --config` adapter drops it. A caller that supplies a matching fixed `trustedInputDigest` therefore always receives `trustedInputDigest does not match generated roundInput manifest digest` instead of a reproducible input handoff.
- Manifest generation advertises the guest model-proxy port, defaulting to 54, independently of where the model proxy actually listens. Host TCP, an alternate UDS, or a plan without `modelVsockPath` can therefore produce a manifest the guest cannot use.

The probe also confirmed that the Python guest client already rejects truncated payloads, oversized declarations, malformed headers, trailing bytes, and an incorrect bundle digest through a real UDS peer. These protections need execution witnesses in the repository, not additional duplicate checks. Two small hygiene items accompany the change: clean up the temporary bare repository when output-parent creation fails, and remove a `socket.gaierror` assertion that cannot observe the health fixture's construction.

## 2. Goals and non-goals

- Preserve deterministic input pinning through the public runner CLI as well as the direct JavaScript API.
- Fail closed before creating listener credentials or launching a worker when a guest input manifest would promise an unusable model endpoint.
- Pin the existing guest rejection behavior using real UDS sockets and the actual Python fetch client.
- Remove the temporary-repository leak without changing the two-OID export contract.

This change does not add a provider, create cloud resources, expand CLI configuration surfaces, extract shared socket helpers, or change `packages/`, `.github/`, `.qwen/skills/`, or `/review`. It does not alter legacy `container`, manually operated `vm`, or `waived` verification workflows. No PR commit, push, or publication is implied by this design.

## 3. Design decisions

### 3.1 Forward the existing entropy field

Add `entropyHex: rawRoundInput.entropyHex` to the existing `resolvedRoundInput` whitelist. Do not add another digest input or bypass canonical-manifest construction. `buildInputManifest` remains responsible for validating exactly 64 lowercase hexadecimal characters and for retaining its random 32-byte default when no entropy was supplied.

A caller-provided `trustedInputDigest` is still compared with the digest of the generated canonical manifest; the canonicalization and comparison are not weakened. A stale digest remains an error. Temporary proxy token/nonce values remain independently random and are still part of the canonical manifest, so the reproducible CLI pinning fixture uses `modelProxy: null`. This change does not expose credential fields, derive credentials from caller-selected entropy, or let callers predict a manifest containing newly generated credentials. A matching fixed digest over reproducible inputs passes this comparison regardless of whether `run --config` or the JavaScript API constructed the input.

### 3.2 Make the endpoint promise match the actual binding

Whenever `roundInput` is present and `modelProxy` is enabled, preflight requires a non-empty `plan.modelVsockPath` and exact equality between that path and the effective proxy binding. The effective binding retains the current order: explicit `socketPath`, then the planned VSOCK UDS when `listenHost` is absent, otherwise host TCP.

The rejected configurations are therefore an explicit host-TCP listener, an alternate UDS, or a missing planned model VSOCK path. Valid Firecracker/vfkit VSOCK plans keep their existing behavior. Host TCP and explicit alternate UDS configurations **without** `roundInput` remain supported because they do not create this guest-endpoint promise; this change does not claim that those routes work in a NIC-less guest.

The guard is ordinary input validation, before the temporary proxy token/nonce are generated, before token-file writes and listener creation, and before `launchBackend`. It does not create an implicit TCP-to-guest mapping, change a provider planner, or suppress the mismatch. The manifest's base path, temporary token, nonce, and the host-only upstream API key rules remain unchanged.

### 3.3 Pin fail-closed guest fetch behavior

A test-only UDS server returns a valid manifest followed by one malicious bundle response. Drive the real `python3 scripts/verify-pr-vm-guest-vsock.py fetch-inputs --unix ... --out ...` client for these cases:

1. A declared payload that is truncated before its length is reached.
2. A declared length greater than `MAX_BUNDLE_BYTES` (128 MiB).
3. A malformed `OK` header.
4. Bytes after the declared payload.
5. Payload bytes whose SHA-256 or length differs from the valid manifest.

Every case must exit nonzero, emit the specific protocol/integrity error, and leave neither `round.bundle` nor another input-file promotion in the output directory. No test hook, mock fetcher, real model service, or real upstream key is needed. Removing a guard must make the corresponding test fail.

### 3.4 Scope cleanup to the full scratch lifetime

Move creation of the `qc-round-bundle-*` scratch bare repository inside its guarded lifetime. Output-parent creation and bundle construction share `try`/`catch`/`finally` ownership: failed bundle output still removes its partial file, and the scratch directory is removed if it was created. If scratch creation itself fails there is nothing to remove.

The test uses an existing searchable but non-writable output parent (mode 0500) under an isolated temporary root. A nested `outPath` returns `ENOENT` at the initial `lstat`, scratch creation then succeeds, and the real `mkdirSync(..., {recursive: true})` fails with `EACCES`/`EPERM`. An ordinary-file obstruction is a control: its initial `ENOTDIR` rejection occurs before scratch creation and must not be mistaken for the leak. The permission fixture requires a non-root user; root bypassing the permission check is not recorded as a pass. The test restores directory permissions before removing the fixture and does not mock Git or the filesystem. Existing checks for explicit base/head OIDs, read-only alternates, no copied `.git/config`, no private branch or secret-file export, and atomic output replacement remain unchanged.

Delete only the test assertion that expects the fixed HTTP health response not to contain `socket.gaierror`. Keep the actual response checks and the separate IPv6 runtime capability probe.

## 4. Security and compatibility boundaries

| Case                                                    | Required result                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Valid fixed entropy through `run --config`              | Reaches the normal post-manifest lifecycle without a digest mismatch        |
| Stale `trustedInputDigest`                              | Fails before token/listener/worker creation                                 |
| `roundInput` plus a non-VSOCK or missing model binding  | Fails before token/listener/worker creation                                 |
| No `roundInput`; legacy host TCP or alternate UDS proxy | Existing behavior                                                           |
| Guest receives malformed or inconsistent bytes          | Nonzero exit and no promoted temporary bundle                               |
| Output-parent creation fails during bundle export       | Original error propagates; owned scratch and output temporaries are removed |

This is a transport/configuration consistency control, not a new hypervisor or a claim of end-to-end verification inside a newly launched kernel. Existing socket identity, single-link regular-file, authentication, budget, revocation, and teardown mechanisms retain their responsibilities. The upstream key never enters the manifest.

## 5. Risks and limitations

- An endpoint-equality assertion does not prove a real VM can communicate with the guest. It prevents the known misconfiguration; actual transport evidence remains a separate integration test.
- Python UDS tests do not establish Linux AF_VSOCK or Apple Virtualization.framework behavior.
- A deliberately early-exiting launcher used by the CLI wiring test is not a successful VM round or merge approval. Later failure must be distinguished from a manifest-digest rejection.
- Old PR verification, successful CI on unrelated code, and green tests from another head cannot establish the result for this change.

There are no unresolved product-direction questions in this slice. Provider-VM and Agent Sandbox data planes remain separate future work, with their existing explicit authorization and cloud-resource boundaries.

## 6. Validation plan

- Run the focused official scripts tests:

  ```bash
  npm run test:scripts:unit -- scripts/tests/verify-pr-vm-channel.test.js scripts/tests/verify-pr-vm-runner.test.js
  ```

- Exercise the identical `run --config` fixture before and after the change: fixed entropy plus its exact digest must no longer fail at the digest comparison, while a stale digest is still rejected.
- Exercise host TCP, alternate UDS, and missing-model-path rejection, plus the existing three-port UDS/loopback launcher flow, without changing legacy no-`roundInput` proxy cases.
- Replay the five malicious UDS cases; no promoted input file may remain.
- Run `npm run build`, `npm run typecheck`, and `npm run bundle`; then use the built CLI for bounded runtime checks where relevant. Report every command actually run and any environment not covered.
- Review the full diff, confirm both language documents agree, and stop background processes and delete disposable fixtures before finishing.

## 7. Acceptance criteria

All four behavior rows have executable evidence, focused and negative tests pass through the official runner, and the validation boundary states exactly which environments were exercised. Compatibility holds without silently degrading isolation or inventing a guest route. No unavailable environment is reported as passing, and no cloud resource or GitHub-side effect is claimed.
