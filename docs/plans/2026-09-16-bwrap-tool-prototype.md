# bwrap tool-execution prototype

[English](2026-09-16-bwrap-tool-prototype.md) | [简体中文](2026-09-16-bwrap-tool-prototype.zh-CN.md)

## Scope and status

Implement the first feasibility step of the [unified sandbox design](../design/2026-09-16-tool-execution-sandbox.md). This is a developer-operated prototype, not a shipped sandbox or a configuration migration. Production launchers, permissions, and configuration remain unchanged. Results below must distinguish actual Linux observations from unimplemented release requirements.

This document records the completed v7 feasibility stage. The current harness has since moved to the [sandbox execution API](../design/2026-09-16-sandbox-execution-api.md); it now bundles the changed core service, relay and worker directly, and no longer contains the temporary host-shell launcher. The v7 hashes and results below remain historical evidence.

## Implementation

Keep the prototype in `scripts/sandbox-prototype/`. Build an isolated bundle of the existing `ShellExecutionService` for the experiment, without modifying its implementation. A trusted adapter validates fixture roots, constructs bwrap arguments, and quotes them into a fixed `exec` wrapper consumed by the existing service. This temporary adapter tests the service's PTY/pipe lifecycle; production must instead supply executable/argv directly at the final launch boundary, including bootstrap environment and descriptor controls.

Use a read-only root, one admitted workspace, private scratch, minimal devices, private PID namespace, and fresh procfs. Command networking is explicitly open or closed. Reject workspace grants overlapping HOME/ancestors, trusted installation/state, or procfs. The prototype accepts only operator-created fixture roots; Git discovery and configurable extra roots are out of scope.

A separate installed file worker accepts one bounded JSON write request through stdin. Directory creation, temporary write, freshness validation, and atomic rename occur inside bwrap. The parent does not open the destination for writing. Limit the experiment to UTF-8 text and explicit expected previous contents; full encoding, binary, mode, and tool-result compatibility remain future integration work.

Use trusted, disposable host HTTP/state fixtures to demonstrate that host communication and state writes continue while command networking is closed. This is not a full model turn. Verify actual namespace identity, host procfs invisibility, PTY input/resize/Ctrl+C, timeout/cancellation, background promotion, and refusal before payload execution when confinement setup fails. Check the file boundary independently of shell commands.

## Validation and evidence

The executable test plan and raw local reports live in `.qwen/e2e-tests/bwrap-tool-prototype.md`. First record the global CLI baseline. Run the prototype on real Linux, never using a fake bwrap for positive evidence. Add narrowly scoped negative controls demonstrating that the outside-write and network assertions fail without confinement. Verify descendant termination and isolate dependencies from the shared macOS installation.

Build, typecheck, bundle, lint/format the changed scripts, and independently verify the prototype. Record exact environment, commands, checks, limitations, and any feasibility failure here after execution. No runtime sandbox feature is considered delivered by these checks.

### Reproduce

On Linux with Node >= 22, `/usr/bin/bwrap`, `/bin/bash`, and `setsid`, build into a new installation directory outside the writable test workspace:

```sh
node scripts/sandbox-prototype/build.mjs /tmp/qwen-prototype-install
npm install --prefix /tmp/qwen-prototype-install --ignore-scripts --no-audit --no-fund @lydell/node-pty@1.2.0-beta.10
node /tmp/qwen-prototype-install/verify.mjs
```

The build requires the repository's installed development dependencies. Its JavaScript bundle can also be built on macOS and copied to Linux; install the native PTY dependency on Linux only. The verifier creates and removes its own disposable fixture, re-executes with a minimal environment, validates artifact hashes, and prints per-case results plus a JSON report. A missing prerequisite fails rather than skipping green. Installations and the native dependency directory are retained for reproduction; fixture cleanup is tested separately.

## Results

Completed on 2026-09-16 against source revision `04721b5dca49e2a100de4d84257a7fa945a698a3`. The independent final run passed **23/23 checks**: 22 functional/safety cases plus fixture cleanup, with exit code 0 and no skips. Environment: Lima `qwen-sbx`, Linux `7.0.0-31-generic`, ARM64, Node `v22.22.1`, bubblewrap `0.11.1`, and `@lydell/node-pty@1.2.0-beta.10`. No kernel/AppArmor settings were changed.

| Area                        | Observed result                                                                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem and namespaces   | Real private PID namespace and matching fresh procfs; host process root alias unavailable; workspace writes succeed while outside writes fail; read-only and protected-root policies reject writes/grants.                                                           |
| Host separation and network | Host loopback HTTP and state writes continue while tool networking is closed. The same tool request succeeds with open networking. These are host fixtures, not an actual model turn.                                                                                |
| Existing shell lifecycle    | Both pipes and real PTY pass. PTY input/resize, terminal Ctrl+C, cancellation, timeout, background handoff/output/settlement, detached descendants, and parent death were exercised. Missing PTY dependencies fall back to pipes while preserving bwrap confinement. |
| File worker                 | Nested creation, atomic replacement, stale-content rejection, outside/symlink-parent denial, and bounded input pass. An independent check also verifies rejection in a read-only workspace.                                                                          |
| Failure and cleanup         | Missing bwrap and failed mount setup never create the payload marker; a failing payload runs once. Cleanup checks process identity by PID/start time and refuses the host namespace before registering any namespace members.                                        |

Three independent, narrowly scoped mutations proved the assertions detect lost enforcement: removing network isolation changes the request result from exit 17 to exit 0; granting writes only to the disposable outside file changes the denial check from exit 0 to exit 42; removing PID isolation makes the namespace-identity predicate fail. These controls never run the entire suite without confinement.

`npm run build`, `npm run typecheck`, `npm run bundle`, script lint/format, and bilingual documentation checks passed. The independently executed `node dist/cli.js --version` reports `0.23.4`; this is only a bundle smoke check. Code review found and closed a test-harness cleanup risk: host-namespace rejection now precedes PID enumeration, and its negative test restores the cleanup set even when the assertion fails. No remaining blocking review finding was reported.

The final verifier SHA-256 is `d7a0ec63dc4c1c8420bf083905d81da44e8a0352f9735e0c34db92df04738dfa`; the bundled unchanged shell service is `d57553153ea82bf0c404dba1264a34e2e9bcf2929e333b8f52184b3928db5564`. Raw evidence is in `.qwen/e2e-tests/bwrap-tool-prototype-independent-v7.log`, `.qwen/e2e-tests/bwrap-tool-prototype-independent-controls.log`, and the associated test plan. The installation manifest records all bundled input and artifact hashes.

## Implications for production integration

At the end of v7, the following prerequisites remained. Items 1–2 are addressed by the subsequent internal API stage linked above; user-facing integration is still pending.

1. Pass a structured executable/argv/environment launch plan into both actual spawn paths. The prototype's host-shell wrapper is not a production boundary; its minimal driver environment avoids bootstrap injection only within this experiment.
2. Implement a trusted setup-status channel compatible with pipes and PTY. The current service exposes neither an additional control descriptor nor worker stdin transport. Fixture markers prove the tested cases, not a general launch-status protocol.
3. Preserve signal semantics: terminal Ctrl+C was reported as `exitCode: 0` with `signal: 2`. A zero exit code alone is not success. Inner-shell trap exit codes are not guaranteed when the terminal signal terminates the bwrap supervisor.
4. Integrate full file-tool semantics, protected worker packaging, selected-runtime policy propagation, and every required execution entry point before retiring the whole-CLI backend. Concurrent file updates, complete encoding/binary/mode compatibility, Linux x64, other kernel versions, Landlock, and production automatic backend selection remain unverified/unimplemented here.
