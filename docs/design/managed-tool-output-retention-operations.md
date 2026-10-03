# O4 tool output retention: deployment gates and operations

[简体中文](./managed-tool-output-retention-operations.zh-CN.md) · [Lifecycle design](./managed-tool-output-retention.md)

## Deployment decision

Physical collection remains disabled. O2/O3, O4-1 and the restored O4-2 are merged into main. Retention uses V30, recovery V31, close V32, AgentDefinition V33 and collection V34; recheck both SQL and Java migration directories against latest main before landing. Provisional close or collection database histories need explicit reconciliation or recreation; no automatic Flyway repair is performed. Upgrade **every Java publication writer** before enabling collection: an older instance can perform a PUT without the attempt ledger, invalidating the write-closure evidence.

The default is `QWEN_MANAGED_AGENT_TOOL_PUBLICATION_GC_ENABLED=false`; the deletion grace is `QWEN_MANAGED_AGENT_TOOL_PUBLICATION_DELETION_GRACE=24h`. Observation runs while physical collection is disabled. Close, archive, ACK, event expiry and Runtime reclamation do not retire the Session retention root. Successful Session deletion establishes the irreversible retirement time; changing the grace does not reset that time. Keep the 24-hour deployment policy. A zero grace is used only in fresh isolated tests.

Workspace-bound Session DELETE still returns `workspace_unavailable` on the current baseline; the merged close/drain route does not retire output. The atomic public-deletion test therefore uses a legacy public Session fixture linked to a private output owner. O4 supplies the protected completion barrier; it does not enable the unfinished Workspace deletion path. The full Hosted gate must first establish that its actual deletion route reaches this same completion barrier.

Enable physical collection only after the real database, real OSS and full Hosted foreground Shell gates below pass on the intended deployment revision. An unavailable or skipped gate is not a pass. This document does not authorize production enablement.

## Reproducible gate entry points

The SDK Java workflow runs for pull requests targeting main and permits manual branch dispatch. Its Linux MySQL 8.4 job preserves the complete Hosted report before a separate clean O4 filesystem profile and source-derived completeness check. O4 fixture results cannot substitute for a failed or skipped Hosted family, real OSS, or the full foreground Shell acceptance below. No test workflow enables deployment GC.

Use Java 21 and build/install the checkout's Java SDK and Runtime Broker dependencies first, as described in their READMEs. The O4 profiles require real MySQL 8.4 with `performance_schema` enabled and never silently substitute H2. Provide an existing dedicated database URL with a `qwen_o4_` name, for example `jdbc:mysql://127.0.0.1:3306/qwen_o4_gate`. The test user needs CREATE/DROP DATABASE privileges and SELECT access to `performance_schema.data_lock_waits`, `performance_schema.data_locks` and `performance_schema.threads` on the isolated test server. That metadata is used only to observe an actual InnoDB lock wait by writer connection ID, generated schema and tenant table. Each case creates a fresh random `qwen_o4_` database, migrates it, and drops only that generated database; it never cleans the supplied database. The main test data source uses a four-connection pool and closes it before dropping the generated database. After an interrupted runner, inspect generated database names, case directories and owned child PIDs before cleaning up; never remove the supplied database.

Set `QWEN_O4_MYSQL_PASSWORD` through the test environment rather than command arguments. Do not put credentials in the JDBC URL or logs. IPv6 literal hosts and the non-sensitive options allowPublicKeyRetrieval, useSSL, sslMode, characterEncoding, connectTimeout and socketTimeout are supported and preserved for the generated database and child. User/password, plugin, userinfo and other connection options are rejected. Run the full profiles from a clean report directory, without integration-test selectors; the explicit Gate classes stay outside ordinary CI's IT family. A successful Maven command alone is insufficient: the source-derived report check below must also pass, with no skipped/failed case or selector property. The plugin's failIfNoSpecifiedTests cannot cover every empty method selector, so preserve the two-stage entry joined by &&; failure of either stage is a failed gate:

```sh
mvn -f packages/sdk-java/managed-agent-server/pom.xml \
  -P o4-mysql-gates \
  -Dqwen.o4.mysql.url=jdbc:mysql://127.0.0.1:3306/qwen_o4_gate \
  -Dqwen.o4.mysql.user=o4_test clean verify checkstyle:check && \
  node scripts/check-failsafe-reports.js o4-mysql packages/sdk-java/managed-agent-server
```

The MySQL gate executes the retention and collection regression cases on real SQL, proves a writer waits for the retirement lock, kills child JVMs after a physical PUT/DELETE and before SQL acknowledgment, pauses a reader with SIGSTOP past its real two-minute lease, and replays a delayed unknown PUT after a successful retry. Storage for the process faults is a controlled filesystem adapter. SIGSTOP/SIGCONT needs macOS or Linux; Windows does not establish this gate. The child writes only readiness/result markers, not raw output or credentials. A normally returning runner kills owned children before dropping their database. Active child pauses stop after at most five minutes or parent exit, and a required regression proves an unresumed child exits. SIGSTOP prevents that watchdog from running: after cancellation, verify child.pid against the exact child command and case directory, then terminate only that owned process, including a stopped child, before dropping its generated schema. Failed cases retain their temporary directory and surface child.log in assertions. Record the tested revision, fresh case totals and retained failure paths.

The 100 MiB and 1 GiB cases use already-admitted catalog fixtures with 1 MiB objects and inline metadata, under a 256 MiB test JVM heap. The filesystem gate also needs at least 1.1 GiB free under the fork's java.io.tmpdir; a small tmpfs is insufficient. Place it on a larger filesystem when needed. They read back every stored segment, then verify 100-key pagination, exact byte accounting, final inline cleanup, retained outside objects and one-time quota release. They establish collector capacity, not a full O2 Shell execution or a production RSS limit. Controlled claim expiry and SQL exceptions exercise recovery, but do not claim actual database network partition evidence.

The OSS profile repeats the database/process cases and substitutes real OSS for the capacity cases, then checks real deletion, explicit nonexistent-object success, discarded delete responses and an identity denied DeleteObject. It requires a dedicated **private bucket that has never enabled versioning**, with `o4-test` in its name, and creates a fresh `o4-tests/<UUID>/` prefix per storage case. Cleanup deletes only deterministic keys owned by that case. It does not modify bucket IAM or sweep prefixes.

```sh
mvn -f packages/sdk-java/managed-agent-server/pom.xml \
  -P o4-oss-gates \
  -Dqwen.o4.mysql.url=jdbc:mysql://127.0.0.1:3306/qwen_o4_gate \
  -Dqwen.o4.mysql.user=o4_test \
  -Dqwen.o4.oss.region=cn-hangzhou \
  -Dqwen.o4.oss.test-bucket=my-o4-test-bucket clean verify checkstyle:check && \
  node scripts/check-failsafe-reports.js o4-oss packages/sdk-java/managed-agent-server
```

Supply the normal test identity via `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET` and optional `OSS_SESSION_TOKEN`. Supply the negative-test identity via `OSS_DELETE_DENIED_ACCESS_KEY_ID`, `OSS_DELETE_DENIED_ACCESS_KEY_SECRET` and optional `OSS_DELETE_DENIED_SESSION_TOKEN`. The negative identity must permit GetBucketVersioning and GetBucketAcl but deny DeleteObject for the fresh test prefix; missing identities fail the gate. Both identities use the same production factory for regional HTTPS endpoint validation, V4 signing and zero implicit retries. Its nonzero SDK limit only exposes failed GET statuses to a strategy that never permits native replay; bounded explicit GET retries check their original guards before each request. PUT and DELETE remain single SDK attempts. Teardown retries only keys not already acknowledged as deleted; failed PUT keys remain tracked. The OSS fork budget is 5400 seconds, distinct from each 1800-second capacity-method timeout, to leave room for both sizes and inherited process/database cases. Full segment read-back is retained as evidence; these budgets do not guarantee a pass on a slow or throttled link. On a killed fork, cleanup cannot be assumed: inspect its generated schema, child PID and recorded fresh o4-tests/<UUID>/ prefixes, and remove only its exact owned keys. A thrown response-loss fixture follows a real successful OSS deletion; this is not a claim that the network itself dropped that response.

## Full Hosted deployment acceptance

Use separate test tenants, workspaces, Sessions, an isolated bucket and unique object keys. Record server, Harness and Broker revisions, database engine/isolation level, OSS region, workload size and the source of each measurement. Run actual foreground Shell commands producing 100 MiB and 1 GiB across stdout/stderr. Check catalog byte lengths/digests, manifest/pages, the original outcome, its SQL/storage copies, recovery and public range downloads before deleting the Session.

For close/archive, ACK, event expiration and Runtime recycling, prove recovery still reads the same output and the tool side-effect marker remains one. Race Session deletion against writer acquisition, receipt commit, projection/backfill and a throttled download. Each race must produce a valid retained reference or a rejection/wait, with no Artifact resurrection after deletion and existing public 404 behavior. Verify that an expired download returns no more bytes when its process resumes, even if another request has acquired a new lease.

Use a controlled transport/process fault at each PUT boundary. Drop the response, allow a retry to return, then release the original delayed request; the original UNKNOWN/IN_FLIGHT attempt must remain blocking and quota must stay held. Do not infer write closure from elapsed time or a successful HEAD/GET. For deletion, drop a response, kill a worker between pages, disconnect confirmation SQL and race two server instances. Validate repeated exact keys, durable cursor/generation, unchanged side-effect count, and one quota release after every object acknowledgment. Partial, blocked, quarantined, recovery-protected and legacy missing-evidence publications must remain retained. Deployment enablement requires these actual Hosted/OSS observations in addition to the automated catalog fixtures.

## Observation and failure handling

The observer logs a bounded sample of at most 100 RETIRING publications per minute. Its candidate count, blocker histogram and eligible logical used bytes are **sample values**, not a total backlog or physical bucket size. Obtain full stage totals separately:

```sql
SELECT retention_state, COUNT(*) AS publications,
       SUM(capture_used_bytes + producer_used_bytes + admission_used_bytes) AS logical_used_bytes,
       SUM(capture_held_bytes + producer_held_bytes + admission_held_bytes) AS held_bytes
FROM qwen_tool_publication GROUP BY retention_state;

SELECT state, COUNT(*) AS attempts
FROM qwen_output_put_attempt GROUP BY state;

SELECT gc_blocker, COUNT(*) AS publications
FROM qwen_tool_publication
WHERE retention_state IN ('RETIRING', 'DELETING') GROUP BY gc_blocker;
```

`gc_blocker` is populated by enabled collection attempts; NULL during observation does not prove eligibility. Logical used bytes exclude storage amplification from duplicated inline/OSS copies. Validate physical totals from exact catalog keys and corresponding inline columns, never infer them from quota or sweep a bucket prefix.

Expected blockers include grace period, reader activity, unresolved PUT, incomplete operation/object evidence, missing legacy write evidence, quarantine, incomplete admission and recovery protection. Escalate unresolved writes and sustained `collection_retry` separately from an ordinary grace wait. Each tick checks at most 32 due candidates and collects at most one page. A grace wait sets the next attempt to the original retirement timestamp plus the configured grace, avoiding minute-by-minute polling throughout the 24-hour window. Other blockers, a failed delete or SQL confirmation preserve quota and retry after one minute, allowing healthy publications to advance. Each page contains at most 100 keys; claim ownership is renewed between objects, and stale generations cannot confirm. Multi-instance recovery repeats idempotent deletes after claim expiry.

Do not clear UNKNOWN/IN_FLIGHT attempts, set `write_evidence`/`accepted_complete` on old rows, release quota, clear recovery protection, edit the retirement generation or delete tombstones to make a backlog disappear. Older evidence remains protected; expired-publication recovery belongs to #13019. A privileged object-store administrator can break these guarantees by recreating keys outside the managed writer path; such writes are outside the collection contract.

To stop further pages, disable GC on all server instances. A currently executing page can finish its SQL confirmation; configuration disablement does not restore deleted bytes. Keep tombstones and zeroed quota, correct the failure, and resume the same generation/cursor protocol. Collection removes original output payloads, not all historical model messages or public previews.

## Evidence ledger

The repaired stack is validated on macOS 26.6.2 arm64 with Java 21.0.12.1, Maven 3.9.16 and MySQL 8.4.11. Record exact gate totals and the tested revision in the separate PR report; inherited test counts change with the stack, so old counts cannot establish completeness. Ordinary CI remains a separate mandatory test family. Filesystem process and catalog capacity gates are separate from real OSS and full Hosted acceptance. No real OSS environment is configured locally; real OSS and full Hosted foreground Shell gates remain required and production GC remains disabled. Windows, Linux, MariaDB and actual SQL network partitions need their own deployment evidence.
