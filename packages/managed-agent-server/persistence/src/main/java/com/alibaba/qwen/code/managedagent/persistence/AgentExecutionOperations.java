package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.ContextCompressionState;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.CwdChangeOutcome;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.TaskCancelOutcome;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

final class AgentExecutionOperations {
    private final AgentEventJournal eventJournal;
    private final AgentLifecycleOperations lifecycleOperations;
    private final AgentSessionPolicies sessionPolicies;
    private final AgentSessionQueries sessionQueries;
    private final AgentStoreRows storeRows;
    private final com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles;
    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final ManagedWorkspaceRegistry workspaces;
    private final boolean workspaceFilesEnabled;

    AgentExecutionOperations(AgentEventJournal eventJournal,
            AgentLifecycleOperations lifecycleOperations,
            AgentSessionPolicies sessionPolicies,
            AgentSessionQueries sessionQueries,
            AgentStoreRows storeRows,
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles,
            JdbcTemplate jdbc,
            Clock clock,
            ManagedWorkspaceRegistry workspaces,
            boolean workspaceFilesEnabled) {
        this.eventJournal = eventJournal;
        this.lifecycleOperations = lifecycleOperations;
        this.sessionPolicies = sessionPolicies;
        this.sessionQueries = sessionQueries;
        this.storeRows = storeRows;
        this.worktreeFiles = worktreeFiles;
        this.jdbc = jdbc;
        this.clock = clock;
        this.workspaces = workspaces;
        this.workspaceFilesEnabled = workspaceFilesEnabled;
    }

    // D7-2: RECOVERY_BLOCKED carries two meanings, decided by kind. For
    // these kinds it means the command's acceptance is unknown: no claim
    // ever takes the row, nothing re-sends it, and only the reconciler
    // settles it, from the kind's own keyed evidence.
    static final String ACCEPTANCE_UNKNOWN_KINDS =
            "('TASK_CANCEL', 'SUBMIT_INPUT', 'CANCEL', 'RENAME')";

    /** A parked Session title the sealed journal proves never landed. */
    static final String SESSION_TITLE_UNDELIVERED = "session_title_undelivered";

    OperationAdmission beginContextCompression(String tenantId, String sessionId,
            String actorId, String actorDigest, String key, String digest,
            long expectedCompactionRevision, boolean supported) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        WorkspaceAccess access = AgentSessionAccess.requireContextCompressionRead(session, actorId, workspaces);
        ContextBinding binding = session.workspace();
        Optional<OperationRecord> replay = lifecycleOperations.replayOperation(tenantId, sessionId,
                OperationKind.CONTEXT_COMPRESSION, actorDigest, key);
        if (replay.isPresent()) {
            if (!digest.equals(replay.get().requestDigest())) {
                throw new ManagedAgentException(409, "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new OperationAdmission(replay.get(), true);
        }
        if (!access.atLeast(WorkspaceAccess.OPERATOR)) {
            throw new ManagedAgentException(403, "session_operation_forbidden",
                    "Only a Workspace operator may compress Session context.");
        }
        if (!supported || !workspaceFilesEnabled) {
            throw new ManagedAgentException(409, "unsupported_feature",
                    "Hosted context compression is unavailable.");
        }
        AgentSessionPolicies.requireSessionStatus(session.status(), "ACTIVE");
        WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, tenantId, binding.getStorageId());
        sessionPolicies.requireCwdChangeRegistryFacts(session);
        if (contextCompressionState(tenantId, sessionId).compactionRevision() != expectedCompactionRevision) {
            throw new ManagedAgentException(409, "compaction_revision_conflict",
                    "The Session compaction revision has changed.");
        }
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        if (sessionPolicies.hasOpenOperation(tenantId, sessionId) || sessionPolicies.hasPendingRenameDelivery(tenantId, sessionId)
                || sessionPolicies.hasActiveTurn(tenantId, sessionId) || sessionPolicies.hasDecidableAction(session)
                || !jdbc.queryForList("SELECT 1 FROM ma_session_record WHERE session_scope_key = ?"
                        + " AND record_kind = 'DOMAIN' AND domain IN ('hook_execution', 'history_maintenance')"
                        + " AND settled_at IS NULL LIMIT 1", scope).isEmpty()
                || !jdbc.queryForList("SELECT 1 FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND status = 'RECOVERY_BLOCKED' LIMIT 1", tenantId, sessionId).isEmpty()
                || !jdbc.queryForList("SELECT 1 FROM ma_session_head WHERE tenant_id = ? AND session_id = ?"
                        + " AND head_kind = 'MANAGED_SESSION' AND (state <> 'ACTIVE' OR recovery_status <> 'READY')",
                        tenantId, sessionId).isEmpty()) {
            throw new ManagedAgentException(409, "session_context_busy",
                    "The Session has an active Turn, approval, Hook, recovery or context operation.");
        }
        String operationId = AgentStoreRows.publicId("op");
        long now = storeRows.lifecycleDatabaseTime();
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("operationId", operationId);
        request.put("expectedCompactionRevision", expectedCompactionRevision);
        var model = sessionQueries.findModelSelections(tenantId, List.of(sessionId)).get(sessionId);
        if (model != null && model.modelId() != null) {
            request.put("modelSelection", Map.of("modelId", model.modelId(), "revision", model.revision()));
        }
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, target_kind,"
                + " target_key, target_id, phase, request_json, idempotency_digest, tenant_id, session_id,"
                + " operation_id, operation_kind, actor_digest, idempotency_key, request_digest, state,"
                + " admission_stage, delivery_state, session_status_before, actor_key, available_at,"
                + " gmt_create, gmt_modified) VALUES (?, ?, ?, 'SESSION', ?, ?, 'PENDING', ?, ?, ?, ?, ?,"
                + " 'CONTEXT_COMPRESSION', ?, ?, ?, 'PENDING', 'JAVA_DURABLE', 'PENDING', ?, ?, ?, ?, ?)",
                AgentStoreRows.sessionOperationKey(tenantId, sessionId, OperationKind.CONTEXT_COMPRESSION, operationId),
                scope, scope, AgentStoreRows.sessionOperationTarget(sessionId), sessionId, storeRows.writeJson(request),
                ManagedSchemaKeys.key(key), tenantId, sessionId, operationId, actorDigest, key, digest,
                session.status(), com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenantId, actorId), now, now, now);
        return new OperationAdmission(lifecycleOperations.findOperation(tenantId, sessionId, operationId).orElseThrow(), false);
    }

    ContextCompressionState contextCompressionState(String tenantId, String sessionId) {
        ensureCompactionProjection(tenantId, sessionId);
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        List<Long> revisions = jdbc.queryForList("SELECT revision FROM ma_session_record WHERE"
                + " session_scope_key = ? AND record_key = ? AND record_kind = 'DOMAIN'", Long.class,
                scope, ManagedExtensionProjection.recordKey(sessionId, "hosted_context_compaction", "latest"));
        List<String> operations = jdbc.queryForList("SELECT operation_id FROM ma_operation WHERE"
                + " scope_key = ? AND operation_kind = 'CONTEXT_COMPRESSION' AND target_key = ?"
                + " AND state IN ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED') ORDER BY gmt_create LIMIT 1",
                String.class, scope, AgentStoreRows.sessionOperationTarget(sessionId));
        return new ContextCompressionState(revisions.isEmpty() ? 0 : revisions.getFirst(),
                operations.isEmpty() ? null : operations.getFirst());
    }

    Map<String, ContextCompressionState> contextCompressionStates(String tenantId, List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object> arguments = new ArrayList<>();
        arguments.add(tenantId);
        sessionIds.forEach(id -> arguments.add(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, id)));
        Map<String, ContextCompressionState> result = new HashMap<>();
        Set<String> indexed = new HashSet<>();
        sessionIds.forEach(id -> result.put(id, new ContextCompressionState(0, null)));
        jdbc.query("SELECT session_id, revision FROM ma_session_record WHERE tenant_id = ?"
                + " AND session_scope_key IN (" + AgentStoreRows.placeholders(sessionIds.size()) + ")"
                + " AND record_kind = 'DOMAIN' AND domain = 'hosted_context_compaction'",
                (RowCallbackHandler) row -> {
                    indexed.add(row.getString("session_id"));
                    result.put(row.getString("session_id"), new ContextCompressionState(row.getLong("revision"), null));
                }, arguments.toArray());
        List<String> missing = sessionIds.stream().filter(id -> !indexed.contains(id)).toList();
        if (!missing.isEmpty()) {
            List<Object> heads = new ArrayList<>();
            heads.add(tenantId);
            heads.addAll(missing);
            for (String id : jdbc.queryForList("SELECT session_id FROM ma_session_head WHERE tenant_id = ?"
                    + " AND session_id IN (" + AgentStoreRows.placeholders(missing.size()) + ") AND head_kind = 'MANAGED_SESSION'",
                    String.class, heads.toArray())) {
                try {
                    result.put(id, contextCompressionState(tenantId, id));
                } catch (ManagedAgentException unavailable) {
                    if (!"context_compression_state_unavailable".equals(unavailable.getCode())) {
                        throw unavailable;
                    }
                    result.put(id, new ContextCompressionState(0, null, false));
                }
            }
        }
        jdbc.query("SELECT session_id, operation_id FROM ma_operation WHERE tenant_id = ?"
                + " AND scope_key IN (" + AgentStoreRows.placeholders(sessionIds.size()) + ")"
                + " AND operation_kind = 'CONTEXT_COMPRESSION' AND state IN ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED')",
                (RowCallbackHandler) row -> {
                    String id = row.getString("session_id");
                    result.put(id, new ContextCompressionState(result.get(id).compactionRevision(),
                            row.getString("operation_id"), result.get(id).available()));
                }, arguments.toArray());
        return result;
    }

    void ensureCompactionProjection(String tenantId, String sessionId) {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String key = ManagedExtensionProjection.recordKey(sessionId, "hosted_context_compaction", "latest");
        if (!jdbc.queryForList("SELECT 1 FROM ma_session_record WHERE session_scope_key = ? AND record_key = ?",
                scope, key).isEmpty()) {
            return;
        }
        var transactions = new org.springframework.transaction.support.TransactionTemplate(
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()));
        transactions.executeWithoutResult(status -> backfillCompactionProjection(tenantId, sessionId, scope, key));
    }

    void backfillCompactionProjection(String tenantId, String sessionId, String scope, String key) {
        var heads = jdbc.queryForList("SELECT workspace_id, journal_revision, compacted_through_revision FROM"
                + " ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                tenantId, sessionId);
        if (heads.isEmpty() || ((Number) heads.getFirst().get("journal_revision")).longValue() == 0) {
            return;
        }
        var head = heads.getFirst();
        if (((Number) head.get("compacted_through_revision")).longValue() != 0) {
            throw compressionStateUnavailable();
        }
        long through = ((Number) head.get("journal_revision")).longValue();
        long scanned = 0;
        com.fasterxml.jackson.databind.JsonNode latest = null;
        while (scanned < through) {
            var page = jdbc.queryForList("SELECT journal_revision, record_bytes, byte_length, record_digest FROM"
                    + " ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision > ?"
                    + " AND journal_revision <= ? ORDER BY journal_revision LIMIT 16", tenantId, sessionId, scanned, through);
            if (page.isEmpty()) {
                throw compressionStateUnavailable();
            }
            for (var row : page) {
                byte[] bytes = (byte[]) row.get("record_bytes");
                long revision = ((Number) row.get("journal_revision")).longValue();
                if (revision != scanned + 1 || bytes == null
                        || bytes.length != ((Number) row.get("byte_length")).longValue()
                        || !DigestUtils.sha256Hex(bytes).equals(row.get("record_digest"))) {
                    throw compressionStateUnavailable();
                }
                for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
                    var record = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(line);
                    if (record == null) {
                        throw compressionStateUnavailable();
                    }
                    var event = record.path("managedSession");
                    if ("context.compacted".equals(event.path("kind").asText())) {
                        latest = event;
                    }
                }
                scanned = revision;
            }
        }
        String workspace = (String) head.get("workspace_id");
        long revision = latest == null ? 0 : latest.path("sequence").asLong();
        String resourceId;
        if (latest == null) {
            byte[] empty = "{}".getBytes(StandardCharsets.UTF_8);
            String digest = DigestUtils.sha256Hex(empty);
            resourceId = "compaction-state:" + digest;
            jdbc.update("INSERT IGNORE INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id,"
                    + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes,"
                    + " state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 2, ?, 'MYSQL_INLINE', ?,"
                    + " 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                    ManagedSchemaKeys.key(scope, resourceId), scope, tenantId, workspace, sessionId, resourceId,
                    "managed-context-compaction-empty", digest, empty);
        } else {
            var ref = latest.path("payload").path("summaryRef");
            try {
                ManagedExtensionRecords.durableRef(ref, "compaction.summaryRef");
            } catch (IllegalArgumentException error) {
                throw compressionStateUnavailable();
            }
            resourceId = ref.path("resourceId").asText();
            var resources = jdbc.queryForList("SELECT sha256, byte_length, kind FROM ma_resource WHERE"
                    + " session_scope_key = ? AND resource_id = ? AND state IN ('REFERENCED', 'PUBLISHED')",
                    scope, resourceId);
            if (resources.size() != 1 || !ref.path("digest").asText().equals(resources.getFirst().get("sha256"))
                    || !ref.path("kind").asText().equals(resources.getFirst().get("kind"))
                    || ref.path("byteLength").asLong() != ((Number) resources.getFirst().get("byte_length")).longValue()) {
                throw compressionStateUnavailable();
            }
        }
        long now = storeRows.lifecycleDatabaseTime();
        int inserted = jdbc.update("INSERT IGNORE INTO ma_session_record (session_scope_key, record_key, tenant_id,"
                + " workspace_id, session_id, domain, record_id, revision, record_resource_id, gmt_create, settled_at,"
                + " first_sequence) VALUES (?, ?, ?, ?, ?, 'hosted_context_compaction', ?, ?, ?, ?, ?, ?)",
                scope, key, tenantId, workspace, sessionId, "latest", revision, resourceId, now, now, revision);
        if (inserted == 1) {
            jdbc.update("INSERT IGNORE INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision,"
                    + " resource_key, tenant_id, workspace_id, session_id, resource_id, gmt_create) VALUES"
                    + " (?, 'SESSION_RECORD', ?, ?, ?, ?, ?, ?, ?, ?)", scope, key, revision,
                    ManagedSchemaKeys.key(scope, resourceId), tenantId, workspace, sessionId, resourceId, now);
        }
    }

    static ManagedAgentException compressionStateUnavailable() {
        return new ManagedAgentException(409, "context_compression_state_unavailable",
                "The retained journal cannot establish the Session compaction revision.");
    }

    Map<String, Object> contextCompressionRequest(String tenantId, String sessionId, String operationId) {
        return jdbc.queryForList("SELECT request_json FROM ma_operation WHERE scope_key = ?"
                + " AND operation_kind = 'CONTEXT_COMPRESSION' AND operation_id = ?", String.class,
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId), operationId).stream()
                .findFirst().map(storeRows::readMap).orElse(Map.of());
    }

    List<OperationTarget> findContextCompressions(int limit) {
        return jdbc.query("SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE"
                + " operation_kind = 'CONTEXT_COMPRESSION' AND state IN ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED')"
                + " AND available_at <= " + ManagedSchemaTime.SQL_NOW + " AND (claim_owner IS NULL OR claim_until < "
                + ManagedSchemaTime.SQL_NOW + ") ORDER BY available_at LIMIT ?", lifecycleOperations.operationTargetMapper, limit);
    }

    Optional<OperationRecord> claimContextCompression(String tenantId, String sessionId,
            String operationId, String owner, Duration duration) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        int changed = jdbc.update("UPDATE ma_operation SET state = 'RUNNING', delivery_state = 'LEASED',"
                + " claim_owner = ?, claim_until = (" + ManagedSchemaTime.SQL_NOW + " + ?),"
                + " claim_generation = claim_generation + 1, attempt_count = attempt_count + 1 WHERE"
                + " scope_key = ? AND operation_kind = 'CONTEXT_COMPRESSION' AND operation_id = ?"
                + " AND state IN ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED') AND available_at <= "
                + ManagedSchemaTime.SQL_NOW + " AND (claim_owner IS NULL OR claim_until < " + ManagedSchemaTime.SQL_NOW + ")",
                owner, duration.toMillis(), com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId), operationId);
        return changed == 1 ? lifecycleOperations.findOperation(tenantId, sessionId, operationId) : Optional.empty();
    }

    void requireContextCompressionCommit(String tenantId, String sessionId, String operationId) {
        OperationRecord operation = lifecycleOperations.findOperation(tenantId, sessionId, operationId).orElse(null);
        if (operation == null || operation.kind() != OperationKind.CONTEXT_COMPRESSION) {
            return;
        }
        SessionRecord session = storeRows.requireSession(tenantId, sessionId);
        if (!List.of("PENDING", "RUNNING", "RECOVERY_BLOCKED").contains(operation.state())
                || session.workspace() == null || !"ACTIVE".equals(session.status())
                || operation.actorKey() == null || !initiatorKeepsOperate(session, operation)) {
            throw new ManagedAgentException(409, "context_compression_authorization_revoked",
                    "The compression initiator no longer has execution authority.");
        }
        sessionPolicies.requireCwdChangeRegistryFacts(session);
    }

    boolean markContextCompressionSubmitted(OperationRecord operation, String owner) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(operation.tenantId(), operation.sessionId());
        if (!"ACTIVE".equals(session.status()) || session.workspace() == null
                || !initiatorKeepsOperate(session, operation)
                || !sessionQueries.hasExecutionRegistryFacts(session.tenantId(), session.sessionId())) {
            settleContextCompression(operation, owner, "failed", null, "workspace_unavailable");
            return false;
        }
        return jdbc.update("UPDATE ma_operation SET admission_stage = 'HARNESS_SUBMITTED' WHERE"
                + compressionClaim(), compressionArguments(operation, owner)) == 1;
    }

    boolean settleContextCompression(OperationRecord operation, String owner,
            String outcome, Long revision, String failureCode) {
        boolean failed = "failed".equals(outcome);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("outcome", outcome);
        if (revision != null) {
            result.put("compactionRevision", revision);
        }
        List<Object> args = new ArrayList<>(List.of(failed ? "FAILED" : "COMPLETED",
                failed ? "FAILED" : "COMPLETED", storeRows.writeJson(result), AgentStoreRows.publicId("rcpt")));
        args.add(failureCode);
        args.addAll(List.of(compressionArguments(operation, owner)));
        return jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, result_json = ?, receipt_id = ?,"
                + " failure_code = ?, admission_stage = 'HARNESS_CONFIRMED', delivery_state = 'CONFIRMED',"
                + " claim_owner = NULL, claim_until = NULL, completed_at = " + ManagedSchemaTime.SQL_NOW
                + ", gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE" + compressionClaim(), args.toArray()) == 1;
    }

    void retryContextCompressionPreparation(OperationRecord operation, String owner, long retryAt) {
        List<Object> args = new ArrayList<>();
        args.add(retryAt);
        args.addAll(List.of(compressionArguments(operation, owner)));
        jdbc.update("UPDATE ma_operation SET state = 'PENDING', admission_stage = 'JAVA_DURABLE',"
                + " delivery_state = 'BLOCKED', available_at = ?, claim_owner = NULL, claim_until = NULL,"
                + " gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE" + compressionClaim()
                + " AND admission_stage = 'JAVA_DURABLE'", args.toArray());
    }

    void awaitContextCompression(OperationRecord operation, String owner,
            boolean acceptanceKnown, String failureCode, long retryAt) {
        List<Object> args = new ArrayList<>();
        args.add(acceptanceKnown && failureCode == null ? "RUNNING" : "RECOVERY_BLOCKED");
        args.add(acceptanceKnown ? "HARNESS_ACCEPTED" : "HARNESS_SUBMITTED");
        args.add(acceptanceKnown ? failureCode : "context_compression_acceptance_unknown");
        args.add(retryAt);
        args.addAll(List.of(compressionArguments(operation, owner)));
        jdbc.update("UPDATE ma_operation SET state = ?, admission_stage = ?, failure_code = ?,"
                + " delivery_state = 'BLOCKED', available_at = ?, claim_owner = NULL, claim_until = NULL,"
                + " gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE" + compressionClaim(), args.toArray());
    }

    static String compressionClaim() {
        return " operation_kind = 'CONTEXT_COMPRESSION' AND tenant_id = ? AND session_id = ?"
                + " AND operation_id = ? AND state = 'RUNNING' AND claim_owner = ? AND claim_generation = ?"
                + " AND claim_until > " + ManagedSchemaTime.SQL_NOW;
    }

    static Object[] compressionArguments(OperationRecord operation, String owner) {
        return new Object[] {operation.tenantId(), operation.sessionId(), operation.operationId(), owner,
                operation.claimGeneration()};
    }

    CwdChangeOutcome completeCwdChangeOperation(String tenantId,
            String sessionId, String operationId, String owner,
            long claimGeneration) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        OperationRecord operation = lifecycleOperations.findSessionOperation(tenantId, sessionId, operationId, true)
                .orElseThrow(() -> new IllegalStateException("Session operation is unavailable"));
        if (operation.kind() != OperationKind.CWD_CHANGE) {
            throw new IllegalStateException("Operation " + operationId
                    + " is not a cwd change");
        }
        Boolean leaseLive =
                jdbc.queryForObject(
                        "SELECT claim_until > " + ManagedSchemaTime.SQL_NOW + " FROM ma_operation WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ? FOR UPDATE",
                        Boolean.class,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId);
        if (!Boolean.TRUE.equals(leaseLive)
                || !"RUNNING".equals(operation.state())
                || !"LEASED".equals(operation.deliveryState())
                || !owner.equals(operation.leaseOwner())
                || operation.claimGeneration() != claimGeneration) {
            return null;
        }
        long now = storeRows.lifecycleDatabaseTime();
        ContextBinding binding = session.workspace();
        long expected = operation.expectedContextRevision() == null ? -1
                : operation.expectedContextRevision();
        String failure = null;
        if (binding == null || !"ACTIVE".equals(session.status())
                || WorkspaceMigrationAdmission.owner(jdbc, tenantId,
                        binding.getStorageId()) != null) {
            failure = "workspace_unavailable";
        } else if (binding.getContextRevision() != expected) {
            failure = "context_revision_conflict";
        } else if (sessionPolicies.hasOpenOperation(tenantId, sessionId, operationId)
                || sessionPolicies.hasActiveTurn(tenantId, sessionId)
                || sessionPolicies.hasDecidableAction(session)
                || sessionPolicies.hasRetainedRuntimeSession(tenantId, sessionId)) {
            failure = "session_context_busy";
        } else if (!sessionQueries.hasExecutionRegistryFacts(session.tenantId(),
                session.sessionId()) || !initiatorKeepsOperate(session,
                operation)) {
            failure = "workspace_unavailable";
        }
        if (failure == null) {
            try {
                SessionWorktreeStore.requireReady(worktreeFiles, jdbc, tenantId, sessionId);
                SessionWorktreeStore.requireCwd(jdbc, tenantId, sessionId, operation.targetCwdRelative());
            } catch (ManagedAgentException error) {
                failure = error.getCode();
            }
        }
        if (failure != null) {
            jdbc.update(
                    "UPDATE ma_operation SET phase = 'FAILED', state ="
                            + " 'FAILED', delivery_state = 'CONFIRMED',"
                            + " failure_code = ?, claim_owner = NULL,"
                            + " claim_until = NULL, gmt_modified = ?,"
                            + " completed_at = ? WHERE scope_key = ? AND operation_kind IN "
                            + AgentStoreRows.SESSION_OPERATION_KINDS
                            + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                            + " operation_id = ?",
                    failure,
                    now,
                    now,
                    com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                    AgentStoreRows.sessionOperationTarget(sessionId),
                    tenantId,
                    sessionId,
                    operationId);
            return new CwdChangeOutcome(false, failure, null);
        }
        long result = expected + 1;
        jdbc.update("UPDATE ma_session SET cwd_relative = ?,"
                        + " context_revision = ?, gmt_modified = ?, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ?",
                operation.targetCwdRelative(), result, now, tenantId,
                sessionId);
        jdbc.update(
                "UPDATE ma_operation SET phase = 'COMPLETED', state = 'COMPLETED', delivery_state ="
                    + " 'CONFIRMED', receipt_id = ?, result_context_revision = ?, claim_owner ="
                    + " NULL, claim_until = NULL, gmt_modified = ?, completed_at = ? WHERE scope_key"
                    + " = ? AND operation_kind IN "
                        + AgentStoreRows.SESSION_OPERATION_KINDS
                        + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                        + " operation_id = ?",
                AgentStoreRows.publicId("rcpt"),
                result,
                now,
                now,
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                AgentStoreRows.sessionOperationTarget(sessionId),
                tenantId,
                sessionId,
                operationId);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("operationId", operationId);
        data.put("workspaceId", binding.getWorkspaceId());
        data.put("cwdRelative", operation.targetCwdRelative());
        data.put("contextRevision", result);
        eventJournal.appendEvent(tenantId, sessionId, null, "session.context.changed",
                Map.copyOf(data), false, AgentEventJournal.operationSource(operationId,
                        "completed"), now);
        return new CwdChangeOutcome(true, null, result);
    }

    boolean failCwdChangeOperation(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            String failureCode) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = storeRows.lifecycleDatabaseTime();
        return jdbc.update(
                        "UPDATE ma_operation SET phase = 'FAILED', state ="
                                + " 'FAILED', delivery_state = 'CONFIRMED',"
                                + " failure_code = ?, claim_owner = NULL,"
                                + " claim_until = NULL, gmt_modified = ?,"
                                + " completed_at = ? WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "",
                        failureCode,
                        now,
                        now,
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                        AgentStoreRows.sessionOperationTarget(sessionId),
                        tenantId,
                        sessionId,
                        operationId,
                        owner,
                        claimGeneration)
                == 1;
    }

    OperationAdmission beginTaskCancelOperation(String tenantId,
            String sessionId, String taskId, String actorDigest,
            String idempotencyKey, String requestDigest) {
        // The caller has already validated the key and checked current
        // access (404, then 403 task_forbidden): those run first by
        // contract, so a revoked caller never replays. Under the Session
        // lock the retained key replays before any new-request check, so
        // a lost 202 survives capability and state changes; only a new
        // request rechecks the Session state, the task's cancel action
        // and the one-open-operation rule, atomically with its insert.
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        Optional<OperationRecord> existing = lifecycleOperations.replayOperation(tenantId, sessionId,
                OperationKind.TASK_CANCEL, actorDigest, idempotencyKey);
        if (existing.isPresent()) {
            if (!existing.get().requestDigest().equals(requestDigest)) {
                throw new ManagedAgentException(409,
                        "idempotency_conflict",
                        "The idempotency key was reused with different content.");
            }
            return new OperationAdmission(existing.get(), true);
        }
        if ("DELETED".equals(session.status())) {
            throw new ManagedAgentException(404, "session_not_found",
                    "The Session was not found.");
        }
        if (!"ACTIVE".equals(session.status())) {
            throw new ManagedAgentException(409, "session_not_active",
                    "The Session is " + session.status().toLowerCase(
                            java.util.Locale.ROOT)
                            + " and accepts no task cancellation.");
        }
        // The task row is the projection its own commits update, so the
        // locking read serializes this admission with the transition that
        // would settle the task.
        List<String[]> task = jdbc.query("SELECT task_kind, task_state FROM"
                        + " ma_session_record WHERE"
                        + " session_scope_key = ? AND record_key = ?"
                        + " AND task_kind IS NOT NULL FOR UPDATE",
                (result, row) -> new String[] {result.getString("task_kind"),
                        result.getString("task_state")},
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                taskId.substring("task_".length()));
        if (task.isEmpty()) {
            throw new ManagedAgentException(404, "task_not_found",
                    "The task was not found.");
        }
        if (!ManagedExtensionProjection.taskActions(task.getFirst()[0],
                task.getFirst()[1]).contains("cancel")) {
            throw new ManagedAgentException(409,
                    "task_action_unavailable",
                    "The task does not accept a cancellation now.");
        }
        // A bound Session under storage migration admits no new work, as
        // every sibling bound admission refuses it: a cancel admitted
        // behind the fence would wedge the migration's idle checks.
        if (session.workspace() != null) {
            WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, tenantId,
                    session.workspace().getStorageId());
        }
        sessionPolicies.requireNoOpenOperation(tenantId, sessionId);
        long now = storeRows.lifecycleDatabaseTime();
        String operationId = AgentStoreRows.publicId("op");
        jdbc.update(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " target_kind, target_key, target_id, phase, request_json,"
                    + " idempotency_digest, tenant_id, session_id, operation_id, operation_kind,"
                    + " actor_digest, idempotency_key, request_digest, state, admission_stage,"
                    + " delivery_state, session_status_before, task_id, available_at, gmt_create,"
                    + " gmt_modified) VALUES (?, ?, ?, 'SESSION', ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?,"
                    + " ?, ?, ?, 'PENDING', 'JAVA_DURABLE', 'PENDING', ?, ?, ?, ?, ?)",
                AgentStoreRows.sessionOperationKey(tenantId, sessionId, OperationKind.TASK_CANCEL, operationId),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                AgentStoreRows.sessionOperationTarget(sessionId),
                sessionId,
                storeRows.writeJson(
                        Map.of(
                                "schemaVersion",
                                1,
                                "kind",
                                "TASK_CANCEL",
                                "sessionId",
                                sessionId,
                                "taskId",
                                taskId)),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                        idempotencyKey),
                tenantId,
                sessionId,
                operationId,
                OperationKind.TASK_CANCEL.name(),
                actorDigest,
                idempotencyKey,
                requestDigest,
                session.status(),
                taskId,
                now,
                now,
                now);
        return new OperationAdmission(lifecycleOperations.findOperation(tenantId, sessionId,
                operationId).orElseThrow(), false);
    }

    List<OperationTarget> findDeliverableTaskCancels(int limit) {
        long now = storeRows.lifecycleDatabaseTime();
        List<OperationTarget> targets =
                new ArrayList<>(
                        jdbc.query(
                                "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE"
                                    + " operation_kind = 'TASK_CANCEL' AND state IN ('PENDING',"
                                    + " 'RUNNING') AND delivery_state = 'PENDING' AND available_at"
                                    + " <= ? AND EXISTS (SELECT 1 FROM ma_session private_scope"
                                    + " WHERE private_scope.tenant_id = ma_operation.tenant_id AND"
                                    + " private_scope.session_id = ma_operation.session_id AND"
                                    + " private_scope.is_csi_guard = FALSE) ORDER BY available_at"
                                    + " LIMIT ?",
                                lifecycleOperations.operationTargetMapper,
                                now,
                                limit));
        if (targets.size() < limit) {
            targets.addAll(jdbc.query(
                            "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE operation_kind = 'TASK_CANCEL' AND delivery_state = 'LEASED' AND claim_until < " + ManagedSchemaTime.SQL_NOW + " AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_operation.tenant_id AND private_scope.session_id = ma_operation.session_id AND private_scope.is_csi_guard = FALSE) ORDER BY claim_until LIMIT ?",
                    lifecycleOperations.operationTargetMapper, limit - targets.size()));
        }
        return List.copyOf(targets);
    }

    List<ParkedOperation> findParkedOperations(int limit) {
        // Kind and state lead the due index, so the per-second scan reads
        // only parked rows, never a kind's settled history.
        return jdbc.query(
                "SELECT tenant_id, session_id, operation_id, operation_kind FROM ma_operation"
                    + " WHERE operation_kind IN " + ACCEPTANCE_UNKNOWN_KINDS + " AND state ="
                    + " 'RECOVERY_BLOCKED' AND available_at <= ? AND delivery_state = 'BLOCKED'"
                    + " AND EXISTS (SELECT 1 FROM ma_session s WHERE s.tenant_id ="
                    + " ma_operation.tenant_id AND s.session_id = ma_operation.session_id AND"
                    + " s.is_csi_guard = FALSE) ORDER BY available_at LIMIT ?",
                (result, row) -> new ParkedOperation(result.getString("tenant_id"),
                        result.getString("session_id"), result.getString("operation_id"),
                        result.getString("operation_kind")),
                storeRows.lifecycleDatabaseTime(), limit);
    }

    boolean settleParkedOperation(ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        storeRows.requireLegacyMutation(parked.tenantId(), parked.sessionId());
        long now = storeRows.lifecycleDatabaseTime();
        List<Object> arguments = new ArrayList<>();
        String update = switch (verdict.acceptance()) {
            case COMMITTED -> {
                arguments.add(AgentStoreRows.publicId("rcpt"));
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'COMPLETED', state = 'COMPLETED',"
                        + " admission_stage = 'HARNESS_CONFIRMED',"
                        + " delivery_state = 'CONFIRMED', receipt_id = ?,"
                        + " failure_code = NULL, gmt_modified = ?, completed_at = ?";
            }
            case NOT_COMMITTED -> {
                // Terminal yet blocked, as the contract has it: available_at
                // moves past every scan of the blocked range for good.
                arguments.add(verdict.failureCode());
                arguments.add(Long.MAX_VALUE);
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'FAILED', state = 'FAILED',"
                        + " admission_stage = 'JAVA_DURABLE',"
                        + " delivery_state = 'BLOCKED', failure_code = ?,"
                        + " available_at = ?, gmt_modified = ?, completed_at = ?";
            }
            case UNKNOWN -> {
                arguments.add(Math.addExact(now,
                        Math.max(0, retryAt - clock.millis())));
                arguments.add(now);
                yield "UPDATE ma_operation SET available_at = ?, gmt_modified = ?,"
                        + " attempt_count = attempt_count + 1";
            }
        };
        arguments.addAll(List.of(parked.kind(), parked.operationId(),
                parked.tenantId(), parked.sessionId()));
        // Only a still-parked row: a reconciliation never rewrites an
        // outcome already recorded, and no claim holds a parked row.
        return jdbc.update(update + " WHERE operation_kind = ? AND operation_id = ?"
                        + " AND tenant_id = ? AND session_id = ? AND operation_kind IN "
                        + ACCEPTANCE_UNKNOWN_KINDS + " AND state = 'RECOVERY_BLOCKED' AND"
                        + " delivery_state = 'BLOCKED' AND claim_owner IS NULL",
                arguments.toArray()) == 1;
    }

    /**
     * The Harness admits a prompt by committing {@code submitInput} to the
     * Session journal under the prompt's id, so the journal row keyed by that
     * command is the admission's own evidence. Its absence proves nothing
     * while a writer may still commit it; once the head refuses every writer
     * (DELETING or DELETED) and compaction has not started, the journal is
     * complete and the absence is proof. Both facts come from one statement,
     * whose single read view holds under any isolation level: a commit that
     * preceded the deletion is visible beside it, and no commit can land
     * between the two reads, as it could between two statements under READ
     * COMMITTED and turn an admitted input into a failed one.
     */
    AcceptanceVerdict turnInputAcceptance(String tenantId,
            String sessionId, String operationId) {
        String turnId = jdbc.queryForList("SELECT target_id FROM ma_operation WHERE"
                        + " scope_key = ? AND operation_kind = 'SUBMIT_INPUT' AND operation_id = ?",
                String.class, com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                operationId).stream().findFirst().orElse(null);
        TurnRecord turn = turnId == null ? null
                : storeRows.findTurn(tenantId, sessionId, turnId).orElse(null);
        if (turn == null) {
            return AcceptanceVerdict.unknown();
        }
        if (turn.harnessEventEpoch() != null) {
            return AcceptanceVerdict.committed();
        }
        JournalEvidence evidence = journalEvidence(tenantId, sessionId,
                "submitInput", turn.promptId());
        if (evidence.admittedDigest() != null) {
            if (("sha256:" + evidence.admittedDigest()).equals(turn.payloadDigest())) {
                return AcceptanceVerdict.committed();
            }
            AgentStoreRows.LOG.warn("Journal admission digest differs from its Turn tenant={}"
                    + " session={} turn={}", tenantId, sessionId, turnId);
            return AcceptanceVerdict.unknown();
        }
        return evidence.sealed() ? AcceptanceVerdict.notCommitted(turn.errorCode())
                : AcceptanceVerdict.unknown();
    }

    record JournalEvidence(String admittedDigest, boolean sealed) {
    }

    /**
     * The Session journal's own record of one keyed command: the content
     * digest it was admitted with, if any, and whether the journal is sealed
     * complete (no writer can still commit, compaction has not started).
     */
    JournalEvidence journalEvidence(String tenantId, String sessionId,
            String operation, String commandId) {
        return jdbc.queryForObject("SELECT (SELECT content_digest"
                        + " FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND command_key_hash = ?) AS admitted_digest, (SELECT COUNT(*) FROM"
                        + " ma_session_head WHERE tenant_key = ? AND harness_key = ? AND"
                        + " tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'"
                        + " AND state IN ('DELETING', 'DELETED') AND"
                        + " COALESCE(compacted_through_revision, 0) = 0) AS sealed",
                (result, row) -> new JournalEvidence(result.getString("admitted_digest"),
                        result.getLong("sealed") > 0),
                tenantId, sessionId,
                ManagedSessionStore.commandKeyHash(operation, commandId),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), tenantId,
                sessionId);
    }

    /**
     * The Hosted Harness commits a fenced title to the Session journal as
     * {@code renameSession} under {@code hosted-title:<revision>}, with the
     * title's SHA-256 as its content digest. That commit is the delivery's
     * own evidence, read in one statement beside the head exactly as a Turn
     * input's admission is.
     */
    Optional<AcceptanceVerdict> renameAcceptance(ParkedOperation parked) {
        var rows = jdbc.queryForList("SELECT target_revision, request_json FROM ma_operation"
                        + " WHERE scope_key = ? AND operation_kind = 'RENAME' AND operation_id = ?"
                        + " AND tenant_id = ? AND session_id = ? AND state = 'RECOVERY_BLOCKED'",
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(parked.tenantId(), parked.sessionId()),
                parked.operationId(), parked.tenantId(), parked.sessionId());
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        long revision = ((Number) rows.getFirst().get("target_revision")).longValue();
        String title = (String) storeRows.readMap((String) rows.getFirst().get("request_json")).get("title");
        JournalEvidence evidence = journalEvidence(parked.tenantId(), parked.sessionId(),
                "renameSession", "hosted-title:" + revision);
        // A row without its title can still be proven undelivered, never
        // matched (review of #14475).
        if (evidence.admittedDigest() != null) {
            if (title != null && DigestUtils.sha256Hex(title).equals(evidence.admittedDigest())) {
                return Optional.of(AcceptanceVerdict.committed());
            }
            AgentStoreRows.LOG.warn("Journal title digest differs from its delivery tenant={}"
                    + " session={} revision={}", parked.tenantId(), parked.sessionId(), revision);
            return Optional.of(AcceptanceVerdict.unknown());
        }
        return Optional.of(evidence.sealed()
                ? AcceptanceVerdict.notCommitted(SESSION_TITLE_UNDELIVERED)
                : AcceptanceVerdict.unknown());
    }

    boolean settleParkedRename(ParkedOperation parked, AcceptanceVerdict verdict,
            long retryAt) {
        String tenantId = parked.tenantId();
        String sessionId = parked.sessionId();
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        // Only a still-parked row: the claim's own late reply or a later
        // title may have settled it since the evidence was read.
        var rows = jdbc.queryForList("SELECT operation_key, idempotency_key, request_json"
                        + " FROM ma_operation WHERE scope_key = ? AND operation_kind = 'RENAME'"
                        + " AND operation_id = ? AND tenant_id = ? AND session_id = ? AND state ="
                        + " 'RECOVERY_BLOCKED' AND delivery_state = 'BLOCKED' FOR UPDATE",
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId), parked.operationId(),
                tenantId, sessionId);
        if (rows.isEmpty()) {
            return false;
        }
        String operationKey = (String) rows.getFirst().get("operation_key");
        String key = (String) rows.getFirst().get("idempotency_key");
        String receipt = ManagedReceipts.commandKey(tenantId, "RENAME_SESSION", key);
        long now = clock.millis();
        switch (verdict.acceptance()) {
            case COMMITTED -> {
                // The Harness holds the title, so the Session shows it in
                // whatever status a lifecycle has since reached, unless a
                // deletion took the Session away. A later title would have
                // superseded this row, so it is still the newest.
                String title = (String) storeRows.readMap((String) rows.getFirst().get("request_json"))
                        .get("title");
                if (title != null && !List.of("DELETING", "DELETED").contains(session.status())) {
                    jdbc.update("UPDATE ma_session SET title = ?, gmt_modified = ?,"
                                    + " version = version + 1 WHERE tenant_id = ? AND session_id = ?",
                            title, now, tenantId, sessionId);
                    eventJournal.appendEvent(tenantId, sessionId, null,
                            AgentSessionCommands.mutationEvent(SessionMutationKind.RENAME, "completed"),
                            Map.of("sessionId", sessionId, "metadata", Map.of("title", title)),
                            false, AgentSessionCommands.mutationSource("RENAME_SESSION", key, "completed"), now);
                }
                jdbc.update("UPDATE ma_request_receipt SET state = 'COMPLETED', gmt_modified = ?"
                                + " WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND'",
                        now, receipt);
                jdbc.update("UPDATE ma_operation SET state = 'COMPLETED', phase = 'COMPLETED',"
                                + " admission_stage = 'HARNESS_CONFIRMED', delivery_state = 'COMPLETED',"
                                + " failure_code = NULL, claim_owner = NULL, claim_until = NULL,"
                                + " gmt_modified = ?, completed_at = ? WHERE operation_key = ?",
                        now, now, operationKey);
            }
            case NOT_COMMITTED -> {
                // Terminal yet blocked, as every proven non-commit is: its
                // available_at moves past every scan for good.
                jdbc.update("UPDATE ma_request_receipt SET state = 'FAILED', gmt_modified = ?"
                                + " WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND'"
                                + " AND state = 'PENDING'",
                        now, receipt);
                jdbc.update("UPDATE ma_operation SET state = 'FAILED', phase = 'FAILED',"
                                + " admission_stage = 'JAVA_DURABLE', delivery_state = 'BLOCKED',"
                                + " failure_code = ?, available_at = ?, claim_owner = NULL,"
                                + " claim_until = NULL, gmt_modified = ?, completed_at = ?"
                                + " WHERE operation_key = ?",
                        verdict.failureCode(), Long.MAX_VALUE, now, now, operationKey);
            }
            case UNKNOWN -> jdbc.update("UPDATE ma_operation SET available_at = ?, gmt_modified = ?,"
                            + " attempt_count = attempt_count + 1 WHERE operation_key = ?",
                    Math.addExact(storeRows.lifecycleDatabaseTime(), Math.max(0, retryAt - now)), now,
                    operationKey);
        }
        return true;
    }

    boolean settleTaskCancel(String tenantId, String sessionId,
            String operationId, String owner, long claimGeneration,
            TaskCancelOutcome outcome, long retryAt) {
        if (owner == null) {
            throw new IllegalArgumentException(
                    "A parked task cancel settles through settleParkedOperation");
        }
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = storeRows.lifecycleDatabaseTime();
        // A leased claim settles only while it is still this worker's.
        String claim = " AND state = 'RUNNING' AND delivery_state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + "";
        List<Object> arguments = new ArrayList<>();
        String update = switch (outcome.status()) {
            case "completed" -> {
                arguments.add(AgentStoreRows.publicId("rcpt"));
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'COMPLETED', state = 'COMPLETED',"
                        + " admission_stage = 'HARNESS_CONFIRMED',"
                        + " delivery_state = 'CONFIRMED', receipt_id = ?,"
                        + " failure_code = NULL, claim_owner = NULL,"
                        + " claim_until = NULL, gmt_modified = ?,"
                        + " completed_at = ?";
            }
            case "failed" -> {
                // A failed cancel is terminal yet keeps the contract's
                // blocked delivery state: its available_at moves past
                // every scan of the blocked index range for good.
                arguments.add(outcome.failureCode());
                arguments.add(Long.MAX_VALUE);
                arguments.add(now);
                arguments.add(now);
                yield "UPDATE ma_operation SET phase = 'FAILED', state = 'FAILED',"
                        + " admission_stage = 'JAVA_DURABLE',"
                        + " delivery_state = 'BLOCKED', failure_code = ?,"
                        + " available_at = ?, claim_owner = NULL,"
                        + " claim_until = NULL, gmt_modified = ?,"
                        + " completed_at = ?";
            }
            case "recovery_blocked" -> {
                arguments.add(outcome.failureCode());
                arguments.add(Math.addExact(now,
                        Math.max(0, retryAt - clock.millis())));
                arguments.add(now);
                yield "UPDATE ma_operation SET"
                        + " phase = 'RECOVERY_BLOCKED', state = 'RECOVERY_BLOCKED',"
                        + " admission_stage = 'JAVA_DURABLE',"
                        + " delivery_state = 'BLOCKED', failure_code = ?,"
                        + " available_at = ?, claim_owner = NULL,"
                        + " claim_until = NULL, gmt_modified = ?,"
                        + " attempt_count = attempt_count + 1";
            }
            default -> throw new IllegalArgumentException(
                    "Unknown task cancel outcome " + outcome.status());
        };
        arguments.addAll(List.of(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId), AgentStoreRows.sessionOperationTarget(sessionId), tenantId, sessionId, operationId, owner, claimGeneration));
        return jdbc.update(
                        update
                                + " WHERE scope_key = ? AND operation_kind IN "
                                + AgentStoreRows.SESSION_OPERATION_KINDS
                                + " AND target_key = ? AND tenant_id = ? AND session_id = ? AND"
                                + " operation_id = ? AND operation_kind = 'TASK_CANCEL'"
                                + claim,
                        arguments.toArray())
                == 1;
    }

    // The initiator, persisted at V56 admission: settlement fails when the
    // operating actor no longer holds OPERATOR — revoking one in-flight
    // initiator stops only their own admitted change, as the W2 guard
    // intends. A pre-V56 (NULL key) row settles on the creator-keyed facts
    // alone. The vocabulary filter keeps an out-of-enum stored role (only
    // reachable by an out-of-band write past V53's CHECK) on the same
    // fail-closed workspace_unavailable verdict as a revocation, rather
    // than an IllegalArgumentException looping through the retry.
    boolean initiatorKeepsOperate(SessionRecord session,
            OperationRecord operation) {
        if (operation.actorKey() == null) {
            return true;
        }
        List<String> roles = jdbc.queryForList("SELECT role FROM"
                        + " ma_workspace_access WHERE tenant_id = ? AND"
                        + " workspace_id = ? AND actor_id = ? AND role IN"
                        + " ('READER', 'OPERATOR', 'OWNER')",
                String.class, session.tenantId(),
                session.workspace().getWorkspaceId(), operation.actorKey());
        return !roles.isEmpty() && WorkspaceAccess.valueOf(roles.getFirst())
                .atLeast(WorkspaceAccess.OPERATOR);
    }
}
