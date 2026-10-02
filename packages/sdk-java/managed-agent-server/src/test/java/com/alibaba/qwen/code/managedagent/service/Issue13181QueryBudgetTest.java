package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
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
import java.util.Base64;
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
 *   <li>materializeNextBatch rewrites the snapshot on catch-up or every
 *       SNAPSHOT_REFRESH_EVENTS, not on every batch.</li>
 *   <li>The SSE fan-out re-checks the workspace read grant once per recheck
 *       window, not per delivered event.</li>
 *   <li>listPublicSessions / listWebShellSessions assemble a page from a
 *       fixed number of grouped batch queries.</li>
 *   <li>Tool-publication authorization reads the activation state from the
 *       journal head, rescanning the journal only for pre-migration heads
 *       (and backfilling them).</li>
 * </ol>
 */
class Issue13181QueryBudgetTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WRITER_TOKEN = "a".repeat(32);
    private static final String PUBLICATION_TOKEN = Base64.getUrlEncoder()
            .withoutPadding().encodeToString(new byte[32]);
    private static final long CAPTURE_BYTES = 1024;
    private static final long ALLOCATION = CAPTURE_BYTES
            + ToolPublicationContract.PRODUCER_BYTES
            + ToolPublicationContract.ADMISSION_BYTES;

    private ObjectNode binding;
    private ObjectNode checkpoint;
    private String activationId = "activation-1";
    private long revision;
    private long sequence;
    private String commitDigest;

    @Test
    void materializationRewritesTheSnapshotOnCatchUpOnly() {
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
        // The burst ends with a terminal event, so the batch that covers it
        // rewrites the snapshot even though the snapshot is fresh.
        fixture.store.appendPublicEventIfAbsent(tenant, sessionId, "turn-1",
                "turn.completed", Map.of(), true, "mat-terminal");
        // 82 events with the session's own; the last batch covers the tail.
        int batches = 9;
        List<Long> itemRowsRead = new ArrayList<>();
        List<Long> itemReads = new ArrayList<>();
        List<Long> snapshotWrites = new ArrayList<>();
        for (int batch = 0; batch < batches; batch++) {
            fixture.ledger.reset();
            fixture.tx.executeWithoutResult(status -> fixture.store
                    .materializeNextBatch(tenant, sessionId, perBatch));
            itemRowsRead.add(fixture.ledger.rows(
                    "from managed_agent_item where", "order by first_sequence"));
            itemReads.add(fixture.ledger.count(
                    "from managed_agent_item where", "order by first_sequence"));
            snapshotWrites.add(fixture.ledger.count("into managed_agent_snapshot")
                    + fixture.ledger.count("update managed_agent_snapshot set"));
        }
        System.out.println("[issue-13181] materializeNextBatch per batch:"
                + " itemRowsRead=" + itemRowsRead
                + " itemReads=" + itemReads
                + " snapshotRewrites=" + snapshotWrites);
        // The first batch inserts the snapshot row; the intermediate batches
        // leave it alone; the batch carrying the terminal event rewrites it.
        assertThat(snapshotWrites)
                .containsExactly(1L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 1L);
        // The whole item table is read exactly once per writing batch — the
        // count (not only the row total) is pinned, so an N+1 decomposition
        // of allItems would show here.
        assertThat(itemReads)
                .containsExactly(1L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 1L);
        // Batch 1 covers session.created plus nine tool events; the last
        // batch sees all 80 items.
        assertThat(itemRowsRead)
                .containsExactly(9L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 80L);
        // The caught-up snapshot is complete and self-consistent.
        assertThat(fixture.store.findSnapshot(tenant, sessionId)).get()
                .satisfies(snapshot -> {
                    assertThat(snapshot.coveredSequence()).isEqualTo(fixture
                            .store.requireSession(tenant, sessionId)
                            .lastSequence());
                    assertThat(snapshot.items()).hasSize(80);
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
        Fixture fixture = new Fixture();
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
        // ...but is re-selected once the deferred snapshot ages out.
        fixture.jdbc.update("UPDATE managed_agent_snapshot SET updated_at ="
                        + " updated_at - 6000 WHERE tenant_id = ? AND"
                        + " session_id = ?", tenant, sessionId);
        assertThat(fixture.store.findMaterializationTargets(32))
                .contains(new MaterializationTarget(tenant, sessionId));
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
        fixture.ledger.reset();
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        assertThat(fixture.ledger.count("update managed_agent_snapshot set"))
                .isZero();
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
        // must differ from the other rows'.
        fixture.jdbc.update("UPDATE managed_agent_session SET approval_mode ="
                + " 'confirm' WHERE tenant_id = ? AND session_id = ?",
                bound, boundIds.get(3));
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
        }
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
        ManagedSessionStore sessions = new ManagedSessionStore(fixture.jdbc);
        JdbcRuntimeBindingRepository bindings = new JdbcRuntimeBindingRepository(
                fixture.dataSource,
                new AesGcmSecretProtector("key", new byte[32]),
                () -> "binding-1");
        JdbcToolExecutionRepository executions =
                new JdbcToolExecutionRepository(fixture.dataSource);
        ToolPublicationStore store = new ToolPublicationStore(fixture.jdbc,
                fixture.manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2,
                        10 * ALLOCATION, 10 * ALLOCATION, 10),
                journalHeadAuthorization);
        var runtime = bindings.findOrCreate(new RuntimeProvisionRequest(
                new RuntimeScope("tenant-1", "workspace-1", "generation-1",
                        "/workspace", "capability", "workspace"), null));
        runtime = bindings.claimOperation(runtime.getBindingId(), "owner",
                Duration.ofMinutes(1));
        assertThat(bindings.compareAndSet(runtime, runtime.withState(
                RuntimeBindingRecord.State.READY, null, Instant.now())))
                .isNotNull();
        binding = JSON.createObjectNode()
                .put("publication", ToolPublicationContract.PROTOCOL)
                .put("publicationId", "pub-1").put("turnId", "turn-1")
                .put("executionCallId", "execution-1")
                .put("modelCallId", "model-1")
                .put("runtimeBindingId", "binding-1")
                .put("bindingGeneration", "1").put("captureId", "capture-1")
                .put("revision", 1).put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required")
                .put("writerId", "writer-1").put("writerGeneration", 1)
                .put("activationId", activationId).put("activationEpoch", 1)
                .put("intentSequence", 2);
        binding.set("sessionKey", JSON.createObjectNode()
                .put("tenantId", "tenant-1").put("workspaceId", "workspace-1")
                .put("sessionId", "session-1"));
        String payload =
                "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf hi\"}}";
        binding.put("requestDigest", "sha256:" + digest(payload));
        binding.set("reference", JSON.createObjectNode()
                .put("sessionId", "runtime-1")
                .put("promptId", "runtime-prompt-1")
                .put("callId", "runtime-call-1")
                .put("argsDigest",
                        "sha256:" + digest("{\"command\":\"printf hi\"}")));
        ObjectNode args = JSON.createObjectNode()
                .put("harnessSessionId", "session-1")
                .put("runtimeSessionId", "runtime-1")
                .put("payloadJson", payload);
        binding.set("argsRef", ref("args-1", "managed-tool-input", args));
        checkpoint = JSON.createObjectNode();
        checkpoint.set("identity", JSON.createObjectNode()
                .put("schemaVersion", 1).put("engine", "managed")
                .put("turnId", "turn-1").put("promptId", "runtime-prompt-1")
                .put("activationId", activationId)
                .put("coveredSequence", 2)
                .set("sessionKey", binding.get("sessionKey")));
        checkpoint.set("continuation",
                JSON.createObjectNode().put("phase", "await_runtime"));
        checkpoint.set("tools", JSON.createObjectNode().set("items",
                JSON.createArrayNode().add(JSON.createObjectNode()
                        .put("executionCallId", "execution-1")
                        .put("functionCallId", "model-1")
                        .put("toolName", "run_shell_command")
                        .put("state", "in_progress")
                        .put("outcomeSource", "runtime")
                        .put("inputDigest",
                                digest("{\"command\":\"printf hi\"}")))));
        binding.set("checkpointRef",
                ref("checkpoint-1", "managed-checkpoint", checkpoint));
        executions.findOrCreate(ToolExecutionRecord.prepared("execution-1",
                "idempotency-1", "binding-1", 1, "session-1", "runtime-1",
                "runtime-prompt-1", "runtime-call-1",
                "sha256:" + digest(payload),
                Map.of("sessionId", "runtime-1", "promptId",
                        "runtime-prompt-1", "callId", "runtime-call-1",
                        "argsDigest",
                        "sha256:" + digest("{\"command\":\"printf hi\"}"),
                        "payloadDigest", "sha256:" + digest(payload),
                        "dispatchMode", "deferred_v3", "publicationId",
                        "pub-1")));
        new TransactionTemplate(fixture.manager).executeWithoutResult(status ->
                sessions.acquireWriter("tenant-1", "session-1", WRITER_TOKEN,
                        new ManagedSessionStoreModels.AcquireWriterRequest(
                                "workspace-1", "writer-1", 300000L)));
        append(sessions, fixture.manager, "session.create", "{}\n{}\n", 0,
                List.of(), null);
        ObjectNode intent = JSON.createObjectNode()
                .put("executionCallId", "execution-1")
                .put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        append(sessions, fixture.manager, "tool.dispatch",
                event(1, "activation.changed", activation("active"))
                        + event(2, "tool.intent", intent) + "{}\n", 2,
                List.of(resource(binding.get("argsRef"), args),
                        resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        store.apply(request("reserve"), WRITER_TOKEN, PUBLICATION_TOKEN);
        return new PublicationFixture(sessions, bindings, executions, store);
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
            append(sessions, fixture.manager, "tool.dispatch",
                    event(sequence + 1, "tool.progress",
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
    }

    @Test
    void publicationAuthorizationFencesAReleasedActivationFromTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A release committed after the reserve updates the head columns.
        append(publication.sessions(), fixture.manager, "activation.release",
                event(sequence + 1, "activation.changed",
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
    void preV34CommitSkewStillFencesWhileTheHeadGateIsOff() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture, false);
        // The head columns hold the active activation from the dispatch
        // commit. A pre-V34 binary then commits a release: the journal gains
        // the row and the revision bumps, but the columns stay untouched.
        // Reproduce that exact skew by restoring the columns after a real
        // release commit.
        var head = fixture.jdbc.queryForMap("SELECT activation_id,"
                + " activation_phase, activation_event_epoch,"
                + " activation_expires_at"
                + " FROM qwen_managed_session_journal_head");
        append(publication.sessions(), fixture.manager, "activation.release",
                event(sequence + 1, "activation.changed",
                        activation("released")) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?",
                head.get("activation_id"), head.get("activation_phase"),
                head.get("activation_event_epoch"),
                head.get("activation_expires_at"));
        // The gate ships off: authorization reads the journal and fences
        // the release instead of trusting the stale active head.
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        // The renew path's evidence read must not trust the stale head
        // either.
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
    }

    @Test
    void unrepresentableExpiresAtFencesTheHeadCleanly() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // An activation with no expiresAt: id/phase are stored, the expiry
        // column stays NULL, and the head branch must refuse cleanly (a
        // missing expiry fails exactly like the scan's absent read).
        ObjectNode noExpiry = JSON.createObjectNode()
                .put("activationId", activationId).put("epoch", 1)
                .put("phase", "active");
        append(publication.sessions(), fixture.manager, "activation.no-expiry",
                event(sequence + 1, "activation.changed", noExpiry) + "{}\n",
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
                .put("activationId", activationId).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", "99999999999999999999999999");
        append(publication.sessions(), fixture.manager, "activation.overflow",
                event(sequence + 1, "activation.changed", overflowing)
                        + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM qwen_managed_session_journal_head",
                Long.class)).isNull();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
    }

    @Test
    void expiredActivationFencesThroughTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A warm head carrying an already-expired activation: both grant
        // paths must refuse through the head columns, exactly as the scan
        // would refuse the same payload.
        ObjectNode expired = JSON.createObjectNode()
                .put("activationId", activationId).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", System.currentTimeMillis() - 1000);
        append(publication.sessions(), fixture.manager, "activation.expired",
                event(sequence + 1, "activation.changed", expired) + "{}\n",
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
    }

    @Test
    void legacyHeadRenewBackfillsFromTheJournalScan() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // Simulate a pre-V34 head: the evidence scan on renew authorizes
        // from the journal and backfills the head columns.
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL");
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
    void oversizedJournalActivationFencesAuthorizationCleanly() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A non-conforming writer commits an activation.changed wider than
        // the V34 columns; the commit blanks the head columns.
        append(publication.sessions(), fixture.manager, "activation.oversize",
                event(sequence + 1, "activation.changed",
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
        ManagedSessionStore sessions = publication.sessions();
        ToolPublicationStore store = publication.store();
        JdbcToolExecutionRepository executions = publication.executions();
        int filler = 30;
        for (int index = 0; index < filler; index++) {
            append(sessions, fixture.manager, "tool.dispatch",
                    event(sequence + 1, "tool.progress",
                            JSON.createObjectNode()) + "{}\n",
                    1, List.of(), null);
        }
        // Simulate a journal last written before migration V34.
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL");

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
        ManagedSessionStore sessions = publication.sessions();
        int filler = 30;
        for (int index = 0; index < filler; index++) {
            append(sessions, fixture.manager, "tool.dispatch",
                    event(sequence + 1, "tool.progress",
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
        // The revision range read plus the one verified page: constant,
        // independent of the filler depth.
        assertThat(reads).isEqualTo(3);
    }

    @Test
    void stringExpiresAtReadsConsistentlyAcrossTheScanAndTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        ManagedSessionStore sessions = publication.sessions();
        ToolPublicationStore store = publication.store();
        JdbcToolExecutionRepository executions = publication.executions();
        long expiry = System.currentTimeMillis() + 180000;
        // A non-conforming writer sends expiresAt as a JSON string; the
        // commit must store what the scans have always parsed, or the head
        // would fence what the scan authorizes.
        ObjectNode stringExpiry = JSON.createObjectNode()
                .put("activationId", activationId).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", String.valueOf(expiry));
        append(sessions, fixture.manager, "activation.string-expiry",
                event(sequence + 1, "activation.changed", stringExpiry)
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
        // A pre-V34 head scans the journal, parses the same value, and
        // backfills it; the next authorization reads the head again.
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL");
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
        ObjectNode result = JSON.createObjectNode()
                .put("publication", ToolPublicationContract.PROTOCOL)
                .put("operation", operation);
        result.set("sessionKey", binding.get("sessionKey").deepCopy());
        result.set("owner", JSON.createObjectNode().put("writerId", "writer-1")
                .put("writerGeneration", 1));
        if ("reserve".equals(operation)) {
            result.set("binding", binding.deepCopy());
            result.put("captureBytes", CAPTURE_BYTES);
        } else {
            result.put("publicationId", "pub-1");
        }
        return result;
    }

    private ObjectNode activation(String phase) {
        return JSON.createObjectNode().put("activationId", activationId)
                .put("epoch", 1).put("phase", phase)
                .put("expiresAt", System.currentTimeMillis() + 180000);
    }

    private String event(long number, String kind, JsonNode payload) {
        ObjectNode event = JSON.createObjectNode().put("v", 1)
                .put("sequence", number).put("kind", kind);
        event.set("sessionKey", binding.get("sessionKey"));
        event.set("payload", payload);
        event.set("subject", JSON.createObjectNode().put("type", "activation")
                .put("activationId", activationId).put("epoch", 1));
        return JSON.createObjectNode()
                .put("subtype", "managed_session_event_v1")
                .set("managedSession", event) + "\n";
    }

    private void append(ManagedSessionStore sessions,
            DataSourceTransactionManager manager, String operation,
            String records, int events,
            List<ManagedSessionStoreModels.CommitResource> resources,
            String checkpointId) {
        String nextDigest = events == 0 ? null : digest(records);
        var request = new ManagedSessionStoreModels.CommitTransactionRequest(
                "workspace-1", "writer-1", 1, revision, sequence,
                "transaction-" + revision, operation, "command-" + revision,
                digest(records), events == 0 ? 0 : sequence + 1,
                sequence + events, events, nextDigest, commitDigest,
                nextDigest, events == 0 ? 0 : 1, checkpointId,
                events == 0 ? 2 : events + 1,
                Base64.getEncoder().encodeToString(
                        records.getBytes(StandardCharsets.UTF_8)),
                digest(records), resources);
        new TransactionTemplate(manager).executeWithoutResult(status ->
                sessions.commit("tenant-1", "session-1", WRITER_TOKEN,
                        request));
        revision++;
        sequence += events;
        commitDigest = nextDigest;
    }

    private static ObjectNode ref(String id, String kind, JsonNode body) {
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind)
                .put("schemaVersion", 1)
                .put("byteLength",
                        body.toString().getBytes(StandardCharsets.UTF_8).length)
                .put("digest", digest(body.toString()));
    }

    private static ManagedSessionStoreModels.CommitResource resource(
            JsonNode ref, JsonNode body) {
        return new ManagedSessionStoreModels.CommitResource(
                ref.path("resourceId").asText(), ref.path("kind").asText(), 1,
                ref.path("byteLength").asLong(), ref.path("digest").asText(),
                Base64.getEncoder().encodeToString(
                        body.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private static String digest(String value) {
        return ToolPublicationContract.sha256(
                value.getBytes(StandardCharsets.UTF_8));
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
                    mock(HarnessConnector.class), registry);
            service.setActions(new ManagedActionStore(jdbc, store));
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
