#!/usr/bin/env python3
"""Render narrow worker access guards; do not access or qualify an ACK installation."""

import argparse
import json
import re
import uuid
from pathlib import Path

from worker_pod_contract import worker_guards


def dns_name(value):
    if len(value) > 200 or not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in value.split(".")
    ):
        raise argparse.ArgumentTypeError("A canonical Kubernetes DNS name is required")
    return value


def identity(value):
    try:
        if str(uuid.UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("An actual canonical Kubernetes UID is required")


def principal(value):
    if not re.fullmatch(r"[A-Za-z0-9:._@/-]{1,253}", value):
        raise argparse.ArgumentTypeError("An exact authenticated username is required")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True, type=dns_name)
    parser.add_argument("--node-uid", required=True, type=identity)
    parser.add_argument("--namespace", required=True, type=dns_name)
    parser.add_argument("--namespace-uid", required=True, type=identity)
    parser.add_argument("--coordinator-user", required=True, type=principal)
    parser.add_argument("--scheduler-user", required=True, type=principal)
    parser.add_argument("--name-prefix", required=True, type=dns_name)
    parser.add_argument("--worker-plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.node in {"cn-beijing.10.135.59.8", "cn-beijing.10.135.59.9"}:
        parser.error("The original shared system nodes are outside these guards")
    if not re.fullmatch(r"qwen-k2-[a-z0-9-]{1,55}", args.namespace):
        parser.error("A dedicated qwen-k2- experimental namespace is required")
    account = args.coordinator_user.removeprefix(
        f"system:serviceaccount:{args.namespace}:"
    )
    if account == args.coordinator_user or account in {"default", "qwen-k2-worker"}:
        parser.error("A dedicated coordinator ServiceAccount in this namespace is required")
    try:
        dns_name(account)
        dns_name(args.name_prefix + "-extra-access")
    except argparse.ArgumentTypeError as failure:
        parser.error(str(failure))
    if args.coordinator_user == args.scheduler_user:
        parser.error("Coordinator and scheduler identities must be distinct")

    try:
        planned_guards, planned_name, plan_digest = worker_guards(args)
    except (OSError, ValueError, TypeError) as failure:
        parser.error(str(failure))
    annotations = {
        "qwen-k2/cluster-id": "c679c4016ff0b4872aa43a2b6688343e8",
        "qwen-k2/node-uid": args.node_uid,
        "qwen-k2/namespace-uid": args.namespace_uid,
        "qwen-k2/worker-plan-sha256": plan_digest,
        "qwen-k2/pod-schema-version": "v1.36.2",
    }
    quoted = json.dumps
    guards = planned_guards + [
        (
            "extra-access",
            [(["CONNECT"], ["pods/exec", "pods/attach", "pods/portforward", "pods/proxy"]),
             (["UPDATE"], ["pods/ephemeralcontainers", "pods/resize"]),
             (["CREATE"], ["pods/eviction"])],
            "false",
            "The K2 worker namespace refuses additional process and eviction routes.",
        ),
        (
            "binding",
            [(["CREATE"], ["pods/binding"])],
            f"request.name == {quoted(planned_name)} && "
            f"request.userInfo.username == {quoted(args.scheduler_user)} && "
            f"object.target.kind == 'Node' && object.target.name == {quoted(args.node)}",
            "Only the reviewed scheduler may bind a K2 worker to the isolated node.",
        ),
        (
            "delete",
            [(["DELETE"], ["pods"])],
            f"request.userInfo.username == {quoted(args.coordinator_user)} && "
            f"request.name == {quoted(planned_name)} && oldObject != null && has(request.options) && "
            "has(request.options.preconditions) && has(request.options.preconditions.uid) && "
            "has(request.options.preconditions.resourceVersion) && "
            "request.options.preconditions.uid == oldObject.metadata.uid && "
            "request.options.preconditions.resourceVersion == oldObject.metadata.resourceVersion && "
            "has(request.options.gracePeriodSeconds) && request.options.gracePeriodSeconds == 30 && "
            "has(request.options.propagationPolicy) && request.options.propagationPolicy == 'Background' && "
            "!has(request.options.orphanDependents) && "
            "(!has(request.options.ignoreStoreReadErrorWithClusterBreakingPotential) || "
            "request.options.ignoreStoreReadErrorWithClusterBreakingPotential == false)",
            "K2 deletion requires the coordinator, original UID/RV and normal 30-second grace.",
        ),
    ]
    items = []
    for suffix, rules, expression, message in guards:
        name = args.name_prefix + "-" + suffix
        items.extend([
            {
                "apiVersion": "admissionregistration.k8s.io/v1",
                "kind": "ValidatingAdmissionPolicy",
                "metadata": {"name": name, "annotations": annotations},
                "spec": {
                    "failurePolicy": "Fail",
                    "matchConstraints": {
                        "matchPolicy": "Exact",
                        "resourceRules": [
                            {"apiGroups": [""], "apiVersions": ["v1"],
                             "resources": resources, "operations": operations,
                             "scope": "Namespaced"}
                            for operations, resources in rules
                        ],
                    },
                    "matchConditions": [{
                        "name": "worker-namespace",
                        "expression": f"request.namespace == {quoted(args.namespace)}",
                    }],
                    "validations": [{"expression": "namespaceObject != null && " +
                                     f"namespaceObject.metadata.uid == {quoted(args.namespace_uid)} && " +
                                     "(" + expression + ")", "message": message}],
                },
            },
            {
                "apiVersion": "admissionregistration.k8s.io/v1",
                "kind": "ValidatingAdmissionPolicyBinding",
                "metadata": {"name": name, "annotations": annotations},
                "spec": {"policyName": name, "validationActions": ["Deny"]},
            },
        ])
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump({"apiVersion": "v1", "kind": "List", "items": items}, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
