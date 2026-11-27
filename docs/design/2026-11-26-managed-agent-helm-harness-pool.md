# Managed Agent Helm Harness pool

[English](2026-11-26-managed-agent-helm-harness-pool.md) | [简体中文](2026-11-26-managed-agent-helm-harness-pool.zh-CN.md)

## Current deployment

The [Managed Agent Helm chart](../../deploy/kubernetes/README.md) runs the Java API, one Hosted Harness, and an optional WebShell in one application Pod. The private Session Store and optional embedded Runtime Broker listen on Pod loopback. Java currently addresses one Harness. The server already supports a static pool whose members each have a stable instance ID and a distinct origin.

## Design

Enable the static pool in the application Pod. The existing `harness` member listens on `127.0.0.1:4170`. A second member, `harness-b`, listens on `127.0.0.1:4172`. Each member advertises its own ID and has separate writable home and temporary volumes. Both use the same image, capability digest, bearer token, model settings and optional Broker connection. WebShell listens on port `4171`.

The Deployment template derives the Java pool member list, Harness startup arguments, probes and member volumes from the same fixed list. Spring binds the list from `SPRING_APPLICATION_JSON`. Enable SQL wake dispatch so the Session Store advertises clean suspension placement release. Java routes to the owner recorded in MySQL. A member that acquires a writer receives its own lease, and another member can take over when the store has release or expiry evidence.

## Deployment and upgrade

The two Harness processes share the application Pod's network namespace and use loopback for private traffic. This allows the current Session Store and embedded LOCAL Broker to serve both members. The Pod requests resources for both Harness containers. Kubernetes computes Service readiness for the whole Pod, so an unhealthy member can temporarily remove the API endpoint from the Service. Pod-wide failures still rely on Pod replacement. Independently scheduled Harness Pods require a separate design for address discovery, mTLS, and access to the private Store and Broker.

Follow the chart's existing drain and backup procedure before upgrading. Once the pool assigns a Session, its writer credentials include the member and epoch. To return to a release that uses the unpooled connector, restore a matching pre-upgrade database and application backup together.

## Verification

- Render the default chart and the combined Workspace tools and WebShell configuration. Verify that the Java pool list exactly matches both Harness identities and loopback ports, that probes check the correct members, that private ports are absent from the Service, and that the second Harness can reach the embedded Broker when enabled.
- Exercise the rendered pool settings with a real Managed Agent, two Hosted Harness processes, disposable MySQL and a mock model. Verify both members serve Sessions and a released Session can continue on the other member.
- Deployment acceptance on a target Kubernetes cluster requires an image build, installation, signed smoke and restart check for its enabled features.
