package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationVerifier;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.ACTIVATION_ID;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.COMMIT_MARKER;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.resource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Pinned query budgets for GitHub issue #13181: four managed-agent hot paths
 * must not amplify database work. Every assertion is derived from statements
 * recorded through a proxy DataSource over H2 (MySQL mode), exercising the
 * production store/service classes exactly as the runtime wiring does.
 *
 * <ol>
 *   <li>materializeNextBatch reads only the current batch and referenced message
 *       parts; it never reads the complete history or writes public snapshots.</li>
 *   <li>The SSE fan-out re-checks the workspace read grant once per recheck
 *       window, not per delivered event.</li>
 *   <li>listPublicSessions / listWebShellSessions assemble a page from a
 *       fixed number of grouped batch queries.</li>
 *   <li>Tool-publication authorization and async heartbeats
 *       read activation state from the journal head and refuse stale projections.</li>
 * </ol>
 */
class Issue13181QueryBudgetTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private PublicationJournalFixture journal;
    private ObjectNode binding;
    private ObjectNode checkpoint;

    @Test
    void materializationReadsOnlyTheCurrentBatchAndNeverWritesSnapshots() {
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
        // The terminal event settles the message within the final bounded batch.
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
                    "from ma_message where", "order by first_sequence"));
            // The single fragment also counts the per-event attributes read
            // (the trailing " where" keeps ma_message out).
            itemReads.add(fixture.ledger.count("from ma_message where"));
            partReads.add(fixture.ledger.count(
                    "select parts_json, body_resource_key from ma_message"));
            snapshotWrites.add(fixture.ledger.count("insert into ma_snapshot"));
            totals.add(fixture.ledger.total());
        }
        System.out.println("[issue-13181] materializeNextBatch per batch:"
                + " itemRowsRead=" + itemRowsRead
                + " itemReads=" + itemReads
                + " partReads=" + partReads
                + " snapshotRewrites=" + snapshotWrites
                + " totals=" + totals);
        assertThat(snapshotWrites).containsOnly(0L);
        // Attributes are read per tool event; the last batch also reads its text
        // part and revision while flushing that one message.
        assertThat(itemReads)
                .containsExactly(9L, 10L, 10L, 10L, 10L, 10L, 10L, 10L, 3L);
        // The parts read rides the same discipline; the last batch also
        // projects the text delta, which reads the part it continues.
        assertThat(partReads)
                .containsExactly(0L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 1L);
        // Five statements acquire Session/stream progress, read the batch and
        // commit coverage. Each new tool costs three; the final batch also
        // reads/inserts/flushes one text message and settles its items.
        assertThat(totals)
                .containsExactly(32L, 35L, 35L, 35L, 35L, 35L, 35L, 35L, 15L);
        assertThat(itemRowsRead).containsOnly(0L);
        var page = fixture.tx.execute(status ->
                fixture.store.findMessagePage(tenant, sessionId, null, 100, false));
        assertThat(page.coveredSequence()).isEqualTo(fixture
                .store.requireSession(tenant, sessionId).lastSequence());
        assertThat(page.items()).hasSize(81);
    }

    @Test
    void emptyBatchReadsOnlyProgressAndDoesNotScheduleCaughtUpSessions() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "empty-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        fixture.ledger.reset();
        var result = fixture.tx.execute(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 200));
        assertThat(result.advanced()).isFalse();
        assertThat(result.coveredSequence()).isEqualTo(1);
        assertThat(fixture.ledger.total()).isEqualTo(4);
        assertThat(fixture.ledger.count("ma_snapshot")).isZero();
        assertThat(fixture.ledger.count("from ma_message")).isZero();
        assertThat(fixture.store.findMaterializationTargets(32)).isEmpty();
    }

    @Test
    void replayFloorStaysClampedToTheLaggingMessageProjection() {
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
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 100));
        long coveredBefore = fixture.store
                .findMessageCoveredSequences(tenant, List.of(sessionId))
                .getOrDefault(sessionId, 0L);
        for (int index = 0; index < 3; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-lag-" + index, "status", "completed"),
                    false, "floor-lag-" + index);
        }
        fixture.tx.executeWithoutResult(status -> fixture.store
                .materializeNextBatch(tenant, sessionId, 2));
        long covered = fixture.store.findMessageCoveredSequences(tenant,
                List.of(sessionId)).getOrDefault(sessionId, 0L);
        assertThat(covered).isEqualTo(coveredBefore + 2);
        long lastSequence = fixture.store.requireSession(tenant, sessionId).lastSequence();
        assertThat(covered).isLessThan(lastSequence);
        assertThat(fixture.store.advanceReplayFloor(tenant, sessionId, lastSequence)
                .floorSequence()).isEqualTo(covered);
    }

    @Test
    void eventStreamRechecksReadPermissionOnAWindow() throws Exception {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        fixture.jdbc.update("INSERT INTO ma_workspace"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?,"
                + " 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES"
                + " (?, 'workspace', ?, 'OPERATOR')", tenant,
                "actor".getBytes(StandardCharsets.UTF_8));
        String sessionId = fixture.tx.execute(status -> fixture.store
                .insertWorkspaceSessionCommand(tenant, "actor",
                        "sse-" + UUID.randomUUID(), "digest", "qwen-code",
                        null, null, List.of(), null,
                        new WorkspaceSelection("workspace", "."))).sessionId();
        long after = fixture.store.requireSession(tenant, sessionId)
                .lastSequence();
        int events = 20;
        EventStreams.RecordingEmitter emitter = EventStreams.RecordingEmitter
                .withTimeout(60_000);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            ManagedAgentProperties properties = EventStreams.pinnedProperties();
            // Longer than the completion budget, so no in-loop recheck can
            // fire mid-test even on a stalled runner.
            properties.getEvents()
                    .setReadGrantRecheckInterval(Duration.ofSeconds(60));
            ManagedEventStreamService streams = EventStreams.streams(
                    fixture.service, fixture.hub, executor, properties,
                    emitter);
            fixture.ledger.reset();
            streams.publicStream(tenant, "actor", sessionId, after);
            // The first in-loop grant check proves the hub subscription
            // exists, so published events can no longer be dropped.
            await().atMost(Duration.ofSeconds(10)).until(() ->
                    fixture.ledger.count("ma_workspace_access") >= 2);
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
            long grants = fixture.ledger.count("ma_workspace_access");
            System.out.println("[issue-13181] workspace session stream of "
                    + (events + 1) + " events ran " + grants
                    + " ma_workspace_access read-grant queries");
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
        EventStreams.RecordingEmitter emitter = EventStreams.RecordingEmitter
                .withTimeout(60_000);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            ManagedEventStreamService streams = EventStreams.streams(
                    fixture.service, fixture.hub, executor, emitter);
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
            assertThat(fixture.ledger.count("ma_workspace_access"))
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
        // turns; materializing then produces a real message coverage value
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
        fixture.jdbc.update("UPDATE ma_turn SET status ="
                + " 'COMPLETED' WHERE tenant_id = ? AND session_id = ?",
                plain, plainIds.get(7));
        fixture.ledger.reset();
        var publicPage = fixture.service.listPublicSessions(plain, null, null,
                20).data();
        assertThat(publicPage).hasSize(20);
        System.out.println("[issue-13181] listPublicSessions(20 rows): "
                + fixture.ledger.summary());
        // Page + active turns + message coverage.
        assertThat(fixture.ledger.total()).isEqualTo(3);
        // The batch turn read projects only the summary columns; the page
        // never holds a parsed prompt graph per row.
        assertThat(fixture.ledger.count("select * from ma_turn"))
                .isZero();
        assertThat(fixture.ledger.count("session_id, turn_id, status,"
                + " gmt_create, completed_at, error_code"
                + " from ma_turn")).isEqualTo(1);
        // Every row carries its own title, its own active turn, and its own
        // message coverage: session 7 is the one without an active turn,
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
        // Page + latest turns + environment events + lifecycle summary; unbound rows read no model metadata.
        assertThat(fixture.ledger.total()).isEqualTo(4);
        assertThat(fixture.ledger.count("row_number() over (partition by o.session_id")).isEqualTo(1);
        // The latest-turn batch read projects only the summary columns.
        assertThat(fixture.ledger.count("turn_record.*")).isZero();
        assertThat(fixture.ledger.count("turn_record.session_id,"
                + " turn_record.turn_id, turn_record.status,"
                + " turn_record.gmt_create, turn_record.completed_at,"
                + " turn_record.error_code"
                + " from ma_turn")).isEqualTo(1);
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
        // Session read + latest turns + environment events + lifecycle summary, one each.
        assertThat(fixture.ledger.total()).isEqualTo(4);

        String bound = "tenant-" + UUID.randomUUID();
        fixture.jdbc.update("INSERT INTO ma_workspace"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?,"
                + " 'ACTIVE')", bound, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES"
                + " (?, 'workspace', ?, 'OPERATOR')", bound,
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
        fixture.jdbc.update("UPDATE ma_session SET approval_mode ="
                + " 'confirm' WHERE tenant_id = ? AND session_id = ?",
                bound, boundIds.get(3));
        String closeSession = boundIds.get(5);
        String closeId = "op_" + UUID.randomUUID();
        String closeScope = ManagedSessionStore.sessionScopeKey(bound, closeSession);
        fixture.jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, target_kind,"
                + " target_key, request_json, phase, tenant_id, session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state, admission_stage, delivery_state, session_status_before,"
                + " receipt_id, available_at, gmt_create, gmt_modified, completed_at)"
                + " VALUES (?, ?, ?, 'SESSION', ?, '{}', 'COMPLETED', ?, ?, ?, 'CLOSE', '', 'close-key',"
                + " 'digest', 'COMPLETED', 'JAVA_DURABLE', 'CONFIRMED', 'CLOSED', 'rcpt', 0, 0, 0, 0)",
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(closeScope, "CLOSE", closeId),
                closeScope, closeScope, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(closeSession),
                bound, closeSession, closeId);
        fixture.ledger.reset();
        var boundPublic = fixture.service.listPublicSessions(bound, "actor",
                null, 20).data();
        assertThat(boundPublic).hasSize(20);
        System.out.println("[issue-13181] listPublicSessions(20 workspace"
                + " rows): " + fixture.ledger.summary());
        // Page + active turns + covered sequences + the workspace-close
        // batch; compression adds its projection, missing-head and active-operation
        // batches. The approval mode rides on the page's own SELECT *.
        assertThat(fixture.ledger.total()).isEqualTo(7);
        assertThat(fixture.ledger.count(
                "approval_mode from ma_session"))
                .isZero();
        assertThat(fixture.ledger.count("from ma_operation"))
                .isEqualTo(2);
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
        // rides on the page's own SELECT *. Model selection, context, approval
        // selection, ownership and lifecycle summary add one bounded query each;
        // compression adds three page-wide batches.
        assertThat(fixture.ledger.total()).isEqualTo(11);
        assertThat(fixture.ledger.count("coalesce(selected_approval_mode, approval_mode)")).isEqualTo(1);
        assertThat(fixture.ledger.count("coalesce(owner_actor_key, creator_actor_key)")).isEqualTo(1);
        assertThat(fixture.ledger.count("select session_id, model_id, model_revision from ma_session")).isEqualTo(1);
        assertThat(fixture.ledger.count("from ma_session_record r join ma_resource u")).isEqualTo(1);
        assertThat(fixture.ledger.count(
                "approval_mode from ma_session"))
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
    void boundWebShellPageBatchesTheRoleSubmitCapability() {
        Fixture fixture = new Fixture();
        when(fixture.harness.isWorkspaceFilesAvailable()).thenReturn(true);
        String tenant = "tenant-" + UUID.randomUUID();
        fixture.jdbc.update("INSERT INTO ma_workspace"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?,"
                + " 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        for (String actor : new String[] {"actor", "other"}) {
            fixture.jdbc.update("INSERT INTO ma_workspace_access"
                    + " (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES (?, 'workspace', ?, 'OPERATOR')",
                    tenant, actor.getBytes(StandardCharsets.UTF_8));
        }
        // A second workspace where the actor's role lands below OPERATOR:
        // its session exercises the grant's role term, and the page's two
        // workspaces make the grant batch's single-query shape
        // discriminable.
        fixture.jdbc.update("INSERT INTO ma_workspace"
                + " (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES (?, X'776f726b737061636532', 1, 'storage', 'Workspace2', ?,"
                + " ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        fixture.jdbc.update("INSERT INTO ma_workspace_access"
                + " (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, X'776f726b737061636532', ?, 'OPERATOR')",
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
        // An eighth session whose creator has no access row at all — the
        // caller stays OPERATOR while its creator's grant is gone, the
        // shape the executable conjunct alone must refuse on.
        fixture.jdbc.update("INSERT INTO ma_workspace_access"
                + " (tenant_id, workspace_id, actor_id, role) VALUES (?,"
                + " 'workspace', ?, 'OPERATOR')", tenant,
                "ghost".getBytes(StandardCharsets.UTF_8));
        ids.add(fixture.tx.execute(status -> fixture.store
                .insertWorkspaceSessionCommand(tenant, "ghost",
                        "ws-ghost-" + UUID.randomUUID(), "digest",
                        "qwen-code", null, "w-ghost", List.of(), null,
                        new WorkspaceSelection("workspace", ".")))
                .sessionId());
        fixture.jdbc.update("DELETE FROM ma_workspace_access"
                + " WHERE tenant_id = ? AND workspace_id = X'776f726b7370616365'"
                + " AND actor_id = ?", tenant,
                "ghost".getBytes(StandardCharsets.UTF_8));
        // One session is closed: the shape gate fences it. The workspace2
        // grant then drops to READER: its session exercises the role term.
        // Only "other", creator of indices 4 and 5, drops with "actor"
        // keeping OPERATOR, so those two Sessions fail the creator-keyed
        // facts while the caller's own role is intact.
        fixture.jdbc.update("UPDATE ma_session SET status ="
                + " 'CLOSED' WHERE tenant_id = ? AND session_id = ?", tenant,
                ids.get(3));
        fixture.jdbc.update("UPDATE ma_workspace_access SET"
                + " role = 'READER' WHERE tenant_id = ? AND workspace_id"
                + " = X'776f726b737061636532'", tenant);
        fixture.jdbc.update("UPDATE ma_workspace_access SET role ="
                + " 'READER' WHERE tenant_id = ? AND workspace_id ="
                + " X'776f726b7370616365' AND actor_id = ?", tenant,
                "other".getBytes(StandardCharsets.UTF_8));
        fixture.ledger.reset();
        var page = fixture.service.listWebShellSessions(tenant, "actor",
                null, 20).data();
        assertThat(page).hasSize(8);
        System.out.println("[issue-13181] listWebShellSessions(8 mixed"
                + " role rows): " + fixture.ledger.summary());
        // Page + latest turns + the close batch + the grant batch across
        // both workspaces + the execution-facts batch over the
        // submit-shaped sessions, plus model/context, approval/owner and lifecycle batches:
        // compression projection, missing-head and operation batches remain
        // constant, not per row.
        assertThat(fixture.ledger.total()).isEqualTo(13);
        assertThat(fixture.ledger.count("row_number() over (partition by o.session_id")).isEqualTo(1);
        assertThat(fixture.ledger.count("coalesce(selected_approval_mode, approval_mode)")).isEqualTo(1);
        assertThat(fixture.ledger.count("coalesce(owner_actor_key, creator_actor_key)")).isEqualTo(1);
        assertThat(fixture.ledger.count("select session_id, model_id, model_revision from ma_session")).isEqualTo(1);
        assertThat(fixture.ledger.count("from ma_session_record r join ma_resource u")).isEqualTo(1);
        assertThat(fixture.ledger.count("from ma_workspace r join ma_workspace_access"))
                .isEqualTo(1);
        assertThat(fixture.ledger.count("from ma_session s left join ma_workspace", "creator_actor_key")).isEqualTo(1);
        // workspaceTurns holds exactly for ACTIVE sessions whose caller
        // holds OPERATOR or above on the Workspace AND whose creator still
        // holds the execution-registry facts — the two conjuncts split at
        // indices 4, 5 and 7.
        for (var row : page) {
            int index = ids.indexOf(row.sessionId());
            assertThat(row.capabilities().workspaceTurns())
                    .isEqualTo(index != 3 && index != 6 && index != 4
                            && index != 5 && index != 7);
        }

        // A caller whose only grant is READER pays no facts read at all,
        // the zero-query shape the removed creator chain provided.
        fixture.jdbc.update("INSERT INTO ma_workspace_access"
                + " (tenant_id, workspace_id, actor_id, role) VALUES (?,"
                + " 'workspace', ?, 'READER')", tenant,
                "reader-only".getBytes(StandardCharsets.UTF_8));
        fixture.ledger.reset();
        var readerPage = fixture.service.listWebShellSessions(tenant,
                "reader-only", null, 20).data();
        assertThat(fixture.ledger.count("from ma_session s left join ma_workspace", "creator_actor_key")).isZero();
        for (var row : readerPage) {
            assertThat(row.capabilities().workspaceTurns()).isFalse();
        }
    }

    @Test
    void contextChangeCapabilitySharesTheGrantAndFactsBatchesRegardlessOfPageSize() {
        for (int size : new int[] {1, 20}) {
            Fixture fixture = new Fixture(Clock.systemUTC(), true, true);
            when(fixture.harness.supportsModelSelection()).thenReturn(true);
            when(fixture.harness.isWorkspaceFilesAvailable()).thenReturn(true);
            String tenant = "cwd-" + UUID.randomUUID();
            fixture.createCwdSessions(tenant, size);
            fixture.ledger.reset();
            var page = fixture.service.listWebShellSessions(tenant, "actor", null, 20).data();
            assertThat(page).hasSize(size);
            assertThat(page).allSatisfy(row -> assertThat(JSON.valueToTree(row).path("capabilities").path("modelChange").asBoolean()).isTrue());
            assertThat(fixture.ledger.total()).isEqualTo(13);
            assertThat(fixture.ledger.count("select session_id, revision from ma_session_record")).isEqualTo(1);
            assertThat(fixture.ledger.count("head_kind = 'managed_session'")).isEqualTo(1);
            assertThat(fixture.ledger.count("operation_kind = 'context_compression'")).isEqualTo(1);
            assertThat(fixture.ledger.count("row_number() over (partition by o.session_id")).isEqualTo(1);
            assertThat(fixture.ledger.count("coalesce(selected_approval_mode, approval_mode)")).isEqualTo(1);
            assertThat(fixture.ledger.count("coalesce(owner_actor_key, creator_actor_key)")).isEqualTo(1);
            assertThat(fixture.ledger.count("select session_id, model_id, model_revision from ma_session")).isEqualTo(1);
            assertThat(fixture.ledger.count("from ma_session_record r join ma_resource u")).isEqualTo(1);
            assertThat(fixture.ledger.count("from ma_session s left join ma_workspace", "creator_actor_key")).isEqualTo(1);
        }
    }

    @Test
    void executableFactsBatchInheritsOnlyAnExactParentBindingAndRejectsCycles() {
        Fixture fixture = new Fixture(Clock.systemUTC(), true, true);
        when(fixture.harness.supportsModelSelection()).thenReturn(true);
        String tenant = "lineage-" + UUID.randomUUID();
        List<String> ids = fixture.createCwdSessions(tenant, 3);
        String parent = ids.get(0);
        String child = ids.get(1);
        String grandchild = ids.get(2);
        fixture.jdbc.update("UPDATE ma_session SET parent_session_id = ?, creator_actor_key = NULL"
                + " WHERE tenant_id = ? AND session_id = ?", parent, tenant, child);
        fixture.jdbc.update("UPDATE ma_session SET parent_session_id = ?, creator_actor_key = NULL"
                + " WHERE tenant_id = ? AND session_id = ?", child, tenant, grandchild);
        fixture.ledger.reset();
        assertThat(fixture.store.sessionsWithExecutionRegistryFacts(tenant, ids)).containsExactlyInAnyOrderElementsOf(ids);
        assertThat(fixture.ledger.total()).isEqualTo(1);
        fixture.ledger.reset();
        assertThat(fixture.store.sessionsWithExecutionRegistryFacts(tenant, List.of(grandchild))).containsExactly(grandchild);
        assertThat(fixture.ledger.total()).isEqualTo(3);
        fixture.jdbc.update("UPDATE ma_session SET workspace_generation = 2 WHERE tenant_id = ? AND session_id = ?", tenant, child);
        assertThat(fixture.store.sessionsWithExecutionRegistryFacts(tenant, ids)).containsExactly(parent);
        fixture.jdbc.update("UPDATE ma_session SET workspace_generation = 1, parent_session_id = ? WHERE tenant_id = ? AND session_id = ?", grandchild, tenant, parent);
        assertThat(fixture.store.sessionsWithExecutionRegistryFacts(tenant, ids)).isEmpty();
    }

    @Test
    void contextChangeCapabilityMirrorsAdmissionWithoutTheTurnProfileRestrictions() {
        Fixture fixture = new Fixture(Clock.systemUTC(), true, true);
        when(fixture.harness.supportsModelSelection()).thenReturn(true);
        String tenant = "cwd-" + UUID.randomUUID();
        String id = fixture.createCwdSessions(tenant, 1).getFirst();
        fixture.jdbc.update("UPDATE ma_session SET agent_id = 'custom' WHERE tenant_id = ? AND session_id = ?", tenant, id);
        var view = fixture.service.getWebShellSession(tenant, "actor", id);
        assertThat(view.capabilities().workspaceTurns()).isFalse();
        assertThat(JSON.valueToTree(view).path("capabilities").path("modelChange").asBoolean()).isTrue();
        // Busy admission remains separate from support and authorization.
        fixture.store.insertTurnCommand(tenant, "SUBMIT", "busy", "digest", id, List.of(Map.of("type", "text", "text", "test")), "digest");
        assertThat(JSON.valueToTree(fixture.service.getWebShellSession(tenant, "actor", id)).path("capabilities").path("modelChange").asBoolean()).isTrue();
    }

    @Test
    void contextChangeCapabilityRequiresOperatorRoleAndExactRegistryFacts() {
        Fixture fixture = new Fixture(Clock.systemUTC(), true, true);
        when(fixture.harness.supportsModelSelection()).thenReturn(true);
        String tenant = "cwd-" + UUID.randomUUID();
        String id = fixture.createCwdSessions(tenant, 1).getFirst();
        // A non-creator holding OPERATOR on the Workspace sees the
        // capability, mirroring admission's atLeast(OPERATOR); a READER
        // does not.
        fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "other".getBytes(StandardCharsets.UTF_8));
        assertThat(JSON.valueToTree(fixture.service.getWebShellSession(tenant, "other", id)).path("capabilities").path("modelChange").asBoolean()).isTrue();
        fixture.jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE tenant_id = ? AND workspace_id = X'776f726b7370616365' AND actor_id = ?", tenant, "other".getBytes(StandardCharsets.UTF_8));
        assertThat(JSON.valueToTree(fixture.service.getWebShellSession(tenant, "other", id)).path("capabilities").path("modelChange").asBoolean()).isFalse();
        for (String mutation : new String[] {
                "UPDATE ma_workspace SET state = 'DRAINING'",
                "UPDATE ma_workspace SET state = 'ACTIVE', workspace_generation = 2",
                "UPDATE ma_workspace SET workspace_generation = 1, storage_id = 'other-storage'",
                "UPDATE ma_workspace SET storage_id = 'storage'; UPDATE ma_workspace_access SET role = 'READER'"
        }) {
            // This fixture has only one tenant; each mutation proves a separate admission conjunct.
            for (String statement : mutation.split(";")) {
                fixture.jdbc.update(statement);
            }
            assertThat(JSON.valueToTree(fixture.service.getWebShellSession(tenant, "actor", id)).path("capabilities").path("modelChange").asBoolean()).isFalse();
        }
        fixture.jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'");
        fixture.jdbc.update("UPDATE ma_session SET status = 'CLOSED'");
        assertThat(JSON.valueToTree(fixture.service.getWebShellSession(tenant, "actor", id)).path("capabilities").path("modelChange").asBoolean()).isFalse();
    }

    @Test
    void contextChangeCapabilityChecksTheCallerRoleOnEachWorkspaceOfAMixedPage() {
        Fixture fixture = new Fixture(Clock.systemUTC(), true, true);
        when(fixture.harness.supportsModelSelection()).thenReturn(true);
        String tenant = "cwd-" + UUID.randomUUID();
        String readRow = fixture.createCwdSessions(tenant, 1).getFirst();
        fixture.jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'workspace-2', 1, 'storage-2', 'Workspace 2', ?, ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'workspace-2', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        String operateRow = fixture.tx.execute(status -> fixture.store.insertWorkspaceSessionCommand(tenant, "actor", UUID.randomUUID().toString(), "digest", "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace-2", "."))).sessionId();
        fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'workspace', ?, 'READER')", tenant, "other".getBytes(StandardCharsets.UTF_8));
        fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'workspace-2', ?, 'OPERATOR')", tenant, "other".getBytes(StandardCharsets.UTF_8));
        fixture.ledger.reset();
        var page = fixture.service.listWebShellSessions(tenant, "other", null, 20).data();
        java.util.Map<String, Boolean> cwd = new java.util.HashMap<>();
        for (var row : page) {
            cwd.put(row.sessionId(), row.capabilities().modelChange());
        }
        assertThat(cwd).hasSize(2).containsEntry(operateRow, true).containsEntry(readRow, false);
        assertThat(fixture.ledger.count("from ma_session s left join ma_workspace", "creator_actor_key")).isEqualTo(1);
    }

    @Test
    void contextChangeCapabilityDoesNotPayForRegistryFactsWhenDisabledOrReaderOnly() {
        for (boolean enabled : new boolean[] {false, true}) {
            Fixture fixture = new Fixture(Clock.systemUTC(), enabled, true);
            when(fixture.harness.supportsModelSelection()).thenReturn(true);
            String tenant = "cwd-" + UUID.randomUUID();
            fixture.createCwdSessions(tenant, 1);
            fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'workspace', ?, 'READER')", tenant, "reader".getBytes(StandardCharsets.UTF_8));
            fixture.ledger.reset();
            var page = fixture.service.listWebShellSessions(tenant, "reader", null, 20).data();
            assertThat(page).hasSize(1);
            assertThat(JSON.valueToTree(page.getFirst()).path("capabilities").path("modelChange").asBoolean()).isFalse();
            assertThat(fixture.ledger.count("from ma_session s left join ma_workspace", "creator_actor_key")).isZero();
        }
    }

    @Test
    void transcriptLeavesUnmaterializedTailForEventReplay() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "tail-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        // A partial drain leaves committed events beyond the message projection.
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
        long covered = fixture.store
                .findMessageCoveredSequences(tenant, List.of(sessionId))
                .getOrDefault(sessionId, 0L);
        long lastSequence = fixture.store.requireSession(tenant, sessionId).lastSequence();
        assertThat(covered).isLessThan(lastSequence);
        fixture.ledger.reset();
        var transcript = fixture.tx.execute(status ->
                fixture.service.transcript(tenant, null, sessionId, null, 10));
        assertThat(transcript.items()).hasSize(10);
        assertThat(transcript.hasMore()).isTrue();
        assertThat(transcript.olderCursor()).isNotNull();
        assertThat(transcript.coveredSequence()).isEqualTo(covered);
        assertThat(transcript.lastSequence()).isEqualTo(covered);
        assertThat(transcript.events()).allSatisfy(event ->
                assertThat(event.sequence()).isLessThanOrEqualTo(covered));
        assertThat(fixture.ledger.count("from ma_public_event", "sequence_id >")).isZero();
        assertThat(fixture.ledger.rows("from ma_message m", "limit")).isEqualTo(11);
        var tail = fixture.service.publicEvents(tenant, null, sessionId,
                transcript.lastSequence(), 100).data();
        assertThat(tail).hasSize((int) (lastSequence - covered));
        assertThat(tail.getFirst().sequence()).isEqualTo(covered + 1);
        assertThat(tail.getLast().sequence()).isEqualTo(lastSequence);
    }

    @Test
    void transcriptReadBudgetDoesNotGrowWithUnmaterializedTail() {
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
        long covered = fixture.store.findMessageCoveredSequences(tenant, List.of(sessionId))
                .getOrDefault(sessionId, 0L);
        for (int index = 0; index < 999; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-b-" + index, "status", "completed"),
                    false, "lag-b-" + index);
        }
        fixture.ledger.reset();
        var transcript = fixture.tx.execute(status ->
                fixture.service.transcript(tenant, null, sessionId, null, 10));
        assertThat(transcript.items()).hasSize(5);
        assertThat(transcript.coveredSequence()).isEqualTo(covered);
        assertThat(transcript.lastSequence()).isEqualTo(covered);
        assertThat(transcript.events()).allSatisfy(event ->
                assertThat(event.sequence()).isLessThanOrEqualTo(covered));
        assertThat(transcript.hasMore()).isFalse();
        assertThat(fixture.ledger.count("from ma_public_event", "sequence_id >")).isZero();
        long reads = fixture.ledger.total();
        for (int index = 0; index < 600; index++) {
            fixture.store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn-1", "item.tool_call.updated",
                    Map.of("callId", "call-c-" + index, "status", "completed"),
                    false, "lag-c-" + index);
        }
        fixture.ledger.reset();
        var longer = fixture.tx.execute(status ->
                fixture.service.transcript(tenant, null, sessionId, null, 10));
        assertThat(longer.items()).isEqualTo(transcript.items());
        assertThat(longer.coveredSequence()).isEqualTo(covered);
        assertThat(longer.lastSequence()).isEqualTo(covered);
        assertThat(longer.hasMore()).isFalse();
        assertThat(fixture.ledger.count("from ma_public_event", "sequence_id >")).isZero();
        assertThat(fixture.ledger.total()).isEqualTo(reads);
    }

    @Test
    void batchTurnReadsFollowAdmissionOrderNotCreatedAt() {
        Fixture fixture = new Fixture();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = fixture.store.insertSessionCommand(tenant,
                "CREATE_SESSION", "order-" + UUID.randomUUID(), "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        // Two Turns admitted out of gmt_create order: the turn.accepted
        // sequence makes turn-b the latest even though turn-a's gmt_create
        // is later.
        String turnA = fixture.store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "order-a-" + UUID.randomUUID(), "digest", sessionId,
                List.of(Map.of("type", "text", "text", "a")), "digest")
                .turnId();
        fixture.jdbc.update("UPDATE ma_turn SET status ="
                        + " 'COMPLETED' WHERE tenant_id = ? AND turn_id = ?",
                tenant, turnA);
        String turnB = fixture.store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "order-b-" + UUID.randomUUID(), "digest", sessionId,
                List.of(Map.of("type", "text", "text", "b")), "digest")
                .turnId();
        fixture.jdbc.update("UPDATE ma_turn SET gmt_create ="
                        + " gmt_create + 10000 WHERE tenant_id = ? AND"
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
        journal = PublicationJournalFixture.create(fixture.dataSource);
        binding = journal.binding;
        checkpoint = journal.checkpoint;
        journal.reserve();
        return new PublicationFixture(journal.sessions, journal.bindings,
                journal.executions, journal.store);
    }

    @Test
    void asynchronousVerificationHeartbeatsAndStatusAvoidJournalBodyReads() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        byte[] bytes = new byte[] {1, 2, 3, 4};
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] input) {}

            @Override
            public InputStream open(String key) {
                return open(key, () -> {});
            }

            @Override
            public InputStream open(String key, Runnable guard) {
                return new ByteArrayInputStream(bytes) {
                    @Override
                    public synchronized int read(byte[] buffer, int offset, int length) {
                        try {
                            Thread.sleep(120);
                        } catch (InterruptedException error) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException(error);
                        }
                        guard.run();
                        return super.read(buffer, offset, Math.min(length, 1));
                    }
                };
            }

            @Override
            public void validateConfiguration() {}
        };
        ToolPublicationDataStore data = new ToolPublicationDataStore(fixture.jdbc, fixture.manager,
                publication.store(), publication.sessions(), bucket, Duration.ofSeconds(10), Duration.ofMillis(300),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        data.publishSegment(binding.path("sessionKey"), "pub-1", PUBLICATION_TOKEN, "async-heartbeat",
                "stdout", 0, bytes, null, true);
        fixture.ledger.reset();
        try (var verifier = new ToolPublicationVerifier(data, 1)) {
            assertThat(verifier.runOnce()).isTrue();
            long renewals = fixture.ledger.count("update ma_operation set",
                    "claim_until = ?, verification_next_at = case when");
            assertThat(renewals).isGreaterThanOrEqualTo(2);
            assertThat(fixture.ledger.count("from ma_session_journal_tx")).isZero();
            assertThat(fixture.ledger.count("from ma_session_head", "for update"))
                    .isGreaterThanOrEqualTo(2 * (renewals + 1));
            await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
                verifier.runOnce();
                assertThat(data.operationStatus(binding.path("sessionKey"), "pub-1", PUBLICATION_TOKEN, "async-heartbeat")
                        .path("state").asText()).isEqualTo("SUCCEEDED");
            });
        }
        fixture.ledger.reset();
        for (int i = 0; i < 12; i++) {
            assertThat(data.operationStatus(binding.path("sessionKey"), "pub-1", PUBLICATION_TOKEN, "async-heartbeat")
                    .path("state").asText()).isEqualTo("SUCCEEDED");
        }
        assertThat(fixture.ledger.total()).isEqualTo(12);
        assertThat(fixture.ledger.count("from ma_session_journal_tx")).isZero();
        assertThat(fixture.ledger.count("from ma_session_head")).isZero();
    }

    @Test
    void frequentReadsDoNotRenewBeforeTheHeartbeatIntervalOrFetchInlineBytes() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        byte[] bytes = new byte[1024];
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override public void putIfAbsent(String key, byte[] input) {}
            @Override public InputStream open(String key) { return open(key, () -> {}); }
            @Override public InputStream open(String key, Runnable guard) {
                return new ByteArrayInputStream(bytes) {
                    @Override public synchronized int read(byte[] buffer, int offset, int length) {
                        guard.run();
                        reads.incrementAndGet();
                        return super.read(buffer, offset, Math.min(length, 1));
                    }
                };
            }
            @Override public void validateConfiguration() {}
        };
        // A five-minute lease gives a 100-second interval, well beyond this bounded read.
        ToolPublicationDataStore data = new ToolPublicationDataStore(fixture.jdbc, fixture.manager,
                publication.store(), publication.sessions(), bucket, Duration.ofMinutes(10), Duration.ofMinutes(5),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        data.publishSegment(binding.path("sessionKey"), "pub-1", PUBLICATION_TOKEN, "async-fast-read",
                "stdout", 0, bytes, null, true);
        fixture.ledger.reset();
        try (var verifier = new ToolPublicationVerifier(data, 1)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(data.operationStatus(binding.path("sessionKey"), "pub-1", PUBLICATION_TOKEN, "async-fast-read")
                .path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(reads).hasValueGreaterThan(1000);
        assertThat(fixture.ledger.count("update ma_operation set",
                "claim_until = ?, verification_next_at = case when")).isZero();
        assertThat(fixture.ledger.count("select inline_bytes from ma_resource")).isZero();
        assertThat(fixture.ledger.count("from ma_session_journal_tx")).isZero();
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
                        + " FROM ma_session_journal_tx",
                Long.class);

        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
                "for update")).isZero();

        int filler = 30;
        for (int index = 0; index < filler; index++) {
            append("tool.dispatch",
                    event(journal.sequence + 1, "tool.intent",
                            JSON.createObjectNode()) + COMMIT_MARKER,
                    1, List.of(), null);
        }
        long head = fixture.jdbc.queryForObject("SELECT MAX(journal_revision)"
                + " FROM ma_session_journal_tx", Long.class);
        assertThat(head).isEqualTo(activationRevision + filler);

        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        long scans = fixture.ledger.count(
                "from ma_session_journal_tx", "for update");
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
            public void validateConfiguration() {
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
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
                "for update")).isZero();
        // Positive control: the publish path locks the head row six times
        // (claim's authorize, the retention put, the verify-open read
        // lease, install's authorize, and each authorization's final writer
        // lease recheck), so the zero above cannot pass
        // vacuously on a broken store.
        assertThat(fixture.ledger.count(
                "from ma_session_head", "for update"))
                .isEqualTo(6);
    }

    @Test
    void publicationAuthorizationFencesAReleasedActivationFromTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A release committed after the reserve updates the head columns.
        append("activation.release",
                event(journal.sequence + 1, "activation.changed",
                        activation("released")) + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        // The head columns answered the check: no journal reads.
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void staleHeadStampRefusesAuthorizationWithoutScanning() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // Restore a stale active projection after a committed release.
        var head = fixture.jdbc.queryForMap("SELECT activation_id,"
                + " activation_phase, activation_event_epoch,"
                + " activation_expires_at, activation_head_revision"
                + " FROM ma_session_head");
        append("activation.release",
                event(journal.sequence + 1, "activation.changed",
                        activation("released")) + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.jdbc.update("UPDATE ma_session_head SET"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?,"
                        + " activation_head_revision = ?",
                head.get("activation_id"), head.get("activation_phase"),
                head.get("activation_event_epoch"),
                head.get("activation_expires_at"),
                head.get("activation_head_revision"));
        // A stale projection cannot authorize the original execution.
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void noChangeCommitDoesNotRestampASkewedHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // Simulate a stale active projection without rewinding the journal.
        var head = fixture.jdbc.queryForMap("SELECT activation_id,"
                + " activation_phase, activation_event_epoch,"
                + " activation_expires_at, activation_head_revision"
                + " FROM ma_session_head");
        append("activation.release",
                event(journal.sequence + 1, "activation.changed",
                        activation("released")) + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.jdbc.update("UPDATE ma_session_head SET"
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
                event(journal.sequence + 1, "tool.intent",
                        JSON.createObjectNode()) + COMMIT_MARKER,
                1, List.of(), null);
        var stamped = fixture.jdbc.queryForMap(
                "SELECT activation_head_revision, journal_revision"
                        + " FROM ma_session_head");
        assertThat(stamped.get("activation_head_revision"))
                .isNotEqualTo(stamped.get("journal_revision"));
        // The skew stays detectable and authorization refuses it.
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void unrepresentableExpiresAtFencesTheHeadCleanly() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // A missing expiry cannot authorize an active grant.
        ObjectNode noExpiry = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active");
        append("activation.no-expiry",
                event(journal.sequence + 1, "activation.changed", noExpiry) + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " ma_session_head", String.class))
                .isEqualTo("active");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM ma_session_head",
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
                        + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM ma_session_head",
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
                event(journal.sequence + 1, "activation.changed", exponent) + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM ma_session_head",
                Long.class)).isNull();
        // The width check itself must not overflow: the largest exponent a
        // JSON string can carry wraps an int precision-minus-scale negative,
        // which must still read as absent rather than materialize.
        ObjectNode maxExponent = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active").put("expiresAt", "1e2147483647");
        append("activation.max-exponent",
                event(journal.sequence + 1, "activation.changed", maxExponent)
                        + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM ma_session_head",
                Long.class)).isNull();
        // The positive-scale direction: 1e-N expands 10^N before dividing
        // (measured ~56s of CPU for these 12 bytes without the bound), so
        // the scale is pre-checked too.
        ObjectNode tinyFraction = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active").put("expiresAt", "1e-100000000");
        append("activation.tiny-fraction",
                event(journal.sequence + 1, "activation.changed", tinyFraction)
                        + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM ma_session_head",
                Long.class)).isNull();
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        // The head answers before the intent read: a fenced renew pays no
        // journal statement.
        assertThat(fixture.ledger.count("from ma_session_journal_tx"))
                .isZero();
    }

    @Test
    void expiredActivationFencesThroughTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        // Both grant paths refuse an expired activation through the head.
        ObjectNode expired = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", System.currentTimeMillis() - 1000);
        append("activation.expired",
                event(journal.sequence + 1, "activation.changed", expired) + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        // The head answers the activation term before the intent is read:
        // a fenced renew pays no journal statement at all.
        assertThat(fixture.ledger.count("from ma_session_journal_tx"))
                .isZero();
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        // Through the head columns: no locked journal read at all.
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void missingActivationHeadRefusesAuthorizationWithoutScanning() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        fixture.jdbc.update("UPDATE ma_session_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        fixture.ledger.reset();
        assertThatThrownBy(() -> publication.store().apply(request("renew"),
                WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        assertThatThrownBy(() -> publication.store().verifyDispatch(
                publication.executions().findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
        assertThat(fixture.ledger.count("from ma_session_journal_tx")).isZero();
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " ma_session_head", String.class)).isNull();
    }

    @Test
    void activationChangeBeyondTheDeclaredEventsIsRejectedAtCommit() {
        Fixture fixture = new Fixture();
        publicationFixture(fixture);
        // The activation line sits past the declared event count (the
        // commit marker's slot): refused, never captured into the head
        // columns.
        assertThatThrownBy(() -> append("activation.misplaced",
                event(journal.sequence + 1, "tool.intent",
                        JSON.createObjectNode())
                        + event(journal.sequence + 2, "activation.changed",
                                activation("released")),
                1, List.of(), null))
                .hasMessageContaining("is not one of the transaction's events");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " ma_session_head", String.class))
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
                        activation("active"), foreignKey, 1) + COMMIT_MARKER,
                1, List.of(), null))
                .hasMessageContaining("The event names another Session.");
        // A version the reader does not know is refused the same way.
        assertThatThrownBy(() -> append("activation.unknown-version",
                event(journal.sequence + 1, "activation.changed",
                        activation("active"), binding.get("sessionKey"), 2)
                        + COMMIT_MARKER,
                1, List.of(), null))
                .hasMessageContaining("event.v must be an integer from 1 to 1.");
        // A key carrying extra fields reads as foreign too, matching the
        // read paths' closed-key comparison.
        ObjectNode paddedKey = binding.get("sessionKey").deepCopy();
        paddedKey.put("junk", 1);
        assertThatThrownBy(() -> append("activation.padded-key",
                event(journal.sequence + 1, "activation.changed",
                        activation("active"), paddedKey, 1) + COMMIT_MARKER,
                1, List.of(), null))
                .hasMessageContaining("event.sessionKey must be an object"
                        + " with exactly");
        // The head columns keep the previous activation.
        assertThat(fixture.jdbc.queryForObject("SELECT activation_phase FROM"
                        + " ma_session_head", String.class))
                .isEqualTo("active");
    }

    @Test
    void renewReadsTheIntentAtItsOwnRevision() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        int filler = 30;
        for (int index = 0; index < filler; index++) {
            append("tool.dispatch",
                    event(journal.sequence + 1, "tool.intent",
                            JSON.createObjectNode()) + COMMIT_MARKER,
                    1, List.of(), null);
        }
        fixture.ledger.reset();
        publication.store().apply(request("renew"), WRITER_TOKEN,
                PUBLICATION_TOKEN);
        long reads = fixture.ledger
                .count("from ma_session_journal_tx");
        System.out.println("[issue-13181] renew with the intent " + filler
                + " revisions behind the head: " + reads
                + " journal statements");
        // The revision range read, the chain-contiguity count, and the one
        // verified page: constant, independent of the filler depth, and none
        // of them locked.
        assertThat(reads).isEqualTo(4);
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
                "for update")).isZero();
    }

    @Test
    void stringExpiresAtIsProjectedIntoTheHead() {
        Fixture fixture = new Fixture();
        PublicationFixture publication = publicationFixture(fixture);
        ToolPublicationStore store = publication.store();
        JdbcToolExecutionRepository executions = publication.executions();
        long expiry = System.currentTimeMillis() + 180000;
        // Numeric strings use the same bounded expiry projection as numbers.
        ObjectNode stringExpiry = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("phase", "active")
                .put("expiresAt", String.valueOf(expiry));
        append("activation.string-expiry",
                event(journal.sequence + 1, "activation.changed", stringExpiry)
                        + COMMIT_MARKER,
                1, List.of(resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
        assertThat(fixture.jdbc.queryForObject("SELECT activation_expires_at"
                        + " FROM ma_session_head",
                Long.class)).isEqualTo(expiry);
        // The head branch authorizes it without a journal read.
        fixture.ledger.reset();
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        assertThat(fixture.ledger.count("from ma_session_journal_tx",
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
            this(clock, false);
        }

        Fixture(Clock clock, boolean workspaceFilesEnabled) {
            this(clock, workspaceFilesEnabled, false);
        }

        Fixture(Clock clock, boolean workspaceFilesEnabled, boolean modelSelection) {
            JdbcDataSource raw = new JdbcDataSource();
            raw.setURL("jdbc:h2:mem:repro-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;"
                    + "LOCK_TIMEOUT=10000");
            Flyway.configure().dataSource(raw).locations("classpath:db/managed-schema").load().migrate();
            ledger = new QueryLedger(raw);
            dataSource = ledger.dataSource();
            jdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(dataSource);
            manager = new DataSourceTransactionManager(dataSource);
            tx = new TransactionTemplate(manager);
            ManagedWorkspaceRegistry registry =
                    new ManagedWorkspaceRegistry(jdbc);
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getHarness().setWorkspaceFilesEnabled(workspaceFilesEnabled);
            if (modelSelection) {
                var option = new ManagedAgentProperties.ModelOption();
                option.setModelId("model-a");
                option.setLabel("Model A");
                properties.setModelCatalog(List.of(option));
                when(harness.supportsModelSelection()).thenReturn(true);
            }
            store = new ManagedAgentStore(jdbc, JSON, clock, hub::publish,
                    registry, properties);
            service = new ManagedAgentService(store, new RequestDigests(),
                    mock(HarnessCoordinator.class),
                    harness, registry);
        }

        List<String> createCwdSessions(String tenant, int count) {
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
            List<String> ids = new ArrayList<>();
            for (int index = 0; index < count; index++) {
                ids.add(tx.execute(status -> store.insertWorkspaceSessionCommand(tenant, "actor", UUID.randomUUID().toString(), "digest", "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", "."))).sessionId());
            }
            return ids;
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
}
