# Runtime Credential Key Rotation

[English](2026-10-15-runtime-credential-key-rotation.md) | [简体中文](2026-10-15-runtime-credential-key-rotation.zh-CN.md)

## Status

Implemented by the change for #13202. The behavior remains unavailable in a release until that change lands.

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

## Rotation procedure

1. Back up the database and the complete current key ring.
2. Configure the new key as `credential-key-id` / `credential-key` and move the old active key into `previous-credential-keys` before starting the server.
3. Verify that existing bindings load and that newly written rows carry the new key ID.
4. Keep each previous key until operational evidence shows that no persisted row references it. Removing a still-referenced key intentionally makes those rows unreadable.

The server does not rewrite old ciphertext during reads. This keeps reads side-effect free and avoids a partial fleet silently changing persisted credentials.

## Validation

- The protector regression encrypts with the active key, decrypts a secret produced by the previous key, rejects the new ciphertext under the old-only protector, and rejects a duplicate active/previous ID.
- The Spring integration test binds `previous-credential-keys`, decrypts a previous-key secret through the configured `SecretProtector`, and proves new encryption uses the active ID.
- Existing wrong-context, wrong-key, tampering, maximum-token, and fresh-IV coverage remains applicable because the ciphertext format and AES-GCM operation are unchanged.

## Acceptance criteria

- A binding encrypted before rotation remains readable when its key ID and key material are present in `previous-credential-keys`.
- A binding created after rotation records the new active key ID.
- Missing, malformed, wrong-length, or duplicate key configuration fails closed.
- A deployment that configures only the existing active-key pair behaves as before.
