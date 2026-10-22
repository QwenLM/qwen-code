# POSIX npm OpenTUI distribution

[English](2026-10-21-opentui-npm-distribution.md) | [简体中文](2026-10-21-opentui-npm-distribution.zh-CN.md)

## Status and problem

The source checkpoint `0d353777bb054b9d5c9925f134dd63db7c316614` normally merges main `19d3289f4818617efdf31ca46d4db0522da36f95`, including the accepted input/output batch #15067 and Bun PTY #14046. It preserves all 49 distribution changes and the existing dependency inputs. Fresh macOS arm64 build and typecheck passed at this checkpoint. Affected consumer, native, bundle and installed-product gates are recorded separately in [#14959](https://github.com/QwenLM/qwen-code/pull/14959); a successful source build is not installed-artifact acceptance.

Earlier evidence remains bound to its source and artifact. Candidate `e8192c18` passed five installation layouts and 41 distinct actual-product cases, plus three separate synthetic protocol cases. Update fixtures used owned 0.0.0 clones and a candidate tarball, not two published releases. Later `7368b97` installation coverage recorded 20 functional passes and two characterized Ink deny gaps across 22 cases; `61f4e5be` source/runtime gates preceded this main integration. None proves the final combined artifact. Original failures, platform skips and corrected harness runs remain recorded separately; the final tarball must remeasure the 160 MiB unpacked-size gate.

The original strict interactive `--json-file` defect is covered by the accepted output changes, but the final installed combination still requires its own output regression. The historical serve shutdown failure requires current-candidate characterization. Native Linux cgroup/bwrap/landlock, other supported platforms and released-version upgrades remain separate open gates. Windows ConPTY diagnostics are not installed-Qwen acceptance and do not change the pinned Bun runtime. This remains an opt-in POSIX npm delivery; completion of all TUI migration and a default-renderer change require the overall migration gates.

The published npm manifest excludes `opentui-assets` and has no private Bun
runtime. On Node below 26.4, an explicit OpenTUI request falls back to Ink; on
newer Node, a bundled installation still lacks the native/parser assets needed
to boot OpenTUI. The separate Bun standalone preview already ships its runtime
and assets. npm/npx must gain the same explicit renderer choice without requiring
a global Bun installation or changing the default renderer.

Related work:

- [Runtime umbrella #11607](https://github.com/QwenLM/qwen-code/issues/11607).
- [Bun PTY #14046](https://github.com/QwenLM/qwen-code/pull/14046), merged at
  reviewed `2972234e`; combined-artifact shell fidelity remains unverified.
- [R1 standalone updates #14934](https://github.com/QwenLM/qwen-code/pull/14934).
- [Publish executable bits #14907](https://github.com/QwenLM/qwen-code/pull/14907).

## Goals and boundaries

Support explicit OpenTUI sessions installed by npm or npx on darwin-arm64,
darwin-x64, linux-arm64, and linux-x64 (glibc). Keep Node as the npm launcher and
package-manager interpreter, and use the existing supervised CLI relaunch when
the selected interactive renderer needs private Bun.

Do not add `QWEN_TUI_RUNTIME`, a new package publishing family, a runtime cache,
startup downloads, a search for Bun on `PATH`, a compiled application, or changes
to the package manager. Do not switch the default renderer or runtime. Windows,
musl, whole-CLI sandbox images, and Node-only external hosts remain outside the
new handoff. Existing standalone runtime selection and updates remain intact.

The direct `process.execPath` audit also identifies a bounded remainder from
[#14134 at c807de17](https://github.com/QwenLM/qwen-code/pull/14134) and
[#14187 at d14b2ad1](https://github.com/QwenLM/qwen-code/pull/14187), consolidated
in this existing R3 delivery. The sandbox diagnostic, Mem0 MCP spawn and bundled
hook identity, cgroup launcher, and bwrap/landlock relay and protected-root pairs
reuse `getJsInterpreterCommand`. Keep the original payload, environment,
reaper and sandbox permissions; retain all four associated regression files.
The helper still falls back to the invoking interpreter for npm/source/SDK.

Three proposed swaps remain explicit exceptions: review Vitest retains its
host interpreter (and image `node` in the container); the PEM loader oracle and
TLS trust probe retain `process.execPath` to match the actual channel worker.
Do not change a probe's runtime independently of the worker it certifies.
The [runtime inventory](bun-runtime-boundary.md) records both the migrated
consumers and these exceptions. Application relaunches, default runtimes,
protocol hosts, and npm's original Node identity are unchanged.

## Mode and runtime selection

Reuse the existing explicit `QWEN_TUI_RENDERER=opentui` request. The handoff runs
after argument/settings resolution and before worktree creation, resume pickers,
authentication, MCP initialization, and renderer initialization. Share the
existing interactive predicate with configuration loading rather than parsing
raw arguments a second time. An explicit `-i` is interactive; otherwise a query
or prompt is non-interactive, and an empty prompt requires terminal stdin.
The private Bun handoff also requires terminal stdout, so redirected output
retains its invoking runtime.

| Invocation                                                           | Runtime behavior                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Renderer unset, `ink`, or unknown                                    | Existing runtime and renderer behavior                               |
| Explicit OpenTUI, interactive Node below 26.4, supported npm install | Private pinned Bun through the existing supervisor                   |
| Explicit OpenTUI, Node 26.4 or newer                                 | Existing Node/OpenTUI path; existing FFI requirements still apply    |
| Already running under Bun                                            | Existing runtime; no recursive handoff                               |
| Screen reader, including settings and CLI overrides                  | Existing Ink capability fallback; strict request fails               |
| Prompt/headless, pipe, help, version                                 | Remain on the invoking runtime                                       |
| `serve`, `mcp`, managed bootstrap, ACP, SDK, IDE protocol hosts      | Remain on their existing runtime/protocol path                       |
| Dual-output protocol input/file or JSON descriptor                   | No new runtime handoff                                               |
| Whole-CLI sandbox or already inside one                              | No host-private Bun handoff; preserve existing sandbox behavior      |
| Windows, unsupported CPU, or Linux musl                              | No private Bun handoff                                               |
| Missing optional runtime or non-executable binary                    | Node/Ink fallback; strict explicit request fails with a useful cause |
| Unsupported inherited Node runtime flags                             | Keep the original Node path; strict explicit request fails           |

Only flags that are valid for this known Bun launch are passed to Bun. Node
memory tuning and Node loaders are not forwarded as Bun arguments. Preserve
script arguments, working directory, environment provenance, trusted launcher
identity, and the existing no-relaunch guard. An inherited request to disable
relaunch remains effective and cannot be silently overridden.

A Bun spawn failure is a startup error through the existing supervisor. Once
the Bun process has started, native renderer construction retains the existing
Ink fallback/strict-failure policy. Do not replay an already-started session
under a second runtime.

## Runtime and npm identities

Resolve the official platform package relative to the selected published CLI
installation, not the user's working directory. Require the expected published
manifest/bin layout, exact pinned runtime package version, and an executable
regular `bin/bun`. Development/source layouts and standalone manifests do not
opt into this npm handoff.

The original Node interpreter is captured at module boot before settings
or project environment loading, carried through the supervised handoff, and used
only for npm work. It must remain associated with this installation and cannot
be replaced by an env-file or `settings.env` value. The existing private
provenance exclusion also prevents a forged value from reaching nested children.
npm registry lookup, global config lookup,
managed update installation and smoke tests, and detached update workers use
that Node identity. They must not derive `npm-cli.js` from private Bun's path.

Keep `QWEN_CODE_CLI`, managed npm root/pin, and standalone trusted-launcher
validation unchanged. Exit 44 must reach the original Node wrapper so the
existing update/relaunch logic can select the new build. Keep the existing IPC
update-on-exit path, terminal process-group signals, stdin ownership, cleanup,
and supervisor-disconnect handling. Do not introduce another supervisor.

The Bun interpreter handoff on a TTY marks its child with the existing private
supervision key's `terminal` value. The child consumes that marker and requires
a real current or disconnected IPC channel before acting on it. If Node is
killed while the terminal remains open, IPC disconnection starts the existing
bounded cleanup immediately, followed by exit 129. Other terminal relaunches
keep their current policy; pipes and ACP retain the 120-second orphan grace.

While that terminal Bun child runs, its Node supervisor ignores SIGINT so the
child alone applies the existing confirmation window to a foreground-group
signal. The temporary listener is removed on close or failure. A SIGINT sent
only to the supervisor is ignored; terminal-group SIGINT and raw Ctrl+C input
are the interactive interrupt paths. TERM/HUP keep Node's default behavior and
are not forwarded a second time: IPC disconnection cleans up the child even
when the parent alone receives the signal. Acceptance checks parent-only
TERM/KILL with a live PTY keeper separately from group SIGINT and Ctrl+C bytes.

The OpenTUI renderer excludes SIGINT from its process exit listeners so the
shared interactive confirmation handler owns that signal. Its second confirmed
interrupt runs the existing registered renderer cleanup. Keep the other
OpenTUI 0.5.10 defaults: SIGTERM, SIGQUIT, SIGABRT, SIGHUP, SIGPIPE, SIGBREAK and
SIGBUS. Disabling the renderer's keyboard Ctrl+C handler alone does not prevent
its process-level SIGINT listener from destroying the terminal on the first
interrupt. Acceptance therefore requires usable input and an actual model
response after the first foreground-group signal, before testing double exit.

## Package construction

The generated npm manifest adds four exact optional dependencies from the
official `@oven` platform packages at Bun 1.3.14. Use the direct platform packages,
whose executable already exists in the tarball, rather than the `bun` wrapper
with its install script. This supports `--ignore-scripts`; `--omit=optional`
deliberately leaves the private Bun path unavailable.

Keep the complete relocated asset root in the published package. It contains
the parser worker, all existing grammar/SCM files, `web-tree-sitter` wasm, and
the four POSIX native libraries. OpenTUI 0.5.10 resolves every key through one
`OTUI_ASSET_ROOT`; splitting common assets from platform libraries without a
complete root would fail. Reuse the current copy logic and release staging
pattern, pinning native package versions from `pnpm-lock.yaml`.

Cross-platform asset staging is a packaging action with network access, not an
installation or startup action. Stage into an owned temporary directory, use
`--ignore-scripts`, copy only the declared native files, and remove temporary
content. The existing desktop caller uses the internal `--host-runtime`
preparation mode to skip universal npm staging. Its final copied runtime retains
only the selected desktop target's native library, including when `--skip-build`
reuses an npm-prepared dist. Common parser assets remain intact; source dist is
not pruned. This avoids regressing Linux desktop dependency scans and preserves
Windows target assets. Selection uses `desktopTarget()`, not the build machine's
`process.arch`, so cross-builds preserve their destination library. Ordinary
bundle construction remains unchanged.

VS Code extension preparation also uses `--host-runtime`, preserving its existing
optional dependencies without adding a private Bun to the embedded `qwen-cli`
layout. After copying, a platform VSIX keeps only its explicit `VSCODE_TARGET`
OpenTUI native library and the common parser assets, using the same target
validation as its existing ripgrep pruning. Universal builds, builds without an
explicit target, and unknown targets retain the existing asset-retention policy.
Only the extension's copied tree is pruned; root dist and existing destination
dependencies remain intact. Sandbox packaging produces an actual npm tarball
and continues to use normal npm preparation.

The existing 160 MiB unpacked npm-package limit remains a hard gate. Measure the
actual prepared tarball, including every published native library, rather than
extrapolating from a host-only bundle. Optional Bun dependencies add installation
size separately and must be reported. If the real artifact exceeds the limit,
this proposal is not deliverable until scope is revised; do not raise the limit
or omit required assets to obtain a passing check.

Preserve main's #14907 `npm publish` executable-bit protection. This branch does
not change release workflows to synchronize its older base. Verification uses
`npm pack` and the trusted main executable-bit checker, including vendored
ripgrep and the installed optional Bun executable. Do not reintroduce a
`pnpm pack` publication path.

## Dependencies and risks

Main now selects the #14046 `qwen-bun-pty` backend under Bun on POSIX and carries
its standalone PTY assets. This batch retains that implementation and adds the
92d4b193 reaped-leader guard; neither source integration nor earlier pipe-fallback
acceptance proves the new installed shell path has Ink/Node PTY fidelity. Its
real-process and artifact gates remain open. Windows Bun PTY remains unsupported.

Four platform archive contents can be checked on one host; native behavior cannot.
Record macOS arm64 execution separately from Linux/x64 or Windows checks.
Node 26.4 preserving Node/OpenTUI is an intentional compatibility choice here:
the later all-TUI-to-Bun milestone must still address these Node versions,
screen-reader behavior, sandboxing, Windows/musl, and the PTY dependency.

Runtime flags, managed npm updates, symlinked/npm-prefix installs, and optional
dependency omission are the highest-risk boundaries. Missing parser workers or
grammars can silently lose highlighting; a version-only smoke test cannot prove
either CLI loading or native renderer startup.

## Validation and acceptance

Use the global CLI to establish the mode/runtime baseline before product E2E.
The detailed plan and results live in `.qwen/e2e-tests/`. All tests use owned
temporary HOME, QWEN_HOME, npm prefix/cache, and shell configuration paths.

1. Unit tests cover the complete mode table, settings precedence, runtime flags,
   package identity, version/executable checks, and original Node npm dispatch.
2. Packaging tests reject incomplete common assets, each missing native target,
   mismatched versions, and an artifact over 160 MiB. Assert the published files
   and exact optional dependency pins. Exercise the real IDE preparation,
   metadata generation and copy chain with npm build/install processes replaced:
   no Bun optional dependency reaches the VSIX installer, existing optional
   dependencies and universal install flags remain, and target filtering
   preserves common assets and the reusable source tree.
3. Build, typecheck, bundle, and focused tests pass for a frozen source commit.
4. Install the actual `npm pack` tarball with no global Bun; test a local npm
   prefix and npx cache, normal install and `--ignore-scripts`. Strict OpenTUI
   must load the native renderer and parser worker with real highlighted output.
5. Test `--omit=optional`, removed/non-executable runtime, missing grammar/native
   files, read-only installation, and a working directory with a decoy Bun.
   Verify fallback and strict failure separately.
6. Exercise actual npm registry/config subprocesses under original Node, managed
   update staging and the 44 relaunch chain, IPC update-on-exit, SIGINT/SIGTERM,
   and shutdown without leaked children. Synthetic fixtures must be labeled.
7. Verify headless/protocol/help/version remain on Node and keep output framing.
   Node 26.4+, screen reader, standalone, Windows, and musl exclusions have
   explicit regression coverage and honest platform execution limits.
8. Preserve npm publication executable bits and record tarball hash, unpacked
   size, installed optional-runtime size, Node/Bun versions, and exact commit.
9. Validate the consolidated interpreter sites with a distinct private path,
   paired Mem0 identity rejection, literal payload arguments and protected-root
   overlap refusal. Real Linux cgroup membership/reaping and bwrap/landlock
   execution remain separate gates; mock assertions cannot close them.

No result is marked passed before execution. Platform content checks do not
substitute for native platform tests, and this delivery does not close the
overall runtime-migration or Ink parity umbrella.
