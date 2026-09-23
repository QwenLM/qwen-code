# cua-driver scripts

Install, uninstall, local-build, and VM sync helpers for cua-driver.

| Script | Purpose |
| --- | --- |
| `install.sh` / `install.ps1` | Install released `qwen-cua-driver` binaries |
| `install-local.sh` / `install-local.ps1` | Build this checkout as the separate `qwen-cua-driver-local` product |
| `uninstall-local.sh` / `uninstall-local.ps1` | Remove only the source-built `qwen-cua-driver-local` product |
| `uninstall.sh` / `uninstall.ps1` | Remove installed driver artifacts |
| `_install-common.sh` / `_install-common.psm1` | Shared install helper logic |
| `_install-rust.sh` / `_install-local-rust.sh` | Rust build/install internals |
| `sync-vm-worktree.sh` | Sync this checkout to verification VMs and pull artifacts back |
| `post-install-hints.txt` | User-facing hints printed by install scripts |

## Stable macOS local signing

macOS Accessibility and Screen Recording grants are tied to an app's
designated requirement. An ad-hoc signature uses a `cdhash` requirement that
changes on every rebuild, so its grants do not survive the next local install.
The installer now reports whether the installed requirement is
`certificate-backed` or `ad-hoc cdhash`; an ad-hoc install always prints a
prominent warning and bootstrap instructions.

For behavior or E2E verification, require the stable path:

```bash
bash packages/cua-driver/scripts/install-local.sh \
  --release --autostart --require-stable-signing
```

`CUA_DRIVER_REQUIRE_STABLE_SIGNING=1` is the environment equivalent. Strict
mode stops before replacing the live app when no usable certificate-backed
identity is available.

For the most reliable non-interactive rebuilds, use a dedicated keychain:

```bash
SIGNING_KEYCHAIN="$HOME/Library/Keychains/cua-driver-signing.keychain-db"
security create-keychain "$SIGNING_KEYCHAIN"  # first time only
security set-keychain-settings "$SIGNING_KEYCHAIN"
security unlock-keychain "$SIGNING_KEYCHAIN"
export CUA_DRIVER_LOCAL_SIGNING_KEYCHAIN="$SIGNING_KEYCHAIN"
```

The first install creates `Qwen Cua Driver Local Signing` in that
keychain. If `codesign` cannot use its private key non-interactively, unlock
the keychain, trust the certificate in Keychain Access, and authorize Apple
code-signing tools:

```bash
read -r -s -p 'Keychain password: ' KEYCHAIN_PASSWORD; echo
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" \
  "$SIGNING_KEYCHAIN"
unset KEYCHAIN_PASSWORD
```

Then rerun the strict installer and grant Accessibility and Screen Recording
once. When the dedicated default keychain above exists, the installer prefers
it automatically; exporting `CUA_DRIVER_LOCAL_SIGNING_KEYCHAIN` remains the
most explicit choice.

Released installers show a telemetry notice before asking the installed binary
to record anything. Telemetry is disabled by default. Explicitly enabling it
sends the upstream content-free event stream to Cua's PostHog endpoint; use
`qwen-cua-driver telemetry disable` to turn it off again. Installation events
use the same consent decision as routine events. A normal uninstall preserves the pseudonymous
installation ID and preference for a future reinstall; use `--purge` on Unix,
or set `CUA_DRIVER_RS_UNINSTALL_PURGE=1` on Windows, to delete them.

Keep source commits host-owned. Verification machines should sync from this
checkout and return artifacts, not push code.

Local and released installations are removed independently:

```bash
# macOS / Linux, from the checkout
packages/cua-driver/scripts/uninstall-local.sh

# Windows, from the checkout
packages/cua-driver/scripts/uninstall-local.ps1
```

The local uninstaller leaves `qwen-cua-driver`, `QwenCuaDriver.app`, release services,
release state, and release TCC grants untouched. On macOS it revokes only
`com.qwencode.cua-driver.local`; pass `--keep-tcc` to retain that local grant.
