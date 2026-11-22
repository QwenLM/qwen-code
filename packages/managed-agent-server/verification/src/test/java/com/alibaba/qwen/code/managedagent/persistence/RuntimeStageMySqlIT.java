package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WakeStamp;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Phase 3b acceptance on real MySQL 8.4 (§10): the staging transaction, its
 * execution-row settlement, the wake/seal fences and Session retirement must
 * behave as they do on H2, including the unsigned columns and the strict-mode
 * boolean CHECKs the production schema relies on.
 */
class RuntimeStageMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "a".repeat(32);
    private static final String TENANT = "tenant";
    private static final String WORKSPACE = "workspace";
    private static final String PROCESS_SUFFIX = ":process";

    private IsolatedManagedSchemaMySqlTestDatabase database;
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate tx;
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
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        tx = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        sessionStore = VerificationFixtures.managedSessionStore(jdbc);
        bindingRepo = new JdbcRuntimeBindingRepository(
                database.source(), new AesGcmSecretProtector("test", new byte[32]));
        runtimeSessionRepo = new JdbcRuntimeSessionRepository(database.source());
        executionRepo = new JdbcToolExecutionRepository(database.source());
        stageStore = new JdbcRuntimeStageStore(jdbc, 512L, 1_024L);

        session = "sess-" + UUID.randomUUID();
        runtimeSessionId = "rts-" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                + " gmt_create, gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                TENANT, session);
        acquireWriter();
        commitGenesis();
        seedReadyBindingAndSession();
    }

    @org.junit.jupiter.api.AfterEach
    void tearDown() throws Exception {
        if (database != null) {
            database.close();
        }
    }

    @Test
    void stagesResourcesRowsWakeAndSettlementInOneMySqlTransaction() {
        String callId = "call-my-1";
        seedPreparedProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(
                bindingId, 1L, "broker-1", Duration.ofSeconds(30));
        assertThat(claim).isNotNull();
        assertThat(stageStore.claimBindingPuller(
                bindingId, 1L, "broker-2", Duration.ofSeconds(30))).isNull();

        sealWriter(new WakeStamp(1, false, System.currentTimeMillis() + 3_600_000L));
        assertThat(headInt("is_wake_pending")).isZero();

        StageOutcome outcome = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 1L, "my-seg-1", "my-page-1", "my-man-1", "hello\n"),
                        terminalEntry(callId, 2L, "my-man-2", "success", false))));
        assertThat(outcome.committed()).isTrue();
        assertThat(outcome.stagedThrough()).isEqualTo(2L);
        assertThat(outcome.terminalSettled()).isTrue();
        assertThat(outcome.wakeMarked()).isTrue();

        // A replay of the same (executionCallId, deliverySeq) changes nothing.
        assertThat(stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 1L, "my-seg-1", "my-page-1", "my-man-1", "hello\n"),
                        terminalEntry(callId, 2L, "my-man-2", "success", false)))).committed()).isTrue();
        assertThat(stageStore.highestStagedSequence(callId)).isEqualTo(2L);

        assertThat(jdbc.queryForObject(
                "SELECT state FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                String.class, TENANT, session, "my-seg-1")).isEqualTo("PUBLISHED");
        assertThat(jdbc.queryForObject(
                "SELECT state FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                String.class, TENANT, session, "my-man-1")).isEqualTo("REFERENCED");
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                        + " AND owner_kind = 'RUNTIME_STAGE'", Integer.class, TENANT, session)).isEqualTo(3);
        assertThat(executionRepo.findByExecutionCallId(callId + PROCESS_SUFFIX).getExecutionStatus())
                .isEqualTo("success");
        assertThat(headInt("is_wake_pending")).isEqualTo(1);

        acquireWriter();
        assertThat(stageStore.listStagedDeliveries(TENANT, session, "writer", writerGeneration))
                .hasSize(2);
        stageStore.acknowledgeStagedDeliveries(
                TENANT, session, "writer", writerGeneration, callId, 2L);
        assertThat(stageStore.listStagedDeliveries(TENANT, session, "writer", writerGeneration))
                .isEmpty();
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                        + " AND owner_kind = 'RUNTIME_STAGE'", Integer.class, TENANT, session)).isZero();
    }

    @Test
    void fencesSealAndRecordPendingThenClearsOnceDrainedOnMySql() {
        String callId = "call-my-fence";
        seedPreparedProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(
                bindingId, 1L, "broker-1", Duration.ofSeconds(30));
        stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(terminalEntry(callId, 1L, "my-fence-man", "success", false))));

        // The detach->seal window: a stamp that claims no pending wake must not
        // clear the staged one, and must keep the retry due now.
        long future = System.currentTimeMillis() + 3_600_000L;
        sealWriter(new WakeStamp(1, false, future));
        assertThat(headInt("is_wake_pending")).isEqualTo(1);
        assertThat(headLong("wake_retry_at")).isLessThanOrEqualTo(System.currentTimeMillis() + 5_000L);

        jdbc.update("UPDATE ma_session_head SET wake_seal_revision = NULL WHERE session_id = ?",
                session);
        JdbcWakeRecoveryStore wakeStore = new JdbcWakeRecoveryStore(jdbc);
        var candidates = wakeStore.findPending(WORKSPACE, 8);
        assertThat(candidates).hasSize(1);
        assertThat(wakeStore.hasPendingInput(candidates.getFirst())).isEqualTo(Optional.of(true));
        assertThat(wakeStore.recordPending(candidates.getFirst(), false)).isFalse();
        assertThat(headInt("is_wake_pending")).isEqualTo(1);

        acquireWriter();
        stageStore.acknowledgeStagedDeliveries(
                TENANT, session, "writer", writerGeneration, callId, 1L);
        sealWriter(new WakeStamp(1, false, future));
        assertThat(headInt("is_wake_pending")).isZero();
    }

    @Test
    void enforcesTheWatermarkHardCapAndReservedTerminalSlotOnMySql() {
        String callId = "call-my-cap";
        seedPreparedProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(
                bindingId, 1L, "broker-1", Duration.ofSeconds(30));
        sealWriter(new WakeStamp(1, false, System.currentTimeMillis() + 3_600_000L));

        String payload = "x".repeat(550);
        assertThat(stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 1L, "cap-s1", "cap-p1", "cap-m1", payload))))
                .wakeMarked()).isTrue();
        assertThat(headInt("is_wake_pending")).isEqualTo(1);

        StageOutcome capped = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 2L, "cap-s2", "cap-p2", "cap-m2", payload),
                        outputEntry(callId, 3L, "cap-s3", "cap-p3", "cap-m3", "blocked\n"))));
        assertThat(capped.stagedThrough()).isEqualTo(2L);
        assertThat(capped.hardCapReached()).isTrue();
        assertThat(stageStore.isSessionAtHardCap(TENANT, session)).isTrue();

        StageOutcome terminal = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(terminalEntry(callId, 3L, "cap-term", "cancelled", true))));
        assertThat(terminal.stagedThrough()).isEqualTo(3L);
        assertThat(terminal.terminalSettled()).isTrue();
        assertThat(executionRepo.findByExecutionCallId(callId + PROCESS_SUFFIX).getExecutionStatus())
                .isEqualTo("cancelled");
    }

    @Test
    void retirementClearsStagedRowsAndRefsOnMySql() {
        String callId = "call-my-retire";
        seedPreparedProcess(callId);
        PullerClaim claim = stageStore.claimBindingPuller(
                bindingId, 1L, "broker-1", Duration.ofSeconds(30));
        stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(outputEntry(callId, 1L, "ret-s1", "ret-p1", "ret-m1", "retire\n"))));

        sealWriter(new WakeStamp(1, true, System.currentTimeMillis() + 60_000L));
        String opKey = "op-gc-" + UUID.randomUUID();
        tx.executeWithoutResult(status ->
                ToolPublicationRetentionStore.retire(jdbc, TENANT, session, opKey));
        assertThat(headInt("is_wake_pending")).isZero();
        while (Boolean.TRUE.equals(tx.execute(status ->
                ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, TENANT, session, 10)))) {
            /* drain every owner batch */
        }
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, session);
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_runtime_stage WHERE runtime_session_key = ?",
                Integer.class, scope)).isZero();
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                        + " AND owner_kind = 'RUNTIME_STAGE'", Integer.class, TENANT, session)).isZero();

        // A trailing batch after retirement settles the row without re-staging.
        StageOutcome trailing = stageStore.stageBatch(new StageBatchRequest(
                claim, TENANT, WORKSPACE, session, callId,
                List.of(terminalEntry(callId, 2L, "ret-m2", "error", false))));
        assertThat(trailing.terminalSettled()).isTrue();
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_runtime_stage WHERE runtime_session_key = ?",
                Integer.class, scope)).isZero();
        assertThat(executionRepo.findByExecutionCallId(callId + PROCESS_SUFFIX).getExecutionStatus())
                .isEqualTo("error");
    }

    private void acquireWriter() {
        writerGeneration = tx.execute(status -> sessionStore.acquireWriter(
                TENANT, session, TOKEN, new AcquireWriterRequest(WORKSPACE, "writer", 60_000L)))
                .writerGeneration();
    }

    private void sealWriter(WakeStamp wake) {
        tx.execute(status -> sessionStore.sealWriter(TENANT, session, TOKEN,
                new SealWriterRequest(WORKSPACE, "writer", writerGeneration, wake)));
    }

    private void commitGenesis() throws Exception {
        String records = "{\"subtype\":\"session_execution_engine\"}\n"
                + "{\"subtype\":\"managed_session_header_v1\"}\n";
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
                .put("recordBytesBase64",
                        Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)));
        var request = JSON.treeToValue(node, CommitTransactionRequest.class);
        tx.execute(status -> sessionStore.commit(TENANT, session, TOKEN, request));
    }

    private void seedReadyBindingAndSession() {
        RuntimeScope scope = new RuntimeScope(TENANT, WORKSPACE, "1", "/workspace",
                "sha256:" + "1".repeat(64), "session");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope, "harness");
        bindingId = bindingRepo.findOrCreate(request).getBindingId();
        RuntimeBindingRecord claimed = bindingRepo.claimOperation(
                bindingId, "owner-1", Duration.ofSeconds(60));
        Instant now = Instant.now();
        RuntimeLease lease = new RuntimeLease(
                "inst-1", URI.create("http://127.0.0.1:9999"), "tok-1", "lease-1", 1L);
        bindingRepo.compareAndSet(claimed,
                claimed.withState(RuntimeBindingRecord.State.READY, lease, now));
        bindingRepo.releaseOperation(bindingId, "owner-1", claimed.getOperationGeneration());
        RuntimeSession runtimeSession = new RuntimeSession(
                session, runtimeSessionId, "bootstrap", scope);
        RuntimeSessionRecord acquiring = bindingRepo.admitSession(runtimeSessionRepo,
                new RuntimeSessionRecord(runtimeSession, bindingId, 1L,
                        RuntimeSessionRecord.State.ACQUIRING, 0L, now));
        runtimeSessionRepo.compareAndSet(acquiring,
                acquiring.withState(RuntimeSessionRecord.State.READY, now));
    }

    private void seedPreparedProcess(String executionCallId) {
        String digest = "sha256:" + "2".repeat(64);
        ToolExecutionRecord candidate = new ToolExecutionRecord(
                executionCallId + PROCESS_SUFFIX, "idem-" + executionCallId, bindingId, 1L,
                session, runtimeSessionId, "turn-1", "tool-1", digest,
                Map.of("sessionId", runtimeSessionId, "promptId", "turn-1", "callId", "tool-1",
                        "argsDigest", digest, "processOf", executionCallId, "kind", "shell"),
                ToolExecutionRecord.State.PREPARED, null, null,
                0L, false, null, null, 0L, 0L, null);
        bindingRepo.admitExecution(runtimeSessionRepo, executionRepo, candidate);
    }

    private static Map<String, Object> outputEntry(
            String callId, long seq, String segId, String pageId, String manId, String content) {
        byte[] segment = content.getBytes(StandardCharsets.UTF_8);
        byte[] page = ("{\"page\":\"" + pageId + "\"}").getBytes(StandardCharsets.UTF_8);
        byte[] manifest = ("{\"manifest\":\"" + manId + "\",\"revision\":" + seq + "}")
                .getBytes(StandardCharsets.UTF_8);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("schemaVersion", 1);
        entry.put("kind", "output");
        entry.put("executionCallId", callId);
        entry.put("deliverySeq", seq);
        entry.put("manifestRef", ref(manId, "managed-tool-result-manifest", manifest));
        entry.put("manifestRevision", seq);
        entry.put("resources", List.of(
                resource(segId, "managed-tool-result-segment", segment),
                resource(pageId, "managed-tool-result-page", page),
                resource(manId, "managed-tool-result-manifest", manifest)));
        return entry;
    }

    private static Map<String, Object> terminalEntry(
            String callId, long seq, String manId, String executionStatus, boolean stopRequested) {
        byte[] manifest = ("{\"manifest\":\"" + manId + "\",\"sealed\":true}")
                .getBytes(StandardCharsets.UTF_8);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("schemaVersion", 1);
        entry.put("kind", "terminal");
        entry.put("executionCallId", callId);
        entry.put("deliverySeq", seq);
        entry.put("outcome", stopRequested ? "stop_requested" : "exited");
        entry.put("executionStatus", executionStatus);
        entry.put("stopRequested", stopRequested);
        entry.put("evidence", Map.of("exitCode", 0));
        entry.put("manifestRef", ref(manId, "managed-tool-result-manifest", manifest));
        entry.put("envelope", Map.of("protocol", "managed-tool-result/1"));
        entry.put("resources", List.of(resource(manId, "managed-tool-result-manifest", manifest)));
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

    private int headInt(String column) {
        Integer value = jdbc.queryForObject(
                "SELECT " + column + " FROM ma_session_head WHERE session_id = ?",
                Integer.class, session);
        return value == null ? 0 : value;
    }

    private long headLong(String column) {
        Long value = jdbc.queryForObject(
                "SELECT " + column + " FROM ma_session_head WHERE session_id = ?",
                Long.class, session);
        return value == null ? 0L : value;
    }
}
