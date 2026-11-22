package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONWriter;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeRequestKeys;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * JDBC implementation of {@link RuntimeStageStore}. Commits carried resources,
 * {@code ma_runtime_stage} rows, wake hints on {@code ma_session_head}, and
 * terminal {@code ma_tool_execution} settlements in one atomic transaction.
 */
@Service
public class JdbcRuntimeStageStore implements RuntimeStageStore {
    public static final int MAX_OBSERVATIONS_PER_RUN = 10_000;
    public static final long DEFAULT_STAGED_BYTES_WATERMARK = 4L * 1024 * 1024;
    public static final long DEFAULT_STAGED_BYTES_HARD_CAP = 16L * 1024 * 1024;
    private static final String PROCESS_SUFFIX = ":process";
    private static final String SEGMENT_KIND = "managed-tool-result-segment";
    private static final Set<String> ALLOWED_REFERENCED_KINDS = Set.of(
            "managed-tool-result-page",
            "managed-tool-result-manifest",
            "managed-monitor-observation",
            "managed-message-chunks",
            "managed-message-chunk",
            "managed-input",
            "managed-admission");

    private final DataSource dataSource;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final long stagedBytesWatermark;
    private final long stagedBytesHardCap;

    @Autowired
    public JdbcRuntimeStageStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this(jdbc, DEFAULT_STAGED_BYTES_WATERMARK, DEFAULT_STAGED_BYTES_HARD_CAP);
    }

    public JdbcRuntimeStageStore(DataSource dataSource) {
        this(new JdbcTemplate(dataSource), DEFAULT_STAGED_BYTES_WATERMARK, DEFAULT_STAGED_BYTES_HARD_CAP);
    }

    public JdbcRuntimeStageStore(
            JdbcTemplate jdbc,
            long stagedBytesWatermark,
            long stagedBytesHardCap) {
        this.jdbc = jdbc;
        this.dataSource = jdbc.getDataSource();
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(this.dataSource));
        this.stagedBytesWatermark = stagedBytesWatermark;
        this.stagedBytesHardCap = stagedBytesHardCap;
    }

    public static boolean hasWakeWorthyRow(JdbcTemplate jdbc, String sessionScopeKey) {
        List<Integer> found = jdbc.query(
                "SELECT 1 FROM ma_runtime_stage WHERE runtime_session_key = ? AND is_wake_worthy = 1 LIMIT 1",
                (rs, index) -> 1,
                sessionScopeKey);
        return !found.isEmpty();
    }

    @Override
    public List<PullableRun> findPullableRuns() {
        return jdbc.query(
                "SELECT b.tenant_id, b.workspace_id, e.harness_session_id, e.runtime_session_id,"
                        + " e.binding_id, e.runtime_generation, e.execution_call_id"
                        + " FROM ma_tool_execution e"
                        + " JOIN ma_runtime_binding b ON b.binding_id = e.binding_id"
                        + " AND b.runtime_generation = e.runtime_generation"
                        + " WHERE e.execution_state = 'PREPARED' AND b.binding_state = 'READY'"
                        + " ORDER BY e.binding_id, e.execution_call_id_hash LIMIT 256",
                (rs, index) -> {
                    String rawCallId = utf8(rs, "execution_call_id");
                    if (!rawCallId.endsWith(PROCESS_SUFFIX)) {
                        return null;
                    }
                    String invocationId = rawCallId.substring(0, rawCallId.length() - PROCESS_SUFFIX.length());
                    return new PullableRun(
                            utf8(rs, "tenant_id"),
                            utf8(rs, "workspace_id"),
                            utf8(rs, "harness_session_id"),
                            utf8(rs, "runtime_session_id"),
                            utf8(rs, "binding_id"),
                            rs.getLong("runtime_generation"),
                            invocationId);
                }).stream().filter(item -> item != null).toList();
    }

    @Override
    public PullerClaim claimBindingPuller(
            String bindingId,
            long runtimeGeneration,
            String ownerId,
            Duration leaseDuration) {
        return transactions.execute(status -> {
            long nowMs = databaseNowMillis();
            long leaseUntilMs = nowMs + Math.max(1_000L, leaseDuration.toMillis());
            List<PullerClaim> rows = jdbc.query(
                    "SELECT binding_state, observation_owner, observation_lease_until, observation_generation"
                            + " FROM ma_runtime_binding WHERE binding_id = ? AND runtime_generation = ? FOR UPDATE",
                    (rs, index) -> {
                        if (!"READY".equals(rs.getString("binding_state"))) {
                            return null;
                        }
                        byte[] currentOwnerBytes = rs.getBytes("observation_owner");
                        String currentOwner = currentOwnerBytes == null
                                ? null : new String(currentOwnerBytes, StandardCharsets.UTF_8);
                        long currentLease = rs.getLong("observation_lease_until");
                        boolean leaseNull = rs.wasNull();
                        long currentGen = rs.getLong("observation_generation");
                        if (currentOwner != null
                                && !currentOwner.equals(ownerId)
                                && !leaseNull
                                && currentLease > nowMs) {
                            return null;
                        }
                        long nextGen = currentOwner != null && currentOwner.equals(ownerId)
                                ? Math.max(1L, currentGen) : currentGen + 1L;
                        return new PullerClaim(
                                bindingId,
                                runtimeGeneration,
                                ownerId,
                                nextGen,
                                Instant.ofEpochMilli(leaseUntilMs));
                    },
                    bytes(bindingId),
                    runtimeGeneration);
            if (rows.isEmpty() || rows.getFirst() == null) {
                return null;
            }
            PullerClaim claimed = rows.getFirst();
            jdbc.update(
                    "UPDATE ma_runtime_binding SET observation_owner = ?, observation_lease_until = ?,"
                            + " observation_generation = ? WHERE binding_id = ? AND runtime_generation = ?",
                    bytes(ownerId),
                    claimed.leaseUntil().toEpochMilli(),
                    claimed.pullerGeneration(),
                    bytes(bindingId),
                    runtimeGeneration);
            return claimed;
        });
    }

    @Override
    public PullerClaim renewBindingPuller(PullerClaim claim, Duration leaseDuration) {
        return transactions.execute(status -> {
            long nowMs = databaseNowMillis();
            long leaseUntilMs = nowMs + Math.max(1_000L, leaseDuration.toMillis());
            int updated = jdbc.update(
                    "UPDATE ma_runtime_binding SET observation_lease_until = ?"
                            + " WHERE binding_id = ? AND runtime_generation = ? AND binding_state = 'READY'"
                            + " AND observation_owner = ? AND observation_generation = ?",
                    leaseUntilMs,
                    bytes(claim.bindingId()),
                    claim.runtimeGeneration(),
                    bytes(claim.ownerId()),
                    claim.pullerGeneration());
            if (updated == 0) {
                return null;
            }
            return new PullerClaim(
                    claim.bindingId(),
                    claim.runtimeGeneration(),
                    claim.ownerId(),
                    claim.pullerGeneration(),
                    Instant.ofEpochMilli(leaseUntilMs));
        });
    }

    @Override
    public void releaseBindingPuller(PullerClaim claim) {
        transactions.executeWithoutResult(status -> jdbc.update(
                "UPDATE ma_runtime_binding SET observation_owner = NULL, observation_lease_until = NULL"
                        + " WHERE binding_id = ? AND runtime_generation = ?"
                        + " AND observation_owner = ? AND observation_generation = ?",
                bytes(claim.bindingId()),
                claim.runtimeGeneration(),
                bytes(claim.ownerId()),
                claim.pullerGeneration()));
    }

    @Override
    public long highestStagedSequence(String executionCallId) {
        String callHash = RuntimeRequestKeys.valueKey(executionCallId);
        Number max = jdbc.queryForObject(
                "SELECT COALESCE(MAX(delivery_seq), 0) FROM ma_runtime_stage WHERE execution_call_id_hash = ?",
                Number.class,
                callHash);
        return max == null ? 0L : max.longValue();
    }

    @Override
    public boolean isSessionAtHardCap(String tenantId, String harnessSessionId) {
        String scopeKey = ManagedSessionStore.sessionScopeKey(tenantId, harnessSessionId);
        Number total = jdbc.queryForObject(
                "SELECT COALESCE(SUM(staged_bytes), 0) FROM ma_runtime_stage WHERE runtime_session_key = ?",
                Number.class,
                scopeKey);
        return total != null && total.longValue() >= stagedBytesHardCap;
    }

    @Override
    public StageOutcome stageBatch(StageBatchRequest request) {
        if (request.entries().isEmpty()) {
            return new StageOutcome(true, 0L, false, false, false);
        }
        return transactions.execute(status -> {
            long nowMs = databaseNowMillis();
            if (!verifyPullerClaim(request.claim(), nowMs)) {
                return new StageOutcome(false, 0L, false, false, false);
            }
            SessionHeadState headState = lockSessionAndHead(request.tenantId(), request.harnessSessionId());
            String callHash = RuntimeRequestKeys.valueKey(request.executionCallId());
            String scopeKey = ManagedSessionStore.sessionScopeKey(
                    request.tenantId(), request.harnessSessionId());

            if (headState.retiredOrDeleted()) {
                boolean settled = false;
                long maxSeq = 0L;
                for (Map<String, Object> entry : request.entries()) {
                    long seq = requiredLong(entry, "deliverySeq");
                    if (seq > maxSeq) {
                        maxSeq = seq;
                    }
                    if ("terminal".equals(entry.get("kind"))) {
                        settleProcessInTx(request.executionCallId(), entry);
                        settled = true;
                    }
                }
                return new StageOutcome(true, maxSeq, settled, false, false);
            }

            long sessionBytes = sumSessionStagedBytes(scopeKey);
            int observationCount = countRunObservations(callHash);
            long stagedThrough = 0L;
            boolean terminalSettled = false;
            boolean batchWakeWorthy = false;
            boolean hardCapReached = sessionBytes >= stagedBytesHardCap;

            for (Map<String, Object> entry : request.entries()) {
                String kind = requiredText(entry, "kind");
                long deliverySeq = requiredLong(entry, "deliverySeq");
                boolean isTerminal = "terminal".equals(kind);

                if (stageRowExists(callHash, deliverySeq)) {
                    if (isTerminal) {
                        settleProcessInTx(request.executionCallId(), entry);
                        terminalSettled = true;
                    }
                    stagedThrough = deliverySeq;
                    continue;
                }

                if (!isTerminal && sessionBytes >= stagedBytesHardCap) {
                    hardCapReached = true;
                    break;
                }
                if ("observation".equals(kind)) {
                    long obsSeq = requiredLong(entry, "sequence");
                    if (obsSeq > MAX_OBSERVATIONS_PER_RUN || observationCount >= MAX_OBSERVATIONS_PER_RUN) {
                        hardCapReached = true;
                        break;
                    }
                }

                long carriedBytes = writeEntryResources(
                        scopeKey,
                        request.tenantId(),
                        request.workspaceId(),
                        request.harnessSessionId(),
                        callHash,
                        deliverySeq,
                        entry,
                        nowMs);

                long nextSessionBytes = sessionBytes + carriedBytes;
                boolean rowWakeWorthy = isTerminal
                        || ("observation".equals(kind) && entry.get("notification") != null)
                        || nextSessionBytes >= stagedBytesWatermark;

                Map<String, Object> stripped = new LinkedHashMap<>(entry);
                stripped.put("resources", List.of());
                String entryJson = JSON.toJSONString(stripped, JSONWriter.Feature.WriteNulls);

                boolean inserted = insertStageRow(
                        callHash,
                        request.executionCallId(),
                        deliverySeq,
                        scopeKey,
                        request.claim().bindingId(),
                        request.claim().runtimeGeneration(),
                        kind,
                        entryJson,
                        rowWakeWorthy,
                        carriedBytes,
                        nowMs);

                if (inserted) {
                    sessionBytes = nextSessionBytes;
                    if ("observation".equals(kind)) {
                        observationCount++;
                    }
                }
                if (rowWakeWorthy) {
                    batchWakeWorthy = true;
                }
                if (isTerminal) {
                    settleProcessInTx(request.executionCallId(), entry);
                    terminalSettled = true;
                }
                stagedThrough = deliverySeq;
                if (sessionBytes >= stagedBytesHardCap) {
                    hardCapReached = true;
                }
            }

            if (batchWakeWorthy && headState.headPresent()) {
                jdbc.update(
                        "UPDATE ma_session_head SET is_wake_pending = 1,"
                                + " wake_retry_at = CASE WHEN wake_retry_at IS NULL OR wake_retry_at > ?"
                                + " THEN ? ELSE wake_retry_at END,"
                                + " gmt_modified = ?"
                                + " WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'",
                        nowMs,
                        nowMs,
                        nowMs,
                        bytes(request.tenantId()),
                        bytes(request.harnessSessionId()));
            }
            return new StageOutcome(true, stagedThrough, terminalSettled, batchWakeWorthy, hardCapReached);
        });
    }

    @Override
    public List<Map<String, Object>> listStagedDeliveries(
            String tenantId,
            String harnessSessionId,
            String writerId,
            long writerGeneration) {
        return transactions.execute(status -> {
            requireActiveWriter(tenantId, harnessSessionId, writerId, writerGeneration);
            String scopeKey = ManagedSessionStore.sessionScopeKey(tenantId, harnessSessionId);
            return jdbc.query(
                    "SELECT entry_json FROM ma_runtime_stage WHERE runtime_session_key = ?"
                            + " ORDER BY execution_call_id_hash ASC, delivery_seq ASC",
                    (rs, index) -> {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> parsed = JSON.parseObject(rs.getString("entry_json"), Map.class);
                        return parsed;
                    },
                    scopeKey);
        });
    }

    @Override
    public void acknowledgeStagedDeliveries(
            String tenantId,
            String harnessSessionId,
            String writerId,
            long writerGeneration,
            String executionCallId,
            long throughSeq) {
        if (throughSeq < 1) {
            return;
        }
        transactions.executeWithoutResult(status -> {
            requireActiveWriter(tenantId, harnessSessionId, writerId, writerGeneration);
            deleteStagedPrefix(tenantId, harnessSessionId, executionCallId, throughSeq);
        });
    }

    @Override
    public void acknowledgeOnDetach(
            String tenantId,
            String harnessSessionId,
            long writerGeneration,
            Map<String, Long> appliedThrough) {
        if (appliedThrough == null || appliedThrough.isEmpty()) {
            return;
        }
        transactions.executeWithoutResult(status -> {
            lockSessionAndHead(tenantId, harnessSessionId);
            List<Long> generations = jdbc.query(
                    "SELECT writer_generation FROM ma_session_head"
                            + " WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'"
                            + " FOR UPDATE",
                    (rs, index) -> rs.getLong("writer_generation"),
                    bytes(tenantId),
                    bytes(harnessSessionId));
            if (generations.isEmpty() || writerGeneration < generations.getFirst()) {
                throw new RuntimeBrokerException(
                        409,
                        "runtime_stage_writer_conflict",
                        "Detach writer generation is stale.",
                        false);
            }
            for (Map.Entry<String, Long> item : appliedThrough.entrySet()) {
                if (item.getValue() != null && item.getValue() > 0) {
                    deleteStagedPrefix(tenantId, harnessSessionId, item.getKey(), item.getValue());
                }
            }
        });
    }

    private void deleteStagedPrefix(String tenantId, String sessionId, String executionCallId, long throughSeq) {
        String callHash = RuntimeRequestKeys.valueKey(executionCallId);
        jdbc.update(
                "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind = 'RUNTIME_STAGE'"
                        + " AND owner_key = ? AND owner_revision <= ?",
                bytes(tenantId),
                bytes(sessionId),
                callHash,
                throughSeq);
        jdbc.update(
                "DELETE FROM ma_runtime_stage WHERE runtime_session_key = ?"
                        + " AND execution_call_id_hash = ? AND delivery_seq <= ?",
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                callHash,
                throughSeq);
    }

    private void requireActiveWriter(
            String tenantId,
            String harnessSessionId,
            String writerId,
            long writerGeneration) {
        lockSessionAndHead(tenantId, harnessSessionId);
        long nowMs = databaseNowMillis();
        List<Boolean> valid = jdbc.query(
                "SELECT state, writer_id, writer_generation, writer_lease_until FROM ma_session_head"
                        + " WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'"
                        + " FOR UPDATE",
                (rs, index) -> {
                    String state = rs.getString("state");
                    byte[] rawWriter = rs.getBytes("writer_id");
                    String currentWriter = rawWriter == null
                            ? null : new String(rawWriter, StandardCharsets.UTF_8);
                    long currentGen = rs.getLong("writer_generation");
                    long leaseUntil = rs.getLong("writer_lease_until");
                    boolean leaseNull = rs.wasNull();
                    return "ACTIVE".equals(state)
                            && writerId.equals(currentWriter)
                            && writerGeneration == currentGen
                            && !leaseNull
                            && leaseUntil > nowMs;
                },
                bytes(tenantId),
                bytes(harnessSessionId));
        if (valid.isEmpty() || !Boolean.TRUE.equals(valid.getFirst())) {
            throw new RuntimeBrokerException(
                    409,
                    "runtime_stage_writer_conflict",
                    "Session writer lease is not active for staged delivery access.",
                    false);
        }
    }

    private boolean verifyPullerClaim(PullerClaim claim, long nowMs) {
        List<Boolean> ok = jdbc.query(
                "SELECT binding_state, observation_owner, observation_lease_until, observation_generation"
                        + " FROM ma_runtime_binding WHERE binding_id = ? AND runtime_generation = ? FOR UPDATE",
                (rs, index) -> {
                    byte[] rawOwner = rs.getBytes("observation_owner");
                    String owner = rawOwner == null ? null : new String(rawOwner, StandardCharsets.UTF_8);
                    long leaseUntil = rs.getLong("observation_lease_until");
                    boolean leaseNull = rs.wasNull();
                    long gen = rs.getLong("observation_generation");
                    return "READY".equals(rs.getString("binding_state"))
                            && claim.ownerId().equals(owner)
                            && claim.pullerGeneration() == gen
                            && !leaseNull
                            && leaseUntil > nowMs;
                },
                bytes(claim.bindingId()),
                claim.runtimeGeneration());
        return !ok.isEmpty() && Boolean.TRUE.equals(ok.getFirst());
    }

    private SessionHeadState lockSessionAndHead(String tenantId, String sessionId) {
        List<Boolean> sessionRetired = jdbc.query(
                "SELECT retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                (rs, index) -> {
                    rs.getLong("retired_at");
                    return !rs.wasNull();
                },
                bytes(tenantId),
                bytes(sessionId));
        if (!sessionRetired.isEmpty() && Boolean.TRUE.equals(sessionRetired.getFirst())) {
            return new SessionHeadState(false, true);
        }
        List<String> headStates = jdbc.query(
                "SELECT state FROM ma_session_head"
                        + " WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'"
                        + " FOR UPDATE",
                (rs, index) -> rs.getString("state"),
                bytes(tenantId),
                bytes(sessionId));
        if (headStates.isEmpty()) {
            return new SessionHeadState(false, !sessionRetired.isEmpty());
        }
        String headState = headStates.getFirst();
        if ("DELETED".equals(headState)) {
            return new SessionHeadState(true, true);
        }
        return new SessionHeadState(true, false);
    }

    private long sumSessionStagedBytes(String scopeKey) {
        Number sum = jdbc.queryForObject(
                "SELECT COALESCE(SUM(staged_bytes), 0) FROM ma_runtime_stage WHERE runtime_session_key = ?",
                Number.class,
                scopeKey);
        return sum == null ? 0L : sum.longValue();
    }

    private boolean stageRowExists(String callHash, long deliverySeq) {
        List<Integer> found = jdbc.query(
                "SELECT 1 FROM ma_runtime_stage WHERE execution_call_id_hash = ? AND delivery_seq = ? LIMIT 1",
                (rs, idx) -> 1,
                callHash,
                deliverySeq);
        return !found.isEmpty();
    }

    private int countRunObservations(String callHash) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_runtime_stage WHERE execution_call_id_hash = ? AND entry_kind = 'observation'",
                Integer.class,
                callHash);
        return count == null ? 0 : count;
    }

    @SuppressWarnings("unchecked")
    private long writeEntryResources(
            String scopeKey,
            String tenantId,
            String workspaceId,
            String sessionId,
            String callHash,
            long deliverySeq,
            Map<String, Object> entry,
            long nowMs) {
        Object rawResources = entry.get("resources");
        if (!(rawResources instanceof List<?> list) || list.isEmpty()) {
            return 0L;
        }
        long totalBytes = 0L;
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> resourceMap)) {
                throw new IllegalArgumentException("Invalid delivery resource entry");
            }
            Map<String, Object> ref = (Map<String, Object>) resourceMap.get("ref");
            if (ref == null) {
                throw new IllegalArgumentException("Missing delivery resource ref");
            }
            String resourceId = requiredText(ref, "resourceId");
            String kind = requiredText(ref, "kind");
            int schemaVersion = (int) requiredLong(ref, "schemaVersion");
            long byteLength = requiredLong(ref, "byteLength");
            String digest = requiredText(ref, "digest");
            String bytesBase64 = requiredText((Map<String, Object>) resourceMap, "bytesBase64");

            boolean isSegment = SEGMENT_KIND.equals(kind);
            if (!isSegment && !ALLOWED_REFERENCED_KINDS.contains(kind)) {
                throw new IllegalArgumentException("Unsupported staged resource kind: " + kind);
            }
            byte[] decoded = Base64.getDecoder().decode(bytesBase64);
            if (decoded.length != byteLength || schemaVersion != 1 || !JournalStoreRows.sha256(decoded).equals(digest)) {
                throw new IllegalArgumentException("Staged resource digest or byteLength mismatch");
            }
            totalBytes += byteLength;

            String resourceKey = ManagedSessionStore.resourceKey(scopeKey, resourceId);
            String state = isSegment ? "PUBLISHED" : "REFERENCED";
            try {
                jdbc.update(
                        "INSERT INTO ma_resource (resource_key, tenant_id, workspace_id,"
                                + " session_id, resource_id, kind, schema_version, byte_length, sha256,"
                                + " storage_kind, inline_bytes, publish_command_id, state, gmt_create,"
                                + " last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MYSQL_INLINE',"
                                + " ?, ?, ?, ?, ?)",
                        resourceKey,
                        bytes(tenantId),
                        bytes(workspaceId),
                        bytes(sessionId),
                        bytes(resourceId),
                        kind,
                        schemaVersion,
                        byteLength,
                        digest,
                        decoded,
                        bytes("stage:" + callHash + ":" + deliverySeq + ":" + resourceId),
                        state,
                        nowMs,
                        nowMs);
            } catch (DuplicateKeyException duplicate) {
                verifyExistingResource(resourceKey, kind, schemaVersion, byteLength, digest);
            }

            if (!isSegment) {
                try {
                    jdbc.update(
                            "INSERT INTO ma_resource_ref (owner_kind, owner_key,"
                                    + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                                    + " resource_id, gmt_create) VALUES ('RUNTIME_STAGE', ?, ?, ?, ?, ?, ?, ?, ?)",
                            callHash,
                            deliverySeq,
                            resourceKey,
                            bytes(tenantId),
                            bytes(workspaceId),
                            bytes(sessionId),
                            bytes(resourceId),
                            nowMs);
                } catch (DuplicateKeyException duplicate) {
                    /* duplicate replay */
                }
            }
        }
        return totalBytes;
    }

    private void verifyExistingResource(
            String resourceKey,
            String kind,
            int schemaVersion,
            long byteLength,
            String digest) {
        List<Boolean> matches = jdbc.query(
                "SELECT kind, schema_version, byte_length, sha256 FROM ma_resource WHERE resource_key = ?",
                (rs, index) -> kind.equals(rs.getString("kind"))
                        && schemaVersion == rs.getInt("schema_version")
                        && byteLength == rs.getLong("byte_length")
                        && digest.equals(rs.getString("sha256")),
                resourceKey);
        if (matches.isEmpty() || !Boolean.TRUE.equals(matches.getFirst())) {
            throw new RuntimeBrokerException(
                    409,
                    "managed_session_resource_conflict",
                    "Staged resourceId reused with different content metadata.",
                    false);
        }
    }

    private boolean insertStageRow(
            String callHash,
            String executionCallId,
            long deliverySeq,
            String scopeKey,
            String bindingId,
            long runtimeGeneration,
            String kind,
            String entryJson,
            boolean wakeWorthy,
            long stagedBytes,
            long nowMs) {
        try {
            jdbc.update(
                    "INSERT INTO ma_runtime_stage (execution_call_id_hash, execution_call_id, delivery_seq,"
                            + " runtime_session_key, binding_id, runtime_generation, entry_kind, entry_json,"
                            + " is_wake_worthy, staged_bytes, gmt_create)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    callHash,
                    bytes(executionCallId),
                    deliverySeq,
                    scopeKey,
                    bytes(bindingId),
                    runtimeGeneration,
                    kind,
                    entryJson,
                    wakeWorthy ? 1 : 0,
                    stagedBytes,
                    nowMs);
            return true;
        } catch (DuplicateKeyException duplicate) {
            return false;
        }
    }

    private void settleProcessInTx(String executionCallId, Map<String, Object> terminalEntry) {
        boolean stopRequested = Boolean.TRUE.equals(terminalEntry.get("stopRequested"));
        Object rawStatus = terminalEntry.get("executionStatus");
        Object evidence = terminalEntry.get("evidence");
        String executionStatus;
        if (stopRequested || "cancelled".equals(rawStatus)) {
            executionStatus = "cancelled";
        } else if ("not_started".equals(rawStatus)) {
            executionStatus = "not_started";
        } else if (evidence instanceof Map<?, ?> ev && ev.containsKey("exitCode")) {
            Object exitCode = ev.get("exitCode");
            boolean zeroExit = exitCode instanceof Number num && num.intValue() == 0;
            executionStatus = zeroExit && !"error".equals(rawStatus) ? "success" : "error";
        } else {
            executionStatus = "success".equals(rawStatus) ? "success" : "error";
        }
        Map<String, Object> settledResult = new LinkedHashMap<>();
        settledResult.put("state", "not_started".equals(executionStatus) ? "not_started" : "exited");
        settledResult.put("evidence", evidence);
        settledResult.put("executionStatus", executionStatus);

        Connection connection = DataSourceUtils.getConnection(dataSource);
        try {
            JdbcToolExecutionRepository.settleBackgroundProcessOnConnection(
                    connection,
                    executionCallId + PROCESS_SUFFIX,
                    settledResult);
        } catch (SQLException error) {
            throw new IllegalStateException("Failed to settle staged background process row", error);
        } finally {
            DataSourceUtils.releaseConnection(connection, dataSource);
        }
    }

    private long databaseNowMillis() {
        Number millis = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW, Number.class);
        return millis == null ? System.currentTimeMillis() : millis.longValue();
    }

    private static byte[] bytes(String value) {
        return ManagedSchemaKeys.identity(value);
    }

    private static String utf8(ResultSet rs, String column) throws SQLException {
        byte[] raw = rs.getBytes(column);
        return raw == null ? null : new String(raw, StandardCharsets.UTF_8);
    }

    private static String requiredText(Map<String, Object> map, String key) {
        Object value = map.get(key);
        if (!(value instanceof String text) || text.isEmpty()) {
            throw new IllegalArgumentException("Missing string field: " + key);
        }
        return text;
    }

    private static long requiredLong(Map<String, Object> map, String key) {
        Object value = map.get(key);
        if (!(value instanceof Number number)) {
            throw new IllegalArgumentException("Missing numeric field: " + key);
        }
        return number.longValue();
    }

    private record SessionHeadState(boolean headPresent, boolean retiredOrDeleted) {
    }
}
