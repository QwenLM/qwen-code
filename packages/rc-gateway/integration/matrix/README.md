# Matrix E2EE live-decrypt integration test

This closes the **decrypt half** of the Matrix E2EE ceiling: it runs the real
`cryptoAdapter` against a real Synapse homeserver and asserts the bot decrypts a
message sent into an encrypted room. The test
(`src/bridges/matrix/crypto.integration.test.ts`) is **env-gated** — it skips in
the normal suite and runs only when pointed at a homeserver.

Everything else around it is already verified without a homeserver: the adapter's
SDK construction is compile-checked, the `synapseRegisterMac` provisioning HMAC has
a known-answer unit test, and the decrypted-message → dispatch routing seam
(`MatrixBridge.dispatchDecryptedMessage`) is unit-tested. This test adds the live
olm/megolm round-trip.

## 1. Stand up Synapse (on the pkix Docker host)

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
# Wait until http://<host>:8008/_matrix/client/versions returns 200.
```

## 2. Run the test

From `packages/rc-gateway`:

```bash
export QWEN_MATRIX_IT_HS_URL="http://<pkix-host>:8008"
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
   share-to-unverified on the sender. This is the #1 silent failure.

## Teardown

```bash
docker compose down -v   # -v also drops the throwaway accounts + olm stores
```
