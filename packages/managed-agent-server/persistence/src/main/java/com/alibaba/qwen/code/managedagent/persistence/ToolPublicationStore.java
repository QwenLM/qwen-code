package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.text;

/** Reserves publication capacity and fences producer grants against the Session owner. */
public final class ToolPublicationStore {
    public record Capacity(long executionBytes, long sessionBytes, long tenantBytes,
            long activeCaptures) {
        public Capacity {
            require(executionBytes > 0 && executionBytes <= ToolPublicationContract.MAX_CAPTURE_BYTES,
                    "Invalid execution capacity");
            for (long value : new long[] {sessionBytes, tenantBytes, activeCaptures}) {
                require(value > 0 && value <= ToolPublicationContract.MAX_COUNT,
                        "Invalid publication capacity");
            }
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JdbcManagedSessionStore sessions;
    private final ToolExecutionRepository executions;
    private final RuntimeBindingRepository bindings;
    private final Capacity capacity;
    private final ToolPublicationCapacityStore quotas;
    private final ToolPublicationEvidence evidence;
    private final DataSource transactionSource;

    private enum Access {
        DISPATCH, PRODUCE, CLAIM, SETTLE
    }

    public record ProducerBinding(JsonNode binding, ToolExecutionRecord execution, long expiresAt) {
    }

    private record PublicationTarget(Row row, JsonNode binding, RuntimeBindingRecord runtime, boolean placement) {
    }

    private record Original(RuntimeBindingRecord runtime, ToolExecutionRecord execution) {
    }
    public ToolPublicationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            JdbcManagedSessionStore sessions, ToolExecutionRepository executions,
            RuntimeBindingRepository bindings, Capacity capacity) {
        this.jdbc = Objects.requireNonNull(jdbc);
        this.transactions = new TransactionTemplate(manager);
        // Discovery precedes the head lock; evidence must see the commits observed by that lock.
        this.transactions.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.sessions = Objects.requireNonNull(sessions);
        this.executions = Objects.requireNonNull(executions);
        this.bindings = Objects.requireNonNull(bindings);
        this.capacity = Objects.requireNonNull(capacity);
        this.quotas = new ToolPublicationCapacityStore(jdbc, capacity);
        this.evidence = new ToolPublicationEvidence(jdbc, sessions, this);
        this.transactionSource = manager instanceof DataSourceTransactionManager nativeManager
                ? nativeManager.getDataSource() : null;
    }

    boolean usesDataSource(DataSource source) {
        return source != null && jdbc.getDataSource() == source && transactionSource == source
                && sessions.usesDataSource(source)
                && bindings instanceof JdbcRuntimeBindingRepository nativeBindings
                && nativeBindings.usesDataSource(source)
                && executions instanceof JdbcToolExecutionRepository nativeExecutions
                && nativeExecutions.usesDataSource(source);
    }

    public JsonNode apply(JsonNode input, String writerToken, String publicationToken) {
        JsonNode request = ToolPublicationContract.parse("request", input);
        String operation = text(request, "operation");
        String hash = ("reserve".equals(operation) || "renew".equals(operation))
                ? ToolPublicationContract.tokenHash(publicationToken) : null;
        return transactions.execute(status -> applyLocked(request, writerToken, hash));
    }

    /** Rechecks the saved grant and original execution before installing it on a worker. */
    public JsonNode verifyDispatch(ToolExecutionRecord execution,
            String publicationId, String publicationToken) {
        return verifyDispatchGrant(execution, publicationId, publicationToken).binding();
    }

    /**
     * The same dispatch recheck, also answering the grant's own horizon. A
     * worker that keeps its capture store locally never sees the control-plane
     * grant, so the Broker needs that horizon to bound the channel it opens
     * there. It comes from the read this method already locks and validates,
     * so a second unlocked read could only be weaker.
     */
    public ProducerBinding verifyDispatchGrant(ToolExecutionRecord execution,
            String publicationId, String publicationToken) {
        RuntimeBindingRecord runtime = bindings.findById(execution.getBindingId());
        require(runtime != null, "Original Runtime binding is missing");
        var runtimeScope = runtime.getRequest().getScope();
        String tenant = runtimeScope.getTenantId();
        String workspace = runtimeScope.getWorkspaceId();
        String session = execution.getHarnessSessionId();
        String scope = hash(JSON.createArrayNode().add(tenant).add(workspace)
                .add(session).toString());
        return transactions.execute(status -> {
            ProducerBinding grant = producerGrantLocked(scope, publicationId, publicationToken);
            JsonNode binding = grant.binding();
            require(publicationId.equals(text(binding, "publicationId"))
                    && execution.getExecutionCallId().equals(text(binding, "executionCallId"))
                    && execution.getRequestDigest().equals(text(binding, "requestDigest"))
                    && execution.getReference().get("argsDigest").equals(
                            text(binding.path("reference"), "argsDigest")),
                    "Original publication execution conflicts");
            return grant;
        });
    }

    private ProducerBinding producerGrantLocked(String scope, String publicationId,
            String publicationToken) {
        return producerBindingWithHashLocked(scope, publicationId,
                ToolPublicationContract.tokenHash(publicationToken), null, Access.DISPATCH);
    }

    private ProducerBinding producerGrantLocked(String scope, String publicationId,
            String publicationToken) {
        return producerBindingWithHashLocked(scope, publicationId,
                ToolPublicationContract.tokenHash(publicationToken), null, Access.DISPATCH);
    }

    JsonNode producerMutationBindingLocked(String scope, String publicationId, String publicationToken) {
        return producerBindingLocked(scope, publicationId, publicationToken, Access.PRODUCE).binding();
    }

    ProducerBinding producerClaimBindingLocked(String scope, String publicationId, String publicationToken) {
        return producerBindingLocked(scope, publicationId, publicationToken, Access.CLAIM);
    }

    private ProducerBinding producerBindingLocked(String scope, String publicationId,
            String publicationToken, Access access) {
        String suppliedHash = ToolPublicationContract.tokenHash(publicationToken);
        return producerBindingWithHashLocked(scope, publicationId, suppliedHash, null, access);
    }

    ProducerBinding producerVerificationBindingLocked(String scope, String publicationId,
            String bindingDigest, String tokenHash) {
        try {
            require(bindingDigest != null && tokenHash != null, "Accepted verification identity is missing");
            // Completing an accepted claim. CLAIM still allows a settled CSI execution
            // after retirement; PRODUCE would fail that claim permanently.
            return producerBindingWithHashLocked(scope, publicationId, tokenHash, bindingDigest,
                    Access.CLAIM, true);
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(409, "managed_tool_publication_fenced",
                    "Original publication authority is fenced", error);
        }
    }

    private ProducerBinding producerBindingWithHashLocked(String scope, String publicationId,
            String suppliedHash, String expectedBindingDigest, Access access) {
        return producerBindingWithHashLocked(scope, publicationId, suppliedHash,
                expectedBindingDigest, access, false);
    }

    private ProducerBinding producerBindingWithHashLocked(String scope, String publicationId,
            String suppliedHash, String expectedBindingDigest, Access access,
            boolean deferActivationLapse) {
        Row row = publicationRow(scope, publicationId);
        JsonNode binding = storedBinding(row.binding(), row.digest(), "Publication grant conflicts");
        require((expectedBindingDigest == null || expectedBindingDigest.equals(row.digest()))
                && equalHash(suppliedHash, row.tokenHash()) && "OPEN".equals(row.state()),
                "Publication grant conflicts");
        Original original;
        try {
            original = lockOriginal(binding);
        } catch (RuntimeException error) {
            // Accepted tasks must leave the queue when their original
            // authority is gone; credential/SQL failures may recover elsewhere.
            boolean missingRuntime = error instanceof IllegalStateException && error.getCause() == null
                    && ("Runtime binding slot is unavailable".equals(error.getMessage())
                    || "Original Runtime binding is unavailable".equals(error.getMessage()));
            if (expectedBindingDigest != null && missingRuntime) {
                throw new ManagedAgentException(409, "managed_tool_publication_runtime_unavailable",
                        "Original publication runtime is unavailable");
            }
            throw error;
        }
        return producerBindingAfterParentLocked(scope, publicationId, suppliedHash, row,
                binding, original, access, deferActivationLapse);
    }

    private ProducerBinding producerBindingAfterParentLocked(String scope, String publicationId,
            String suppliedHash, Row row, JsonNode binding, Original original, Access access) {
        return producerBindingAfterParentLocked(scope, publicationId, suppliedHash, row,
                binding, original, access, false);
    }

    private ProducerBinding producerBindingAfterParentLocked(String scope, String publicationId,
            String suppliedHash, Row row, JsonNode binding, Original original, Access access,
            boolean deferActivationLapse) {
        JsonNode key = binding.get("sessionKey");
        ToolPublicationRetentionStore.requireLive(jdbc, row.tenant(), row.session());
        require(row.tenant().equals(text(key, "tenantId"))
                && row.workspace().equals(text(key, "workspaceId"))
                && row.session().equals(text(key, "sessionId")), "Publication scope conflicts");
        var head = jdbc.query(
                                "SELECT workspace_id, state, writer_id, writer_generation, CASE WHEN writer_lease_until > " + ManagedSchemaTime.SQL_NOW + " THEN 1 ELSE 0 END AS writer_live, recovery_status, activation_epoch, journal_revision, activation_id, activation_phase, activation_event_epoch, activation_expires_at, activation_head_revision FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? FOR UPDATE", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                ManagedSchemaKeys.key(row.tenant()), ManagedSchemaKeys.key(row.session()), row.tenant(), row.session()).getFirst();
        var current = jdbc.query(
                                "SELECT token_hash, state, expires_at, binding_digest,"
                                    + " binding_json, tenant_id, workspace_id, session_id, CASE"
                                    + " WHEN is_quarantined THEN 1 ELSE 0 END AS is_quarantined FROM"
                                    + " ma_output_capture WHERE scope_key = ? AND publication_id ="
                                    + " ? FOR UPDATE", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                scope, publicationId).getFirst();
        long nowEpoch = ToolPublicationRetentionStore.now(jdbc);
        require(((Number) current.get("is_quarantined")).intValue() == 0, "Publication is quarantined");
        if (access != Access.SETTLE) {
            require(equalHash(suppliedHash, (String) current.get("token_hash"))
                    && "OPEN".equals(current.get("state")) && current.get("expires_at") != null,
                    "Publication grant changed or expired");
        }
        require(row.digest().equals(current.get("binding_digest"))
                && row.binding().equals(current.get("binding_json"))
                && row.tenant().equals(current.get("tenant_id"))
                && row.workspace().equals(current.get("workspace_id"))
                && row.session().equals(current.get("session_id")), "Publication binding changed");
        require(row.workspace().equals(head.get("workspace_id")) && "ACTIVE".equals(head.get("state"))
                && text(binding, "writerId").equals(head.get("writer_id"))
                && ((Number) head.get("writer_generation")).longValue() == binding.get("writerGeneration").longValue()
                && ((Number) head.get("writer_live")).intValue() == 1
                && ((Number) head.get("activation_epoch")).longValue() == binding.get("activationEpoch").longValue(),
                "Original Session owner is fenced");
        require("READY".equals(head.get("recovery_status")), "Original Session owner is fenced");
        // The grant expiry is min(writer lease, activation horizon), so a
        // real activation lapse expires the grant on the same clock and
        // this check runs before the activation deferral below.
        if (access != Access.SETTLE && ((Number) current.get("expires_at")).longValue() <= nowEpoch) {
            if (deferActivationLapse) {
                throw new ActivationLapsedException();
            }
            require(false, "Publication grant changed or expired");
        }
        require(head.get("activation_head_revision") instanceof Number stamped
                && stamped.longValue() == ((Number) head.get("journal_revision")).longValue()
                && "active".equals(head.get("activation_phase"))
                && text(binding, "activationId").equals(head.get("activation_id"))
                && head.get("activation_event_epoch") instanceof Number epoch
                && epoch.longValue() == binding.get("activationEpoch").longValue()
                && head.get("activation_expires_at") instanceof Number,
                "Original activation is fenced");
        long activationUntil = requireCurrentActivation(
                ((Number) head.get("activation_expires_at")).longValue(), nowEpoch,
                deferActivationLapse);
        nowEpoch = ToolPublicationRetentionStore.now(jdbc);
        Integer writerLive = jdbc.queryForObject(
                        "SELECT CASE WHEN writer_lease_until > " + ManagedSchemaTime.SQL_NOW + " THEN 1 ELSE 0 END FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? FOR UPDATE", Integer.class, ManagedSchemaKeys.key(row.tenant()), ManagedSchemaKeys.key(row.session()), row.tenant(), row.session());
        if (writerLive == null || writerLive != 1) {
            require(false, "Original Session or activation expired");
        }
        if (activationUntil <= nowEpoch) {
            // Renewal keeps the activation id and epoch, so a lapsed horizon can
            // recover. An expired writer lease is not renewable and stays above.
            if (deferActivationLapse) {
                throw new ActivationLapsedException();
            }
            require(false, "Original Session or activation expired");
        }
        if (access != Access.SETTLE) {
            require(((Number) current.get("expires_at")).longValue() > nowEpoch, "Publication grant expired");
        }
        requireAccess(original, access);
        Object horizon = current.get("expires_at");
        return new ProducerBinding(binding, original.execution(),
                horizon instanceof Number expiry ? expiry.longValue() : 0L);
    }

    private JsonNode applyLocked(JsonNode request, String writerToken, String tokenHash) {
        JsonNode key = request.get("sessionKey");
        String tenant = text(key, "tenantId");
        String workspace = text(key, "workspaceId");
        String session = text(key, "sessionId");
        String tenantKey = ManagedSchemaKeys.key(tenant);
        String scope = hash(JSON.createArrayNode().add(tenant).add(workspace).add(session).toString());
        JsonNode candidate = request.get("binding");
        String id = candidate == null ? text(request, "publicationId") : text(candidate, "publicationId");
        PublicationTarget target = lockPublicationPlacement(key, id, candidate, false);
        lockOriginal(target.binding(), false, target.runtime());
        // Every mutation uses this order, including no-start capacity release:
        // Session root and head, then the publication row, as collection does.
        // An ordinary publication takes no tenant publication guard:
        // reservations of one Session serialize on its root, so the Session
        // byte limit stays exact, and this lane reads committed data, so a
        // reservation sees every one committed before its sums. Reservations
        // of different Sessions may overlap between their sums and commits and
        // briefly pass the tenant byte and active-capture limits together;
        // that bounded, self-correcting overshoot is accepted (design
        // 2026-11-04-managed-publication-tenant-guards).
        JsonNode owner = request.get("owner");
        var writer = sessions.lockPublicationWriter(tenant, workspace, session,
                text(owner, "writerId"), owner.get("writerGeneration").longValue(), writerToken, target.placement(), false);
        String operation = text(request, "operation");
        List<Row> rows = jdbc.query("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture"
                        + " WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                (r, index) -> new Row(r.getString("tenant_id"), r.getString("workspace_id"),
                        r.getString("session_id"), r.getString("binding_json"),
                        r.getString("binding_digest"), r.getString("token_hash"),
                        r.getString("state"), r.getObject("expires_at", Long.class),
                        r.getLong("capture_bytes")), scope, id);
        Row row = rows.isEmpty() ? null : rows.get(0);
        if (row != null) {
            require(tenant.equals(row.tenant()) && workspace.equals(row.workspace())
                    && session.equals(row.session()), "Publication scope conflicts");
            if (target.row() != null) {
                require(target.row().binding().equals(row.binding()) && target.row().digest().equals(row.digest()),
                        "Publication binding changed");
            }
        }
        if ("reserve".equals(operation)) {
            long bytes = request.get("captureBytes").longValue();
            String digest = ToolPublicationContract.bindingDigest(candidate);
            if (row != null) {
                require(digest.equals(row.digest()) && bytes == row.captureBytes()
                        && equalHash(tokenHash, row.tokenHash()), "Reservation replay conflicts");
                require("OPEN".equals(row.state()), "Reservation is fenced");
                evidence.requireEvidence(candidate, writerToken, writer, false);
                require(row.expiresAt() > writer.now(), "Reservation expired; renew explicitly");
                return grant(id, row);
            }
            long expires = evidence.requireEvidence(candidate, writerToken, writer, true);
            require(bytes <= capacity.executionBytes(), "Execution capture capacity exceeded");
            long allocation = bytes + ToolPublicationContract.PRODUCER_BYTES
                    + ToolPublicationContract.ADMISSION_BYTES;
            quotas.requireCapacity(tenantKey, scope, allocation, writer.now());
            jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id,"
                            + " session_id, publication_id, execution_key, capture_id, binding_json,"
                        + " binding_digest, token_hash, state, expires_at, capture_bytes,"
                        + " producer_bytes, admission_bytes, capture_held_bytes,"
                        + " producer_held_bytes, admission_held_bytes, is_write_evidence) VALUES (?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, TRUE)",
                    scope, tenantKey, tenant, workspace, session, id, hash(text(candidate, "executionCallId")),
                    text(candidate, "captureId"), candidate.toString(), digest, tokenHash, expires, bytes,
                    ToolPublicationContract.PRODUCER_BYTES, ToolPublicationContract.ADMISSION_BYTES,
                    bytes, ToolPublicationContract.PRODUCER_BYTES, ToolPublicationContract.ADMISSION_BYTES);
            return grant(id, new Row(tenant, workspace, session, candidate.toString(), digest, tokenHash,
                    "OPEN", expires, bytes));
        }
        require(row != null, "Publication does not exist");
        JsonNode binding = storedBinding(row.binding(), row.digest(), "Stored binding is corrupt");
        if ("renew".equals(operation)) {
            require("OPEN".equals(row.state()) && equalHash(tokenHash, row.tokenHash()), "Publication is fenced");
            require(text(owner, "writerId").equals(text(binding, "writerId"))
                    && owner.get("writerGeneration").longValue() == binding.get("writerGeneration").longValue(),
                    "Original writer is fenced");
            long expires = evidence.requireEvidence(binding, writerToken, writer, false);
            jdbc.update(
                    "UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", expires_at = ? WHERE scope_key = ? AND"
                            + " publication_id = ?",
                    expires, scope, id);
            return grant(id, row.withState("OPEN", expires));
        }
        String state = "FENCED";
        if ("close_not_started".equals(operation)) {
            ToolExecutionRecord execution = requireExecution(binding, false);
            require(execution.isSettled() && ("not_started".equals(execution.getExecutionStatus())
                    || "cancelled".equals(execution.getExecutionStatus()) && execution.getDispatchGeneration() == 0),
                    "Execution has no authoritative not-started proof");
            Long published = jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, id);
            Long attempted = jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, id);
            require(published == 0 && attempted == 0 && "OPEN".equals(jdbc.queryForObject(
                                                    "SELECT producer_phase FROM ma_output_capture"
                                                        + " WHERE scope_key = ? AND publication_id"
                                                        + " = ?", String.class, scope, id)),
                    "Publication has accepted producer work");
            state = "NOT_STARTED";
        } else if ("NOT_STARTED".equals(row.state())) {
            state = row.state();
        }
        jdbc.update(
                "UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = ?, expires_at = NULL, capture_held_bytes ="
                    + " CASE WHEN ? = 'NOT_STARTED' THEN 0 ELSE capture_used_bytes END,"
                    + " producer_held_bytes = CASE WHEN ? = 'NOT_STARTED' THEN 0 ELSE"
                    + " producer_used_bytes END, admission_held_bytes = CASE WHEN ? = 'NOT_STARTED'"
                    + " THEN 0 WHEN producer_phase IN ('FINISHED', 'REFERENCED') THEN"
                    + " admission_held_bytes ELSE admission_used_bytes END WHERE scope_key = ? AND"
                    + " publication_id = ?", state, state, state, state, scope, id);
        return grant(id, row.withState(state, null));
    }

    ToolExecutionRecord liveExecution(JsonNode b) {
        return requireExecution(b, true);
    }

    private ToolExecutionRecord requireExecution(JsonNode b, boolean live) {
        Original original = lockOriginal(b);
        if (live) {
            requireAccess(original, Access.DISPATCH);
        }
        return original.execution();
    }

    private Original lockOriginal(JsonNode b) {
        return lockOriginal(b, false);
    }

    private Original lockOriginal(JsonNode b, boolean acknowledgement) {
        return lockOriginal(b, acknowledgement, publicationRuntime(b));
    }

    private Original lockOriginal(JsonNode b, boolean acknowledgement, RuntimeBindingRecord runtime) {
        ToolExecutionRecord execution;
        if (bindings instanceof JdbcRuntimeBindingRepository nativeBindings
                && executions instanceof JdbcToolExecutionRepository nativeExecutions) {
            require(nativeBindings.usesDataSource(jdbc.getDataSource())
                    && nativeExecutions.usesDataSource(jdbc.getDataSource())
                    && transactionSource == jdbc.getDataSource(),
                    "Local publication requires native repositories on the original DataSource");
            RuntimeBindingRecord hint = runtime;
            Original locked = jdbc.execute((ConnectionCallback<Original>) connection -> {
                var target = DataSourceUtils.getTargetConnection(connection);
                require(DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource()),
                        "Local publication requires the original transaction connection");
                var originalBinding = ToolPublicationPlacement.lockOriginal(jdbc, nativeBindings, target, hint,
                        text(b.path("sessionKey"), "sessionId"));
                require(originalBinding != null, "Original Runtime binding is missing");
                var originalExecution = nativeExecutions.findByExecutionCallIdForUpdate(
                        target, text(b, "executionCallId"));
                return new Original(originalBinding, originalExecution);
            });
            runtime = locked.runtime();
            execution = locked.execution();
        } else {
            execution = executions.findByExecutionCallId(text(b, "executionCallId"));
        }
        JsonNode key = b.get("sessionKey");
        JsonNode ref = b.get("reference");
        require(execution != null && runtime != null, "Original Broker records are missing");
        var scope = runtime.getRequest().getScope();
        require(scope.getTenantId().equals(text(key, "tenantId"))
                && scope.getWorkspaceId().equals(text(key, "workspaceId"))
                && runtime.getGeneration() == Long.parseLong(text(b, "bindingGeneration"))
                && execution.getBindingId().equals(runtime.getBindingId())
                && execution.getRuntimeGeneration() == runtime.getGeneration()
                && execution.getHarnessSessionId().equals(text(key, "sessionId"))
                && execution.getRuntimeSessionId().equals(text(ref, "sessionId"))
                && execution.getTurnId().equals(text(ref, "promptId"))
                && execution.getToolCallId().equals(text(ref, "callId"))
                && "deferred_v3".equals(execution.getReference().get("dispatchMode"))
                && text(b, "publicationId").equals(execution.getReference().get("publicationId"))
                && text(ref, "argsDigest").equals(execution.getReference().get("argsDigest"))
                && execution.getRequestDigest().equals(text(b, "requestDigest")), "Broker execution identity conflicts");
        return new Original(runtime, execution);
    }

    private static void requireAccess(Original original, Access access) {
        RuntimeBindingRecord runtime = original.runtime();
        ToolExecutionRecord execution = original.execution();
        if (access == Access.SETTLE) {
            require(execution.getState() == ToolExecutionRecord.State.SETTLED,
                    "Original result is not settled");
        } else {
            require(runtime.getState() == RuntimeBindingRecord.State.READY && !runtime.isDrainRequested()
                    && !execution.isSettled(), "Runtime cannot authorize publication");
        }
    }

    private Row publicationRow(String scope, String publicationId) {
        Row row = findPublicationRow(scope, publicationId);
        require(row != null, "Publication does not exist");
        return row;
    }

    private Row findPublicationRow(String scope, String publicationId) {
        List<Row> rows = jdbc.query("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture WHERE scope_key = ?"
                        + " AND publication_id = ?",
                (r, index) -> new Row(r.getString("tenant_id"), r.getString("workspace_id"),
                        r.getString("session_id"), r.getString("binding_json"), r.getString("binding_digest"),
                        r.getString("token_hash"), r.getString("state"), r.getObject("expires_at", Long.class),
                        r.getLong("capture_bytes")), scope, publicationId);
        require(rows.size() <= 1, "Publication is ambiguous");
        return rows.isEmpty() ? null : rows.getFirst();
    }

    void lockStagedPlacement(JsonNode key, String publicationId, boolean requirePlacement) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            transactions.executeWithoutResult(status -> lockPublicationPlacement(key, publicationId, requirePlacement));
        }
    }

    boolean lockPublicationPlacement(JsonNode key, String publicationId, boolean requirePlacement) {
        return lockPublicationPlacement(key, publicationId, null, requirePlacement).placement();
    }

    private PublicationTarget lockPublicationPlacement(JsonNode key, String publicationId, JsonNode candidate,
            boolean requirePlacement) {
        String scope = hash(JSON.createArrayNode().add(text(key, "tenantId"))
                .add(text(key, "workspaceId")).add(text(key, "sessionId")).toString());
        Row row = findPublicationRow(scope, publicationId);
        JsonNode binding = candidate;
        if (row != null) {
            require(row.tenant().equals(text(key, "tenantId")) && row.workspace().equals(text(key, "workspaceId"))
                    && row.session().equals(text(key, "sessionId")), "Publication scope conflicts");
            binding = storedBinding(row.binding(), row.digest(), "Stored binding is corrupt");
            require(candidate == null || ToolPublicationContract.bindingDigest(candidate).equals(row.digest()),
                    "Reservation replay conflicts");
        }
        require(binding != null, "Publication does not exist");
        require(binding.path("sessionKey").equals(key) && publicationId.equals(text(binding, "publicationId")),
                "Publication scope conflicts");
        RuntimeBindingRecord runtime = publicationRuntime(binding);
        // The lane's first lock: placement, or the Session root for an ordinary original
        // (design 2026-11-04-managed-publication-placement). Later locks follow it.
        return new PublicationTarget(row, binding, runtime, ToolPublicationPlacement.lockEntry(jdbc, bindings,
                runtime, text(key, "tenantId"), text(key, "sessionId"), requirePlacement));
    }

    private RuntimeBindingRecord publicationRuntime(JsonNode binding) {
        RuntimeBindingRecord runtime = bindings.findById(text(binding, "runtimeBindingId"));
        require(runtime != null, "Original Runtime binding is missing");
        JsonNode key = binding.path("sessionKey");
        var scope = runtime.getRequest().getScope();
        require(runtime.getBindingId().equals(text(binding, "runtimeBindingId"))
                && scope.getTenantId().equals(text(key, "tenantId"))
                && scope.getWorkspaceId().equals(text(key, "workspaceId"))
                && runtime.getGeneration() == Long.parseLong(text(binding, "bindingGeneration")),
                "Broker execution identity conflicts");
        if (bindings instanceof JdbcRuntimeBindingRepository nativeBindings
                && nativeBindings.usesDataSource(jdbc.getDataSource())) {
            var rows = jdbc.query("SELECT binding_id, tenant_id, workspace_id, runtime_generation,"
                    + " provisioner_kind FROM ma_runtime_binding WHERE binding_id = ?", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), runtime.getBindingId());
            require(rows.size() == 1, "Original Runtime binding is missing");
            var row = rows.getFirst();
            require(runtime.getBindingId().equals(row.get("binding_id"))
                    && scope.getTenantId().equals(row.get("tenant_id"))
                    && scope.getWorkspaceId().equals(row.get("workspace_id"))
                    && row.get("runtime_generation") instanceof Number generation
                    && generation.longValue() == runtime.getGeneration()
                    && runtime.getRequest().getProvisionerKind().equals(row.get("provisioner_kind")),
                    "Original persisted Runtime scope conflicts");
        }
        return runtime;
    }

    static void requireLockedBinding(Map<String, Object> row, JsonNode expected) {
        JsonNode binding = storedBinding((String) row.get("binding_json"),
                (String) row.get("binding_digest"), "Publication binding changed");
        require(binding.equals(expected), "Publication binding changed");
    }

    private static JsonNode storedBinding(String value, String digest, String message) {
        JsonNode binding = ToolPublicationContract.parseBytes("binding", value.getBytes(StandardCharsets.UTF_8));
        require(ToolPublicationContract.bindingDigest(binding).equals(digest), message);
        return binding;
    }

    /** Locks placement and verifies the finished binding; always returns false (CSI removed). */
    boolean lockOriginalSettledResult(JsonNode key, String publicationId, JsonNode finished) {
        PublicationTarget target = lockPublicationPlacement(key, publicationId, null, false);
        require(target.binding().equals(finished.path("binding")), "Original finished binding conflicts");
        return false;
    }

    ToolExecutionRecord lockOriginalAcknowledgementResult(JsonNode key, String publicationId, JsonNode finished) {
        throw new IllegalStateException("Original acknowledgement is no longer supported");
    }

    // The admission lanes' entry: placement or the Session root, then root
    // and head, as collection does (design 2026-11-04-managed-publication-placement).
    void lockAdmissionLane(JsonNode key, String publicationId, JsonNode original,
            String writerId, long writerGeneration, String writerToken) {
        boolean placement = lockPublicationPlacement(key, publicationId, false);
        lockOriginalSettledResult(key, publicationId, original);
        sessions.lockPublicationWriter(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), writerId, writerGeneration, writerToken, placement, false);
    }

    void requireStagedCall(JsonNode key, String publicationId) {
        // No CSI ambient check needed; all publications are ordinary.
    }

    private static JsonNode grant(String id, Row row) {
        ObjectNode grant = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL)
                .put("publicationId", id).put("bindingDigest", row.digest()).put("state", row.state())
                .put("captureBytes", row.captureBytes()).put("producerBytes", ToolPublicationContract.PRODUCER_BYTES)
                .put("admissionBytes", ToolPublicationContract.ADMISSION_BYTES);
        if (row.expiresAt() == null) {
            grant.putNull("expiresAt");
        } else {
            grant.put("expiresAt", row.expiresAt());
        }
        return ToolPublicationContract.parse("grant", grant);
    }

    private static long requireCurrentActivation(Long expiresAt, long nowEpoch, boolean deferLapse) {
        if (expiresAt == null || expiresAt <= nowEpoch) {
            if (deferLapse && expiresAt != null) {
                throw new ActivationLapsedException();
            }
            require(false, "Original activation is fenced");
        }
        return expiresAt;
    }

    private static final class ActivationLapsedException extends RuntimeException {
        private ActivationLapsedException() {
            super("Original activation expired");
        }
    }

    private static String hash(String text) {
        return ToolPublicationContract.sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    private static boolean equalHash(String left, String right) {
        return MessageDigest.isEqual(left.getBytes(StandardCharsets.US_ASCII), right.getBytes(StandardCharsets.US_ASCII));
    }

    private record Row(String tenant, String workspace, String session, String binding,
            String digest, String tokenHash, String state, Long expiresAt, long captureBytes) {
        Row withState(String next, Long expiry) {
            return new Row(tenant, workspace, session, binding, digest, tokenHash, next, expiry, captureBytes);
        }
    }
}
