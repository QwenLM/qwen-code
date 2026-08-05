# Qwen CUA driver default integration

## Context

Qwen Code's built-in `computer_use__*` tools currently download and launch the
upstream `trycua/cua` driver pinned at 0.5.2. The repository now vendors the
Qwen CUA driver and owns its release workflow, binary identity, macOS app
bundle, MCP payload filter, and expanded tool contract.

This change makes the vendored Qwen CUA driver 0.17.0 the default backend while
preserving the existing lazy install and per-tool confirmation experience.

## Decisions

1. Download Qwen-owned release assets from the Aliyun OSS mirror first and the
   `QwenLM/qwen-code` GitHub Release second. The exact version remains pinned
   so the checked-in schemas and installed runtime cannot drift independently.
2. Use the Qwen identities end to end: `qwen-cua-driver`,
   `QwenCuaDriver.app`, `com.qwencode.cua-driver`, and the
   `qwen-cua-driver` state namespace. Existing trycua installations and TCC
   grants are not reused implicitly.
3. Keep the driver's standard authorization mode. Qwen Code does not pass
   `--dangerously-bypass-approvals`, and protected operations that require a
   stronger authorization host continue to fail closed.
4. Keep absolute pixel coordinates as the default. Qwen Code does not set
   `CUA_DRIVER_RS_COORDINATE_SPACE`; users may still opt into the driver's
   relative coordinate mode explicitly through their environment.
5. Enable `MCP_MODEL_PAYLOAD_FILTER=1` for the built-in MCP process because this
   is a model-facing route owned by Qwen Code.
6. Generate all 54 MCP schemas from the pinned binary and preserve MCP tool
   annotations. A destructive annotation forces the stronger confirmation
   surface in AUTO_EDIT; the existing curated high-risk list remains for
   sensitive tools whose annotation is intentionally non-destructive.
7. Run OSS mirroring only after the Qwen GitHub Release job succeeds. The
   release workflow uploads and verifies the exact assets consumed by the
   downloader, removing the race created by a separate main-branch pin watcher.

## Runtime topology

The first approved tool call downloads one platform archive into
`~/.qwen/computer-use/cua-driver-rs-0.17.0`. On macOS, Qwen Code registers the
bundled `QwenCuaDriver.app` with LaunchServices and starts the status daemon
through that app so Accessibility and Screen Recording grants belong to
`com.qwencode.cua-driver`. The stdio MCP child remains a thin proxy to the
persistent driver daemon.

The built-in client inherits the user's environment, adds only the model
payload filter, and invokes `qwen-cua-driver mcp`. It does not select a
coordinate mode or weaken driver authorization.

## Release dependency

The code pin is usable only after `cua-driver-rs-v0.17.0` has been published in
`QwenLM/qwen-code` and its consumer assets have been mirrored to OSS. Until
then, the integration PR must remain draft and must not be described as a
working first-install path.

## Validation

- Unit tests cover every platform/architecture mapping, Qwen identities,
  download source order, MCP environment, runtime-config error handling, and
  annotation-based risk classification.
- Schema regeneration must report exactly 54 tools from the local 0.17.0
  binary without setting relative-coordinate mode.
- Workflow validation checks that the mirror job depends on the release and
  uploads only downloader-consumed assets plus `checksums.txt`.
- A release-candidate E2E run must verify first install, macOS TCC attribution,
  an absolute-coordinate action, and model-facing payload filtering against
  the published artifact.
