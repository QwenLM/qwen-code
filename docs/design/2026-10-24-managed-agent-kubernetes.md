# Managed Agent Kubernetes bootstrap

[English](2026-10-24-managed-agent-kubernetes.md) | [简体中文](2026-10-24-managed-agent-kubernetes.zh-CN.md)

## Problem and current state

The Java control plane and Qwen CLI have container build definitions, but there
is no complete Kubernetes installation. The reference distribution targets a
single trusted Linux host. The existing K2 resident Workspace configuration
describes registered CSI execution, rather than installing the application.

## Proposed deployment

Add a dependency-free Helm chart under `deploy/kubernetes`. After building and
pushing the Java and CLI images from the same revision, one `helm upgrade
--install` installs the following resources:

| Resource                                   | Responsibility                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Single-replica Deployment                  | Java control plane and Hosted Harness in one Pod                                   |
| ClusterIP Service                          | Signed public Java API on port 8080                                                |
| MySQL 8.4 StatefulSet and headless Service | Application database with a persistent volume                                      |
| ConfigMap                                  | Explicit OpenAI-compatible model settings and MySQL initialization grant           |
| Secret                                     | Stable signing, Session Store, Harness and database credentials, and model API key |

The Harness must bind to loopback and requires bearer authentication even for
health requests. Co-location preserves that existing contract. An isolated Java
internal listener on loopback port 8081 serves the Session Store. Neither private
port is exposed through a Service. The public listener uses signed authentication;
the application and Session Store use different keys. No Kubernetes API access or
service-account token is needed by the application.

The initial deployment supports durable text-only Managed Sessions. Runtime
Broker, Workspace files and Shell remain disabled. This avoids treating a
container-local directory as a registered physical Workspace or assuming that
workers survive Pod replacement. It does not change K2 admission or recovery.

## Configuration and credentials

Require explicit server and Harness image references and an explicit model ID
and base URL. The operator builds both images from the same revision; no
unpublished registry image is assumed. Install the model settings through
`QWEN_HOME/settings.json`; credentials enter the Harness through a Secret-backed
environment variable, rather than command arguments or the ConfigMap.

On initial installation, the chart generates independent random credentials.
Subsequent installations and upgrades reuse the retained Secret through Helm
`lookup`. An upgrade without the managed Secret must fail rather than silently
rotate keys against existing database data. A reinstall with a retained database
PVC but no Secret also refuses. The Secret is retained on uninstall,
as is the StatefulSet volume. An operator may instead provide an existing Secret
with the same keys. Updating an existing model API key is an explicit Secret
rotation followed by a Pod restart; an ordinary Helm upgrade does not rotate it.

The bundled MySQL uses an application user, not root, for Java connections. Its
initialization grant includes SELECT on
`performance_schema.user_variables_by_thread`, which Flyway requires at boot.
Storage size/class, image pull secrets and container resources are deployment
inputs. There is no external-database abstraction, Ingress controller, chart
dependency, automatic Workspace registration or cluster-wide RBAC installation.

## Startup, persistence and upgrades

The application uses one replica and the Recreate strategy. Java startup and
liveness check application liveness; readiness also checks the database. Harness
exec probes run Node fetch against the authenticated loopback health route.
Database readiness checks the application credentials and Flyway grant. A database
outage must remove readiness without making Java liveness fail.

MySQL is the durable authority for Sessions and journals. Harness home, temporary
files and the text-only working directory use writable emptyDir volumes. Application
containers run as non-root with read-only roots and no added capabilities. The
official MySQL entry point retains its own initialization and ownership behavior.

Before upgrading, stop new admissions, settle active work and back up the database
and credentials. Keep the release name, namespace, volume and keys stable. Do not
use automatic Helm rollback across a schema migration. A failed upgrade requires
a forward fix or restoration of the matching database and application backup.
Current pre-release builds may change the canonical V1 baseline in place;
incompatible development catalogs require a fresh database and must remain with
their matching application for historical access.
Idle restart validation is distinct from arbitrary in-flight recovery or HA.

## Affected files

Add the chart, deployment instructions in both languages, render/contract tests
and a signed API smoke client under `deploy/kubernetes`. Link the new entry point
from both reference-deployment documents. Application code, APIs, authentication,
database schema and K2 runtime behavior are unchanged.

## Validation and acceptance

1. Helm lint and rendering must produce valid objects, including custom release
   and namespace values, image pull secrets and storage class configuration.
2. Missing required deployment inputs and an upgrade missing its credentials must
   fail before resource mutation. Existing-Secret installations must not generate
   another Secret. No credential belongs in ConfigMaps or command arguments.
3. Verify distinct signing/store keys, matching Harness token/digest references,
   private listener ownership, non-root application containers, MySQL grant and
   probe semantics from rendered objects.
4. Verify the signed smoke client against real Java/Harness processes and a
   controlled model when available: reject unsigned requests, create a Session,
   complete a text Turn, read history and close. A controlled model is not
   real-provider acceptance.
5. On a disposable real cluster, install, execute the smoke, retain an idle Session,
   recreate the application Pod and verify history plus a new Turn. Verify a Helm
   upgrade preserves credentials and database bytes. Record real-cluster, MySQL,
   image-build and provider evidence independently.

Local rendering does not establish cluster, CSI, ACK, production or fault-matrix
acceptance. Those checks stay pending when the required environment is absent.

## Open questions

No implementation decision is blocked. Published images, an authenticated
WebShell gateway, external database integration and qualified K2 provisioning can
be separate follow-ups once this deployment baseline is exercised on a cluster.
