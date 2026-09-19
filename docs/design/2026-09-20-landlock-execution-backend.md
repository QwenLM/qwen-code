# Landlock tool execution backend

[English](2026-09-20-landlock-execution-backend.md) | [简体中文](2026-09-20-landlock-execution-backend.zh-CN.md)

## Status and scope

This design adds a Landlock filesystem backend to the tool execution boundary introduced by the bwrap delivery. It is stacked on the public bwrap CLI cutover and does not restore whole-CLI sandboxing. Shell commands, terminal shell entrypoints, and the existing file worker continue to enter confinement per tool invocation while the CLI, model transport, authentication, and session state remain on the host.

The first Landlock release is a fallback for Linux hosts where bwrap is missing or unusable. It confines pathname content and directory-structure mutations, but Linux Landlock still cannot restrict every metadata operation such as `chmod`, `chown`, extended attributes, or timestamps. It also does not provide bwrap's PID or network namespaces. The backend therefore reports `partial` filesystem enforcement, requires Landlock ABI 3 or newer so cross-directory rename and truncation are governed, and supports only `network: open`. It never claims that a partial Landlock profile is equivalent to bwrap.

## Operator contract

`tools.executionSandbox.backend` accepts `auto`, `bwrap`, or `landlock`.

- `bwrap` probes and uses only bwrap. Failure stops startup.
- `landlock` probes and uses only the bundled Landlock helper. `network: closed` is rejected before a payload can start.
- `auto` probes bwrap first. If bwrap is unusable and the requested policy has `network: open`, it probes Landlock and selects it when enforceable. With `network: closed`, bwrap is the only compatible candidate; failure reports that Landlock cannot satisfy the network policy.

Backend selection happens once during runtime initialization. The resolved backend, enforcement level, and Landlock ABI are frozen into the active Config policy. A command-time setup failure never falls through to another backend and never replays the payload on the host.

Inspection and UI surfaces show requested and effective backends. Landlock is rendered with `partial` and its probed ABI. The documentation states the uncovered metadata and process/IPC boundaries. This visibility is required because `auto` may move from full bwrap enforcement to partial Landlock enforcement on a host where user namespaces or mounts are unavailable.

## Bundled helper

Qwen Code ships `qwen-landlock-run` for Linux x64 and arm64 under `packages/core/vendor/landlock-run/<arch>-linux/`. The Apache-2.0 C11 source uses the stable raw Landlock UAPI and has no runtime library dependency because release binaries are statically linked with musl.

The command contract is:

```text
qwen-landlock-run --probe
qwen-landlock-run [--status-fd <fd>] [--ro <path>]... [--rw <path>]... -- <argv>...
```

`--ro` grants read and execute rights. `--rw` grants every filesystem right handled by the negotiated ABI. All handled rights outside those roots are denied. File grants mask directory-only rights. Every missing or unopenable grant, unsupported ABI, ruleset error, or failed exec exits 125 with a `qwen-landlock-run: ` diagnostic and does not silently remove a requested grant.

The helper requires ABI 3. ABI 1 cannot grant cross-directory reparenting and ABI 2 cannot control truncation, so accepting those kernels would leave common content-write paths outside the stated policy. ABI 5's device-ioctl right is enabled when available. Newer kernel rights are not treated as full coverage; the backend remains partial until the product contract and helper are reviewed together.

The helper sets `PR_SET_NO_NEW_PRIVS`, installs the ruleset, sets a parent-death signal, and then `exec`s the payload. Landlock restrictions survive exec and are inherited by descendants. The helper sends a small execution attestation to a dedicated status file descriptor; an unrestricted relay turns that wire plus the child status into the same confirmed/unconfirmed receipt used by bwrap. This preserves the no-blind-retry rule and temporary-directory retention behavior.

## Filesystem profile

Both backends retain broad host reads. Landlock grants read and execute below `/`, write access to `/dev/null` and the per-command scratch directory, and write access to the canonical workspace only for `workspace-write`. Runtime state and installation roots remain read-only. The helper opens rule roots with `O_PATH`, so rules bind to filesystem objects rather than trusting a later textual path lookup.

The Landlock process receives the same sanitized payload environment as bwrap, with `TMPDIR`, `TMP`, and `TEMP` pointing at private scratch. The existing workspace/protected-root admission checks remain authoritative. File writes continue through the same worker and version check; shell and file paths dispatch through the runtime's resolved backend.

Landlock does not create a PID namespace. Host processes remain visible, while Landlock's domain comparison restricts ptrace-like access to less-confined processes. Pathname and abstract Unix sockets are not part of this first helper profile. `network: open` therefore retains host networking and reachable host services. Closed networking remains a bwrap-only promise until a separately reviewed seccomp or namespace design can cover the whole network vocabulary.

## Packaging and verification

The build script compiles one architecture at a time with a native `musl-gcc` or an explicit Zig musl target. The two committed binaries are copied by the existing core `vendor/` package and bundle paths. A dedicated Linux x64/arm64 workflow rebuilds the helper, compares it byte-for-byte with the committed binary, runs the functional probe, and checks read-only denial, workspace write allowance, outside-write denial, descendant inheritance, and launcher failure attribution.

Unit coverage exercises settings validation, exact backend selection order, incompatible-network refusal, probe parsing, asset resolution, helper argv, backend dispatch, status-wire parsing, diagnostics, and public `qwen sandbox` verification differences. Real Linux acceptance must run the exact committed helper on both architectures. macOS tests can validate selection and argv construction but do not establish kernel enforcement.

## Security and compatibility

- Selection is fail-closed. Neither probe failure nor launch failure produces an unconfined retry.
- `partial` is an enforcement fact, not a warning label that callers may reinterpret as full. It covers Landlock's documented gaps in metadata operations and the absence of namespace isolation.
- ABI 3 is the minimum. Kernels without enabled Landlock or with older ABIs are unusable.
- Network-closed policies never select Landlock.
- Open file descriptors inherited across the confinement boundary retain their pre-Landlock rights. The launcher inherits only the command's standard streams and its execution-status descriptor.
- The helper's parent-death signal terminates the direct payload if its relay dies. Landlock has no PID-namespace lifetime boundary: detached descendants keep the inherited filesystem restrictions but rely on the existing runtime process cleanup rather than `--die-with-parent` semantics.
- Host reads, process visibility, and host Unix-socket reachability remain outside the first Landlock promise and are shown in documentation and verification output.

## Follow-up work

A future seccomp companion may make closed networking available without bwrap, but it requires its own syscall and compatibility design. Landlock's newer IPC scopes and ABI 9 pathname Unix-socket resolution, along with future filesystem rights, should be adopted only with exact-kernel tests and a deliberate enforcement-level decision. This PR does not change ACP/serve support, broaden writable roots, add per-command approval-derived policies, or change the whole-CLI Docker/Podman/Seatbelt paths.
