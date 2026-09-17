# Linux bwrap acceptance

This lane tests the public tool-scoped bwrap sandbox through the actual bundled CLI. A single runner executes the public 62-case suite, the supplemental 31-case direct-runtime suite, and the 34-case adapter suite. Any failed, missing, timed-out or incomplete suite fails the run. Landlock is not part of this acceptance.

Use Linux with unprivileged user, mount, PID and network namespaces, `/usr/bin/bwrap`, `/usr/bin/tmux`, `/usr/bin/git`, Bash and coreutils/util-linux. An unusable namespace setup fails explicitly; the tests never silently skip or fall back to host execution. Ubuntu's AppArmor user-namespace admission is an additional prerequisite. The workflow first probes the unmodified runner. If Ubuntu's AppArmor user-namespace restriction prevents admission, its hosted-runner setup loads a temporary profile attached only to `/usr/bin/bwrap`, using `flags=(unconfined)` and `userns,` as documented in the [Ubuntu 24.04 release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890). The setup leaves AppArmor enabled and does not change global sysctls or the product's sandbox policy. Acceptance then runs as the ordinary runner user. These are prepared-runner results, not a guarantee that bwrap works on an unmodified Ubuntu installation. `prepare-runner.sh` refuses non-hosted environments; it is not part of the local acceptance command.

Install Node 22 or newer, repository-lockfile native dependencies, and Bun 1.3.14 (the repository's current TUI CI pin). Install dependencies on the target architecture: macOS assets and Linux x64 native modules cannot validate Linux arm64. The normal bundle step copies the matching OpenTUI native library, parser worker and WASM assets. PTY acceptance requires the real `@lydell/node-pty` transport; OpenTUI acceptance uses strict selection and verifies that `libopentui.so` is loaded.

```sh
QWEN_SKIP_PREPARE=1 npm ci
npm run build
npm run bundle
export QWEN_SANDBOX_TEST_BUN="$(command -v bun)"
node scripts/sandbox-public/run.mjs /tmp/qwen-bwrap-evidence
```

The final argument must be an absolute directory that does not exist. The runner builds disposable supplemental harnesses from the current source and copies the built public CLI into an installation outside every test workspace. Do not rebuild or modify source/dependencies during acceptance. The runner records artifact hashes before and after the tests, environment versions, the lockfile hash and git revision. The public bundle must have been built from the same checkout immediately beforehand.

All model responses come from a deterministic loopback HTTP server using a synthetic `sk-mock` key. Each case has an isolated HOME, settings, workspace and runtime. Child environment variables are enumerated explicitly; no real API key, external model endpoint or GitHub token is needed. Public behavior includes filesystem/network enforcement, operator-only policy precedence, migration/admission failures, file and nested tools, skill rejection, Omni startup-helper suppression and both terminal renderers. Supplemental suites retain lifecycle, pipe/PTY, file-byte/mode/symlink and two-runtime grant checks.

Runner preparation stores its original probe, any applied profile, post-setup probe and AppArmor/kernel diagnostics in the separate `bwrap-preflight/` artifact directory, including when preparation fails before the build. Acceptance reports and logs go into `reports/` and `logs/`. Disposable public/runtime fixtures are retained in `fixtures/`, including stdout/stderr and TUI screen captures; the adapter retains its fixtures on failure. The workflow uploads only these directories, including their synthetic `.qwen` settings, and excludes the candidate installations and dependencies. Remove the exact owned evidence directory after inspection. Every suite is attempted even if an earlier suite fails; setup failures stop before product execution.

For targeted public reproduction, use a prepared installation:

```sh
QWEN_SANDBOX_TEST_BUN="$(command -v bun)" node scripts/sandbox-public/verify.mjs /absolute/installation /tmp/public-report.json '^skill '
```

Zero matching cases fail. The dedicated CI lane always runs all 62 public cases on both `ubuntu-24.04` and `ubuntu-24.04-arm`. Local ARM64 results are not proof of x64 or hosted-runner success; inspect both workflow jobs before claiming that coverage.
