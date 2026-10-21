# CSI SQL-to-worker acceptance

[English](csi-sql-worker-acceptance.md) | [简体中文](csi-sql-worker-acceptance.zh-CN.md)

## Problem and current state

The private READY original-owner CSI contract has SQL admission, authenticated
native readback, finite file tools and retained history. Existing component
tests use captured native prefixes or worker replies. They do not establish
that a grant minted by SQL from live native records reaches the authenticated
worker and continues through retained history on the same original activation.

## Proposed test

Add an explicitly invoked MySQL integration test and a Node producer/worker
fixture. Create a fresh canonical V1/V2 catalog and an original private Session
through the production create and reservation APIs. Run the actual Core managed
authority and HTTP store adapter against the production JDBC store. Use the
actual Broker service, HTTP server and `WorkspaceCsiRuntimeAccess.readNative`.
The worker uses production authentication, native fetch, composer, file tools
and retained-history implementation. SQL grants must originate from dispatch;
the fixture must never insert `native_authorization_json` or manufacture a
positive native journal marker.

Run sequential write, edit and read batches under one writer and activation.
Commit observed history and tool receipts through the authority, consume the
runtime results, and continue to the next input. Check the original preimage,
later retained backups and final working bytes. Exact allocation/start retries
must preserve grant and effects. Wrong credentials, owner/context or an
ungranted execution must refuse before file effects.

## Fixture boundaries

The database, listeners, worker process and working directory are owned by the
test and are removed in `finally`. Placement/protection descriptors are an
explicit fixture, not Kubernetes observations. A test-only HTTP destination
mapping routes the fixed fixture Pod endpoint to the owned loopback worker;
headers, body, lease and incarnation remain unchanged. On every platform a
labelled mount/proc-fd mapping delegates to genuine inodes and file handles,
so the file backend does not depend on the host exposing `/proc/self/fd`,
while mount provenance remains a fixture. No worker result, native readback,
SQL authorization, file tool or history composer is stubbed. This qualifies
the SQL/HTTP/file chain under these boundaries, not a native CSI mount or
Kubernetes deployment.

## Files and scope

Live reproduction found that the HTTP adapter omitted the private file-history
preparation's nested input, declaration and intent references. Collect those
references for schemaVersion 2 / `csi-files-retirement/1`; omit the predecessor
metadata reference, whose original journal transaction already owns it. This
keeps SQL's exact same-transaction candidate check intact. The collector's
commit, resource-read and read-only snapshot consumers share this rule; ordinary
file-history snapshots retain their existing behavior.

The change is limited to this Core collector and regression test, a
managed-agent-server MySQL test, its test resources and these bilingual design
files. The existing `mysql-integration` profile discovers the new IT. Published
V1/V2 and the 32 business tables remain unchanged. There is
no public selector, Hosted private execution, replacement writer, cold
recovery, DRAINING continuation, terminal/finalization, retirement, release,
reuse or deployment feature. A discovered production correctness defect must
be reproduced and fixed separately within the original READY owner boundary.

## Validation and acceptance

Use an isolated MySQL database, built Node modules and freshly compiled Java
classes. Record source, dependency, commit and cleanup bindings. The global
CLI has no operator entry for this internal fixture; use an explicit test-script
fallback. Verify the positive SQL grant/readback/worker/continuation chain and
negative cases, then run build, typecheck, bundle, affected tests and Java
static checks. Read the complete diff in two clean audit passes and obtain an
independent review. Evidence must distinguish H2, actual MySQL, macOS platform
mapping and Linux CI. Maintainer architecture review remains required.

## Open questions

None about scope. Native Linux CSI and deployment qualification remain future
work and must not be inferred from this integration fixture.
