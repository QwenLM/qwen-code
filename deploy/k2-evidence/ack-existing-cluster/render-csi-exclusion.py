#!/usr/bin/env python3
"""Render the original ACK's isolated-node addon guard without accessing a cluster."""

import argparse
import json
import re
import uuid
from pathlib import Path


CLUSTER = "c679c4016ff0b4872aa43a2b6688343e8"
SYSTEM_NODES = {"cn-beijing.10.135.59.8", "cn-beijing.10.135.59.9"}


def dns_name(value):
    if len(value) > 253 or not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in value.split(".")
    ):
        raise argparse.ArgumentTypeError("A canonical Kubernetes DNS name is required")
    return value


def node_uid(value):
    try:
        if str(uuid.UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("The actual new Node UID is required")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True, type=dns_name)
    parser.add_argument("--node-uid", required=True, type=node_uid)
    parser.add_argument("--policy-name", required=True, type=dns_name)
    parser.add_argument("--binding-name", required=True, type=dns_name)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.node in SYSTEM_NODES:
        parser.error("The original shared system nodes are outside this guard's scope")

    selected = (
        "(has(object.metadata.labels) && 'app' in object.metadata.labels && "
        "object.metadata.labels['app'] in ['csi-plugin', 'csi-plugin-non-ecs']) || "
        "(has(object.metadata.ownerReferences) && object.metadata.ownerReferences.exists(o, "
        "o.kind == 'DaemonSet' && o.name in ['csi-plugin', 'csi-plugin-non-ecs']))"
    )
    required = "object.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution"
    may_target = (
        "has(object.spec.nodeName) && object.spec.nodeName != '' ? "
        f"object.spec.nodeName == '{args.node}' : "
        "(!has(object.spec.affinity) || !has(object.spec.affinity.nodeAffinity) || "
        f"!has({required}) || {required}.nodeSelectorTerms.exists(t, "
        "!has(t.matchFields) || !t.matchFields.exists(m, m.key == 'metadata.name' && "
        f"((m.operator == 'In' && has(m.values) && !('{args.node}' in m.values)) || "
        f"(m.operator == 'NotIn' && has(m.values) && '{args.node}' in m.values)))))"
    )
    annotations = {"qwen-k2/cluster-id": CLUSTER, "qwen-k2/node-uid": args.node_uid}
    policy = {
        "apiVersion": "admissionregistration.k8s.io/v1",
        "kind": "ValidatingAdmissionPolicy",
        "metadata": {"name": args.policy_name, "annotations": annotations},
        "spec": {
            "failurePolicy": "Fail",
            "matchConstraints": {
                "matchPolicy": "Exact",
                "resourceRules": [{"apiGroups": [""], "apiVersions": ["v1"],
                                   "resources": ["pods"], "operations": ["CREATE"],
                                   "scope": "Namespaced"}],
            },
            "matchConditions": [
                {"name": "addon-namespace", "expression": "request.namespace == 'kube-system'"},
                {"name": "selected-addon", "expression": selected},
            ],
            "variables": [{"name": "mayTargetIsolatedNode", "expression": may_target}],
            "validations": [{"expression": "!variables.mayTargetIsolatedNode",
                             "message": "The isolated K2 node excludes the managed CSI addon."}],
        },
    }
    binding = {
        "apiVersion": "admissionregistration.k8s.io/v1",
        "kind": "ValidatingAdmissionPolicyBinding",
        "metadata": {"name": args.binding_name, "annotations": annotations},
        "spec": {"policyName": args.policy_name, "validationActions": ["Deny"]},
    }
    document = {"apiVersion": "v1", "kind": "List", "items": [policy, binding]}
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(document, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


if __name__ == "__main__":
    main()
