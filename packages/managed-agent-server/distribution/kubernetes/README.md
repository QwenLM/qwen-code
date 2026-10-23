# Shared Hosted Harness pool

[中文](README.zh-CN.md)

This opt-in package runs the Hosted Harness as a private, horizontally expandable pool. Java retains tenant/actor admission, durable placement and subscriptions. Session RPCs target the selected EndpointSlice Pod address and exact instance/boot; the Service is a discovery anchor. The existing local-process deployment does not enable the pool environment variable or Java pool configuration.

See the [design](../../../../docs/design/2026-10-21-managed-harness-kubernetes.md) for ownership, fencing and the acceptance matrix. These files are deployment templates. No cluster, certificate issuer, metrics adapter or production capacity has been validated by adding them.

## Prerequisites and inputs

- Kubernetes 1.33+ with native sidecars, NetworkPolicy enforcement, an existing Java control plane, durable Session Store and Runtime Broker. Use matching Server/Broker builds and a fresh single-V1 catalog containing the placement columns; earlier development catalogs require a separate fresh database and state directory rather than an upgrade. Harness Pods have no Kubernetes API token or tenant workspace mount.
- Build and publish an immutable Harness image, and pin both container images to verified digests in `harness-pool.yaml`. The example Envoy version is 1.39.4; validate the configuration with the selected image before rollout.
- Fill `settings.example.yaml` with the same capability digest required by Java, an HTTPS Broker URL and the approved model provider. Settings are operator-owned and shared; tenant files must never become operator HOME, settings or working directory.
- Create Secret `qwen-harness-secrets` from files named `harness-token`, `broker-token`, `model-api-key` and `outbound-ca.crt`. The first three contain only their respective credential. The CA file trusts the actual HTTPS Store/Broker/model gateways. The launcher reads files and passes credentials through the child environment; Deployment arguments contain no secrets.
- Create Secret `qwen-harness-tls` with `tls.crt`, `tls.key` and `client-ca.crt`. Envoy verifies the Java client CA and exact URI SAN `spiffe://qwen.internal/managed-agent-server`; change this allowlist to the actual approved identity. Java must present that client identity and trust the Harness server CA.
- **Endpoint TLS identity is a deployment prerequisite:** Java connects to concrete Pod IPs and retains normal HTTPS hostname verification. Every selected Pod IP must appear as an IP SAN in its presented certificate. Supply a per-Pod certificate projection/issuer, or an operator-managed shared certificate covering all actual endpoint IPs and their replacements. A Service DNS certificate alone cannot validate these connections. The Secret mount in the template is an input for that mechanism; it does not issue certificates. Do not deploy with hostname verification disabled.
- Bind `discovery-rbac.yaml` to the actual Java service account/namespace. Discovery reads the named Service and lists EndpointSlices only in the configured namespace, verifying the exact Service UID, named port, Pod UID and readiness. Harness processes have no cluster discovery role.
- The ingress NetworkPolicy assumes Java Pods share the Harness namespace. For a separate Java namespace, add the approved `namespaceSelector` alongside `podSelector` in the same ingress peer. Adapt egress destinations and ports to the actual HTTPS gateways. If a Service maps port `443` to target port `8443`, the CNI may evaluate the backend port; allow that target port only for the approved Store/Broker peers and verify connectivity from an actual Harness Pod. The tested Terway deployment required this explicit backend-port rule.

## Build and configure

Build from a clean source checkout at the repository root. The Dockerfile-specific ignore file excludes local settings, credentials, logs and build outputs:

```sh
docker build -f packages/managed-agent-server/distribution/kubernetes/Dockerfile -t YOUR_REGISTRY/qwen-harness:YOUR_VERSION .
```

Publish the image through the deployment system and replace `qwen-harness:replace-with-built-digest` with its immutable reference. Adapt resource sizes and HTTPS egress destinations to measured workload and actual ports; the supplied CPU/memory requests, limits, heap budget and backlog threshold are starting values for acceptance, not measured production sizing.

Create the Envoy ConfigMap from the reviewed configuration, then apply the filled settings, RBAC and pool manifests in the Harness namespace through your normal deployment workflow:

Each manifest contains one resource. Apply the Deployment in `harness-pool.yaml` together with `harness-service.yaml`, `harness-pdb.yaml` and `harness-network-policy.yaml`. Java discovery requires both `discovery-rbac.yaml` and `discovery-role-binding.yaml`.

```sh
kubectl create configmap qwen-harness-envoy --from-file=envoy.yaml=packages/managed-agent-server/distribution/kubernetes/envoy.yaml --dry-run=client -o yaml
```

The command renders the ConfigMap for review; the templates deliberately contain required image, model and identity inputs. Secrets must come from the operator's secret management system.

Configure the existing Java service with `qwen.managed-agent.harness.enabled=true`, its existing Harness token/capability digest, and these pool properties:

```yaml
qwen:
  managed-agent:
    harness:
      pool:
        enabled: true
        discovery: kubernetes
        namespace: YOUR_HARNESS_NAMESPACE
        service-name: qwen-harness
        service-uid: YOUR_ACTUAL_SERVICE_UID
        port-name: https
        key-store-file: /etc/java-tls/client.p12
        key-store-password-file: /etc/java-tls/client-password
        trust-store-file: /etc/java-tls/trust.p12
        trust-store-password-file: /etc/java-tls/trust-password
```

Use HTTPS Store URLs with the pool writer grant supplied by Java. The pool refuses the plaintext Store opt-in and private CSI roots. Tool Runtime provisioning remains the Broker's responsibility. This image carries the Harness and CA certificates, without user workspaces or local tool installations.

## Lifecycle and operations

The Node process listens only on `127.0.0.1:4170`. Envoy exposes `8443` with mTLS, rejects every `Origin`, allows approved private routes, rewrites upstream Host to `127.0.0.1:4170`, and preserves bearer, protocol/boot, client, operation and SSE headers. It installs no buffering/cache filter and disables upstream retries. Its 60-second stream idle window accommodates the 15-second event keepalive. The existing application enforces its request body limits.

Exec startup/readiness probes authenticate and verify instance/boot and pool capabilities. Readiness requires `ACCEPTING`; liveness uses cheap `/health`, without SQL/model/Runtime dependency checks. Proxy listener readiness is also required. These probes do not prove mTLS interoperability; test Java's direct endpoint handshake separately.

`preStop` invokes the authenticated instance drain through loopback, retaining its operation ID for that boot. The native Envoy sidecar stays alive until the Harness stops. Drain immediately stops fresh Session admission, prompts, autonomous wakes and cold execution recovery. Existing foreground Turns may finish their continuation. The Harness itself quiesces and releases eligible resident owners through the Store, so Java unavailability does not prevent that attempt.

The first graceful boundary is resource-idle Sessions and foreground work that reaches that boundary. Unattempted durable wake backlog stays queued. Hooks, MCP, live publishers/background shells, child/monitor resources, cleanup debt, interrupted work and unknown effects keep the owner attached. Failed initialization remains unresolved until the same Session attaches successfully or the boot expires; a generic writer seal is not release proof. Release drops a live idle activation under the barrier, atomically obtains the Store's receipt for the exact placement/head/proof, then closes streams and local timers. It does not detach, cancel accepted inputs or emit SessionEnd. Only zero owners and zero initialization/mutations/resources/publications produce `DRAINED`.

The drain helper waits at most 90 seconds within the 120-second Pod termination grace period. A timeout, failed Store call or unsupported work does not prove release: Kubernetes eventually takes the crash path, and Java must wait for writer/placement lease fencing before recovering on another boot. SIGTERM, Pod absence, readiness loss and an HTTP release acknowledgement lost in transit are not durable release proof. A live stream reconnects on a new owner with its new event epoch and committed cursor.

Rolling updates use zero unavailable Pods, one surge Pod and a PDB minimum of one. The PDB does not select an idle victim or guarantee graceful release. Arbitrary deletion, eviction and forced termination must pass the design's failure matrix before enabling workloads beyond the first boundary.

## Metrics and optional scale-out

Authenticated `GET /internal/hosted-harness/v1/metrics` reports Hosted-owned attached/active/opening/input/resource/publication/mutation counters plus RSS, heap and event-loop utilization. The endpoint requires the same bearer and exact protocol/boot headers as instance administration; it has no tenant/session labels. Neither ACP gauges nor missing metrics represent empty Hosted capacity. `pendingInputs` includes durable waits and is not itself a runnable-backlog metric.

Apply `hpa.yaml` only after providing an external metrics adapter for `qwen_harness_runnable_backlog{pool=qwen-harness}`, derived from actual Java runnable admission and the Hosted counters. Exclude approval waits, unknown outcomes and work blocked by external quotas; preserve unknown/missing samples as unavailable metrics. The adapter is an operator integration and is not included here. Measure the per-Pod target before using the example value `4`. Remove the declarative Deployment `replicas` field from subsequent rollout manifests when handing replica control to HPA. The HPA expands at most one Pod per minute within 2..10 replicas and sets `scaleDown.selectPolicy: Disabled`. Automatic scale-in remains disabled pending its own resource/failure acceptance; no additional replica controller is introduced.

## Deployment acceptance

Validate the selected Envoy image configuration, Kubernetes server-side schema and secret mounts before rollout. In an isolated acceptance namespace, prove two instance/boot identities, real Java mTLS per endpoint, rejection of wrong CA/SAN/bearer/Origin/boot, Session placement affinity across two Pods and streamed event cursor/epoch continuity. Exercise an idle release, a foreground Turn plus queued wake, lost release ACK/retry, Store/Java outage, unknown tool effects, a busy arbitrary victim and the bounded crash recovery path. Verify local single-process regressions separately. A healthy listener or parsed YAML does not establish these outcomes.

References: [Kubernetes native sidecars](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [Envoy TLS validation](https://www.envoyproxy.io/docs/envoy/v1.39.4/api-v3/extensions/transport_sockets/tls/v3/common.proto), [HPA behavior](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/).

The first pool does not expose MCP management APIs or public child-agent delegation. Existing single-instance deployments retain those capabilities from main. Historical placement-V17 ACK acceptance and later V18 CI results predate the current single-V1 integration; fresh-baseline, Java/MySQL/Hosted and cross-language CI acceptance remain required. Preserve old artifacts and their own state for historical access; do not repair Flyway history to reuse them.
