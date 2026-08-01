# Autofix targeted E2E verification

## Problem

A failed post-merge `E2E Tests` run on `main` already creates an approved issue that Qwen Autofix can turn into a repair PR. The independent publication gate runs build, typecheck, lint, structural checks, and changed-package unit tests, but it does not deterministically rerun the E2E case that created the issue.

Issue prose cannot safely provide executable verification inputs. The failure issue is editable after creation, and its body intentionally preserves human and agent notes. The existing failure analyzer also merges anonymous job logs, losing the operating system, sandbox mode, and shard that produced each failure.

## Goals

- Preserve authenticated failed-job provenance when the main-CI watcher identifies E2E failures.
- Transport the provenance to Autofix through a trusted channel that is not mutable issue prose.
- Require every supported originally failing E2E case to run and pass on the candidate fix before any branch push or PR creation.
- Keep model credentials and the GitHub bot PAT out of the targeted verification process.
- Fail closed when the failure cannot be reproduced faithfully enough to support automatic publication.

## Non-goals

- Reproducing macOS-only failures on the Ubuntu Autofix runner.
- Verifying tests that require real provider credentials or mutable model behavior.
- Recreating shard-wide load, ordering, or timing conditions.
- Automatically repairing infrastructure, dependency-installation, or runner failures that produced no exact test result.
- Adding `E2E Tests` as a required merge-queue check.

## Trusted metadata producer

`Main CI Failure Issue` remains the authoritative parser because it receives authenticated `workflow_run` metadata, reads the triggering run through the Actions API, and downloads failed job logs with read-only permissions.

The analyzer associates every log with its Actions job name. For `E2E Tests`, each extracted Vitest failure is normalized into a case containing:

```json
{
  "id": "sdk-typescript/tool-control.test.ts > Suite > case",
  "file": "sdk-typescript/tool-control.test.ts",
  "name": "Suite > case",
  "job": "E2E Test (Linux) - sandbox:none - shard 1/3",
  "os": "linux",
  "sandbox": "none",
  "shard": "1/3"
}
```

The metadata document also binds the repository, issue number, source workflow, source run ID, source run attempt, URL, failed `main` SHA, event, and completeness status. Failed jobs are fetched from the attempt-specific Actions API so a rerun cannot be analyzed with jobs from another attempt. Unknown job names, missing test names, excessive failure sets, unsupported platforms, and missing logs remain represented as an ineligible analysis rather than being silently dropped. The watcher may still create or update a bug issue for human diagnosis, but it does not upload executable metadata, add Autofix approval or routing labels, or assign the Autofix bot unless the analysis is both eligible and complete.

## Artifact transport and routing

Every completed `workflow_run` remains independently processable; neither the workflow nor its jobs use Actions concurrency groups that could replace a pending failure. First-occurrence deduplication remains marker-based, but only issues authored by the configured Autofix bot may be reused; a user-created issue containing a publicly computable marker cannot be promoted into trusted agent input. A recurrence may update the issue body, but re-reads live ownership and cancellation state before routing and never restores ready/approved labels or bot assignment after a maintainer has opted out, requested information/retesting, linked another PR, or changed ownership. Publication remains fail-closed. GitHub does not provide an atomic lock for a previously unseen failure signature, so two simultaneous first occurrences can still create duplicate issues and independent Autofix attempts. A fixed global or issue-scoped concurrency group is not an acceptable workaround because GitHub may replace a pending `workflow_run` and lose one failure event. Preventing both event loss and duplicate publication requires a future external atomic store or a canonical cross-issue claim key; the current design prioritizes retaining every authenticated failure and leaves duplicate reconciliation to maintainers.

For a targeted issue, the writer binds the issue number into the metadata and uploads an immutable artifact named `autofix-e2e-failure-<issue>-<source-run>-<source-attempt>-<producer-run>-<producer-attempt>`. The loader enumerates all live artifacts for the issue, validates every name against authenticated producer and source runs, and selects the newest trusted source recurrence, using producer run, producer attempt, and artifact ID as immutable tie-breakers. A closed bot-authored issue remains the authoritative match for its public failure marker even if another open duplicate exists, so recurrence cannot recreate an automatically approved replacement after a maintainer closes the original issue.

An eligible issue starts or resumes a routing transaction only while it remains open, ready, approved, bot-owned, unclaimed, and unlinked. The writer applies `autofix/routing` before changing an existing issue body, or creates a new issue with the routing lock already present. Autofix excludes that label from forced, scheduled, selected, and claim paths. After the immutable artifact upload, the writer revalidates the live issue state, adds `autofix/e2e-verification-required`, records a bot-authored SHA-256 marker over the exact current title and body, and only then removes `autofix/routing`. A maintainer-applied `autofix/approved` label records the event payload's exact title and body only when the live issue still matches that payload. Scheduled and event-driven Autofix candidates must match a bot-authored approval marker during scanning and again immediately before claim, so editing issue prose consumes the effective approval until a maintainer re-applies the approval label or a later authenticated CI recurrence records its trusted update. Claim records the live prose digest as an immutable job output for every route, including manual dispatch; proof revalidation and every publication-time issue check require the current title and body to retain that digest. Manual dispatch therefore bypasses the approval marker but not the end-to-end prose binding. Any interruption leaves a visible fail-closed lock; a later authenticated recurrence may resume the transaction only while the human-controlled ready, approval, ownership, and cancellation signals still permit it. Cancellation uses structured state—ownership, labels, issue state, and linked PRs—rather than attempting to interpret untrusted natural-language comments. The writer never removes and later restores approval as part of publication.

This ordering prevents the Autofix event from racing ahead of artifact publication. The PAT-bearing job still checks out no repository code; it only writes the issue, writes the already-produced JSON output to a temporary file, invokes the pinned artifact action, and applies labels.

SDK Python and non-test failures retain the existing route and do not receive the targeted-E2E label.

## Autofix metadata loading

The issue-autofix job receives `actions: read` in addition to `contents: read`. After selecting an issue, it checks the selected candidate's labels.

For `autofix/e2e-verification-required` issues it must:

1. Find every live artifact with the exact issue-bound name.
2. Ignore artifacts whose producer is not `.github/workflows/main-ci-failure-issue.yml` with event `workflow_run`.
3. For each trusted producer, download an archive containing exactly one `metadata.json` document.
4. Validate the metadata repository and issue binding.
5. Re-fetch the referenced source Actions run and require:
   - workflow name `E2E Tests`;
   - source run attempt equal to the metadata attempt;
   - event `push`;
   - branch `main`;
   - conclusion `failure`;
   - head SHA equal to the metadata SHA.
6. Select the newest validated source recurrence by run ID and attempt, then use producer run, producer attempt, and artifact ID as deterministic tie-breakers rather than API enumeration order.
7. Write the validated document to `/tmp/autofix/ci-failure.json`.

Missing, expired, malformed, mismatched, or unverifiable metadata stops the issue job. The workflow never reconstructs trusted commands from issue prose.

The agent may read `ci-failure.json` as evidence during diagnosis, but cannot weaken the publication gate because the verifier is staged from the trusted initial checkout.

## Isolated verification and publication

The agent runner never publishes after executing candidate code. Before any agent step, the trusted checkout captures its exact `HEAD^{commit}` as a job output. Candidate packaging uses only that captured OID, never a ref name that candidate code could shadow. It packages the committed candidate as a Git bundle plus the independently captured base OID and candidate OID, requires that base to be an ancestor of the candidate, and uploads that artifact without a bot credential in any later step.

Each fresh deterministic, targeted, and publication job independently requires both the artifact base OID and its own trusted checkout `HEAD^{commit}` to equal the captured base output. The deterministic-verification job then requires the trusted base OID to remain an ancestor of the candidate, checks out the candidate detached, and runs build, typecheck, lint, structural gates, and changed-package tests against that exact base. Its immutable job output records the verified candidate OID.

A second fresh job downloads the original candidate artifact, requires its OID to equal the deterministic job output, loads current issue-bound metadata before starting any candidate lifecycle script, and runs the trusted targeted verifier. It uploads a verified artifact containing only the original bundle, fixed OID, human-authored PR files, and the verifier report.

A third fresh publication job contains the bot PAT. It executes no candidate package script or test code. Before changing issue ownership, the claim operation creates a unique commit whose tree and parent are the independently captured trusted base and whose trusted message binds the workflow run ID and attempt. It atomically creates `refs/heads/autofix/claim-issue-<issue>` at that unique OID with an expected-absent lease. Overlapping scheduled runs cannot both create the ref, and an old run cannot mistake a later delete-and-recreate cycle for its own claim, so only the exact owner may assign the Autofix bot, remove approval, execute candidate code, withdraw ownership, or release the ref. A failure before any issue ownership write removes the ref with its exact-OID lease. Once an ownership write may have partially succeeded, API uncertainty preserves the unique ref for recovery. Every later job receives the claim OID as immutable job output and requires the live ref to remain at that exact value. A missing or mismatched ref fails closed and leaves ownership untouched rather than allowing an older run to withdraw a newer claim.

Immediately before pushing, immediately after pushing, and after PR creation, publication requires the issue to remain open, retain the Autofix claim label, retain the exact claim-time title/body digest, remain free of the maintainer opt-out, need-information, and need-retesting labels, and remain assigned to at least the Autofix bot with no human assignee; an empty assignee list is a cancellation signal. Before PR creation, no linked PR is allowed. After creation, the issue may have no linked PR yet or exactly the current verified PR, but never an unrelated PR; the PR itself must be open, bot-authored, target `main`, have the exact verified head OID, and declare the source issue in `closingIssuesReferences`. It also revalidates the live routing label, reloads trusted metadata and compares its digest with the isolated verifier output, verifies the trusted base/candidate ancestry, and requires the artifact OID to equal the deterministic job output. Before `gh pr create`, publication constructs one final PR body with the workflow-generated proof first: the exact verified candidate OID, deterministic-gate result, approved-prose digest, targeted-metadata digest, and workflow run/attempt link, followed by the optional trusted targeted-verifier report. The coding agent's PR prose and self-reported checks follow in separately labeled sections, with every line rendered as a Markdown blockquote so agent-controlled headings cannot impersonate a sibling trusted-proof section. The body explicitly states that the independent gates are authoritative; proof publication is atomic with PR creation rather than a best-effort follow-up comment. The publication branch is created with an expected-absent lease, so an existing recovery or attacker-created branch cannot be silently fast-forwarded or adopted. It pushes exactly the detached verified OID. If a post-push check fails before a PR can exist, branch deletion uses an OID lease so it succeeds only while the remote still points to that exact verified commit. If PR creation returns an uncertain failure, publication continues only when exactly one open PR on the branch is bot-authored, targets `main`, and already has the verified head OID; otherwise the branch and claim ref are preserved for recovery because the workflow cannot prove whether a PR exists. A created or recovered PR that later loses its issue-state, closing-reference, or head-OID binding is closed, closure is re-read as `CLOSED`, and only then is the branch removed with the same lease. API, parser, linked-PR, or claim-ref uncertainty preserves recoverable state rather than destructively compensating. If PR state or closure cannot be confirmed, the PR, branch, and claim ref are preserved for retry or manual recovery. After all publication bindings succeed, the exact claim ref is released; failure to release it warns without falsely withdrawing ownership from an already-published verified PR.

The verifier accepts only schema-versioned `E2E Tests` metadata with:

- one to five complete cases;
- Linux as the source OS;
- sandbox `none`;
- an exact file in the trusted external-process allowlist (initially only `cli/qwen-serve-client-mcp.test.ts`);
- normalized relative `.test.ts` paths under `integration-tests/`;
- non-empty bounded test names;
- existing test files on the candidate branch.

Unsupported or incomplete metadata fails closed. A removed or renamed failing test also fails; deleting the test is not accepted as a fix. The candidate must descend from the failed source SHA and may not change trusted verification inputs: integration or unit tests, test utilities, setup, fixtures, mocks and snapshots, any committed `node_modules` path, package manifests, package locks or `npm-shrinkwrap.json` files, repository or package-local script directories, package-local build entry points and executable tool configuration, patches, CI files, lint/TypeScript/Vitest/build configuration, the committed settings schema, or the source files and re-export entries that determine that schema. Autofix therefore never loads the candidate-controlled settings-schema module graph during verification; ordinary CI remains the authoritative freshness check for maintainer-authored schema changes. A repair that needs to update those files requires maintainer review rather than automatic publication.

Before running package tests, the deterministic and targeted verifiers use a phased filesystem boundary:

1. Make tracked files and `.git` root-owned and non-writable while leaving source directories sticky-writable for declared build outputs.
2. Make the fixed verification HOME and every privileged path ancestor root-owned and non-writable by the candidate UID before creating root-operated `runs` and `reports` directories beneath it.
3. Run `npm ci --ignore-scripts`, then invoke the protected `patch-package` command explicitly.
4. Recursively find and seal every root and workspace-local `node_modules` tree before candidate build code runs, recording their exact relative paths in a root-owned read-only manifest inside `.git`.
5. Run generate, build, bundle, typecheck, and lint through the trusted credential-free command wrapper. Every command receives a fresh isolated HOME, Qwen/XDG state, npm cache, and temp directory. Signal traps terminate the tracked wrapper child and every process owned by the dedicated verifier UID; normal completion also kills and verifies the absence of all remaining verifier processes, so a daemon or inherited writable file descriptor cannot mutate sealed bytes later.
6. Enumerate ignored and untracked paths outside only the dependency trees named by the protected manifest. A new `node_modules` tree created after sealing is therefore not hidden. Only declared build outputs, exact generated commit/template files, and TypeScript build info are accepted; arbitrary generated source, configuration, undeclared dependency trees, secret files, and every generated symbolic link fail the audit. Candidate commits that add or replace any path with a symbolic link are also rejected, while unchanged baseline fixture links remain allowed.
7. Make the entire checkout read-only and reopen only `.integration-tests` for targeted test runtime state.
8. Run contract, package, or exact targeted tests against the sealed source, dependencies, and build outputs.
9. After the last candidate command, remove `.integration-tests` with the trusted root helper and repeat the ignored/untracked output audit so runtime files, links, sockets, or undeclared dependencies cannot survive as unaudited proof state.

This sequence closes an ignored-state gap that ordinary `git status` cannot detect: candidate lifecycle code could otherwise poison an ignored dependency executable, reporter, generated source, or build output, let a later verification step consume that state, and still publish a clean commit that did not contain the verified bytes. Root ownership of the fixed verification HOME also prevents the candidate UID from replacing privileged child directory entries with attacker-controlled paths or symbolic links. Dependency trees are excluded from the output enumeration only after the stronger recursive ownership and write-protection boundary is applied.

For each case, the verifier:

1. Escapes the full test name into an anchored regular expression.
2. Runs the exact file and test-name pattern in a separate Vitest invocation.
3. Preserves sandbox `none` but does not reuse the old shard, because sharding applies to files and can exclude a single explicit file.
4. Clears provider credentials and uses an isolated `QWEN_HOME`.
5. Runs candidate lifecycle commands as a separate no-sudo user with no supplementary groups, `no_new_privs`, a clean environment, and no write access to tracked files, sealed dependencies, generated build state after finalization, or `.git`.
6. Runs a trusted Vitest coordinator and worker with a fixed trusted config, no candidate-controlled global setup, `no_new_privs`, and no DAC-override capabilities. The allowlisted test imports no candidate package or build output in-process. It invokes `node "$TEST_CLI_PATH"`, where `TEST_CLI_PATH` is a root-owned trusted launcher outside the candidate checkout. The launcher clears supplementary groups and drops to the verifier UID before importing the candidate `dist/cli.js`, so candidate code receives neither the Vitest worker runtime nor its coordinator IPC channel.
7. Gives each case fresh root-owned, verifier-group-writable HOME and runtime directories beneath a root-owned traversal-only `.integration-tests` root, then kills the coordinator process group and every verifier-UID process and removes that runtime directory before sealing the report root-owned and read-only.
8. Validates the sealed report, removes its directory before the next case, and requires exactly one assertion result whose file and reconstructed suite/test name match the requested case and whose status is passed.

A zero process exit without an exact matching assertion is not a pass. No `--passWithNoTests` fallback is allowed.

Each case has a bounded outer timeout and the aggregate case count is capped. Any timeout, unsupported sandbox or environment, missing credential-free behavior, zero/multiple matches, skip/todo status, or test failure blocks publication. Docker-source failures remain ineligible until they can run behind an isolated rootless daemon or VM; exposing the hosted runner's Docker socket would defeat the read-only worktree boundary.

## Security boundaries

- Issue text remains untrusted and is never converted into commands.
- Metadata originates from the authenticated failure watcher and is transported as an Actions artifact.
- The artifact producer with the bot PAT checks out and executes no repository code.
- Artifact download uses the workflow token with `actions: read`, not the bot PAT.
- The deterministic gate, targeted verifier, and publisher run on separate fresh hosted runners.
- Test paths and names are passed as subprocess arguments; no shell interpolation or `eval` is used.
- Targeted install, build, bundle, and test subprocesses use an isolated HOME and a minimal environment that contains neither GitHub nor provider credentials.
- The publisher executes no candidate lifecycle script and pushes only the OID emitted by the deterministic verifier.
- Immediately before push, publication re-reads the live routing label, reloads the newest trusted metadata, and requires its digest to equal the isolated verifier output. Its issue-scoped concurrency also prevents a recurrence writer from overlapping the final revalidation and push.

## Failure semantics

A targeted verification failure uses the existing Autofix failure path: no branch is pushed and no PR is created. After confirming the exact claim ref still belongs to this run, the claim label and bot assignment are withdrawn, the ref is released, and a maintainer must decide whether to reapprove or investigate the unsupported environment. If claim ownership or the GitHub API cannot be confirmed, the issue and ref remain untouched for manual recovery. The verifier writes a concise report into the Autofix workdir so the run artifacts and issue failure comment explain which case was unsupported or failed.

## Scope boundaries

The first implementation supports ordinary post-merge Linux E2E matrix jobs only:

- `sandbox:none`
- exact Vitest failures from the reviewed external-process allowlist
- at most five environment-specific cases
- credential-free deterministic execution

Tests that import candidate packages or build output inside Vitest, macOS-only cases, nightly isolated tests, provider-dependent cases, unidentified failures, and shard-load-dependent flakes intentionally block automatic PR publication. Expanding the allowlist requires an explicit review of the full protected test/helper import closure and confirmation that candidate execution occurs only through the trusted launcher.
