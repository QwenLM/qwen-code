package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WakeStamp;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore.PullerClaim;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore.StageBatchRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore.StageOutcome;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Verifies Phase 3b Broker staging transactions, single-puller binding claims,
 * watermark/hard-cap bounds, wake/seal fencing, and Session retirement cleanup.
 */
class RuntimeStageStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "a".repeat(32);
    private static final String TENANT = "tenant";
    private static final String WORKSPACE = "workspace";

    private JdbcDataSource source;
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private JdbcManagedSessionStore sessionStore;
    private JdbcRuntimeBindingRepository bindingRepo;
    private JdbcRuntimeSessionRepository runtimeSessionRepo;
    private JdbcToolExecutionRepository executionRepo;
    private JdbcRuntimeStageStore stageStore;
    private String session;
    private String bindingId;
    private String runtimeSessionId;
    private long writerGeneration;

    @BeforeEach
    void setUp() throws Exception {
        source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:runtime-stage-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        sessionStore = VerificationFixtures.managedSessionStore(jdbc);
        bindingRepo = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        runtimeSessionRepo = new JdbcRuntimeSessionRepository(source);
        executionRepo = new JdbcToolExecutionRepository(source);
        stageStore = new JdbcRuntimeStageStore(jdbc, 512L, 1_024L);

        session = "sess-" + UUID.randomUUID();
        bindingId = "bind-" + UUID.randomUUID();
        runtimeSessionId = "rts-" + UUID.randomUUID();

        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                + " gmt_create, gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                TENANT, session);
        acquireWriter();
        commitGenesis();
        seedReadyBindingAndSession();
    }

    @Test
    void stagesResourcesRowsWakeHintAndProcessSettlementInOneTransaction() {
        String callId = "call-1";
        seedPreparedBackgroundProcess(callId);

        PullerClaim claim = stageStore.claimBindingPuller(bindingId, 1L, "broker-1", Duration.ofSeconds(30));
        assertThat(claim).isNotNull();
        // Competing Broker replica cannot steal an unexpired puller claim.
        assertThat(stageStore.claimBindingPuller(bindingId, 1L, "broker-2", Duration.ofSeconds(30))).isNull();

        Map<String, Object> output = outputEntry(callId, 1L, "seg-1", "page-1", "man-1", "hello\n");
        Map<String, Object> terminal = terminalEntry(callId, 2L, "man-2", "exited", "success", false);

        sealWriter(new WakeStamp(1, false, System.currentTimeMillis() + 3_600_000L));
        assertThat(headInt("is_wake_pending")).isZero();

        StageOutcome outcome = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId, List.of(output, terminal)));
        assertThat(outcome.committed()).isTrue();
        assertThat(outcome.stagedThrough()).isEqualTo(2L);
        assertThat(outcome.terminalSettled()).isTrue();
        assertThat(outcome.wakeMarked()).isTrue();

        // Duplicate replay of the same (executionCallId, deliverySeq) is idempotent.
        StageOutcome replay = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId, List.of(output, terminal)));
        assertThat(replay.committed()).isTrue();
        assertThat(stageStore.highestStagedSequence(callId)).isEqualTo(2L);

        // Segment is PUBLISHED without RUNTIME_STAGE ref; page + manifests are REFERENCED under RUNTIME_STAGE.
        assertThat(jdbc.queryForObject(
                "SELECT state FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                String.class, TENANT, session, "seg-1")).isEqualTo("PUBLISHED");
        assertThat(jdbc.queryForObject(
                "SELECT state FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                String.class, TENANT, session, "man-1")).isEqualTo("REFERENCED");
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'RUNTIME_STAGE'",
                Integer.class, TENANT, session)).isEqualTo(3);

        // Background :process row in ma_tool_execution is settled as completed.
        ToolExecutionRecord settledProcess = executionRepo.findByExecutionCallId(callId + ":process");
        assertThat(settledProcess.isTerminal()).isTrue();
        assertThat(settledProcess.getExecutionStatus()).isEqualTo("success");
        assertThat(settledProcess.getResult()).containsEntry("state", "exited");

        // Head is marked wake-pending and due immediately; inline bytes were stripped from entry_json.
        assertThat(headInt("is_wake_pending")).isEqualTo(1);
        assertThat(headLong("wake_retry_at")).isLessThanOrEqualTo(System.currentTimeMillis() + 5_000L);

        acquireWriter();
        List<Map<String, Object>> listed = stageStore.listStagedDeliveries(
                TENANT, session, "writer", writerGeneration);
        assertThat(listed).hasSize(2);
        assertThat((List<?>) listed.get(0).get("resources")).isEmpty();

        // Acknowledge prefix 1..2 deletes staged rows and RUNTIME_STAGE refs, leaving ma_resource intact.
        stageStore.acknowledgeStagedDeliveries(TENANT, session, "writer", writerGeneration, callId, 2L);
        assertThat(stageStore.listStagedDeliveries(TENANT, session, "writer", writerGeneration)).isEmpty();
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'RUNTIME_STAGE'",
                Integer.class, TENANT, session)).isZero();
    }

    @Test
    void stagesMonitorNotificationResources() {
        String callId = "call-mon";
        seedPreparedBackgroundProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(bindingId, 1L, "broker-1", Duration.ofSeconds(30));

        byte[] input = "{\"text\":\"tick\"}".getBytes(StandardCharsets.UTF_8);
        byte[] admission = "{}".getBytes(StandardCharsets.UTF_8);
        Map<String, Object> notification = new LinkedHashMap<>();
        notification.put("inputId", "mon:notify:1");
        notification.put("turnId", "mon:notify:1");
        notification.put("contentRef", ref("input-1", "managed-input", input));
        notification.put("admissionRef", ref("admission-1", "managed-admission", admission));
        Map<String, Object> observation = new LinkedHashMap<>();
        observation.put("kind", "observation");
        observation.put("executionCallId", callId);
        observation.put("deliverySeq", 1L);
        observation.put("sequence", 1L);
        observation.put("lines", List.of("tick"));
        observation.put("notification", notification);
        observation.put("resources", List.of(
                resource("input-1", "managed-input", input),
                resource("admission-1", "managed-admission", admission)));

        StageOutcome outcome = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId, List.of(observation)));
        assertThat(outcome.committed()).isTrue();
        assertThat(outcome.stagedThrough()).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
                "SELECT state FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                String.class, TENANT, session, "input-1"))
                .isEqualTo("REFERENCED");
    }

    @Test
    void keepsNullEntryFieldsWhenStaging() {
        String callId = "call-null";
        seedPreparedBackgroundProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(bindingId, 1L, "broker-1", Duration.ofSeconds(30));
        Map<String, Object> terminal = terminalEntry(callId, 1L, "man-null", "exited", "success", false);
        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("exitCode", 0);
        evidence.put("exitSignal", null);
        terminal.put("evidence", evidence);

        StageOutcome outcome = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId, List.of(terminal)));
        assertThat(outcome.committed()).isTrue();

        acquireWriter();
        List<Map<String, Object>> listed = stageStore.listStagedDeliveries(
                TENANT, session, "writer", writerGeneration);
        assertThat(listed).hasSize(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> listedEvidence = (Map<String, Object>) listed.get(0).get("evidence");
        assertThat(listedEvidence)
                .containsEntry("exitCode", 0)
                .containsKey("exitSignal")
                .containsEntry("exitSignal", null);
    }

    @Test
    void enforcesWatermarkWakeHardCapAndReservedTerminalSlot() {
        String callId = "call-cap";
        seedPreparedBackgroundProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(bindingId, 1L, "broker-1", Duration.ofSeconds(30));

        sealWriter(new WakeStamp(1, false, System.currentTimeMillis() + 3_600_000L));
        assertThat(headInt("is_wake_pending")).isZero();

        // ~600 bytes crosses the 512-byte soft watermark -> output entry itself marks wake!
        String payload600 = "x".repeat(550);
        StageOutcome watermarkOutcome = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 1L, "seg-w1", "page-w1", "man-w1", payload600))));
        assertThat(watermarkOutcome.wakeMarked()).isTrue();
        assertThat(headInt("is_wake_pending")).isEqualTo(1);

        // Second ~600 bytes crosses the 1024-byte hard cap -> accepted, then Session is at hard cap.
        StageOutcome capOutcome = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 2L, "seg-w2", "page-w2", "man-w2", payload600),
                        outputEntry(callId, 3L, "seg-w3", "page-w3", "man-w3", "blocked\n"))));
        assertThat(capOutcome.stagedThrough()).isEqualTo(2L);
        assertThat(capOutcome.hardCapReached()).isTrue();
        assertThat(stageStore.isSessionAtHardCap(TENANT, session)).isTrue();

        // Reserved terminal slot ALWAYS admits terminal even above the Session hard cap!
        StageOutcome terminalAtCap = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(terminalEntry(callId, 3L, "man-term", "stop_requested", "cancelled", true))));
        assertThat(terminalAtCap.stagedThrough()).isEqualTo(3L);
        assertThat(terminalAtCap.terminalSettled()).isTrue();
        assertThat(executionRepo.findByExecutionCallId(callId + ":process").getExecutionStatus()).isEqualTo("cancelled");
    }

    @Test
    void fencesSealAndRecordPendingWithoutPinningDrainedSessions() {
        String callId = "call-fence";
        seedPreparedBackgroundProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(bindingId, 1L, "broker-1", Duration.ofSeconds(30));

        // Stage a wake-worthy terminal entry WHILE the writer is still ACTIVE (detach -> seal window!).
        stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(terminalEntry(callId, 1L, "man-f1", "exited", "success", false))));

        // Writer seals with wake.pending = false and a far-future dueAt: seal MUST preserve staged wake!
        long futureDue = System.currentTimeMillis() + 3_600_000L;
        sealWriter(new WakeStamp(1, false, futureDue));
        assertThat(headInt("is_wake_pending")).isEqualTo(1);
        assertThat(headLong("wake_retry_at")).isLessThanOrEqualTo(System.currentTimeMillis() + 5_000L);

        // Unstamped proof skips journal scan and recordPending(false) refuses to clear while staged row exists.
        jdbc.update("UPDATE ma_session_head SET wake_seal_revision = NULL WHERE session_id = ?", session);
        JdbcWakeRecoveryStore wakeStore = new JdbcWakeRecoveryStore(jdbc);
        var candidates = wakeStore.findPending(WORKSPACE, 8);
        assertThat(candidates).hasSize(1);
        assertThat(wakeStore.hasPendingInput(candidates.getFirst())).isEqualTo(Optional.of(true));
        assertThat(wakeStore.recordPending(candidates.getFirst(), false)).isFalse();
        assertThat(headInt("is_wake_pending")).isEqualTo(1);

        // Once woken Harness drains and acknowledges the staged row, subsequent seal(false) clears wake cleanly!
        acquireWriter();
        stageStore.acknowledgeStagedDeliveries(TENANT, session, "writer", writerGeneration, callId, 1L);
        sealWriter(new WakeStamp(1, false, futureDue));
        assertThat(headInt("is_wake_pending")).isZero();
    }

    @Test
    void retirementCleansStagedRowsAndRefsAndTrailingStageSkipsRetiredSession() {
        String callId = "call-retire";
        seedPreparedBackgroundProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(bindingId, 1L, "broker-1", Duration.ofSeconds(30));

        stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 1L, "seg-r1", "page-r1", "man-r1", "retire-me\n"))));

        sealWriter(new WakeStamp(1, true, System.currentTimeMillis() + 60_000L));
        String opKey = "op-gc-" + UUID.randomUUID();

        transaction.executeWithoutResult(
                status -> ToolPublicationRetentionStore.retire(jdbc, TENANT, session, opKey));
        assertThat(headInt("is_wake_pending")).isZero();

        // Drain all owner batches until false; staged rows and RUNTIME_STAGE refs must be empty.
        while (Boolean.TRUE.equals(transaction.execute(
                status -> ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, TENANT, session, 10)))) {
            /* drain batches */
        }
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, session);
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_runtime_stage WHERE runtime_session_key = ?",
                Integer.class, scope)).isZero();
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'RUNTIME_STAGE'",
                Integer.class, TENANT, session)).isZero();

        // A trailing stageBatch arriving after retirement settles :process without re-populating ma_runtime_stage.
        StageOutcome trailing = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(terminalEntry(callId, 2L, "man-r2", "process_failed", "error", false))));
        assertThat(trailing.committed()).isTrue();
        assertThat(trailing.terminalSettled()).isTrue();
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_runtime_stage WHERE runtime_session_key = ?",
                Integer.class, scope)).isZero();
        assertThat(executionRepo.findByExecutionCallId(callId + ":process").getExecutionStatus()).isEqualTo("error");

        // Stale writer cannot list or acknowledge staged deliveries.
        assertThatThrownBy(() -> stageStore.listStagedDeliveries(TENANT, session, "writer", writerGeneration))
                .isInstanceOf(RuntimeBrokerException.class);
    }

    private void acquireWriter() {
        writerGeneration = transaction.execute(status -> sessionStore.acquireWriter(
                TENANT, session, TOKEN, new AcquireWriterRequest(WORKSPACE, "writer", 60_000L)))
                .writerGeneration();
    }

    private void sealWriter(WakeStamp wake) {
        transaction.execute(status -> sessionStore.sealWriter(
                TENANT, session, TOKEN, new SealWriterRequest(WORKSPACE, "writer", writerGeneration, wake)));
    }

    private void commitGenesis() throws Exception {
        String records = "{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n";
        String digest = DigestUtils.sha256Hex(records.getBytes(StandardCharsets.UTF_8));
        var node = JSON.createObjectNode()
                .put("workspaceId", WORKSPACE)
                .put("writerId", "writer")
                .put("writerGeneration", writerGeneration)
                .put("expectedJournalRevision", 0)
                .put("expectedCommittedSequence", 0)
                .put("transactionId", "genesis")
                .put("operation", "session.create")
                .put("commandId", "genesis")
                .put("contentDigest", digest)
                .put("firstSequence", 0)
                .put("lastSequence", 0)
                .put("eventCount", 0)
                .put("activationEpoch", 0)
                .put("recordCount", 2)
                .put("recordDigest", digest)
                .put("recordBytesBase64", Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        var req = JSON.treeToValue(node, CommitTransactionRequest.class);
        transaction.execute(status -> sessionStore.commit(TENANT, session, TOKEN, req));
    }

    private void seedReadyBindingAndSession() {
        RuntimeScope scope = new RuntimeScope(
                TENANT, WORKSPACE, "1", "/workspace",
                "sha256:" + "1".repeat(64), "session");
        RuntimeProvisionRequest req = new RuntimeProvisionRequest(scope, "harness");
        RuntimeBindingRecord created = bindingRepo.findOrCreate(req);
        bindingId = created.getBindingId();
        RuntimeBindingRecord claimed = bindingRepo.claimOperation(
                bindingId, "owner-1", Duration.ofSeconds(60));
        Instant now = Instant.now();
        RuntimeLease lease = new RuntimeLease(
                "inst-1", URI.create("http://127.0.0.1:9999"), "tok-1", "lease-1", 1L);
        bindingRepo.compareAndSet(claimed, claimed.withState(RuntimeBindingRecord.State.READY, lease, now));
        bindingRepo.releaseOperation(bindingId, "owner-1", claimed.getOperationGeneration());

        RuntimeSession rtSession = new RuntimeSession(session, runtimeSessionId, "bootstrap", scope);
        RuntimeSessionRecord acquiring = bindingRepo.admitSession(
                runtimeSessionRepo,
                new RuntimeSessionRecord(
                        rtSession, bindingId, 1L, RuntimeSessionRecord.State.ACQUIRING, 0L, now));
        runtimeSessionRepo.compareAndSet(
                acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, now));
    }

    private void seedPreparedBackgroundProcess(String executionCallId) {
        Instant now = Instant.now();
        ToolExecutionRecord candidate = new ToolExecutionRecord(
                executionCallId + ":process",
                "idem-" + executionCallId,
                bindingId,
                1L,
                session,
                runtimeSessionId,
                "turn-1",
                "tool-1",
                "sha256:" + "2".repeat(64),
                Map.of("sessionId", runtimeSessionId, "promptId", "turn-1", "callId", "tool-1", "argsDigest", "sha256:" + "2".repeat(64), "processOf", executionCallId, "kind", "shell"),
                ToolExecutionRecord.State.PREPARED,
                null,
                null,
                0L,
                false,
                null,
                null,
                0L,
                0L,
                null);
        bindingRepo.admitExecution(runtimeSessionRepo, executionRepo, candidate);
    }

    private static Map<String, Object> outputEntry(
            String callId,
            long seq,
            String segId,
            String pageId,
            String manId,
            String content) {
        byte[] segBytes = content.getBytes(StandardCharsets.UTF_8);
        byte[] pageBytes = ("{\"page\":\"" + pageId + "\"}").getBytes(StandardCharsets.UTF_8);
        byte[] manBytes = ("{\"manifest\":\"" + manId + "\",\"revision\":" + seq + "}")
                .getBytes(StandardCharsets.UTF_8);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("schemaVersion", 1);
        entry.put("kind", "output");
        entry.put("executionCallId", callId);
        entry.put("deliverySeq", seq);
        entry.put("manifestRef", ref(manId, "managed-tool-result-manifest", manBytes));
        entry.put("manifestRevision", seq);
        entry.put("resources", List.of(
                resource(segId, "managed-tool-result-segment", segBytes),
                resource(pageId, "managed-tool-result-page", pageBytes),
                resource(manId, "managed-tool-result-manifest", manBytes)));
        return entry;
    }

    private static Map<String, Object> terminalEntry(
            String callId,
            long seq,
            String manId,
            String outcome,
            String executionStatus,
            boolean stopRequested) {
        byte[] manBytes = ("{\"manifest\":\"" + manId + "\",\"sealed\":true}").getBytes(StandardCharsets.UTF_8);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("schemaVersion", 1);
        entry.put("kind", "terminal");
        entry.put("executionCallId", callId);
        entry.put("deliverySeq", seq);
        entry.put("outcome", outcome);
        entry.put("executionStatus", executionStatus);
        entry.put("stopRequested", stopRequested);
        entry.put("manifestRef", ref(manId, "managed-tool-result-manifest", manBytes));
        entry.put("envelope", Map.of("protocol", "managed-tool-result/1"));
        entry.put("resources", List.of(resource(manId, "managed-tool-result-manifest", manBytes)));
        return entry;
    }

    private static Map<String, Object> ref(String id, String kind, byte[] bytes) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("resourceId", id);
        map.put("kind", kind);
        map.put("schemaVersion", 1);
        map.put("byteLength", (long) bytes.length);
        map.put("digest", DigestUtils.sha256Hex(bytes));
        return map;
    }

    private static Map<String, Object> resource(String id, String kind, byte[] bytes) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ref", ref(id, kind, bytes));
        map.put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
        return map;
    }

    private int headInt(String col) {
        return headMap().get(col) == null ? 0 : ((Number) headMap().get(col)).intValue();
    }

    private long headLong(String col) {
        return headMap().get(col) == null ? 0L : ((Number) headMap().get(col)).longValue();
    }

    private Map<String, Object> headMap() {
        return jdbc.queryForObject(
                "SELECT is_wake_pending, wake_retry_at FROM ma_session_head WHERE session_id = ?",
                (rs, idx) -> {
                    Map<String, Object> values = new HashMap<>();
                    values.put("is_wake_pending", rs.getInt("is_wake_pending"));
                    values.put("wake_retry_at", rs.getLong("wake_retry_at"));
                    return values;
                },
                session);
    }
}
