# Matrix E2EE live integration test

This closes the Matrix E2EE ceiling end-to-end: it runs the real `cryptoAdapter`

- `MatrixBridge` against a real Synapse homeserver. The test file
  (`src/bridges/matrix/crypto.integration.test.ts`) is **env-gated** — it skips in
  the normal suite and runs only when pointed at a homeserver — and asserts:

1. the bot decrypts a message sent into an encrypted room;
2. a decrypted message reaches a **bound session** through dispatch;
3. the bot's reply is real ciphertext the **sender decrypts** (no plaintext leak);
4. a 👍 reaction on the bot's tracked message **registers a vote**.

Everything around it is verified without a homeserver: the adapter's SDK
construction is compile-checked, the `synapseRegisterMac` provisioning HMAC has a
known-answer unit test, and the dispatch seams (`dispatchDecryptedMessage`,
`dispatchReaction`, the `runInbound` subsume) are unit-tested. This test adds the
live olm/megolm round-trip and the full wired path.

## 1. Stand up Synapse (any Docker host)

```bash
cd packages/rc-gateway/integration/matrix

# One-time: generate the homeserver config.
docker compose run --rm synapse generate

# Shared-secret registration provisions the throwaway test users. The current
# matrixdotorg/synapse image ALREADY writes a random `registration_shared_secret`
# into ./data/homeserver.yaml during `generate` — just read it:
#     grep registration_shared_secret ./data/homeserver.yaml
# (Only if it is absent: add exactly one such line — never a duplicate key, which
# makes Synapse error. /_synapse/admin/v1/register needs only this key; public
# registration can stay off.)

docker compose up -d
# Readiness: curl http://<host>:8008/_matrix/client/versions  → expect 200.
```

## 2. Run the test

From `packages/rc-gateway`:

```bash
export QWEN_MATRIX_IT_HS_URL="http://<homeserver-host>:8008"
export QWEN_MATRIX_IT_REG_SECRET="<value from ./data/homeserver.yaml>"  # registration_shared_secret
npx vitest run src/bridges/matrix/crypto.integration.test.ts
```

When the env vars are absent the test reports `skipped` (the default `npm test`
stays green); when set, it provisions two ephemeral crypto users per run, creates
an encrypted room, and asserts the bot decrypts.

## Gotchas (the two that actually break E2EE tests)

1. **Key-share ordering.** Megolm shares the room session key to _known_ devices
   at send time and does **not** re-key history. The test therefore joins the bot,
   prepares crypto, and starts syncing **before** the sender sends. If you adapt
   it, preserve that order — a decrypt failure here is almost always sequencing,
   not crypto.
2. **Unverified-device policy.** The sender must be willing to share keys to the
   bot's (unverified) device. If your Synapse / SDK build withholds keys from
   unverified devices, the bot never decrypts — verify the device or enable
   share-to-unverified on the sender. (matrix-bot-sdk's default shares to
   unverified, so this passed out of the box — but it's the #1 silent failure if a
   build changes the policy.)
3. **Runtime-erased const enum.** matrix-bot-sdk's `RustSdkCryptoStoreType` is a
   `const enum` — it type-checks but is **erased at runtime** under esbuild
   (`.Sqlite` → `undefined`), which silently makes the adapter degrade to `null`.
   The store-type value is sourced from the native `@matrix-org/matrix-sdk-crypto-
nodejs` `StoreType` instead; don't "simplify" it back to the matrix-bot-sdk
   re-export.

## Status

Verified **green** end-to-end against a self-hosted Synapse container: both tests
pass (~25 s total) — bot decrypt, decrypted→bound-session dispatch, sender-decrypts
the bot's encrypted reply, and reaction→vote.

## Teardown

```bash
docker compose down -v   # -v also drops the throwaway accounts + olm stores
```
