#!/usr/bin/env python3
"""Read-only preflight for an explicitly selected Harness qualification namespace."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubectl", default="kubectl")
    parser.add_argument("--context", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--cluster-uid", required=True)
    parser.add_argument("--node", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_sha):
        parser.error("--source-sha must be an immutable 40-character commit")
    for name, value in [("namespace", args.namespace), ("run-id", args.run_id)]:
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value):
            parser.error(f"--{name} must be a DNS label")

    if len(args.node) != 2 or len(set(args.node)) != 2:
        parser.error("exactly two distinct --node arguments are required")

    report = {
        "context": args.context,
        "namespace": args.namespace,
        "runId": args.run_id,
        "sourceSha": args.source_sha,
        "readOnly": True,
        "checks": [],
        "errors": [],
        "limitations": [
            "This is deployment preflight, not execution or tenant-isolation acceptance.",
            "Source annotations are operator declarations, not image build attestations.",
            "No Secrets, kubeconfig, token values or raw Pod environments are recorded.",
            "No create, apply, exec, delete, rollout or scale operation is performed.",
            "Context name and run label do not independently prove cluster identity; confirm the API-server identity before writes.",
        ],
    }

    def get(resource, *extra):
        command = [args.kubectl, "--context", args.context, "--namespace", args.namespace,
                   "get", resource, *extra, "-o", "json", "--request-timeout=15s"]
        result = subprocess.run(command, text=True, capture_output=True, timeout=25)
        if result.returncode:
            report["errors"].append({"resource": resource, "exitCode": result.returncode,
                                     "stderrSha256": hashlib.sha256(result.stderr.encode()).hexdigest()})
            raise RuntimeError(f"kubectl get {resource} failed (exit {result.returncode})")
        return json.loads(result.stdout)

    def check(name, passed):
        report["checks"].append({"name": name, "passed": bool(passed)})

    try:
        identity = get("namespace", "kube-system")
        check("kube-system UID matches the selected cluster", identity.get("metadata", {}).get("uid") == args.cluster_uid)
        if not report["checks"][-1]["passed"]:
            raise RuntimeError("cluster identity mismatch; remaining reads stopped")
        nodes = get("nodes").get("items", [])
        selected = [n for n in nodes if n.get("metadata", {}).get("name") in args.node]
        def eligible(node):
            labels = node.get("metadata", {}).get("labels", {})
            return (not node.get("metadata", {}).get("deletionTimestamp")
                    and not node.get("spec", {}).get("unschedulable")
                    and labels.get("alibabacloud.com/system-nodepool") != "true"
                    and "node-role.kubernetes.io/control-plane" not in labels
                    and "node-role.kubernetes.io/master" not in labels
                    and not any((t.get("key") == "CriticalAddonsOnly" or t.get("effect") in ["NoSchedule", "NoExecute"]) for t in node.get("spec", {}).get("taints", []))
                    and any(c.get("type") == "Ready" and c.get("status") == "True" for c in node.get("status", {}).get("conditions", []))
                    and not any(c.get("type") in ["MemoryPressure", "DiskPressure", "PIDPressure"] and c.get("status") == "True" for c in node.get("status", {}).get("conditions", [])))
        check("both selected nodes are existing eligible business workers", len(selected) == 2 and all(eligible(n) for n in selected))
        hostnames = [n.get("metadata", {}).get("labels", {}).get("kubernetes.io/hostname") for n in selected]
        check("two distinct hostname topology domains exist", len(hostnames) == 2 and all(hostnames) and len(set(hostnames)) == 2)
        report["selectedNodes"] = [{"name": n["metadata"]["name"], "uid": n["metadata"].get("uid"), "allocatable": n.get("status", {}).get("allocatable", {})} for n in selected]
        if not all(c["passed"] for c in report["checks"]):
            raise RuntimeError("selected business node eligibility failed; remaining reads stopped")
        namespace = get("namespace", args.namespace)
        report["namespaceUid"] = namespace.get("metadata", {}).get("uid")
        labels = namespace.get("metadata", {}).get("labels", {})
        check("namespace explicitly belongs to this qualification run",
              labels.get("qwen.ai/qualification-run") == args.run_id)
        if not report["checks"][-1]["passed"]:
            raise RuntimeError("namespace ownership label does not match; remaining reads stopped")

        priority = get("priorityclass", args.run_id)
        check("dedicated priority cannot preempt or become the cluster default",
              priority.get("metadata", {}).get("name") == args.run_id
              and priority.get("metadata", {}).get("labels", {}).get("qwen.ai/qualification-run") == args.run_id
              and priority.get("value") == -1000 and priority.get("globalDefault", False) is False
              and priority.get("preemptionPolicy") == "Never")

        deployment = get("deployment", "qwen-harness")
        spec = deployment.get("spec", {})
        template = spec.get("template", {})
        pod_spec = template.get("spec", {})
        status = deployment.get("status", {})
        check("two current replicas have completed rollout",
              spec.get("replicas") == 2
              and all(status.get(field) == 2 for field in
                      ["replicas", "updatedReplicas", "readyReplicas", "availableReplicas"]))
        check("Deployment controller has observed the current generation",
              deployment.get("status", {}).get("observedGeneration") == deployment.get("metadata", {}).get("generation")
              and isinstance(deployment.get("metadata", {}).get("generation"), int))
        check("Pod template declares the selected source commit",
              template.get("metadata", {}).get("annotations", {}).get("qwen.ai/source-sha") == args.source_sha)
        check("Harness does not automatically mount service account credentials",
              pod_spec.get("automountServiceAccountToken") is False)
        check("termination grace is bounded and positive",
              0 < pod_spec.get("terminationGracePeriodSeconds", 0) <= 120)
        expected_affinity = {"nodeAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": {"nodeSelectorTerms": [{"matchFields": [{"key": "metadata.name", "operator": "In", "values": [name]}]} for name in sorted(args.node)]}}}
        def restricted_affinity(spec):
            actual = json.loads(json.dumps(spec.get("affinity")))
            try:
                terms = actual["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"]
                terms.sort(key=lambda term: json.dumps(term, sort_keys=True))
            except (TypeError, KeyError, IndexError, AttributeError):
                return False
            return actual == expected_affinity
        def ordinary_tolerations(spec):
            return all(t.get("key") in ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"]
                       and t.get("effect") == "NoExecute" and t.get("operator") == "Exists"
                       and isinstance(t.get("tolerationSeconds"), int) and 0 < t["tolerationSeconds"] <= 300
                       for t in spec.get("tolerations", []))
        check("Pod scheduling is restricted to the two explicit existing nodes", restricted_affinity(pod_spec) and ordinary_tolerations(pod_spec) and pod_spec.get("preemptionPolicy") == "Never" and pod_spec.get("priorityClassName") == args.run_id)
        def isolated(spec):
            return (all(set(v) <= {"name", "emptyDir", "configMap", "secret"} for v in spec.get("volumes", []))
                    and spec.get("automountServiceAccountToken") is False
                    and not any(spec.get(flag) for flag in ["hostNetwork", "hostPID", "hostIPC"]))
        check("Harness has no host or tenant Workspace volume", isolated(pod_spec))
        check("all container images are pinned by digest", all(re.search(r"@sha256:[a-f0-9]{64}$", c.get("image", "")) is not None for c in pod_spec.get("containers", []) + pod_spec.get("initContainers", [])))
        harness = next((c for c in pod_spec.get("containers", []) if c.get("name") == "harness"), {})
        check("Harness image is pinned by digest",
              re.search(r"@sha256:[a-f0-9]{64}$", harness.get("image", "")) is not None)
        ready = harness.get("readinessProbe", {}).get("exec", {}).get("command", [])
        drain = harness.get("lifecycle", {}).get("preStop", {}).get("exec", {}).get("command", [])
        check("readiness invokes the Harness probe through Node", ready == ["node", "/opt/qwen/harness-probe.mjs", "ready"])
        check("preStop invokes the Harness drain through Node", drain == ["node", "/opt/qwen/harness-probe.mjs", "drain"])
        check("mTLS proxy is a native sidecar",
              any(c.get("name") == "mtls" and c.get("restartPolicy") == "Always"
                  for c in pod_spec.get("initContainers", [])))

        deployment_uid = deployment.get("metadata", {}).get("uid")
        revision = deployment.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision")
        replica_sets = get("replicasets", "-l", "app=qwen-harness").get("items", [])
        current = [r for r in replica_sets
                   if revision and r.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision") == revision
                   and deployment_uid and any(o.get("uid") == deployment_uid
                       and o.get("kind") == "Deployment" and o.get("controller") is True
                       for o in r.get("metadata", {}).get("ownerReferences", []))]
        check("one current ReplicaSet is controlled by this Deployment", len(current) == 1)
        replica_set_uid = current[0].get("metadata", {}).get("uid") if len(current) == 1 else None
        report["deploymentUid"] = deployment_uid
        report["replicaSetUid"] = replica_set_uid
        report["deploymentRevision"] = revision

        pods = get("pods", "-l", "app=qwen-harness").get("items", [])
        active = [p for p in pods if not p.get("metadata", {}).get("deletionTimestamp")]
        ready_pods = [p for p in active if p.get("status", {}).get("phase") == "Running"
                      and any(c.get("type") == "Ready" and c.get("status") == "True"
                              for c in p.get("status", {}).get("conditions", []))]
        check("exactly two live ready Pods and no terminating Pods",
              len(pods) == len(ready_pods) == 2)
        check("both ready Pods are controlled by the current ReplicaSet",
              replica_set_uid and len(ready_pods) == 2 and all(
                  any(o.get("uid") == replica_set_uid and o.get("kind") == "ReplicaSet"
                      and o.get("controller") is True
                      for o in p.get("metadata", {}).get("ownerReferences", []))
                  for p in ready_pods))
        check("actual ready Pods declare the selected source and Harness image",
              len(ready_pods) == 2 and all(
                  p.get("metadata", {}).get("annotations", {}).get("qwen.ai/source-sha") == args.source_sha
                  and next((c.get("image") for c in p.get("spec", {}).get("containers", [])
                            if c.get("name") == "harness"), None) == harness.get("image")
                  for p in ready_pods))
        check("the two Pods have distinct scheduled node names",
              len(ready_pods) == 2 and all(p.get("spec", {}).get("nodeName") for p in ready_pods)
              and {p["spec"]["nodeName"] for p in ready_pods} == set(args.node))
        check("actual Pods retain the restricted scheduling and immutable images", len(ready_pods) == 2 and all(p.get("spec", {}).get("priorityClassName") == args.run_id and p.get("spec", {}).get("preemptionPolicy") == "Never" and restricted_affinity(p.get("spec", {})) and ordinary_tolerations(p.get("spec", {})) and isolated(p.get("spec", {})) and {c.get("name"): c.get("image") for c in p.get("spec", {}).get("containers", []) + p.get("spec", {}).get("initContainers", [])} == {c.get("name"): c.get("image") for c in pod_spec.get("containers", []) + pod_spec.get("initContainers", [])} for p in ready_pods))
        report["pods"] = [{"name": p["metadata"]["name"], "uid": p["metadata"]["uid"],
                           "node": p.get("spec", {}).get("nodeName"),
                           "images": [{"name": c.get("name"), "imageID": c.get("imageID"),
                                       "restartCount": c.get("restartCount")}
                                      for c in p.get("status", {}).get("containerStatuses", [])]}
                          for p in ready_pods]

        service = get("service", "qwen-harness")
        service_uid = service["metadata"]["uid"]
        report["serviceUid"] = service_uid
        check("discovery Service creates no external load balancer",
              service.get("spec", {}).get("type", "ClusterIP") == "ClusterIP")
        slices = get("endpointslices", "-l", "kubernetes.io/service-name=qwen-harness").get("items", [])
        owned = [s for s in slices if any(o.get("uid") == service_uid and o.get("kind") == "Service"
                                        for o in s.get("metadata", {}).get("ownerReferences", []))]
        targets = {endpoint.get("targetRef", {}).get("uid") for s in owned
                   for endpoint in s.get("endpoints", [])
                   if endpoint.get("conditions", {}).get("ready") is True
                   and endpoint.get("conditions", {}).get("terminating") is not True}
        check("ready discovery targets match the two actual Pod UIDs",
              len(ready_pods) == 2 and targets == {p["metadata"]["uid"] for p in ready_pods})
        by_uid = {p["metadata"]["uid"]: p for p in ready_pods}
        endpoint_identity_ok = True
        for endpoint_slice in owned:
            valid_port = any(port.get("name") == "https" and port.get("port") == 8443
                             and port.get("protocol", "TCP") == "TCP" for port in endpoint_slice.get("ports", []))
            for endpoint in endpoint_slice.get("endpoints", []):
                if endpoint.get("conditions", {}).get("ready") is not True or endpoint.get("conditions", {}).get("terminating") is True:
                    continue
                target = endpoint.get("targetRef", {})
                pod = by_uid.get(target.get("uid"), {})
                addresses = {v.get("ip") for v in pod.get("status", {}).get("podIPs", [])}
                addresses.add(pod.get("status", {}).get("podIP"))
                endpoint_identity_ok = endpoint_identity_ok and bool(
                    valid_port and endpoint_slice.get("metadata", {}).get("namespace") == args.namespace
                    and target.get("kind") == "Pod" and target.get("namespace") == args.namespace
                    and endpoint.get("addresses") and all(address in addresses and address for address in endpoint["addresses"]))
        check("ready EndpointSlice addresses and HTTPS ports belong to the actual Pods", len(ready_pods) == 2 and endpoint_identity_ok)
        hpas = get("hpa").get("items", [])
        relevant = [h for h in hpas if h.get("spec", {}).get("scaleTargetRef", {}).get("name") == "qwen-harness"]
        check("automatic scale-in remains disabled",
              all(h.get("spec", {}).get("behavior", {}).get("scaleDown", {}).get("selectPolicy") == "Disabled"
                  for h in relevant))
        report["hpaCount"] = len(relevant)
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        report["errors"].append({"kind": type(error).__name__})

    report["preflightPassed"] = not report["errors"] and all(c["passed"] for c in report["checks"])
    report["executionAcceptance"] = "NOT_RUN"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"preflightPassed": report["preflightPassed"], "executionAcceptance": "NOT_RUN",
                      "checks": len(report["checks"]), "report": str(args.output)}))
    return 0 if report["preflightPassed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
