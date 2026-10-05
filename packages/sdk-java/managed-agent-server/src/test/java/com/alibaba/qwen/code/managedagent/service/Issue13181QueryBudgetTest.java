package com.alibaba.qwen.code.managedagent.service;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.ACTIVATION_ID;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.ref;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.resource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter.DataWithMediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Pinned query budgets for GitHub issue #13181: four managed-agent hot paths
 * must not amplify database work. Every assertion is derived from statements
 * recorded through a proxy DataSource over H2 (MySQL mode), exercising the
 * production store/service classes exactly as the runtime wiring does.
 *
 * <ol>
 *   <li>materializeNextBatch rewrites the snapshot only at creation, at
 *       every SNAPSHOT_REFRESH_EVENTS covered events, on a batch carrying a
 *       terminal event, or on a caught-up batch once the previous write is
 *       SNAPSHOT_REFRESH_MILLIS old — not on every batch; a deferred write
 *       converges via the snapshot_stale_since marker.</li>
 *   <li>The SSE fan-out re-checks the workspace read grant once per recheck
 *       window, not per delivered event.</li>
 *   <li>listPublicSessions / listWebShellSessions assemble a page from a
 *       fixed number of grouped batch queries.</li>
 *   <li>Tool-publication authorization reads the activation state from the
 *       journal head when journal-head-authorization is enabled (the flag
 *       ships false), rescanning the journal only for pre-migration heads
 *       (and backfilling them).</li>
 * </ol>
 */
class Issue13181QueryBudgetTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private PublicationJournalFixture journal;
    private ObjectNode binding;
    private ObjectNode checkpoint;

    @Test
    void materializationRewritesTheSnapshotAtCreationAndTerminalEvents() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "mat-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        int events = 80;
        int perBatch = 10;
        for (int index = 0; index < events; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-" + index, "status", "completed"),
                    false, "mat-src-" + index);
        }
        // One text delta gives the assistant item a part, so the parts read
        // returns a row and its per-batch counts are pinned too.
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.output_text.delta", Map.of("text", "part"), false,
                "mat-part");
        // The burst ends with a terminal event, so the batch that covers it
        // rewrites the snapshot even though the snapshot is fresh.
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "turn.completed", Map.of(), true, "mat-terminal");
        // 83 events with the session's own; the last batch covers the tail.
        int batches = 9;
        List<Long> itemRowsRead = new ArrayList<>();
        List<Long> itemReads = new ArrayList<>();
        List<Long> partReads = new ArrayList<>();
        List<Long> snapshotWrites = new ArrayList<>();
        List<Long> totals = new ArrayList<>();
        for (int batch = 0; batch < batches; batch++) {
            fixture.ledger.reset();
            fixture.tx.executeWithoutResult(status -> fixture.store
                    .materializeNextBatch(tenant, sessionId, perBatch));
            itemRowsRead.add(fixture.ledger.rows(
                    "from managed_agent_item where", "order by first_sequence"));
            // The single fragment also counts the per-event attributes read
            // (the trailing " where" keeps managed_agent_item_part out).
            itemReads.add(fixture.ledger.count("from managed_agent_item where"));
            partReads.add(fixture.ledger.count(
                    "from managed_agent_item_part where"));
            snapshotWrites.add(fixture.ledger.count("into managed_agent_snapshot")
                    + fixture.ledger.count("update managed_agent_snapshot set"));
            totals.add(fixture.ledger.total());
        }
        System.out.println("[issue-13181] materializeNextBatch per batch:"
                + " itemRowsRead=" + itemRowsRead
                + " itemReads=" + itemReads
                + " partReads=" + partReads
                + " snapshotRewrites=" + snapshotWrites
                + " totals=" + totals);
        // The first batch inserts the snapshot row; the intermediate batches
        // leave it alone; the batch carrying the terminal event rewrites it.
        assertThat(snapshotWrites)
                .containsExactly(1L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 1L);
        // The whole item table is read exactly once per writing batch, and
        // the per-event attributes read fires once per tool event — one item
        // statement per covered event plus the page read, nothing more. The
        // parts read rides the same discipline.
        assertThat(itemReads)
                .containsExactly(10L, 10L, 10L, 10L, 10L, 10L, 10L, 10L, 2L);
        // The parts read rides the same discipline; the last batch also
        // projects the text delta, which reads the part it continues.
        assertThat(partReads)
                .containsExactly(1L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 2L);
        // Hot path 1 is bounded the same way hot path 3 is: the whole
        // batch's statement count is pinned, so any added per-row read
        // shows here.
        assertThat(totals)
                .containsExactly(35L, 35L, 35L, 35L, 35L, 35L, 35L, 35L, 17L);
        // Batch 1 covers session.created plus nine tool events; the last
        // batch sees all 81 items (80 tool plus the text delta's assistant).
        assertThat(itemRowsRead)
                .containsExactly(9L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 81L);
        // The caught-up snapshot is complete and self-consistent.
        assertThat(fixture.store.findSnapshot(tenant, sessionId)).get()
                .satisfies(snapshot -> {
                    assertThat(snapshot.coveredSequence()).isEqualTo(fixture
                            .store.requireSession(tenant, sessionId)
                            .lastSequence());
                    assertThat(snapshot.items()).hasSize(81);
                });
    }

    @Test
    void trickleTicksDoNotRewriteTheSnapshotPerTick() {
        // A frozen clock: the 5s age floor can never trip mid-loop, so the
        // exact per-tick write counts do not depend on the wall clock.
        Fixture fixture = new Fixture(
                Clock.fixed(Instant.now(), java.time.ZoneOffset.UTC));
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "trickle-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        // The workload the issue calls common: a trickle of events fully
        // drained by every scheduler tick (fewer than a batch per tick), so
        // catch-up alone must not rewrite the snapshot each tick.
        List<Long> snapshotWrites = new ArrayList<>();
        for (int tick = 0; tick < 12; tick++) {
            for (int index = 0; index < 5; index++) {
                fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                        "turn-1", "item.tool_call.updated",
                        Map.of("callId", "call-" + tick + "-" + index,
                                "status", "completed"),
                        false, "trickle-" + tick + "-" + index);
            }
            fixture.ledger.reset();
            fixture.tx.executeWithoutResult(status -> fixture.store
                    .materializeNextBatch(tenant, sessionId, 200));
            snapshotWrites.add(fixture.ledger.count("into managed_agent_snapshot")
                    + fixture.ledger.count("update managed_agent_snapshot set"));
        }
        System.out.println("[issue-13181] trickle snapshotRewrites per tick: "
                + snapshotWrites);
        assertThat(snapshotWrites)
                .containsExactly(1L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 0L,
                        0L);
    }

    @Test
    void deferredSnapshotConvergesOnTheAgedOutReselection() {
        // A frozen clock: the deferral and the reselection both key off the
        // 5s age floor, which the test ages explicitly by SQL.
        Fixture fixture = new Fixture(
                Clock.fixed(Instant.now(), java.time.ZoneOffset.UTC));
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "converge-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        // The first drain creates the snapshot; the second drains below the
        // thresholds and defers the rewrite, leaving the snapshot behind.
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.tool_call.updated",
                Map.of("callId", "call-0", "status", "completed"),
                false, "converge-0");
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.tool_call.updated",
                Map.of("callId", "call-1", "status", "completed"),
                false, "converge-1");
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        long snapshotCovered = fixture.store
                .findSnapshotCoveredSequences(tenant, List.of(sessionId))
                .getOrDefault(sessionId, 0L);
        long lastSequence = fixture.store.requireSession(tenant, sessionId)
                .lastSequence();
        assertThat(snapshotCovered).isLessThan(lastSequence);
        // A caught-up session is not a target while its snapshot is fresh...
        assertThat(fixture.store.findMaterializationTargets(32))
                .doesNotContain(new MaterializationTarget(tenant, sessionId));
        // ...but is re-selected once the deferral MARKER alone ages out —
        // the snapshot row stays fresh, so a regression to probing
        // managed_agent_snapshot per row would not select it here.
        fixture.jdbc.update("UPDATE managed_agent_consumer_progress SET"
                        + " snapshot_stale_since = snapshot_stale_since - 6000"
                        + " WHERE tenant_id = ? AND session_id = ?",
                tenant, sessionId);
        fixture.ledger.reset();
        assertThat(fixture.store.findMaterializationTargets(32))
                .contains(new MaterializationTarget(tenant, sessionId));
        assertThat(fixture.ledger.count("snapshot_stale_since"))
                .isGreaterThan(0);
        assertThat(fixture.ledger.count("managed_agent_snapshot")).isZero();
        // The convergence tick still waits for the snapshot's own age.
        fixture.jdbc.update("UPDATE managed_agent_snapshot SET updated_at ="
                        + " updated_at - 6000 WHERE tenant_id = ? AND"
                        + " session_id = ?", tenant, sessionId);
        // The re-selected tick has no new events; it converges the snapshot.
        fixture.ledger.reset();
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        assertThat(fixture.store.findSnapshotCoveredSequences(tenant,
                List.of(sessionId)).getOrDefault(sessionId, 0L))
                .isEqualTo(lastSequence);
        assertThat(fixture.ledger.count("update managed_agent_snapshot set"))
                .isEqualTo(1);
    }

    @Test
    void caughtUpBatchRewritesAnAgedOutSnapshotInline() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "inline-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.tool_call.updated",
                Map.of("callId", "call-0", "status", "completed"),
                false, "inline-0");
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        // Age the snapshot past the 5s floor, then drain one more event:
        // the catching-up batch must rewrite inline instead of waiting for
        // an aged-out reselection tick.
        fixture.jdbc.update("UPDATE managed_agent_snapshot SET updated_at ="
                        + " updated_at - 6000 WHERE tenant_id = ? AND"
                        + " session_id = ?", tenant, sessionId);
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.tool_call.updated",
                Map.of("callId", "call-1", "status", "completed"),
                false, "inline-1");
        fixture.ledger.reset();
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        assertThat(fixture.store.findSnapshotCoveredSequences(tenant,
                List.of(sessionId)).getOrDefault(sessionId, 0L))
                .isEqualTo(fixture.store.requireSession(tenant, sessionId)
                        .lastSequence());
        assertThat(fixture.ledger.count("update managed_agent_snapshot set"))
                .isEqualTo(1);
    }

    @Test
    void emptyBatchDoesNotRewriteAFreshLaggingSnapshot() {
        // A frozen clock: the debounce window never lapses mid-test.
        Fixture fixture = new Fixture(
                Clock.fixed(Instant.now(), java.time.ZoneOffset.UTC));
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "debounce-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.tool_call.updated",
                Map.of("callId", "call-0", "status", "completed"),
                false, "debounce-0");
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        // A drained trickle batch leaves the fresh snapshot one event
        // behind; an empty tick arriving before the snapshot ages out must
        // not rewrite it.
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.tool_call.updated",
                Map.of("callId", "call-1", "status", "completed"),
                false, "debounce-1");
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        Long marker = fixture.jdbc.queryForObject(
                "SELECT snapshot_stale_since FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ?",
                Long.class, tenant, sessionId);
        assertThat(marker).isNotNull();
        fixture.ledger.reset();
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        assertThat(fixture.ledger.count("update managed_agent_snapshot set"))
                .isZero();
        // The empty tick — the scheduler's hottest path — is pinned whole:
        // the event read, the session lock, the progress lock, and the
        // snapshot read.
        assertThat(fixture.ledger.total()).isEqualTo(4);
        // The not-aged exit must leave the deferral marker untouched —
        // clearing or re-stamping it would stop the aged reselection from
        // ever converging the snapshot.
        assertThat(fixture.jdbc.queryForObject(
                "SELECT snapshot_stale_since FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ?",
                Long.class, tenant, sessionId)).isEqualTo(marker);
        assertThat(fixture.store.findMaterializationTargets(32))
                .doesNotContain(new MaterializationTarget(tenant, sessionId));
    }

    @Test
    void replayFloorStaysClampedToALaggingSnapshot() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "floor-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        for (int index = 0; index < 5; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-" + index, "status", "completed"),
                    false, "floor-" + index);
        }
        // Cover all five events so the snapshot exists, then append more:
        // the projection advances past the snapshot, which now lags.
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 100));
        long snapshotCovered = fixture.store
                .findSnapshotCoveredSequences(tenant, List.of(sessionId))
                .getOrDefault(sessionId, 0L);
        for (int index = 0; index < 3; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-lag-" + index, "status",
                            "completed"),
                    false, "floor-lag-" + index);
        }
        // A partial batch advances the projection but, below the threshold,
        // leaves the snapshot behind.
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 2));
        assertThat(fixture.store.findSnapshotCoveredSequences(tenant,
                List.of(sessionId)).getOrDefault(sessionId, 0L))
                .isEqualTo(snapshotCovered);
        long lastSequence = fixture.store.requireSession(tenant, sessionId)
                .lastSequence();
        assertThat(lastSequence).isGreaterThan(snapshotCovered);
        // The floor never advances past what the snapshot covers.
        assertThat(fixture.store
                .advanceReplayFloor(tenant, sessionId, lastSequence)
                .floorSequence()).isEqualTo(snapshotCovered);
    }

    @Test
    void materializationRewritesTheSnapshotOnTheEventThreshold() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "thr-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        // Establish the current snapshot with a small caught-up burst.
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "item.tool_call.updated",
                Map.of("callId", "call-first", "status", "completed"), false,
                "thr-first");
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 100));
        // A burst of 1500 events plus the turn's terminal event,
        // materialized in 500-event batches: the first batch stays 500
        // events below the threshold, the second crosses it (1000 covered
        // since the snapshot), the tail batch carries the terminal event.
        for (int index = 0; index < 1500; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-" + index, "status", "completed"),
                    false, "thr-src-" + index);
        }
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "turn.completed", Map.of(), true, "thr-terminal");
        List<Long> snapshotWrites = new ArrayList<>();
        for (int batch = 0; batch < 4; batch++) {
            fixture.ledger.reset();
            fixture.tx.executeWithoutResult(status -> fixture.store
                    .materializeNextBatch(tenant, sessionId, 500));
            snapshotWrites.add(fixture.ledger.count("into managed_agent_snapshot")
                    + fixture.ledger.count("update managed_agent_snapshot set"));
        }
        assertThat(snapshotWrites).containsExactly(0L, 1L, 0L, 1L);
        assertThat(fixture.store.findSnapshot(tenant, sessionId)).get()
                .satisfies(snapshot -> assertThat(snapshot.coveredSequence())
                        .isEqualTo(fixture.store
                                .requireSession(tenant, sessionId)
                                .lastSequence()));
    }

    @Test
    void eventStreamRechecksReadPermissionOnAWindow() throws Exception {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        fixture.jdbc.update("INSERT INTO managed_workspace_registry"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?,"
                + " 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        fixture.jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, can_read, can_create) VALUES"
                + " (?, 'workspace', ?, TRUE, TRUE)", tenant,
                "actor".getBytes(StandardCharsets.UTF_8));
        String sessionId = fixture.tx.execute(status -> fixture.store
                .insertWorkspaceSessionCommand(tenant, "actor",
                        "sse-" + UUID.randomUUID(), "digest", "qwen-code",
                        null, null, List.of(), null,
                        new WorkspaceSelection("workspace", "."))).sessionId();
        long after = fixture.store.requireSession(tenant, sessionId)
                .lastSequence();
        int events = 20;
        RecordingEmitter emitter = new RecordingEmitter(60_000);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getEvents().setPollInterval(Duration.ofSeconds(60));
            properties.getEvents().setHeartbeatInterval(Duration.ofSeconds(60));
            // Longer than the completion budget, so no in-loop recheck can
            // fire mid-test even on a stalled runner.
            properties.getEvents()
                    .setReadGrantRecheckInterval(Duration.ofSeconds(60));
            ManagedEventStreamService streams = new ManagedEventStreamService(
                    fixture.service, fixture.hub, executor, properties) {
                @Override
                SseEmitter emitter() {
                    return emitter;
                }
            };
            fixture.ledger.reset();
            streams.publicStream(tenant, "actor", sessionId, after);
            // The first in-loop grant check proves the hub subscription
            // exists, so published events can no longer be dropped.
            await().atMost(Duration.ofSeconds(10)).until(() ->
                    fixture.ledger.count("managed_workspace_access") >= 2);
            for (int index = 0; index < events; index++) {
                fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                        "turn-1", "test.progress", Map.of("index", index),
                        false, "sse-src-" + index);
            }
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId, null,
                    "session.deleted", Map.of(), true, "sse-end");
            assertThat(emitter.completed.await(10, TimeUnit.SECONDS)).isTrue();
            assertThat(emitter.failed).isEmpty();
            assertThat(emitter.ids).hasSize(events + 1);
            long grants = fixture.ledger.count("managed_workspace_access");
            System.out.println("[issue-13181] workspace session stream of "
                    + (events + 1) + " events ran " + grants
                    + " managed_workspace_access read-grant queries");
            // 1 admission + 1 first in-loop check; the 60-second recheck
            // window (overridden above, beyond the completion budget)
            // covers every delivered event.
            assertThat(grants).isEqualTo(2);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void plainSessionStreamRunsNoGrantQueries() throws Exception {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "plain-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        long after = fixture.store.requireSession(tenant, sessionId)
                .lastSequence();
        int events = 10;
        RecordingEmitter emitter = new RecordingEmitter(60_000);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getEvents().setPollInterval(Duration.ofSeconds(60));
            properties.getEvents().setHeartbeatInterval(Duration.ofSeconds(60));
            ManagedEventStreamService streams = new ManagedEventStreamService(
                    fixture.service, fixture.hub, executor, properties) {
                @Override
                SseEmitter emitter() {
                    return emitter;
                }
            };
            streams.publicStream(tenant, null, sessionId, after);
            for (int index = 0; index < events; index++) {
                fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                        "turn-1", "test.progress", Map.of("index", index),
                        false, "plain-src-" + index);
            }
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId, null,
                    "session.deleted", Map.of(), true, "plain-end");
            assertThat(emitter.completed.await(10, TimeUnit.SECONDS)).isTrue();
            assertThat(emitter.failed).isEmpty();
            assertThat(emitter.ids).hasSize(events + 1);
            // Control: the per-event checks only exist for workspace-bound
            // sessions, i.e. they are the permission check, not overhead of
            // the stream itself.
            assertThat(fixture.ledger.count("managed_workspace_access"))
                    .isZero();
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void sessionListsAssemblePagesFromGroupedBatchQueries() {
        Fixture fixture = new Fixture();
        String plain = "tenant-" + UUID.randomUUID();
        List<String> plainIds = new ArrayList<>();
        List<String> plainTurnIds = new ArrayList<>();
        for (int index = 0; index < 20; index++) {
            String sessionId = fixture.store.insertSessionCommand(plain,
                    "CREATE_SESSION", "plain-" + index + "-" + UUID.randomUUID(),
                    "digest", "qwen-code", null, "s-" + index, List.of(), null)
                    .sessionId();
            plainIds.add(sessionId);
            String turnId = fixture.store.insertTurnCommand(plain,
                    "SUBMIT_TURN", "turn-" + index + "-" + UUID.randomUUID(),
                    "digest",
                    sessionId, List.of(Map.of("type", "text", "text", "hi")),
                    "digest").turnId();
            plainTurnIds.add(turnId);
        }
        // Sessions 2 and 5 carry distinct environment events on their latest
        // turns; materializing then produces a real snapshot covered value
        // per session.
        for (int index : new int[] {2, 5}) {
            fixture.store.appendPublicEventIfAbsent(plain, plainIds.get(index),
                    plainTurnIds.get(index), "environment.ready",
                    Map.of("environmentId", "env-" + index), false,
                    "env-" + index);
        }
        for (String sessionId : plainIds) {
            String sid = sessionId;
            fixture.tx.executeWithoutResult(status -> fixture.store
                    .materializeNextBatch(plain, sid, 1000));
        }
        // One turn is already completed: its row must differ from the rest.
        fixture.jdbc.update("UPDATE managed_agent_turn SET status ="
                + " 'COMPLETED' WHERE tenant_id = ? AND session_id = ?",
                plain, plainIds.get(7));
        fixture.ledger.reset();
        var publicPage = fixture.service.listPublicSessions(plain, null, null,
                20).data();
        assertThat(publicPage).hasSize(20);
        System.out.println("[issue-13181] listPublicSessions(20 rows): "
                + fixture.ledger.summary());
        // Page + active turns + snapshot covered sequences.
        assertThat(fixture.ledger.total()).isEqualTo(3);
        // The batch turn read projects only the summary columns; the page
        // never holds a parsed prompt graph per row.
        assertThat(fixture.ledger.count("select * from managed_agent_turn"))
                .isZero();
        assertThat(fixture.ledger.count("session_id, turn_id, status,"
                + " created_at, completed_at, error_code"
                + " from managed_agent_turn")).isEqualTo(1);
        // Every row carries its own title, its own active turn, and its own
        // snapshot coverage: session 7 is the one without an active turn,
        // and the two environment sessions were covered through one more
        // event.
        for (var row : publicPage) {
            int index = plainIds.indexOf(row.id());
            assertThat(row.metadata()).containsEntry("title", "s-" + index);
            if (index == 7) {
                assertThat(row.activeTurn()).isNull();
            } else {
                assertThat(row.activeTurn()).isNotNull();
                assertThat(row.activeTurn().sessionId()).isEqualTo(row.id());
            }
            assertThat(row.capabilities().actions()).isFalse();
            assertThat(row.snapshotThroughSequence())
                    .isEqualTo(index == 2 || index == 5 ? 3 : 2);
        }

        fixture.ledger.reset();
        var webShellPage = fixture.service.listWebShellSessions(plain, null,
                null, 20).data();
        assertThat(webShellPage).hasSize(20);
        System.out.println("[issue-13181] listWebShellSessions(20 rows): "
                + fixture.ledger.summary());
        // Page + latest turns + environment events.
        assertThat(fixture.ledger.total()).isEqualTo(3);
        // The latest-turn batch read projects only the summary columns.
        assertThat(fixture.ledger.count("turn_record.*")).isZero();
        assertThat(fixture.ledger.count("turn_record.session_id,"
                + " turn_record.turn_id, turn_record.status,"
                + " turn_record.created_at, turn_record.completed_at,"
                + " turn_record.error_code"
                + " from managed_agent_turn")).isEqualTo(1);
        // The latest turn surfaces even when completed, still per session,
        // and each row carries its own latest turn's environment event.
        for (var row : webShellPage) {
            int index = plainIds.indexOf(row.sessionId());
            assertThat(row.title()).isEqualTo("s-" + index);
            assertThat(row.activeTurn()).isNotNull();
            assertThat(row.activeTurn().sessionId()).isEqualTo(row.sessionId());
            assertThat(row.activeTurn().status()).isEqualTo(
                    index == 7 ? "completed" : "accepted");
            if (index == 2 || index == 5) {
                assertThat(row.environment()).isInstanceOf(Map.class);
                assertThat(((Map<?, ?>) row.environment())
                        .get("environmentId")).isEqualTo("env-" + index);
            } else {
                assertThat(row.environment()).isNull();
            }
        }

        // The single-session WebShell detail shares the batched assembly.
        fixture.ledger.reset();
        assertThat(fixture.service.getWebShellSession(plain, null,
                plainIds.get(0)).sessionId()).isEqualTo(plainIds.get(0));
        // Session read + latest turns + environment events, one each.
        assertThat(fixture.ledger.total()).isEqualTo(3);

        String bound = "tenant-" + UUID.randomUUID();
        fixture.jdbc.update("INSERT INTO managed_workspace_registry"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?,"
                + " 'ACTIVE')", bound, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        fixture.jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, can_read, can_create) VALUES"
                + " (?, 'workspace', ?, TRUE, TRUE)", bound,
                "actor".getBytes(StandardCharsets.UTF_8));
        List<String> boundIds = new ArrayList<>();
        for (int index = 0; index < 20; index++) {
            String key = "ws-" + index + "-" + UUID.randomUUID();
            String title = "w-" + index;
            boundIds.add(fixture.tx.execute(status -> fixture.store
                    .insertWorkspaceSessionCommand(bound, "actor", key,
                            "digest", "qwen-code", null, title,
                            List.of(), null,
                            new WorkspaceSelection("workspace", "."))).sessionId());
        }
        // One workspace session opts out of yolo: its actions capability
        // must differ from the other rows'. Another holds a completed close:
        // its retention capabilities must differ per row, not per page.
        fixture.jdbc.update("UPDATE managed_agent_session SET approval_mode ="
                + " 'confirm' WHERE tenant_id = ? AND session_id = ?",
                bound, boundIds.get(3));
        fixture.jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                + " session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state, admission_stage,"
                + " delivery_state, session_status_before, receipt_id,"
                + " available_at, created_at, updated_at, completed_at)"
                + " VALUES (?, ?, ?, 'CLOSE', '', 'close-key', 'digest',"
                + " 'COMPLETED', 'JAVA_DURABLE', 'DELIVERED', 'CLOSED',"
                + " 'rcpt', 0, 0, 0, 0)",
                bound, boundIds.get(5), "op_" + UUID.randomUUID());
        fixture.ledger.reset();
        var boundPublic = fixture.service.listPublicSessions(bound, "actor",
                null, 20).data();
        assertThat(boundPublic).hasSize(20);
        System.out.println("[issue-13181] listPublicSessions(20 workspace"
                + " rows): " + fixture.ledger.summary());
        // Page + active turns + covered sequences + the workspace-close
        // batch; the approval mode rides on the page's own SELECT *.
        assertThat(fixture.ledger.total()).isEqualTo(4);
        assertThat(fixture.ledger.count(
                "approval_mode from managed_agent_session"))
                .isZero();
        assertThat(fixture.ledger.count("from managed_agent_operation"))
                .isEqualTo(1);
        for (var row : boundPublic) {
            int index = boundIds.indexOf(row.id());
            assertThat(row.metadata()).containsEntry("title", "w-" + index);
            assertThat(row.capabilities().actions()).isEqualTo(index == 3);
            assertThat(row.capabilities().sessionDelete())
                    .isEqualTo(index == 5);
        }

        fixture.ledger.reset();
        var boundWebShell = fixture.service.listWebShellSessions(bound,
                "actor", null, 20).data();
        assertThat(boundWebShell).hasSize(20);
        System.out.println("[issue-13181] listWebShellSessions(20 workspace"
                + " rows): " + fixture.ledger.summary());
        // Page + the latest-turn read + the workspace-close batch; without
        // turns the environment-event read is skipped, and the approval mode
        // rides on the page's own SELECT *.
        assertThat(fixture.ledger.total()).isEqualTo(3);
        assertThat(fixture.ledger.count(
                "approval_mode from managed_agent_session"))
                .isZero();
        for (var row : boundWebShell) {
            int index = boundIds.indexOf(row.sessionId());
            assertThat(row.title()).isEqualTo("w-" + index);
            assertThat(row.capabilities().actions()).isEqualTo(index == 3);
            assertThat(row.capabilities().sessionDelete())
                    .isEqualTo(index == 5);
        }
    }

    @Test
    void boundWebShellPageBatchesTheCreatorSubmitCapability() {
        Fixture fixture = new Fixture();
        when(fixture.harness.isWorkspaceFilesAvailable()).thenReturn(true);
        String tenant = "tenant-" + UUID.randomUUID();
        fixture.jdbc.update("INSERT INTO managed_workspace_registry"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?,"
                + " 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        for (String actor : new String[] {"actor", "other"}) {
            fixture.jdbc.update("INSERT INTO managed_workspace_access"
                    + " (tenant_id, workspace_id, actor_id, can_read,"
                    + " can_create) VALUES (?, 'workspace', ?, TRUE, TRUE)",
                    tenant, actor.getBytes(StandardCharsets.UTF_8));
        }
        // A second workspace where the actor reads but cannot create: its
        // session exercises the grant's can_create term, and the page's two
        // workspaces make the grant batch's single-query shape
        // discriminable.
        fixture.jdbc.update("INSERT INTO managed_workspace_registry"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace2', 1, 'storage', 'Workspace2', ?,"
                + " ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        fixture.jdbc.update("INSERT INTO managed_workspace_access"
                + " (tenant_id, workspace_id, actor_id, can_read,"
                + " can_create) VALUES (?, 'workspace2', ?, TRUE, TRUE)",
                tenant, "actor".getBytes(StandardCharsets.UTF_8));
        List<String> ids = new ArrayList<>();
        for (int index = 0; index < 7; index++) {
            String creator = index < 4 || index == 6 ? "actor" : "other";
            String workspace = index == 6 ? "workspace2" : "workspace";
            String key = "ws-" + index + "-" + UUID.randomUUID();
            String title = "w-" + index;
            ids.add(fixture.tx.execute(status -> fixture.store
                    .insertWorkspaceSessionCommand(tenant, creator, key,
                            "digest", "qwen-code", null, title,
                            List.of(), null,
                            new WorkspaceSelection(workspace, ".")))
                    .sessionId());
        }
        // One creator-owned session is closed: the shape gate fences it even
        // for its creator. The workspace2 grant then drops can_create: its
        // session exercises the grant term.
        fixture.jdbc.update("UPDATE managed_agent_session SET status ="
                + " 'CLOSED' WHERE tenant_id = ? AND session_id = ?", tenant,
                ids.get(3));
        fixture.jdbc.update("UPDATE managed_workspace_access SET"
                + " can_create = FALSE WHERE tenant_id = ? AND workspace_id"
                + " = 'workspace2'", tenant);
        fixture.ledger.reset();
        var page = fixture.service.listWebShellSessions(tenant, "actor",
                null, 20).data();
        assertThat(page).hasSize(7);
        System.out.println("[issue-13181] listWebShellSessions(7 mixed"
                + " creator rows): " + fixture.ledger.summary());
        // Page + latest turns + the close batch + the creator batch + the
        // grant batch across both workspaces: constant, not per row.
        assertThat(fixture.ledger.total()).isEqualTo(5);
        assertThat(fixture.ledger.count(
                "from managed_workspace_create_command")).isEqualTo(1);
        assertThat(fixture.ledger.count("from managed_workspace_registry"))
                .isEqualTo(1);
        // workspaceTurns holds exactly for the caller's own ACTIVE sessions
        // on a workspace where the grant still allows creation.
        for (var row : page) {
            int index = ids.indexOf(row.sessionId());
            assertThat(row.capabilities().workspaceTurns())
                    .isEqualTo(index < 3);
        }
    }

    @Test
    void transcriptServesEveryEventPastTheSnapshot() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "tail-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        // Five events materialize so a snapshot exists; 150 more are
        // appended and only partially materialized, leaving the snapshot
        // behind with a long tail.
        for (int index = 0; index < 5; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-" + index, "status", "completed"),
                    false, "tail-" + index);
        }
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 100));
        for (int index = 0; index < 150; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-b-" + index, "status",
                            "completed"),
                    false, "tail-b-" + index);
        }
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 100));
        long snapshotCovered = fixture.store
                .findSnapshotCoveredSequences(tenant, List.of(sessionId))
                .getOrDefault(sessionId, 0L);
        long lastSequence = fixture.store.requireSession(tenant, sessionId)
                .lastSequence();
        assertThat(snapshotCovered).isLessThan(lastSequence);
        fixture.ledger.reset();
        var transcript = fixture.service.transcript(tenant, null, sessionId,
                null, 10);
        // The published contract: the cursor-less page serves every event
        // after the snapshot, so the stream can resume at the reported
        // watermark with no band left unserved; the tail is one read sized
        // by the snapshot gate's lag bound.
        assertThat(transcript.events().stream()
                .filter(event -> event.sequence()
                        > transcript.coveredSequence())
                .count()).isEqualTo(lastSequence - snapshotCovered);
        assertThat(transcript.events().getLast().sequence())
                .isEqualTo(lastSequence);
        assertThat(transcript.hasMore()).isFalse();
        assertThat(transcript.olderCursor()).isNull();
        assertThat(transcript.lastSequence()).isEqualTo(lastSequence);
        assertThat(fixture.ledger.count("from managed_agent_event",
                "sequence_id >")).isEqualTo(1);
    }

    @Test
    void aMaximallyLaggingSnapshotTailIsOneRead() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "lag-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        for (int index = 0; index < 5; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-" + index, "status", "completed"),
                    false, "lag-" + index);
        }
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 100));
        long covered = fixture.store
                .findSnapshotCoveredSequences(tenant, List.of(sessionId))
                .getOrDefault(sessionId, 0L);
        // The gate's lag ceiling: 999 events appended, none materialized.
        for (int index = 0; index < 999; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-b-" + index, "status",
                            "completed"),
                    false, "lag-b-" + index);
        }
        fixture.ledger.reset();
        var transcript = fixture.service.transcript(tenant, null, sessionId,
                null, 10);
        // The full 999-event tail is served, in one event read.
        assertThat(transcript.events().stream()
                .filter(event -> event.sequence() > covered).count())
                .isEqualTo(999);
        assertThat(transcript.hasMore()).isFalse();
        assertThat(fixture.ledger.count("from managed_agent_event",
                "sequence_id >")).isEqualTo(1);
        // A tail longer than one page (a session the materializer never
        // visited) is served completely, paging per 1000.
        for (int index = 0; index < 600; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-c-" + index, "status",
                            "completed"),
                    false, "lag-c-" + index);
        }
        fixture.ledger.reset();
        var longer = fixture.service.transcript(tenant, null, sessionId,
                null, 10);
        assertThat(longer.events().stream()
                .filter(event -> event.sequence() > covered).count())
                .isEqualTo(1599);
        assertThat(longer.hasMore()).isFalse();
        assertThat(fixture.ledger.count("from managed_agent_event",
                "sequence_id >")).isEqualTo(2);
    }

    @Test
    void batchTurnReadsFollowAdmissionOrderNotCreatedAt() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "order-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        // Two Turns admitted out of created_at order: the turn.accepted
        // sequence makes turn-b the latest even though turn-a's created_at
        // is later.
        String turnA = fixture.store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "order-a-" + UUID.randomUUID(), "digest", sessionId,
                List.of(Map.of("type", "text", "text", "a")), "digest")
                .turnId();
        fixture.jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " 'COMPLETED' WHERE tenant_id = ? AND turn_id = ?",
                tenant, turnA);
        String turnB = fixture.store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "order-b-" + UUID.randomUUID(), "digest", sessionId,
                List.of(Map.of("type", "text", "text", "b")), "digest")
                .turnId();
        fixture.jdbc.update("UPDATE managed_agent_turn SET created_at ="
                        + " created_at + 10000 WHERE tenant_id = ? AND"
                        + " turn_id = ?", tenant, turnA);
        // Inverted environment sequences: the older Turn's failed event
        // sits at the higher sequence, the latest Turn's ready below it.
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, turnB,
                "environment.ready", Map.of("environmentId", "env-b"),
                false, "order-env-ready");
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, turnA,
                "environment.failed", Map.of("code", "runtime_warm_failed"),
                false, "order-env-failed");
        // The batch reads behind the page must report the latest Turn by
        // admission order and that Turn's own environment, not the newest
        // environment event of the Session.
        var page = fixture.service.listWebShellSessions(tenant, null, null,
                20).data();
        assertThat(page).hasSize(1);
        var row = page.getFirst();
        assertThat(row.activeTurn().turnId()).isEqualTo(turnB);
        assertThat(((Map<?, ?>) row.environment()).get("environmentId"))
                .isEqualTo("env-b");
    }

    private record PublicationFixture(ManagedSessionStore sessions,
            JdbcRuntimeBindingRepository bindings,
            JdbcToolExecutionRepository executions, ToolPublicationStore store) {
    }

    private PublicationFixture publicationFixture(Fixture fixture) {
        return publicationFixture(fixture, true);
    }

    private PublicationFixture publicationFixture(Fixture fixture,
            boolean journalHeadAuthorization) {
        journal = PublicationJournalFixture.create(fixture.dataSource,
                journalHeadAuthorization);
        binding = journal.binding;
        checkpoint = journal.checkpoint;
        journal.reserve();
        return new PublicationFixture(journal.sessions, journal.bindings,
                journal.executions, journal.store);
    }

    @Test
    void publicationAuthorizationReadsTheActivationFromTheJournalHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        ManagedSessionStore sessions = publication.sessions();
        ToolPublicationStore store = publication.store();
        JdbcToolExecutionRepository executions = publication.executions();
        long activationRevision = fixture.jdbc.queryForObject(
                "SELECT MAX(journal_revision)"
                        + " FROM qwen_managed_session_journal_tx",
                Long.class);

        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();

        int filler = 30;
        for (int index = 0; index < filler; index++) {
            append("tool.dispatch",
                    event(journal.sequence + 1, "tool.progress",
                            JSON.createObjectNode()) + "{}\n",
                    1, List.of(), null);
        }
        long head = fixture.jdbc.queryForObject("SELECT MAX(journal_revision)"
                + " FROM qwen_managed_session_journal_tx", Long.class);
        assertThat(head).isEqualTo(activationRevision + filler);

        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        long scans = fixture.ledger.count(
                "from qwen_managed_session_journal_tx", "for update");
        System.out.println("[issue-13181] verifyDispatch with the activation "
                + filler + " revisions behind the head: " + scans
                + " locked journal reads");
        assertThat(scans).isZero();

        Map<String, byte[]> objects = new java.util.HashMap<>();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                objects.putIfAbsent(key, bytes.clone());
            }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() {
            }
        };
        ToolPublicationDataStore data = new ToolPublicationDataStore(
                fixture.jdbc, fixture.manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30),
                new ToolPublicationDataStore.VerificationBudget(
                        16 * 1024 * 1024, Duration.ofMinutes(25)));
        byte[] bytes = "hello".getBytes(StandardCharsets.UTF_8);
        fixture.ledger.reset();
        data.publishSegment(binding.get("sessionKey"), "pub-1",
                PUBLICATION_TOKEN, "op-1", "stdout", 0, bytes, digest("hello"));
        // publish() authorizes twice per call (claim + install); both read
        // the activation state from the head row.
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
        // Positive control: the publish path locks the head row six times
        // (claim's authorize, the retention put, the verify-open read
        // lease, install's authorize, and each authorization's final writer
        // lease recheck), so the zero above cannot pass
        // vacuously on a broken store.
        assertThat(fixture.ledger.count(
                "from qwen_managed_session_journal_head", "for update"))
                .isEqualTo(6);
    }

    @Test
    void publicationAuthorizationFencesAReleasedActivationFromTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A release committed after the reserve updates the head columns.
        append("activation.release",
                event(journal.sequence + 1, "activation.changed",
                        activation("released")) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        // The head columns answered the check: no journal reads.
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void preV36CommitSkewStillFencesWhileTheHeadGateIsOff() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture, false);
        // The head columns hold the active activation from the dispatch
        // commit. A pre-V36 binary then commits a release: the journal gains
        // the row and the revision bumps, but the columns stay untouched.
        // Reproduce that exact skew by restoring the columns and their stamp
        // after a real release commit.
        var head = fixture.jdbc.queryForMap("SELECT activation_id,"
                + " activation_phase, activation_event_epoch,"
                + " activation_expires_at, activation_head_revision"
                + " FROM qwen_managed_session_journal_head");
        append("activation.release",
                event(journal.sequence + 1, "activation.changed",
                        activation("released")) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?,"
                        + " activation_head_revision = ?",
                head.get("activation_id"), head.get("activation_phase"),
                head.get("activation_event_epoch"),
                head.get("activation_expires_at"),
                head.get("activation_head_revision"));
        // The gate ships off: authorization reads the journal and fences
        // the release instead of trusting the stale active head.
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        // The legacy path's cost is explicit: one locked journal read (the
        // release sits at the latest revision), no head write.
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isEqualTo(1);
        assertThat(fixture.ledger.count("update qwen_managed_session_journal_head"))
                .isZero();
        // The renew path's evidence read must not trust the stale head
        // either.
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
    }

    @Test
    void staleHeadStampRescansInsteadOfTrustingTheColumns() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // The rolling-window residue: columns backfilled active, then a
        // pre-V36 binary commits a release, bumping journal_revision without
        // touching the columns. Reproduce by restoring the columns and their
        // stamp after a real release commit, with the gate ON.
        var head = fixture.jdbc.queryForMap("SELECT activation_id,"
                + " activation_phase, activation_event_epoch,"
                + " activation_expires_at, activation_head_revision"
                + " FROM qwen_managed_session_journal_head");
        append("activation.release",
                event(journal.sequence + 1, "activation.changed",
                        activation("released")) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?,"
                        + " activation_head_revision = ?",
                head.get("activation_id"), head.get("activation_phase"),
                head.get("activation_event_epoch"),
                head.get("activation_expires_at"),
                head.get("activation_head_revision"));
        // The stamp lags journal_revision, so the head is not trusted: the
        // legacy scan fences the released activation even with the gate on.
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isGreaterThan(0);
    }

    @Test
    void staleHeadStampRebackfillsAndRejoinsTheHeadPath() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // The self-heal arm: the columns are current but the stamp lags, so
        // the first authorization scans and re-stamps; the next reads the
        // head again.
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_head_revision = activation_head_revision - 1");
        publication.store().verifyDispatch(publication.executions()
                .findByExecutionCallId("execution-1"), "pub-1",
                PUBLICATION_TOKEN);
        var head = fixture.jdbc.queryForMap("SELECT activation_head_revision,"
                + " journal_revision FROM qwen_managed_session_journal_head");
        assertThat(head.get("activation_head_revision"))
                .isEqualTo(head.get("journal_revision"));
        fixture.ledger.reset();
        publication.store().verifyDispatch(publication.executions()
                .findByExecutionCallId("execution-1"), "pub-1",
                PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void noChangeCommitDoesNotRestampASkewedHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // The rolling-window skew: the columns hold the active activation,
        // then a pre-V36 binary commits a release (journal row + revision
        // bump, columns and stamp untouched) — reproduced by restoring the
        // pre-commit columns and stamp after a real release commit.
        var head = fixture.jdbc.queryForMap("SELECT activation_id,"
                + " activation_phase, activation_event_epoch,"
                + " activation_expires_at, activation_head_revision"
                + " FROM qwen_managed_session_journal_head");
        append("activation.release",
                event(journal.sequence + 1, "activation.changed",
                        activation("released")) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?,"
                        + " activation_head_revision = ?",
                head.get("activation_id"), head.get("activation_phase"),
                head.get("activation_event_epoch"),
                head.get("activation_expires_at"),
                head.get("activation_head_revision"));
        // A current binary then commits a batch with no activation change:
        // it must not advance the skewed columns' stamp, or the stale
        // active state would be certified as current.
        append("tool.dispatch",
                event(journal.sequence + 1, "tool.progress",
                        JSON.createObjectNode()) + "{}\n",
                1, List.of(), null);
        var stamped = fixture.jdbc.queryForMap(
                "SELECT activation_head_revision, journal_revision"
                        + " FROM qwen_managed_session_journal_head");
        assertThat(stamped.get("activation_head_revision"))
                .isNotEqualTo(stamped.get("journal_revision"));
        // The skew stays detectable: authorization rescans the journal and
        // fences the release.
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isGreaterThan(0);
    }

    @Test
    void unrepresentableExpiresAtFencesTheHeadCleanly() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // An activation with no expiresAt: id/phase are stored, the expiry
        // column stays NULL, and the head branch must refuse cleanly (a
        // missing expiry fails exactly like the scan's absent read).
        ObjectNode noExpiry = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active");
        append("activation.no-expiry",
                event(journal.sequence + 1, "activation.changed", noExpiry) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isEqualTo("active");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isNull();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        // An overflowing string expiresAt is likewise absent, never a
        // truncated timestamp.
        ObjectNode overflowing = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", "99999999999999999999999999");
        append("activation.overflow",
                event(journal.sequence + 1, "activation.changed", overflowing)
                        + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isNull();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        // An exponent-form string is rejected by the width pre-check without
        // materializing the giant integer (measured ~65s/1GB per call before
        // the pre-check existed).
        ObjectNode exponent = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active").put("expiresAt", "1e100000000");
        append("activation.exponent",
                event(journal.sequence + 1, "activation.changed", exponent) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isNull();
        // The width check itself must not overflow: the largest exponent a
        // JSON string can carry wraps an int precision-minus-scale negative,
        // which must still read as absent rather than materialize.
        ObjectNode maxExponent = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active").put("expiresAt", "1e2147483647");
        append("activation.max-exponent",
                event(journal.sequence + 1, "activation.changed", maxExponent)
                        + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isNull();
        // The positive-scale direction: 1e-N expands 10^N before dividing
        // (measured ~56s of CPU for these 12 bytes without the bound), so
        // the scale is pre-checked too.
        ObjectNode tinyFraction = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active").put("expiresAt", "1e-100000000");
        append("activation.tiny-fraction",
                event(journal.sequence + 1, "activation.changed", tinyFraction)
                        + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isNull();
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        // The head answers before the intent read: a fenced renew pays no
        // journal statement.
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx"))
                .isZero();
    }

    @Test
    void expiredActivationFencesThroughTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A warm head carrying an already-expired activation: both grant
        // paths must refuse through the head columns, exactly as the scan
        // would refuse the same payload.
        ObjectNode expired = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", System.currentTimeMillis() - 1000);
        append("activation.expired",
                event(journal.sequence + 1, "activation.changed", expired) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        // The head answers the activation term before the intent is read:
        // a fenced renew pays no journal statement at all.
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx"))
                .isZero();
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        // Through the head columns: no locked journal read at all.
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void legacyHeadRenewBackfillsFromTheJournalScan() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // Simulate a pre-V36 head: the evidence scan on renew authorizes
        // from the journal and backfills the head columns.
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        publication.store().apply(request("renew"), WRITER_TOKEN,
                PUBLICATION_TOKEN);
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isEqualTo("active");
        // The next authorization reads the head: zero journal reads.
        fixture.ledger.reset();
        publication.store().verifyDispatch(publication.executions()
                .findByExecutionCallId("execution-1"), "pub-1",
                PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count(
                "from qwen_managed_session_journal_tx", "for update"))
                .isZero();
    }

    @Test
    void activationChangeBeyondTheDeclaredEventsIsRejectedAtCommit() {
        Fixture fixture = new Fixture();
        publicationFixture(fixture);
        // The activation line sits past the declared event count (the
        // commit marker's slot): refused, never captured into the head
        // columns.
        assertThatThrownBy(() -> append("activation.misplaced",
                event(journal.sequence + 1, "tool.progress",
                        JSON.createObjectNode())
                        + event(journal.sequence + 2, "activation.changed",
                                activation("released")),
                1, List.of(), null))
                .hasMessageContaining("invalid journal position");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isEqualTo("active");
    }

    @Test
    void foreignScopedActivationChangeIsRejectedAtCommit() {
        Fixture fixture = new Fixture();
        publicationFixture(fixture);
        JsonNode foreignKey = JSON.createObjectNode().put("tenantId", "tenant-1")
                .put("workspaceId", "workspace-1").put("sessionId", "session-9");
        assertThatThrownBy(() -> append("activation.foreign",
                event(journal.sequence + 1, "activation.changed",
                        activation("active"), foreignKey, 1) + "{}\n",
                1, List.of(), null))
                .hasMessageContaining("Journal event scope conflicts");
        // A version the reader does not know is refused the same way.
        assertThatThrownBy(() -> append("activation.unknown-version",
                event(journal.sequence + 1, "activation.changed",
                        activation("active"), binding.get("sessionKey"), 2)
                        + "{}\n",
                1, List.of(), null))
                .hasMessageContaining("Journal event scope conflicts");
        // A key carrying extra fields reads as foreign too, matching the
        // read paths' closed-key comparison.
        ObjectNode paddedKey = binding.get("sessionKey").deepCopy();
        paddedKey.put("junk", 1);
        assertThatThrownBy(() -> append("activation.padded-key",
                event(journal.sequence + 1, "activation.changed",
                        activation("active"), paddedKey, 1) + "{}\n",
                1, List.of(), null))
                .hasMessageContaining("Journal event scope conflicts");
        // The head columns keep the previous activation.
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isEqualTo("active");
    }

    @Test
    void oversizedActivationPhaseBlanksTheHeadColumnsCleanly() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // The phase arm of the width guard: a 33+ character phase with a
        // conforming id blanks the columns instead of failing the commit,
        // and the stamp still advances.
        append("activation.wide-phase",
                event(journal.sequence + 1, "activation.changed",
                        JSON.createObjectNode()
                                .put("activationId", ACTIVATION_ID)
                                .put("epoch", 1)
                                .put("phase", "active-" + "a".repeat(40))
                                .put("expiresAt",
                                        System.currentTimeMillis() + 180000))
                        + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isNull();
        var head = fixture.jdbc.queryForMap("SELECT activation_head_revision,"
                + " journal_revision FROM qwen_managed_session_journal_head");
        assertThat(head.get("activation_head_revision"))
                .isEqualTo(head.get("journal_revision"));
        // Authorization reads the journal and fences the unknown phase.
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isGreaterThan(0);
    }

    @Test
    void oversizedJournalActivationFencesAuthorizationCleanly() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A non-conforming writer commits an activation.changed wider than
        // the V36 columns; the commit blanks the head columns.
        append("activation.oversize",
                event(journal.sequence + 1, "activation.changed",
                        JSON.createObjectNode()
                                .put("activationId",
                                        "activation-" + "a".repeat(600))
                                .put("epoch", 1).put("phase", "active")
                                .put("expiresAt",
                                        System.currentTimeMillis() + 180000))
                        + "{}\n",
                1, List.of(), null);
        assertThat(fixture.jdbc.queryForObject("SELECT activation_id FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isNull();
        // Authorization reads the journal and fences the id mismatch
        // cleanly — no storage error from writing the oversized value.
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
    }

    @Test
    void publicationAuthorizationRescansAndBackfillsPreMigrationHeads() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        ToolPublicationStore store = publication.store();
        JdbcToolExecutionRepository executions = publication.executions();
        int filler = 30;
        for (int index = 0; index < filler; index++) {
            append("tool.dispatch",
                    event(journal.sequence + 1, "tool.progress",
                            JSON.createObjectNode()) + "{}\n",
                    1, List.of(), null);
        }
        // Simulate a journal last written before migration V36.
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL,"
                + " activation_head_revision = NULL");

        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        long scans = fixture.ledger.count(
                "from qwen_managed_session_journal_tx", "for update");
        System.out.println("[issue-13181] legacy head verifyDispatch: "
                + scans + " locked journal reads, then backfilled");
        // The legacy fallback scans the filler revisions plus the
        // activation's own.
        assertThat(scans).isEqualTo(filler + 1L);
        // The scan backfills the head, so later checks are O(1).
        assertThat(fixture.jdbc.queryForObject(
                "SELECT activation_phase FROM qwen_managed_session_journal_head",
                String.class)).isEqualTo("active");
        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void renewReadsTheIntentAtItsOwnRevision() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        int filler = 30;
        for (int index = 0; index < filler; index++) {
            append("tool.dispatch",
                    event(journal.sequence + 1, "tool.progress",
                            JSON.createObjectNode()) + "{}\n",
                    1, List.of(), null);
        }
        fixture.ledger.reset();
        publication.store().apply(request("renew"), WRITER_TOKEN,
                PUBLICATION_TOKEN);
        long reads = fixture.ledger
                .count("from qwen_managed_session_journal_tx");
        System.out.println("[issue-13181] renew with the intent " + filler
                + " revisions behind the head: " + reads
                + " journal statements");
        // The revision range read, the chain-contiguity count, and the one
        // verified page: constant, independent of the filler depth, and none
        // of them locked.
        assertThat(reads).isEqualTo(4);
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void stringExpiresAtReadsConsistentlyAcrossTheScanAndTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        ToolPublicationStore store = publication.store();
        JdbcToolExecutionRepository executions = publication.executions();
        long expiry = System.currentTimeMillis() + 180000;
        // A non-conforming writer sends expiresAt as a JSON string; the
        // commit must store what the scans have always parsed, or the head
        // would fence what the scan authorizes.
        ObjectNode stringExpiry = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", String.valueOf(expiry));
        append("activation.string-expiry",
                event(journal.sequence + 1, "activation.changed", stringExpiry)
                        + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isEqualTo(expiry);
        // The head branch authorizes it without a journal read.
        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
        // A pre-V36 head scans the journal, parses the same value, and
        // backfills it; the next authorization reads the head again.
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isEqualTo(expiry);
        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count("from qwen_managed_session_journal_tx",
                "for update")).isZero();
    }

    private ObjectNode request(String operation) {
        return journal.request(operation);
    }

    private ObjectNode activation(String phase) {
        return journal.activation(phase);
    }

    private String event(long number, String kind, JsonNode payload) {
        return journal.event(number, kind, payload);
    }

    private String event(long number, String kind, JsonNode payload,
            JsonNode sessionKey, int v) {
        return journal.event(number, kind, payload, sessionKey, v);
    }

    private void append(String operation, String records, int events,
            List<ManagedSessionStoreModels.CommitResource> resources,
            String checkpointId) {
        journal.append(operation, records, events, resources, checkpointId);
    }

    /** Wires the production stores over a query-recording H2 DataSource. */
    private static final class Fixture {
        final DataSource dataSource;
        final QueryLedger ledger;
        final JdbcTemplate jdbc;
        final DataSourceTransactionManager manager;
        final TransactionTemplate tx;
        final SessionEventHub hub = new SessionEventHub();
        final ManagedAgentStore store;
        final ManagedAgentService service;
        final HarnessConnector harness = mock(HarnessConnector.class);

        Fixture() {
            this(Clock.systemUTC());
        }

        Fixture(Clock clock) {
            JdbcDataSource raw = new JdbcDataSource();
            raw.setURL("jdbc:h2:mem:repro-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;"
                    + "LOCK_TIMEOUT=10000");
            Flyway.configure().dataSource(raw).load().migrate();
            ledger = new QueryLedger(raw);
            dataSource = ledger.dataSource();
            jdbc = new JdbcTemplate(dataSource);
            manager = new DataSourceTransactionManager(dataSource);
            tx = new TransactionTemplate(manager);
            ManagedWorkspaceRegistry registry =
                    new ManagedWorkspaceRegistry(jdbc);
            store = new ManagedAgentStore(jdbc, JSON, clock, hub,
                    registry, new ManagedAgentProperties());
            service = new ManagedAgentService(store, new RequestDigests(),
                    mock(HarnessCoordinator.class),
                    harness, registry);
        }
    }

    /** Records each SQL statement and how many rows its ResultSet yielded. */
    static final class QueryLedger {
        static final class Query {
            final String sql;
            final AtomicLong rows = new AtomicLong();

            Query(String sql) {
                this.sql = sql.toLowerCase(Locale.ROOT)
                        .replaceAll("\\s+", " ").trim();
            }
        }

        private final DataSource delegate;
        private final List<Query> queries = new CopyOnWriteArrayList<>();

        QueryLedger(DataSource delegate) {
            this.delegate = delegate;
        }

        DataSource dataSource() {
            return (DataSource) Proxy.newProxyInstance(
                    QueryLedger.class.getClassLoader(),
                    new Class<?>[] {DataSource.class}, (proxy, method, args) -> {
                        try {
                            Object result = method.invoke(delegate, args);
                            if (result instanceof Connection connection) {
                                return connection(connection);
                            }
                            return result;
                        } catch (InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
        }

        long total() {
            return queries.size();
        }

        void reset() {
            queries.clear();
        }

        long count(String... fragments) {
            return queries.stream().filter(query -> matches(query, fragments))
                    .count();
        }

        long rows(String... fragments) {
            return queries.stream().filter(query -> matches(query, fragments))
                    .mapToLong(query -> query.rows.get()).sum();
        }

        Map<String, Long> summary() {
            Map<String, Long> grouped = new TreeMap<>();
            for (Query query : queries) {
                grouped.merge(query.sql, 1L, Long::sum);
            }
            return grouped;
        }

        private static boolean matches(Query query, String[] fragments) {
            for (String fragment : fragments) {
                boolean negated = fragment.startsWith("!");
                String needle = negated ? fragment.substring(1) : fragment;
                if (query.sql.contains(needle) == negated) {
                    return false;
                }
            }
            return true;
        }

        private Query record(String sql) {
            Query query = new Query(sql);
            queries.add(query);
            return query;
        }

        private Connection connection(Connection target) {
            return (Connection) Proxy.newProxyInstance(
                    QueryLedger.class.getClassLoader(),
                    new Class<?>[] {Connection.class},
                    (proxy, method, args) -> {
                        try {
                            if ("prepareStatement".equals(method.getName())
                                    && args != null && args.length > 0
                                    && args[0] instanceof String sql) {
                                Query query = record(sql);
                                Object statement =
                                        method.invoke(target, args);
                                return prepared(statement, query);
                            }
                            Object result = method.invoke(target, args);
                            if ("createStatement".equals(method.getName())
                                    && result instanceof Statement statement) {
                                return statement(statement);
                            }
                            return result;
                        } catch (InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
        }

        private PreparedStatement prepared(Object target, Query query) {
            return (PreparedStatement) Proxy.newProxyInstance(
                    QueryLedger.class.getClassLoader(),
                    new Class<?>[] {PreparedStatement.class},
                    (proxy, method, args) -> {
                        try {
                            Object result = method.invoke(target, args);
                            if (result instanceof ResultSet resultSet
                                    && "executeQuery".equals(
                                            method.getName())) {
                                return resultSet(resultSet, query);
                            }
                            return result;
                        } catch (InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
        }

        private Statement statement(Statement target) {
            return (Statement) Proxy.newProxyInstance(
                    QueryLedger.class.getClassLoader(),
                    new Class<?>[] {Statement.class},
                    (proxy, method, args) -> {
                        try {
                            if (args != null && args.length > 0
                                    && args[0] instanceof String sql
                                    && method.getName()
                                            .startsWith("execute")) {
                                Query query = record(sql);
                                Object result = method.invoke(target, args);
                                if (result instanceof ResultSet resultSet) {
                                    return resultSet(resultSet, query);
                                }
                                return result;
                            }
                            return method.invoke(target, args);
                        } catch (InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
        }

        private ResultSet resultSet(ResultSet target, Query query) {
            return (ResultSet) Proxy.newProxyInstance(
                    QueryLedger.class.getClassLoader(),
                    new Class<?>[] {ResultSet.class},
                    (proxy, method, args) -> {
                        try {
                            Object result = method.invoke(target, args);
                            if ("next".equals(method.getName())
                                    && Boolean.TRUE.equals(result)) {
                                query.rows.incrementAndGet();
                            }
                            return result;
                        } catch (InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
        }
    }

    /** Captures delivered event ids and stream completion. */
    static final class RecordingEmitter extends SseEmitter {
        private static final Pattern ID = Pattern.compile("(?m)^id:(\\d+)$");
        final List<Long> ids = new CopyOnWriteArrayList<>();
        final List<Throwable> failed = new CopyOnWriteArrayList<>();
        final CountDownLatch completed = new CountDownLatch(1);

        RecordingEmitter(long timeoutMillis) {
            super(timeoutMillis);
        }

        @Override
        public void send(SseEventBuilder builder) {
            StringBuilder text = new StringBuilder();
            for (DataWithMediaType part : builder.build()) {
                if (part.getData() instanceof String value) {
                    text.append(value);
                }
            }
            Matcher matcher = ID.matcher(text);
            if (matcher.find()) {
                ids.add(Long.parseLong(matcher.group(1)));
            }
        }

        @Override
        public void complete() {
            completed.countDown();
        }

        @Override
        public void completeWithError(Throwable error) {
            failed.add(error);
            completed.countDown();
        }
    }
}
