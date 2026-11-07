# Ephemeral GitHub Actions runners

Each slot registers one just-in-time runner and runs it in a new container.
After at most one job, the manager removes the container and runner registration
before creating the next one. While the manager waits on a container it also
enforces a per-slot deadline and removes a container whose runner does not exit;
a manager crash is covered by reconciling leftover resources on the next start.

Each job has a separate Docker bridge with inter-container communication
disabled. Deleting the network is part of cleanup and a failure blocks slot
replacement. This does not itself prevent access to the host or private
networks: configure and verify the host's external egress controls separately.

Use a dedicated host for untrusted pull requests. Docker shares the host kernel;
jobs must not receive the host Docker socket, host directories, cloud instance
credentials, internal network access, or long-lived secrets. A runner label is a
scheduling selector, not an access-control boundary. Before enabling external
pull requests, verify they cannot select other sensitive runner pools.

## Build the image

The image supports Linux x64 and ARM64. Its Node base is pinned to an OCI index
digest and the runner downloads are checked against pinned SHA-256 digests.
BuildKit supplies `TARGETARCH`; with Docker's legacy builder pass it explicitly:

```sh
docker build --build-arg TARGETARCH=arm64 -t qwen-ephemeral-runner:trial scripts/ci/ephemeral-runner
```

The runner image supports ARM64, but full PR CI on this image has not yet been
verified. The repository also selects ARM64 linters; verify the complete CI
toolchain before routing production work to either architecture.

Hosts with restricted upstream connectivity can set `DEBIAN_MIRROR`,
`PIP_INDEX_URL` or `RUNNER_RELEASE_URL` at build time. The runner archive is
still verified against its pinned digest when served from a mirror.

For a real deployment, publish the image to a registry and configure its
immutable `repository@sha256:...` digest. A local `sha256:...` image ID may be
used for a trial. Runner and base versions need routine security updates.

## Configure the manager

Run one manager on each host, managing only that host's Docker socket. Give each
host a unique `poolId`; matching runner labels let GitHub share work across the
hosts without a central scheduler. `slots` is a per-host limit, not a fleet total.
New runner names start with `ecs-qwen-` so the existing CI worker caps and test
timeouts apply. Restart recovery also accepts the earlier `qwen-` identities.

Install Docker, Node 22, `gh`, and `flock` on the host. The manager uses a
dedicated PAT supplied as `GH_TOKEN`. The account must administer the target
repository. Prefer a fine-grained PAT restricted to that repository with
Administration: write and a short expiry. GitHub currently requires this broader
permission for runner registration; it is not a runner-only credential. Some
organization or outside-collaborator policies prevent fine-grained access. Do
not silently replace it with a classic `repo` token, which can cover other
repositories the account can access.

Store `GH_TOKEN=<PAT>` in `/etc/qwen-ephemeral-runner/credentials.env`, owned by
root with mode `600`, inside the root-only configuration directory. The supplied
systemd unit loads this file; do not put it in shell history, config JSON, job
environments or the repository. Replace it and restart the service to rotate or
renew the token. The service fails startup if `GH_TOKEN` is missing. Docker child
environments are allowlisted, and only the one-time JIT configuration enters a
job container. Host root and Docker administrators are trusted and can access
host credentials; ordinary container isolation does not change that boundary.

Copy `config.example.json` to `/etc/qwen-ephemeral-runner/config.json` and
replace the placeholders: repository, actual runner group ID, unique host/pool
ID, immutable image reference, and matching architecture and labels. Use a
unique test label and a controlled test repository for a trial. The example runs
one slot; increase only after measuring the host. Restrict configuration and
credential directories to the manager account.

The `ttlSeconds` limit starts when the container starts, including idle time.
A job assigned near the deadline can be interrupted. The manager removes and
replaces the container; GitHub remains authoritative for job status. The
manager logs cleanup but does not distinguish expiry from normal completion.
`minDiskBytes` applies to the Docker data filesystem. Configure and verify
disk quotas or a dedicated data volume as appropriate for the host.

## Install and operate

Install `manager.mjs` in `/opt/qwen-ephemeral-runner/`, install the supplied
unit in `/etc/systemd/system/`, and create the configured state/log directories
with permissions restricted to the manager account. From the trusted checkout:

```sh
sudo install -d /opt/qwen-ephemeral-runner
sudo install -d -m 700 /etc/qwen-ephemeral-runner /var/lib/qwen-ephemeral-runner /var/log/qwen-ephemeral-runner
sudo install -m 644 scripts/ci/ephemeral-runner/manager.mjs /opt/qwen-ephemeral-runner/manager.mjs
sudo install -m 644 scripts/ci/ephemeral-runner/qwen-ephemeral-runner.service /etc/systemd/system/qwen-ephemeral-runner.service
```

Finish the configuration and PAT setup above before starting. A Docker-authorized user
has host-level power; the unit is intended for a trusted dedicated host.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now qwen-ephemeral-runner.service
sudo systemctl status qwen-ephemeral-runner.service
sudo journalctl -u qwen-ephemeral-runner.service -f
```

systemd restarts an unexpectedly exited manager after ten seconds, including a
clean exit. An explicit `systemctl stop` leaves it stopped. This is process
supervision, not hang detection; inspect the journal and runner availability if
slots are not replenishing.

Stopping the service stops replenishment, waits up to the configured grace
period, and cleans up its containers. The next start reconciles abandoned
resources first. A cleanup or ambiguous registration error blocks that slot;
inspect its state and GitHub runner list before manual reconciliation. Never
remove unrelated runners or run a global Docker prune.

```sh
sudo systemctl stop qwen-ephemeral-runner.service
```

After validating a single runner and its recovery paths, set the repository
variable `EXTERNAL_PR_EPHEMERAL_RUNNER_ENABLED=true` to route untrusted fork PR
build, test, lint and no-AK integration jobs to this pool. Unset, `false`, or any
other value keeps those jobs on `ubuntu-latest`. Trusted and same-repository PRs
retain their existing routing. The global kill-switch and hosted-fleet override
still win. Leave the switch off until the host and GitHub access policies have
been verified. Changing it affects newly evaluated jobs; cancel queued work and
start a new workflow run when rolling back. It does not detect idle runners or
migrate a queued job automatically.
Set `EXTERNAL_PR_EPHEMERAL_ARCH=arm64` for an ARM64 pool; the default is x64.
