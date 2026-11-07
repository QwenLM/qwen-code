# Ephemeral container runners for external PRs

[English](2026-11-07-ephemeral-container-runners.md) | [简体中文](2026-11-07-ephemeral-container-runners.zh-CN.md)

Date: 2026-11-07. Status: implemented; a five-slot systemd trial is deployed on
hz4. Production external-PR routing remains disabled.

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
The Hangzhou trial ran ten slots at once; the hz4 deployment now maintains five slots. It takes no webhook, schedules no PR
itself, and introduces neither Kubernetes nor a database. GitHub assigns work by
runner label. Each ECS runs its own manager against its local Docker socket,
with a unique `poolId` and a per-host `slots` count. Hosts share the scheduling
labels; no central manager is needed. New names use `ecs-qwen-` for compatibility
with CI worker caps and timeouts; recovery still accepts old `qwen-` identities.

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
host manager is responsible for actually destroying the container. The design
must not rely on a malicious job exiting on its own, finishing a final cleanup
step, or keeping the runner intact. A watchdog outside the container enforces a
maximum lifetime, and a manager restart reconciles old resources first.

If deleting a container fails, that slot stops; if GitHub registration cleanup
fails, the failure is recorded and retried instead of endlessly requesting new
identities. Host failures cannot clean up immediately, so recovery must reclaim
before accepting new work.

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

Keep the existing `ubuntu_runner` output and all of its former semantics, and add
a `pr_test_runner` output used by `test_build` and `test`. For an untrusted fork
PR, `EXTERNAL_PR_EPHEMERAL_RUNNER_ENABLED=true` selects the disposable pool;
unset, `false`, or any other value selects `ubuntu-latest`. `lint_runner` follows
the same switch for `lint_and_static` and `integration_no_ak`, replacing the old
shared-ECS fallback for these fork jobs. Trusted and same-repository PR routing
stays unchanged. The global kill-switch and hosted setting take precedence.

The switch selects a destination when a job is evaluated, without querying
runner availability. It cannot move an already queued job; cancel queued work
and start a new workflow run to apply a rollback. Verify unset/false/invalid,
true for both architectures, and the global overrides against the actual shell
selector before rollout.

`classify_pr`, `web_shell_e2e_smoke`, `integration_cli` and the other workflows
keep their current routing. This avoids migrating browser system dependencies
that the new image has not verified, and leaves the routing image relationship
of the existing classifier job and the other workflows unchanged.

The new pool label is `ecs-qwen-ephemeral`. Default routing uses x64; setting
`EXTERNAL_PR_EPHEMERAL_ARCH=arm64` selects ARM64 instead. The toolchain of full
PR CI on the new image still has to be verified.

## References

- [GitHub ephemeral runner semantics and cleanup responsibility](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#ephemeral-runners-for-autoscaling)
- [GitHub repository-level JIT API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
- [Docker daemon and kernel security boundary](https://docs.docker.com/engine/security/)

The facts this design relies on were checked against the official documentation
during this discussion; the actual runner version, GitHub account capabilities,
API permissions and ECS network configuration must be confirmed again at
deployment time.
