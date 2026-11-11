# Ephemeral container runners for external PRs

[English](2026-11-07-ephemeral-container-runners.md) | [简体中文](2026-11-07-ephemeral-container-runners.zh-CN.md)

Date: 2026-11-07. Status: runner lifecycle implemented; thirty fixed slots are
deployed on hz4. Direct external-PR routing still needs default-branch
deployment and real CI acceptance.

Ten slots registering and running ten keyless test jobs of a private repository
at the same time on the Hangzhou shared test machine; containers, networks and
registrations were all reclaimed. A subsequent one-slot trial uses a real PAT
and two sequential GitHub Actions jobs to verify registration, container
replacement, workspace separation and absence of the PAT in jobs. A forced
manager exit verified systemd restart and cleanup before replacement. These
trials found and fixed compatibility with gh 2.46 pagination and Docker's quiet
mode overriding formatted slot output. Full PR CI and production isolation
remain unverified, so the shared host is still only a controlled trial host.

Follow-up model access is described in
[the runner and model-proxy combination](2026-11-07-ephemeral-runner-model-proxy.md);
that proposal is neither implemented nor enabled.

## Goals and boundaries

Put the whole GitHub Actions runner into a disposable Docker container. The
container runs one job and is then deleted; the next job gets a new container,
a new runner identity and a new working directory from the same clean image.
Users do not want to maintain a per-command permission allowlist for CI.

The disposable unit is a job, not a workflow, a step or a PR. Multiple jobs
exchange files through GitHub artifacts and never share a writable working
directory.

This design addresses run-environment residue and cross-task file and process
contamination. Plain Docker shares the host kernel and gives no virtual-machine
isolation from malicious code; any secret passed into a job can still be read
by that job. The first phase accepts only Linux CI work without long-lived
secrets: no model gateway is built here, and release, autofix, real-model E2E
and tasks that need a Docker daemon are not migrated.

## Architecture

```text
External-CI dedicated ECS
├── systemd-managed manager (long-running, trusted)
│   ├── requests JIT runner configuration with the host-only PAT
│   ├── starts, monitors and deletes containers and their isolated networks
│   └── keeps management state, exports logs, recovers interrupted tasks
├── slot 1: container A → one job → delete → container C
└── slot 2: container B → one job → delete → container D

Each container
├── one JIT runner that connects to GitHub on its own
├── Node.js 22, Git and the CI dependencies
└── its own HOME, working directory, temporary directory and npm cache
```

The manager keeps a configured number of slots, at most one container per slot.
The Hangzhou trial ran ten slots at once; the hz4 deployment now maintains thirty slots. It takes no webhook, schedules no PR
itself, and introduces neither Kubernetes nor a database. GitHub assigns work by
runner label. Each ECS runs its own manager against its local Docker socket,
with a unique `poolId` and a per-host `slots` count. Hosts share the scheduling
labels; no central manager is needed. Display names use
`ecs-qwen-<poolId>-<slot>-<suffix>` with two-digit slots and an
eight-hex-character suffix, for example `ecs-qwen-hz4-ephemeral-01-1a2b3c4d`.
Replenishment picks a fresh suffix for every registration, so a leftover
registration still owning an earlier name can never reject a replacement with
HTTP 422, while the GitHub runner ID, container and internal UUID are new for
each job. The UUID remains in state and diagnostic filenames. The `ecs-qwen-`
prefix preserves CI worker caps and timeouts; recovery still accepts the
suffixed form, earlier UUID-based runner names, and old `qwen-` identities.

systemd starts the manager at boot when enabled and restarts unexpected exits
after ten seconds (`Restart=always`). An explicit service stop remains stopped.
This supervises process exits; it does not detect a live but stuck manager.

Images are produced by a trusted build and pinned by digest. The manager and the
image may only be deployed from versions maintained under maintainer control,
never updated from a job checkout or from PR artifacts.

Authentication uses a dedicated PAT in the root-only systemd EnvironmentFile,
`/etc/qwen-ephemeral-runner/credentials.env`, as `GH_TOKEN`. A fine-grained token
should select only the target repository and Administration: write, the GitHub
API's required permission. It is not restricted to runner operations alone.
Fine-grained access can be unavailable for outside collaborators or under
organization policy; a broader classic token requires an explicit decision.
The PAT stays on the host, never in the config JSON or a job container. Host
root and Docker administrators remain trusted. Rotate the credential file and
restart the service before expiry; no GitHub App or organization runner
permission is needed for repository-scoped runners.

## Ownership and lifecycle

| Object                                | Owner                   | Lifetime                                             |
| ------------------------------------- | ----------------------- | ---------------------------------------------------- |
| ECS, Docker daemon, manager           | Ops / maintainers       | Long term                                            |
| Host-only runner-management PAT       | Manager                 | Never enters a job container                         |
| Clean image                           | Trusted image build     | Versioned, not writable from a job                   |
| JIT configuration, runner identity    | One container instance  | Used for a single job                                |
| Container writable layer and job data | One container instance  | Deleted on destruction                               |
| Docker bridge network                 | One container instance  | Deleted on destruction                               |
| Diagnostic logs                       | Exported by the manager | Size and retention bounded, unreadable by later jobs |

Normal path: request JIT → create the isolated network and container → runner
comes online → run one job → runner exits → export logs → delete the container
and network → clean up the leftover registration → create the next one.

JIT provides single-job registration semantics under the normal protocol; the
host manager is responsible for actually destroying the container after it
exits. `ttlSeconds` marks the age at which health checks begin, not a hard
lifetime: healthy idle runners remain available and late-assigned jobs are not
interrupted by container age. Every five minutes after that threshold, the
manager checks the recorded GitHub runner ID, name and online status. Missing,
offline, invalid or unavailable registration information raises `WATCHDOG ALERT`
without destroying the container. GitHub workflow job timeouts bound normal
execution (45–90 minutes for the routed jobs).

A `docker wait` transport error also does not prove that the container exited;
the manager checks Docker state and retries the observation. The wait client
has no age timeout and is cancelled when monitoring ends. A runner that is
actually hung and cannot honor cancellation requires operator inspection and
targeted recovery. This is an explicit availability tradeoff: container age or
an offline control-plane record cannot safely identify a finished job, and
malicious jobs are not guaranteed to exit cooperatively. Resource limits remain
in force. Manager restart recovery still reconciles old resources first.
A stop with a drain window configured is automatic: replenishment stops, and a
slot whose container has shown no job worker for two consecutive polls retires
its registration with a DELETE before the container is removed. The accepted
deletion is the point at which GitHub can no longer assign work to that runner,
which is what closes the gap between the last idle probe and `docker rm -f`. A
refused retirement — busy, rate limited, or otherwise unconfirmed — keeps the
container draining and restarts the idle window; only the drain deadline forces
the shutdown. Assigned jobs finish on their own; the deadline, not the idle
test, is what bounds a job that outlives the window. GitHub treats JIT
registration labels as read-only, so removing the scheduling label is not an
available drain mechanism; retiring the registration is.
Record the actual installed commit and manager checksum when deploying.

If deleting a container fails, that slot stops; if GitHub registration cleanup
fails, the failure is recorded and retried instead of endlessly requesting new
identities. Host failures cannot clean up immediately, so recovery must reclaim
before accepting new work.

Retrying is only safe when each attempt can still reach the resource it must
reclaim. Two self-perpetuating stalls were observed on hz4 on 2026-11-08 and are
now closed. First, killing the `docker create` client on its command timeout
does not stop the daemon, so a container could appear after cleanup had already
deleted the slot state; cleanup then refused to touch an unidentifiable
container, and the only code that could delete it sat behind that refusal. Such
resources are now identified by their `qwen.instance` label. A single
unambiguous identity for this pool and slot drives targeted cleanup. With no
slot state and disagreeing labels, every leftover is provably an orphan, so the
whole pile is swept without a GitHub identity and registrations are swept by
the slot's naming scheme — gated on every leftover carrying this slot's
identity prefix and on GitHub reporting each registration offline, which
relies on `poolId` being unique per host. A foreign or missing identity label
still blocks registration sweeping for manual reconciliation. The sweep
deletes registrations before removing the resources so a rejected deletion
stays reachable on the next cycle. Second, a rejected JIT request deleted the local slot state while a leftover
registration kept owning the display name, so every retry was rejected and the
record needed to delete that registration was gone. A definitive rejection now
reconciles the name instead of discarding the state, and a runner deletion
GitHub rejects retains the state for the next attempt.

Because these faults leave the process alive, systemd supervision cannot detect
them. A slot that repeats the same failure for `stallAlertSeconds` (default
1800, thirty minutes) logs a `STALL ALERT` naming the slot, the duration, the
count and the error; the clock resets on any successful cycle or changed error
and each stall episode alerts once. The threshold is wall-clock because failed cycles
retry with jittered exponential backoff (10 s to 60 s, or 30 s to 300 s under
HTTP 403/429), so a retry count no longer maps to a fixed delay. The backoff
sleep is sliced and ends early on shutdown. This is the operator signal for a
slot that is consuming no jobs; alert on it rather than on service state. The
earlier retry-count key `stallAlertRetries` is no longer read; a config that
still carries it falls back to the default.

## Minimal but necessary deployment boundary

- Use an ECS dedicated to external CI; do not share a host with existing runners
  that hold long-lived secrets.
- Mount no host home, workspace, management state, credential directory or
  Docker socket; use neither privileged mode, host PID nor host networking. No
  per-command allowlist is needed inside the container.
- Images declare no persistent VOLUME and the first phase creates no job volume;
  all job writes go to the container writable layer.
- Network policy outside the host and unmodifiable from the container blocks the
  management interface, sensitive intranets, instance credentials and metadata;
  configure only the GitHub, npm and image-service egress actually required.
- Access granted to the old trusted runners must be verified on the GitHub side.
  Neither labels nor PR-modifiable YAML are an authorization boundary; an
  external PR must not route back into a sensitive pool by editing runs-on.
- Do not open fork secrets because a self-hosted runner is enabled, and do not
  introduce a privileged pull_request_target flow that executes PR code.

## Initial routing decision

Keep the existing `ubuntu_runner` output and all of its former semantics.
For untrusted fork PRs, `pr_test_runner` directly selects
`["self-hosted", "ecs-qwen-ephemeral"]` for `test_build` and
`test`. `lint_runner` uses the same destination for `lint_and_static` and
`integration_no_ak`. Trusted and same-repository PR routes stay unchanged.

Real external PR run 42382582937, attempt 2, received empty repository variables
even though the repository settings were populated. Direct routing removes that
dependency. It requires no configuration relay or manual smoke workflow. The
thirty registered runners use the formal labels to validate actual CI. The
manager accepts up to 64 slots per host; keep capacity conservative until
success rate, duration and resource use are stable. Capacity changes are
manual configuration changes, not queue-driven scaling.

Existing global overrides still take precedence where their values are
available. Fork-triggered runs cannot rely on those variables for rollback.
Instead, change the fork selector to hosted, deploy the workflow change and
trigger fresh CI using that revision. Cancel already-selected work as needed;
rerunning a saved old workflow does not update its routing. No job migrates
automatically. Verify the empty-variable fork case, trusted and non-PR routes,
and available global overrides against the actual shell selector.

`classify_pr`, `web_shell_e2e_smoke`, `integration_cli` and the other workflows
keep their current routing. This avoids migrating browser system dependencies
that the new image has not verified, and leaves the routing image relationship
of the existing classifier job and the other workflows unchanged.

Update 2026-11-08: the credential-free Web-shell Visuals capture job
initially moved onto this pool **for untrusted fork PRs only**. At that stage,
same-repo PRs stayed on the hosted lane under the original rule above.
The main CI `Test (ubuntu-latest, Node 22.x)` aggregate gate was tried
here and moved back off (below).
The capture job matches the pool's security
model exactly (untrusted PR code, read-only token, only the event-scoped
`GITHUB_TOKEN`), which supersedes the browser-dependency exclusion above for
this one job: it reuses the image's Node behind the self-hosted preflight,
gates on a lane-calibrated disk floor (8 GiB free and less than 85% used —
the shared 2 GiB default passed a slot with 14.6 GB free on an 89%-used
filesystem and pnpm died on ENOSPC minutes later), renders with pinned
`--workers=2` (an unpinned run sizes Chromium from the host's cores inside
the 4-CPU container and starved the runner process itself), carries a
routed 90-minute pool ceiling against the hosted 45 (two cold installs
measured 22m18s plus a Chromium download past 36m48s), and installs the
DejaVu font baseline plus ffmpeg
best-effort at runtime — apt egress and the Debian archive stay hard
requirements because the earlier `playwright install --with-deps` step needs
the same archive; the best-effort step degrades only its own extra
font/ffmpeg install failure to fallback fonts and .webm-only recordings
instead of failing the preview, with bounded apt calls and a post-install
font check. The first complete pooled render still needs acceptance for
font metrics and end-to-end duration. At that stage, same-repo PRs never left
the hosted lane. Fork-triggered runs receive empty repository variables
(see the fork section above), so the kill-switch cannot reach them; the
real fork-path escape is changing the selector on `main`, not the switch.
The E2E OpenTUI leg deliberately stays hosted: it injects long-lived model
secrets, which this pool's boundary forbids until a separate trusted pool
exists.

Update 2026-11-09: the aggregate gate no longer rides this pool. It is a
required context on `pull_request`, `push` and `merge_group`, and pinning
it to the manually sized pool parked it in an empty-runner queue for 110
minutes (job 128729488158) while sibling jobs were served in ~3 —
`timeout-minutes` does not cover queue time, and the fleet-wide
kill-switch cannot reach fork runs. It now follows the classifier's
`ubuntu_runner` exactly like the sibling aggregates: persistent fleet for
trusted events, hosted for untrusted forks, kill-switch honored through
the classifier on every path.

Update 2026-11-11: GitHub-hosted concurrency became the bottleneck while the
disposable hz4/hz5 pool had available capacity. Web-shell Visuals capture now
uses `ecs-qwen-ephemeral` for every PR, and the credential-free Managed Host
Build uses it for PR events as well. Both jobs execute PR code with a read-only
token and no long-lived secrets. Managed Host push and manual runs remain
GitHub-hosted; the privileged Visuals publisher also remains GitHub-hosted
because it receives OSS credentials and `CI_BOT_PAT`. The Managed Host lane
reuses the image's Node, applies the same 8 GiB / 85% disk gate and gives pool
runs a 90-minute ceiling while retaining the hosted 20-minute ceiling. Where
repository variables are available, `MAINTAINER_ECS_RUNNER_DISABLED=true`
returns these PR jobs to GitHub-hosted runners. Fork runs still cannot observe
that variable, so their escape path remains a workflow selector change on
`main` followed by a fresh event.

The pool label is `ecs-qwen-ephemeral`; the initial deployment registered ten
ARM64 runners, and the 2026-11-08 live query showed 22 online slot
registrations on hz4.
Register only `self-hosted` and this dedicated label, omitting generic Linux and
ARM64 labels so existing broad ARM64 selectors cannot admit unrelated jobs.
Full PR CI on the new image still has to be verified. The recorded
host/network and runner-authorization limitations remain open; changing labels
does not resolve them.

## References

- [GitHub ephemeral runner semantics and cleanup responsibility](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#ephemeral-runners-for-autoscaling)
- [GitHub repository-level JIT API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
- [Docker daemon and kernel security boundary](https://docs.docker.com/engine/security/)

The facts this design relies on were checked against the official documentation
during this discussion; the actual runner version, GitHub account capabilities,
API permissions and ECS network configuration must be confirmed again at
deployment time.
