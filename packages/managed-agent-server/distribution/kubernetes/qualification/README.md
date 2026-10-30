# Shared Harness qualification

[English](README.md) | [简体中文](README.zh-CN.md)

These tools prepare the existing [pool deployment](../README.md) and test its public behavior. They do not provision cloud resources, apply YAML, issue certificates, run a local Java service or enable HPA. Use a disposable namespace, dedicated tenants and a fresh single-V1 MySQL catalog. Keep automatic scale-in disabled.

## Build matching images

Commit the qualification Dockerfile and select that immutable source revision. From the repository root, first inspect a plan:

```sh
node scripts/build-managed-harness-images.mjs --source-sha YOUR_40_HEX_COMMIT --image-prefix YOUR_REGISTRY/qwen-qualification --output image-plan.json
```

On the authorized remote Docker builder, use the same command with `--execute --push` and a new output path. It archives only that commit, builds the existing Harness and Java images for `linux/amd64`, and derives the Java-plus-worker image from both. It never copies the local working directory or credential files. Publication is explicit and limited to the Harness and worker images; there are no `latest` or release tags. The report records verified published repository digests. A build-only report is not a deployable image digest.

The derived worker image includes Java 21, Node 22, the complete CLI package, bash/git/procps/util-linux, and three separate UID-10001-owned paths: `/data/runtime`, `/data/default-workspace`, `/data/workspaces`. Supply private persistent mounts, a real unique machine identity at `/etc/machine-id` and valid Linux `/proc` identities. Missing native Workspace identity, lifecycle or cgroup evidence must fail normally; do not disable verified recovery or add privileged host mounts. This image alone does not qualify Pod replacement of the Java/Broker/worker host.

## Configure and render

Adapt [server.example.yaml](server.example.yaml) on the existing Java host and [server-envoy.yaml](server-envoy.yaml) in its HTTPS sidecar. The proxy must remain colocated with Java: Store traffic reaches its loopback internal connector on 4183, Broker traffic reaches 4182. Supply actual server TLS certificates, CA trust, tokens and a private network policy; this template exposes only the Store, Broker and publication route prefixes and rejects `Origin`. Validate Envoy with the selected immutable image before deployment. The additional Tomcat connector itself is plaintext.

Foreground Shell across separate Harness and worker Pods requires the existing Tool v3 publication path. The example enables it with explicit qualification capacity/deadline limits and a real private, never-versioned OSS bucket; provide its regional HTTPS endpoint, region and bucket variables, plus temporary `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET` and `OSS_SESSION_TOKEN` to Java only. The local-process provisioner removes `OSS_` credentials from worker environments. Configure the worker's normal Node CA trust for the private publication gateway and allow the actual Java-to-OSS/DNS and worker-to-gateway network destinations. The proxy forwards the publication prefix to the internal connector. These limits are test inputs, not production sizing. The legacy capture path advertises a Harness loopback callback and cannot reach a worker in another Pod; do not qualify shared Shell with publication disabled or expose that loopback publisher. Background Shell/Monitor/Hook resources remain outside this foreground qualification.

Configure the existing Java discovery service account and mTLS client stores, actual Harness Service UID, signed public authentication and a fresh database. The Harness certificate issuer must cover every actual Pod IP SAN, including replacements; a Service DNS certificate is insufficient. Preserve the existing application-level Store/Broker credentials and do not expose those internal routes publicly. Prepare the two Secrets documented in the parent README through your secret manager.

Copy [render.example.json](render.example.json), replace all placeholders, and save a fresh `kubectl --context YOUR_CONTEXT get nodes -o json` snapshot as its `nodeInventoryFile`. Pick exactly two existing Ready business workers. The renderer rejects system/reserved/tainted nodes and pins scheduling to the exact node names, preventing newly provisioned nodes from satisfying the workload. Check actual free capacity for three Harness-plus-proxy Pods during rollout; the quota is only a ceiling. The namespace must be dedicated to the pool: its quota allows three Pods and forbids PVCs, external load balancers and NodePorts. Run Java, MySQL and gateways outside that pool namespace if they need additional resources, and set `javaNamespace` accordingly.

```sh
node scripts/render-managed-harness-kubernetes.mjs --config render.json --output NEW_REVIEW_DIRECTORY
```

Review `pool.yaml` and `result.json` with the actual cluster identity, trusted image build report, endpoints and capacity. Rendering performs no cluster write. Apply only through the authorized deployment process after all prerequisites are provided. Never add `CriticalAddonsOnly` tolerations or remove system taints to make the test pass.

The bundle includes one cluster-scoped PriorityClass named by `runId`, with priority -1000, `globalDefault: false` and `preemptionPolicy: Never`. Applying it needs the corresponding cluster permission. Pods reference this dedicated class so admission preserves the non-preempting policy. Verify ownership before applying and remove the class after its Pods during cleanup.

Use the tracked read-only preflight after rollout, with the verified `kube-system` UID and both selected node names:

```sh
python3 scripts/harness-kubernetes-preflight.py --context YOUR_CONTEXT --namespace YOUR_NAMESPACE --run-id YOUR_RUN_ID --source-sha YOUR_COMMIT --cluster-uid YOUR_KUBE_SYSTEM_UID --node EXISTING_NODE_1 --node EXISTING_NODE_2 --output preflight.json
```

It checks live node eligibility, rollout and controller identities, actual immutable images, probe commands and Service-owned EndpointSlice targets. It never reads Secrets or executes inside a Pod. A pass is deployment readiness; its `executionAcceptance` stays `NOT_RUN`.

## Exercise the public contract

Install the repository's pinned dependencies. Copy [public.example.json](public.example.json), select two dedicated tenants with two actors each, and provide enabled files/shell agent IDs for both tenants. Use a controlled model endpoint that actually calls the requested tools; the files agent must allow write/read/edit in its own Workspace without approval, while the Shell agent must request permission for foreground commands. Do not use `yolo`. The driver creates four owned Workspaces and exactly eight Sessions, one files lane and one Shell lane per actor. It does not create agent definitions or extra role grants.

Put the signing key in a private file with no group/other permissions, never in command arguments or JSON. For an internal CA use Node's normal `NODE_EXTRA_CA_CERTS` trust configuration; never disable TLS verification. Only HTTPS or an explicit loopback HTTP port-forward origin is accepted. With Node 22+, run:

```sh
node --import tsx scripts/run-managed-harness-qualification.mjs --config private-public.json --output NEW_RESULT.json
```

The driver checks signature/tamper refusal, Workspace and Session ownership, idempotent admission, four actors' physical write/read/edit results and next-Turn history, exact-command Shell Allow/Deny with original revisions and replay receipt, actual SSE disconnect/resume, foreground cancellation and completed close operations. It approves only the exact test command shown in an untruncated input preview. Public file reads witness effects independently of the model transcript. Requests, bodies, streams and waits are bounded. Reports contain resource IDs and stage outcomes, without keys, signatures or raw response bodies. Output paths are exclusive so a previous report is not overwritten.

On failure, keep the original run configuration, IDs and report. Resolve outstanding work with its original operation/idempotency keys and close only task-owned Sessions; do not automatically start a new run to retry unknown effects. Successful runs close all admitted Sessions, but retain the four Workspaces and test files for operator evidence and scoped cleanup. The runner does not delete namespaces or persistent storage.

`PUBLIC_SCENARIOS_PASSED` proves only the public cases on the addressed service. Independently prove both actual Harness Pod/boot placements, SQL writer fencing, resource-idle release receipts and the busy/crash/lost-ACK/unknown-effect matrix. Capacity and HPA qualification remain separate. Synthetic HTTP and kubectl fixtures validate these tools, not a real cluster.
