# Landlock tool execution backend

[English](2026-09-20-landlock-execution-backend.md) | [简体中文](2026-09-20-landlock-execution-backend.zh-CN.md)

## Status and scope

This design adds a Landlock filesystem backend to the tool execution boundary introduced by the bwrap delivery. It builds on the public bwrap CLI cutover and trusted review-state migration already merged into main (#12267 and #12491), without restoring whole-CLI sandboxing. Shell commands, terminal shell entrypoints, and the existing file worker continue to enter confinement per tool invocation while the CLI, model transport, authentication, and session state remain on the host.

The first Landlock release is a fallback for Linux hosts where bwrap is missing or unusable. It confines pathname content and directory-structure mutations, but Linux Landlock still cannot restrict every metadata operation such as `chmod`, `chown`, extended attributes, or timestamps. It also does not provide bwrap's PID or network namespaces. The backend therefore reports `partial` filesystem enforcement, requires Landlock ABI 3 or newer so cross-directory rename and truncation are governed, and supports only `network: open`. It never claims that a partial Landlock profile is equivalent to bwrap.

## Operator contract

`tools.executionSandbox.backend` accepts `auto`, `bwrap`, or `landlock`.

- `bwrap` probes and uses only bwrap. Failure stops startup.
- `landlock` probes and uses only the bundled Landlock helper. `network: closed` and every remaining nonempty `maskedPaths` list are rejected before probing the helper or starting a payload.
- `auto` probes bwrap first. If bwrap is unusable and the requested policy has `network: open`, it probes Landlock and selects it when enforceable. A remaining nonempty mask list makes Landlock incompatible; fallback never drops masks. With `network: closed`, bwrap is the only compatible candidate; failure reports that Landlock cannot satisfy the network policy.

Backend selection happens once during runtime initialization. The resolved backend, enforcement level, and Landlock ABI are frozen into the active Config policy. A command-time setup failure never falls through to another backend and never replays the payload on the host.

The Landlock policy probe executes `/usr/bin/true` inside the boundary. Hosts without that executable fail the probe; helper capability alone does not make such a host usable.

Inspection and UI surfaces show requested and effective backends. Landlock is rendered with `partial` and its probed ABI. The documentation states the uncovered metadata and process/IPC boundaries. This visibility is required because `auto` may move from full bwrap enforcement to partial Landlock enforcement on a host where user namespaces or mounts are unavailable.

The model prompt uses the effective backend: Landlock describes partial content-write restrictions and EACCES refusals, including metadata and namespace limits; bwrap retains its read-only mount guidance.

## Bundled helper

Qwen Code ships `qwen-landlock-run` for Linux x64 and arm64 under `packages/core/vendor/landlock-run/<arch>-linux/`. The Apache-2.0 C11 source uses the stable raw Landlock UAPI and has no runtime library dependency because release binaries are statically linked with musl.

Before probing or launching the bundled helper, the host restores its mode to 0755 if packaging removed all executable bits. This applies to fresh and managed installs without a postinstall script. A read-only or permission-restricted install that cannot restore the mode fails before the payload starts; it never substitutes a host command. Explicit helper-path overrides are not chmod'ed. Helper lookup distinguishes source layout from the bundle directory by its trailing path components, so installation ancestor names do not change asset resolution.

The command contract is:

```text
qwen-landlock-run --probe
qwen-landlock-run [--status-fd <fd>] [--ro <path>]... [--rw <path>]... -- <argv>...
```

`--ro` grants read and execute rights. `--rw` grants every filesystem right handled by the negotiated ABI. All handled rights outside those roots are denied. File grants mask directory-only rights. Every missing or unopenable grant, unsupported ABI, ruleset error, or failed exec exits 125 with a `qwen-landlock-run: ` diagnostic and does not silently remove a requested grant.

The helper requires ABI 3. ABI 1 cannot grant cross-directory reparenting and ABI 2 cannot control truncation, so accepting those kernels would leave common content-write paths outside the stated policy. ABI 5's device-ioctl right is enabled when available. Newer kernel rights are not treated as full coverage; the backend remains partial until the product contract and helper are reviewed together.

Both relays initialize Node's shared output descriptors before spawning the helper or bwrap, preventing lazy stream setup from changing their flags after the child starts. The Landlock helper then restores blocking mode on open standard streams before exec, so inherited Node relay flags cannot truncate native payload output with `EAGAIN`. It sets `PR_SET_NO_NEW_PRIVS`, installs the ruleset, sets a parent-death signal, and then `exec`s the payload. Landlock restrictions survive exec and are inherited by descendants. The helper sends a small execution attestation to a dedicated status file descriptor; an unrestricted relay turns that wire plus the child status into the same confirmed/unconfirmed receipt used by bwrap. This preserves the no-blind-retry rule and temporary-directory retention behavior.

## Filesystem profile

Both backends retain broad host reads. Landlock grants read and execute below `/`, write access to `/dev/null` and the per-command scratch directory, and write access to the canonical workspace only for `workspace-write`. Runtime state and installation roots remain read-only. The helper opens rule roots with `O_PATH`, so rules bind to filesystem objects rather than trusting a later textual path lookup.

Landlock does not create bwrap's private `/dev` and `/proc` mounts. Its narrower write grants reject opening other device paths such as `/dev/full` or `/dev/tty` for writing and creating files in `/dev/shm`; programs that require these operations may fail. Use the private scratch directory exposed through `TMPDIR`, `TMP`, and `TEMP` for temporary files. This restriction concerns new pathname access, not the caller-provided standard streams that are already open.

Trusted review state remains outside the writable workspace under the merged migration. Landlock cannot hide paths under its broad read grant: both its probe and execution entrypoints reject every nonempty `maskedPaths` list. Bubblewrap continues to enforce explicit masks.

The unrestricted Node relay starts with a minimal environment. Payload variables travel through an exclusively created, mode-0600 control file, which the relay reads and removes before spawning the static helper. Variables such as `NODE_OPTIONS` therefore apply only after confinement to a Node payload, never to the unrestricted relay. The Landlock process receives the same sanitized payload environment as bwrap, with `TMPDIR`, `TMP`, and `TEMP` pointing at private scratch. The existing workspace/protected-root admission checks remain authoritative. File writes continue through the same worker and version check; shell and file paths dispatch through the runtime's resolved backend.

Landlock does not create a PID namespace. Host processes remain visible, while Landlock's domain comparison restricts ptrace-like access to less-confined processes. Pathname and abstract Unix sockets are not part of this first helper profile. `network: open` therefore retains host networking and reachable host services. Closed networking remains a bwrap-only promise until a separately reviewed seccomp or namespace design can cover the whole network vocabulary.

## Packaging and verification

The build script compiles one architecture at a time with a native `musl-gcc` or an explicit Zig musl target. The two committed binaries are copied by the existing core `vendor/` package and bundle paths. A dedicated Linux x64/arm64 workflow rebuilds the helper, compares it byte-for-byte with the committed binary, runs the functional probe, and checks read-only denial, workspace write allowance, outside-write denial, descendant inheritance, and launcher failure attribution.

Production-bundle acceptance covers read-only and workspace-write policies, network and mask refusal, literal argv and payload environment isolation, byte-exact stdin/stdout/stderr, streamed-input backpressure, slow consumers, EPIPE cleanup, negative controls, and no unconfined replay. Unit coverage exercises settings validation, exact backend selection order, incompatible-network refusal, probe parsing, asset resolution, helper argv, backend dispatch, status-wire parsing, diagnostics, and public `qwen sandbox` verification differences. Real Linux acceptance must run the exact committed helper on both architectures. macOS tests can validate selection and argv construction but do not establish kernel enforcement.

## Security and compatibility

- Selection is fail-closed. Neither probe failure nor launch failure produces an unconfined retry.
- `partial` is an enforcement fact, not a warning label that callers may reinterpret as full. It covers Landlock's documented gaps in metadata operations and the absence of namespace isolation.
- ABI 3 is the minimum. Kernels without enabled Landlock or with older ABIs are unusable.
- Network-closed policies and nonempty path-mask policies never select Landlock.
- Open descriptors retain their pre-Landlock rights. The relay streams host-backed regular-file and named-FIFO stdin through a pipe; it only directly shares sockets, character devices, or anonymous pipes. It preserves input bytes and backpressure without granting the payload a host-file stdin descriptor. Output standard streams remain explicit caller-provided destinations. The helper marks its execution-status descriptor close-on-exec.
- The helper's parent-death signal terminates the direct payload if its relay dies. Landlock has no PID-namespace lifetime boundary: detached descendants keep the inherited filesystem restrictions but rely on the existing runtime process cleanup rather than `--die-with-parent` semantics.
- Host reads, process visibility, and host Unix-socket reachability remain outside the first Landlock promise and are shown in documentation and verification output.

## Follow-up work

A future seccomp companion may make closed networking available without bwrap, but it requires its own syscall and compatibility design. Landlock's newer IPC scopes and ABI 9 pathname Unix-socket resolution, along with future filesystem rights, should be adopted only with exact-kernel tests and a deliberate enforcement-level decision. This PR does not change ACP/serve support, broaden writable roots, add per-command approval-derived policies, or change the whole-CLI Docker/Podman/Seatbelt paths.
