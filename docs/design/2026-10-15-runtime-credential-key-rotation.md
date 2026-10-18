# Runtime Credential Key Rotation

[English](2026-10-15-runtime-credential-key-rotation.md) | [简体中文](2026-10-15-runtime-credential-key-rotation.zh-CN.md)

## Status

The base key-ring support for #13202 landed in #14317. The change for #14408 extends that configuration to operator recovery and adds ID-only diagnostics; its runtime acceptance remains a separate gate.

## Problem

The Runtime Broker persists the key ID beside every encrypted provision seed and Runtime credential, but the server configures only one AES-256-GCM key. Replacing that key makes every row written with the previous key unreadable even though the row still identifies the key required to decrypt it.

## Goals

- Encrypt every new secret with one explicitly configured active key.
- Decrypt existing secrets with the active key or a configured previous key selected by the persisted key ID.
- Fail startup for malformed or duplicate key configuration and fail reads for an unavailable key ID.
- Keep the existing single-key configuration compatible.

Automatic re-encryption, key generation, key expiry, secret-manager integration, and database migration are outside this change.

## Design

`AesGcmSecretProtector` owns an active key ID and a key ring. `protect()` always selects the active key and persists its ID in `ProtectedSecret`. `unprotect()` selects a key only by `ProtectedSecret.keyId`; it never falls back to a different key when the ID is absent. AES-GCM context binding and ciphertext format stay unchanged.

The Managed Agent server keeps the existing active settings and adds a map of previous keys:

```yaml
qwen:
  managed-agent:
    runtime-broker:
      credential-key-id: reference-v2
      credential-key: <base64-encoded-32-byte-v2-key>
      previous-credential-keys:
        '[reference-v1]': <base64-encoded-32-byte-v1-key>
```

Every configured key must decode to exactly 32 bytes. The active key ID must not also appear in `previous-credential-keys`. An unknown persisted key ID continues to fail with `Runtime credential key is unavailable`. Map keys are written in Spring's bracket form (`'[…]'`): the relaxed binder normalises plain keys (an ID like `legacy/v1` binds as `legacyv1`, quoted or not), so anything else silently matches no persisted row.

The Spring-bound operator-recovery entry consumes the same active pair and previous-key map. It keeps the rotated active key rather than requiring an operator to make the old key active. Load the same external YAML through `SPRING_CONFIG_ADDITIONAL_LOCATION`; the previous-key map still has no environment-variable map protocol. CSI/migration maintenance mains, including the CSI Hosted probe, retain their existing single-pair input contract.

Key IDs are non-secret identifiers already persisted beside ciphertext. After successful protector construction, log the resolved active ID and sorted configured IDs once. Missing-key errors include the requested ID and the same resolved ring; existing ID-bearing key-validation errors use the same escaping. Fastjson2's JSON string encoding with `EscapeNoneAscii` preserves exact ID spelling while escaping controls and Unicode line separators. Never log key maps, key bytes, plaintext, ciphertext or lease tokens. These diagnostics support operator comparison with persisted IDs; they do not perform a startup scan or certify that every row is readable.

Use only non-secret labels as key IDs; never put credential material in an ID. Missing-key faults return a generic HTTP 500 without key IDs in the response. Only the actual Broker-closed exception maps to HTTP 503 `runtime_broker_closed`; a key ID containing `closed` must not change that classification.

## Rotation procedure

1. Back up the database and the complete current key ring.
2. Configure the new key as `credential-key-id` / `credential-key` and move the old active key into `previous-credential-keys` before starting the server.
3. Verify that existing bindings load and that newly written rows carry the new key ID.
4. Keep each previous key until the [deployment runbook](../users/managed-agent-reference-deployment.md#rotate-the-runtime-credential-key) retirement query returns no other key ID. Removing a still-referenced key intentionally makes those rows unreadable.

The server does not rewrite old ciphertext during reads. This keeps reads side-effect free and avoids a partial fleet silently changing persisted credentials.

## Validation

- The protector regression encrypts with the active key, decrypts a secret produced by the previous key, rejects the new ciphertext under the old-only protector, and rejects a duplicate active/previous ID.
- The Spring integration test binds `previous-credential-keys`, decrypts a previous-key secret through the configured `SecretProtector`, and proves new encryption uses the active ID.
- The existing Hosted operator-recovery case runs the real maintenance subprocess with a new active pair plus the old bound map, and checks that the original provision-seed ciphertext and key ID remain unchanged. Its parent broker is configured to read both keys. Seed-backed workers do not duplicate the token in the runtime-credential columns; do not require a lease re-encryption that their storage contract deliberately omits.
- The diagnostic regression captures one successful constructor summary and an unavailable-key error, checking exact ID visibility, escaped control characters and absence of secret values. Full Java, Linux/MySQL and Hosted verification must be reported separately; the source changes alone do not establish acceptance.
- Existing wrong-context, wrong-key, tampering, maximum-token, and fresh-IV coverage remains applicable because the ciphertext format and AES-GCM operation are unchanged.

## Acceptance criteria

- A binding encrypted before rotation remains readable when its key ID and key material are present in `previous-credential-keys`.
- A binding created after rotation records the new active key ID.
- Missing, malformed, wrong-length, or duplicate key configuration fails closed.
- A deployment that configures only the existing active-key pair behaves as before.
- Operator recovery can read pre-rotation bindings through the configured previous-key map without changing the original provision seed.
- Startup and unavailable-key diagnostics expose escaped IDs only and make the resolved ring inspectable without logging secret values.
