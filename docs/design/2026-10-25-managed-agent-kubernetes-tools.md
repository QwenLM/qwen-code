# Managed Agent Kubernetes Workspace tools and WebShell

[English](2026-10-25-managed-agent-kubernetes-tools.md) | [简体中文](2026-10-25-managed-agent-kubernetes-tools.zh-CN.md)

## Problem and current state

The [bootstrap chart](2026-10-24-managed-agent-kubernetes.md) deploys text-only
Managed Sessions. Files and Shell need a registered physical Workspace and a
Runtime owner. A browser also needs an authenticated gateway: the Java API uses
signed requests and must not disclose its signing key to browser code.

K2 resident CSI currently refuses Shell. A kind hostpath volume cannot satisfy
its Aliyun CSI disk identity or RWOP contract. This increment instead adds an
explicit, trusted single-node LOCAL Runtime option and a separate WebShell
gateway. It does not alter the K2 admission or recovery contract.

## Proposed changes

Keep the default text-only deployment. An opt-in LOCAL mode requires a fixed
trusted node, a Workspace PVC, and a Runtime state PVC. The server image combines
JRE 21, Node 22, the same revision of the bundled CLI, and Linux filesystem tools.
Mount the selected node's real machine identity read-only. Never manufacture a
machine ID to pass admission. The existing Workspace creation API prepares the
root, registers physical storage, and grants the fixed caller OWNER access.

The legacy cwd `/workspace` uses the first 16 SHA-256 hex characters of its
canonical path as its Workspace ID in both modes, matching Runtime Broker
admission and keeping that identity stable when tools are enabled.

Workspace creation roots, legacy cwd, private Runtime state, and Runtime home
must be separate. Runtime records retain exact owner-private permissions; a
private child directory, rather than a PVC root, holds state. Enable durable
LOCAL Session isolation, verified recovery, files, and foreground Shell with
default approval. Leave publication and child agents disabled. Background Shell,
Monitor, command Hooks, and delegated cgroup support are outside this increment.

Add `qwen serve --managed-web-config <file>` as a dedicated gateway runner.
Configuration contains only `apiUrl`, `tenantId`, `actorId`, and `signingKeyFile`.
The upstream must be a loopback HTTP origin. Read the signing key as exact UTF-8
bytes and require an independent browser bearer token. Reuse the current signing
proxy, static assets, and Host/Origin/authentication middleware. Expose only the
Managed proxy, artifact content, boot data, authentication probe, and static UI;
all ordinary daemon routes, ACP, and WebSocket entry points remain unavailable.
Do not initialize a daemon Runtime or broaden the existing local runner.

The gateway uses the existing Managed-only `ManagedAgentWebShell` UI, without
daemon Workspace/Session contexts. A same-Pod web container receives only its
browser token and signing key. Java remains loopback-reachable from the gateway;
the gateway's ClusterIP Service publishes the browser port. Tenant and actor are
fixed deployment inputs, never supplied by browser headers. This is one trusted
operator identity, not a multi-user identity provider. HTTP port-forward is the
local entry point; TLS ingress needs the existing explicit allowed origin.

## Persistence and lifecycle

SQL, credentials, Workspace data, and private Runtime records persist. LOCAL
workers belong to the original host and PID/time namespaces. A replacement Pod
cannot adopt an old live worker by assuming that a stable node or PVC is enough.
Close every tool Session and confirm physical holders are clear before a planned
rollout. After replacement, create a new Session against the retained Workspace.
Interrupted effects retain their original uncertainty and must not be replayed
or falsely marked closed. This is not HA or cross-Pod live Session recovery.

Generated optional credentials are independent and retained across upgrades.
Enabling an optional component may add its missing keys; it must never rotate
existing database, signing, Store, or Harness keys. External Secrets must supply
every enabled component's required keys. No provider key belongs in browser
configuration, ConfigMaps, command arguments, or logs.

## Affected components

Update the Helm chart, deployment images, bilingual instructions, and smoke
clients under `deploy/kubernetes`. Add the gateway command/runner and focused
CLI tests, and a Managed-only browser boot branch with focused UI tests. Reuse
existing Java Workspace creation and Runtime provisioning APIs without adding a
database schema or public API change.

## Validation and acceptance

1. Build matching Linux arm64 images and install the default chart on isolated
   kind. Verify migration, unsigned rejection, a completed controlled-model
   Turn, history, idle restart, credential-preserving upgrade, and retained
   database/Secret behavior. Record image and cluster revisions.
2. Enable LOCAL mode, create a Workspace through the signed API, verify its
   physical registration and OWNER grant, and have the model write/read/edit a
   file. Check exact PVC bytes independently of model output.
3. Request a foreground Shell test command, observe approval, approve it, and
   verify its result and one execution. Verify denial/cancellation and repeated
   request handling. Without delegated cgroups, background work must not start.
4. Close tool Sessions and verify workers, receipts, journals, and holders;
   replace the Pod and read retained files from a new Session. Faulted workers
   must not trigger replay or fabricated cleanup.
5. Reject missing/equal browser and signing credentials. With a valid browser
   token, reject ordinary daemon file, Workspace/trust, Session/Shell, settings,
   MCP, ACP, and WebSocket routes, including HTML Accept requests. A browser
   must authenticate, create/select a Workspace, change a project file, approve
   a test command, and display the result through Managed APIs only.

Controlled-model kind checks establish local Linux/container behavior. They do
not establish a real provider, ACK/CSI, multi-node isolation, arbitrary in-flight
recovery, or production acceptance. Required CI checks remain separate gates.

## Open questions

No implementation decision requires user input. A qualified CSI execution lane,
live worker recovery across Pod replacement, public images, and multi-user SSO
remain follow-up work.
