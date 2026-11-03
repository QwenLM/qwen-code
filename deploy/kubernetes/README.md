# Managed Agent on Kubernetes

[English](README.md) | [简体中文](README.zh-CN.md)

This experimental Helm chart installs a signed Managed Agent API, a private
Hosted Harness in the same Pod, and MySQL 8.4 with a persistent volume. One Helm
command installs the stack after you provide images and model configuration.
The default supports text Sessions. Optional settings add trusted single-node
Workspace files and foreground Shell, and a Managed WebShell gateway. K2 CSI
provisioning remains a separate deployment.

## Prerequisites

- Kubernetes 1.28 or newer, Helm 3.18 or newer, kubectl, and a namespace in which
  you may create workloads, Services, ConfigMaps, Secrets and PVCs.
- A default StorageClass supporting ReadWriteOnce, or an explicit
  `mysql.storage.className`. The default database volume requests 10 GiB.
- A container builder and registry reachable from the cluster. Both application
  images must come from the same reviewed source revision and match the nodes'
  CPU architecture. Publicly published Managed Agent images are not assumed.
- An OpenAI-compatible model endpoint, model ID and API key.

The default application Pod requests 500m CPU and 1 GiB memory in total; MySQL requests
another 250m CPU and 512 MiB. Resource requests and limits are configurable in
[values.yaml](chart/values.yaml). The application requires no Kubernetes API
permissions and does not mount a service-account token.

## Build the images

Run from the repository root. Replace the registry and select the platform of
your cluster; the example builds for Linux amd64:

```bash
QWEN_K8S_REV=$(git rev-parse HEAD)
QWEN_K8S_REGISTRY=registry.example.com/team
docker buildx build --platform linux/amd64 --push \
  -f packages/managed-agent-server/Dockerfile \
  -t "$QWEN_K8S_REGISTRY/managed-agent:$QWEN_K8S_REV" .
docker buildx build --platform linux/amd64 --push \
  -f Dockerfile \
  -t "$QWEN_K8S_REGISTRY/qwen-cli:$QWEN_K8S_REV" .
```

Prepare a deployment values file outside the checkout. Use the actual image
references above, preferably immutable registry digests:

```yaml
server:
  image: registry.example.com/team/managed-agent@sha256:<server-digest>
harness:
  image: registry.example.com/team/qwen-cli@sha256:<cli-digest>
model:
  id: <provider-model-id>
  baseUrl: https://provider.example/v1
```

For a private registry, add `imagePullSecrets: [{name: registry-credentials}]`
and create that registry Secret in the deployment namespace before installation.
Use the same source revision for both images on every upgrade.

For LOCAL Workspace tools, build a third image from those exact two images. It
combines the Java JAR/JRE with the CLI image's Node.js, bundled worker and Linux
filesystem tools. Use matching CPU architectures for all three:

```bash
docker buildx build --platform linux/amd64 --push \
  -f deploy/kubernetes/runtime.Dockerfile \
  --build-arg SERVER_IMAGE="$QWEN_K8S_REGISTRY/managed-agent:$QWEN_K8S_REV" \
  --build-arg HARNESS_IMAGE="$QWEN_K8S_REGISTRY/qwen-cli:$QWEN_K8S_REV" \
  -t "$QWEN_K8S_REGISTRY/managed-agent-runtime:$QWEN_K8S_REV" .
```

The runtime image checks `java`, `node`, the bundled CLI entry and native `stat`
during its build. `server.image` selects this combined image when tools are
enabled. The default text-only mode continues to use the smaller Java image.
WebShell uses the matching CLI image, including its built static assets and
`qwen serve --managed-web-config` command.

## Install

Store the model API key in a private file, without shell quotes, and restrict its
permissions to 0600. Then run from the repository root:

```bash
helm upgrade --install managed-agent deploy/kubernetes/chart \
  --namespace qwen-managed-agent --create-namespace \
  --values /private/managed-agent-values.yaml \
  --set-file model.apiKey=/private/model-api-key \
  --wait --timeout 15m
```

The chart creates independent random signing, Session Store, Harness and database
credentials on the first install. Their Secret is retained on uninstall and
reused on subsequent installs and upgrades. Enabling an optional component adds
only its missing keys; disabling it retains every existing key. An upgrade with a missing managed
Secret fails, as does a reinstall with a retained database PVC but no Secret;
restore the original Secret instead of generating new database
passwords or journal keys. On an existing release, `model.apiKey` is ignored:
rotate the Secret's `model-api-key` explicitly and restart the application Pod.

Helm stores managed Secret data in its release metadata. To manage credentials
separately, set `credentials.existingSecret` and omit `model.apiKey`. The Secret
must already exist in the release namespace and contain all of these keys:

| Key                         | Value                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `auth-signing-key`          | At least 32 UTF-8 bytes                                                                                               |
| `session-store-binding-key` | Independent key, at least 32 UTF-8 bytes                                                                              |
| `harness-token`             | Private bearer token shared by Java and Harness                                                                       |
| `capability-digest`         | `sha256:` followed by 64 lowercase hexadecimal digits                                                                 |
| `mysql-password`            | Application database password                                                                                         |
| `mysql-root-password`       | MySQL initialization root password                                                                                    |
| `model-api-key`             | Provider API key                                                                                                      |
| `runtime-broker-token`      | Required with `runtime.enabled`; private Broker bearer token                                                          |
| `runtime-credential-key`    | Required with `runtime.enabled`; base64 encoding of 32 random bytes                                                   |
| `web-token`                 | Required with `web.enabled`; independent browser bearer token of at least 32 bytes, different from `auth-signing-key` |

The Runtime credential key ID is fixed to `kubernetes-v1`; preserve that key for
every retained binding. When connected to the cluster, Helm validates an existing
external Secret's required keys. Offline `helm template` cannot inspect that
Secret; Kubernetes still requires every referenced key before starting a
container. Never replace a missing credential on a retained deployment with a
new random value.
If a retained Runtime PVC exists but its Runtime keys are missing, enabling the
managed Runtime also refuses generation and requires the original Secret.

Changing database Secret values alone does not change MySQL accounts in an
existing volume. Coordinate database password rotation separately. MySQL's
initialization grants the application user its database privileges and SELECT on
`performance_schema.user_variables_by_thread`, required by Flyway's boot probe.

Only the signed public API is exposed on the ClusterIP Service's port 8080.
Harness port 4170 and the Session Store listener on port 8081 bind to loopback.
There is no unauthenticated public bind, LoadBalancer or Ingress. Remote clients
use a separately configured TLS ingress or trusted gateway while retaining API
signatures; tenant and actor headers alone do not authenticate a caller.

## Enable trusted single-node Workspace tools

This option runs the current LOCAL process Runtime on one explicitly trusted
node. The node must provide its real, nonempty `/etc/machine-id`, Linux process
and namespace identity, and persistent storage with reliable directory birth
times. The chart mounts that machine ID read-only into the server. It does not
manufacture host identity, request privileged containers, or delegate cgroups.
Clusters whose policy rejects this hostPath must keep this option disabled.

Add these values, using the combined image above and the exact Kubernetes Node
name from your approved execution host:

```yaml
server:
  image: registry.example.com/team/managed-agent-runtime@sha256:<runtime-digest>
runtime:
  enabled: true
  nodeName: <trusted-node-name>
  storage:
    workspaceSize: 10Gi
    stateSize: 1Gi
    className: <qualified-storage-class>
```

Node affinity pins scheduling to that exact node while allowing the scheduler to
bind WaitForFirstConsumer volumes. The chart retains two PVCs: `/workspaces` for
created Workspaces, and `/runtime-data` for private state and Runtime home. The
legacy cwd remains `/workspace`. The launcher creates owner-private state and
home child directories, restores their 0700 directory and 0600 file permissions,
and refuses symlinks, unsupported entries and different owners. Kubelet uses
`fsGroupChangePolicy: OnRootMismatch` to avoid widening retained records on every
mount. SQL, both PVCs, the credential Secret, node identity and original file
identities form one deployment; copying PVC contents to another host is not
takeover authority.

After installation, send a signed
`POST /api/agent/web-shell/v1/workspaces/create` with
`{"displayName":"Project","idempotencyKey":"<unique-key>"}`. The existing API
creates a directory, verifies and registers its physical storage, and grants
OWNER to the authenticated tenant/actor. Use the returned `workspaceId` in a
Session creation request's `workspace.workspace_id`; do not manually populate
registration or ownership rows. The WebShell option below offers this same flow.

This mode enables files, foreground Shell, durable Session isolation and verified
Workspace recovery with `default` asking approval. Under that policy, Shell commands require an
approval response; child agents and tool publication remain off. Background
Shell, Monitor, command Hooks and arbitrary escaped processes are outside this
mode's acceptance. The tools execute with the server account's filesystem
permissions and can reach paths outside the Workspace; use trusted workloads.
No object-storage account is needed for the foreground Shell receipt path.

Close every tool Session and confirm physical close, sealed journals and clear
storage/Runtime holders before any planned Pod replacement or Helm upgrade.
Keep those checks as an explicit operational gate; the chart does not drain
Sessions automatically. A new Pod has different PID/time namespaces and cannot
adopt the old LOCAL worker merely because its node and PVC are unchanged. After
a clean rollout, create a new Session on the retained Workspace. An unexpected
worker or Pod loss must retain its uncertain effects and admission fences;
neither retries nor removing SQL rows authorizes replay or fabricated cleanup.

## Enable Managed WebShell

The optional gateway serves only the Managed UI and signs its Java requests as
one fixed trusted tenant/actor. It does not create a multi-user authentication
system. Enable it independently, or together with LOCAL tools:

```yaml
web:
  enabled: true
  tenantId: <trusted-tenant-id>
  actorId: <trusted-actor-id>
```

An empty `web.image` reuses `harness.image`. The gateway has its own home and
temporary directory, receives only the browser token and a read-only signing-key
file, and reads no model API key or Runtime/Workspace volume. Its configuration
contains the loopback Java URL, fixed tenant/actor and signing-key file path;
browser-supplied identity headers do not select the caller. Ordinary daemon
Sessions, filesystem, Shell, settings, MCP, ACP and WebSocket routes are closed.

Forward the browser port:

```bash
kubectl -n qwen-managed-agent port-forward service/managed-agent 4171:4171
```

Open [the local WebShell](http://127.0.0.1:4171/) and authenticate with the
Secret's independent `web-token`. Keep the signing key server-side. When LOCAL
tools are enabled, create/select a Workspace and complete approvals through the
Managed UI. For an external TLS ingress, configure the exact browser origin in
`web.allowOrigins`, for example `[https://agent.example.com]`; the chart itself
does not create an ingress.

## Verify a Session

Forward the API in one terminal:

```bash
kubectl -n qwen-managed-agent port-forward service/managed-agent 8080:8080
```

In another terminal, export the signing key to a private temporary file and run
the signed smoke client. With an operator-managed Secret, replace the Secret
name below:

```bash
umask 077
QWEN_K8S_KEY_FILE=$(mktemp)
kubectl -n qwen-managed-agent get secret managed-agent-keys \
  -o jsonpath='{.data.auth-signing-key}' | openssl base64 -d -A > "$QWEN_K8S_KEY_FILE"
node deploy/kubernetes/smoke.mjs --key-file "$QWEN_K8S_KEY_FILE"
```

The smoke requires Node.js 22 or newer. It checks rejection of unsigned requests,
creates a Session, submits a unique text marker, waits for a completed model Turn,
verifies assistant history and closes the Session. Success prints Session and
Turn IDs as JSON. It makes a real provider call using the configured account.
On failure it reports the Session ID and leaves that Session for inspection; it
does not replay an uncertain input. Logs can be read with
`kubectl -n qwen-managed-agent logs deployment/managed-agent -c server` or
`-c harness`. The default timeout is 120 seconds; `--timeout-ms` overrides it.

To check idle persistence, first run the smoke with `--keep-session`. Record its
Session ID, restart the application, then resume the smoke using that ID:

```bash
kubectl -n qwen-managed-agent rollout restart deployment/managed-agent
kubectl -n qwen-managed-agent rollout status deployment/managed-agent --timeout=10m
node deploy/kubernetes/smoke.mjs --key-file "$QWEN_K8S_KEY_FILE" --session-id <session-id>
```

After a restart, a new Turn may wait for the previous 60-second writer lease and
automatic retries before it can run. Increase `--timeout-ms` if the model also
needs a longer response window. This verifies
retained history and a new Turn after an idle restart. It does not verify
arbitrary interrupted-Turn recovery, multi-replica HA or CSI ownership recovery.
After the final smoke, remove the temporary key with `rm "$QWEN_K8S_KEY_FILE"`.

## Upgrade and uninstall

Stop new admissions, settle active work, and back up MySQL plus the complete
credential Secret before changing versions. With LOCAL tools, first close every
tool Session and confirm all physical holders are clear as described above.
Retain the namespace, release name,
MySQL and optional Runtime/Workspace PVCs and credentials. Repeat the installation command with matching
new images and run the Session smoke before restoring traffic. The application
uses one replica and Recreate, so upgrades have downtime. Do not scale it to
multiple replicas.

Do not use `--atomic` or automatically roll back a schema-changing upgrade.
Flyway migrations run before readiness; an older binary is not guaranteed to
accept the new schema. Fix forward, or restore the matching database and
application backup before accepting writes. Current pre-release development
builds may change the canonical V1 baseline in place; those incompatible catalogs
require a fresh database, not an in-place Helm upgrade. Preserve historical data
with its matching application version.

```bash
helm uninstall managed-agent --namespace qwen-managed-agent
```

Uninstall retains the managed Secret, StatefulSet PVC and optional Runtime/Workspace PVCs. Delete none while
history is needed; permanent data removal is a separate explicit operation.
Changing the namespace or release name creates a different deployment.

## Validation boundary

Run `helm lint` with deployment inputs and
`node --test deploy/kubernetes/*.test.mjs` from the repository root.
`HELM_BIN=/absolute/path/to/helm` selects a Helm executable outside PATH.
The tests render the chart and exercise credential reuse with a controlled
Kubernetes API peer, plus the signed smoke protocol with a controlled HTTP peer.
These are not real-cluster acceptance.

Record image builds, installation, real MySQL, provider calls and restart results
for each target cluster. ACK, node failure, CSI, physical retirement and production
acceptance remain separate gates. The optional trusted LOCAL mode is separate
from [K2 resident deployment](../k2-resident/README.md), which requires qualified
CSI identities and does not support Shell. The chart does not enable K2. Design:
[English](../../docs/design/2026-10-24-managed-agent-kubernetes.md) |
[简体中文](../../docs/design/2026-10-24-managed-agent-kubernetes.zh-CN.md);
tools and WebShell:
[English](../../docs/design/2026-10-25-managed-agent-kubernetes-tools.md) |
[简体中文](../../docs/design/2026-10-25-managed-agent-kubernetes-tools.zh-CN.md).
