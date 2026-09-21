# Internal runtime tool sandbox acceptance

These test scripts exercise the production `loadCliConfig`, authentication, noninteractive model/tool loop, Read/Write/Edit/Shell tools, and background task registry. They inject the trusted host policy through a test launcher. The ordinary public CLI does not accept this internal mode.

## Prerequisites

- Install repository development dependencies and build workspace packages with Node.js 22 or newer.
- Run the candidate on Linux with working unprivileged bubblewrap at `/usr/bin/bwrap`, Node.js at `/usr/bin/node`, and Bash at `/bin/bash`.
- Keep the installation, workspace, runtime state, and HOME directories separate. Tests create their own disposable fixtures under `/tmp`.
- If testing native PTY transport, provide the Linux `@lydell/node-pty` dependency in the test installation's `node_modules`; do not reuse macOS native packages. The separate `scripts/sandbox-prototype` verifier checks both transport implementations.

No model credentials or internet endpoint are needed. The driver serves a deterministic OpenAI-compatible endpoint over loopback and supplies only a synthetic API key. It clears ambient environment variables and creates an isolated HOME/runtime for each case. It does not change kernel configuration, AppArmor, or shared dependencies.

## Before implementation baseline

Run `node scripts/sandbox-runtime/baseline.mjs` on the development host with a global `qwen` installation. It drives the global CLI through a real model/tool turn and confirms the ordinary baseline can write both inside the disposable workspace and to a sibling directory. Evidence goes under `.qwen/e2e-tests/runtime-shell-sandbox` by default; an optional first argument overrides that output directory. Preserve the dated baseline evidence before implementing the feature.

## Build and verify a candidate

1. Run `node scripts/sandbox-runtime/build.mjs /absolute/empty/installation` from the exact source revision under test. The directory must be empty. The builder resolves repository paths from its own location and bundles the actual CLI and core sources into one production headless launcher. The manifest records the Git revision, worktree dirtiness, source inputs, all test scripts, and output hashes.
2. Copy the complete installation to the Linux host if necessary. It must be outside the test workspaces. Link Linux native dependencies into this owned installation when possible. If they must be installed there, use npm with `--no-save --package-lock=false`; changing the manifest-tracked `package.json` invalidates the candidate by design.
3. Keep the exact source checkout available on Linux, then run `node /absolute/installation/verify.mjs /absolute/installation /tmp/runtime-shell-report.json /absolute/source-checkout`. The verifier refuses a different revision, dirty state, or source-input hash before exercising the candidate. Store output on a writable Linux filesystem. Lima may mount the host repository read-only; copy the report back afterward.
4. Retain stdout and the JSON report under `.qwen/e2e-tests`. The driver verifies artifact hashes again after execution, and exits nonzero on any failed check.

The checks cover workspace/network enforcement, host model/session persistence, repository clean filters during prompt startup, sed and unsupported NotebookEdit behavior, read-only/YOLO, two Config instances in the same process, ignored ambient startup effects, explicit unsupported MCP/extensions/LSP/ACP startup rejection, setup failure without replay, and real ShellTool cancellation/timeout/background/promotion/receipt-loss lifecycle. File checks cover Read-based freshness, new-file creation, UTF-8 and UTF-16 encoding/BOM/CRLF preservation, modes, relative and dangling symlinks, direct and symlinked outside-write denial without directory or temporary-file litter, read-only/YOLO, content larger than one MiB, special-file rejection, PDF host-helper exclusion, and setup failure without host fallback. Both Config instances also exercise independent file-write grants. The Git fixture confirms that the filter is exercised by an explicit confined Git tool call while its outside write is denied. Namespace cleanup checks compare `/proc/self/ns/pid` identities and reject the host namespace before enumerating descendants.

Fixtures and their stdout/stderr/session files remain under the unique `/tmp/qwen-runtime-shell-candidate-*` directory named in the report for inspection. Remove only that owned directory and the owned installation when the evidence is archived. The driver confirms all controlled payload namespaces have no remaining descendants. Production source is never edited by these scripts.
