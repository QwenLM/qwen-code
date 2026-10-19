package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.PublishToolResultRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.RecoveryStateReceipt;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.SealReceipt;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredTransaction;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import java.util.regex.Pattern;

@Repository
public class ManagedSessionStore {
    private static final int STORAGE_VERSION = 1;
    private static final ObjectMapper CSI_JSON = new ObjectMapper();
    private static final ObjectMapper CSI_TERMINAL_JSON = CSI_JSON.copy().enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(com.fasterxml.jackson.databind.DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    private static final int MAX_ID_BYTES = 512;
    private static final int MAX_TEXT_BYTES = 4096;
    // Hot paths touch the tenant-wide guard rows only on admission, and
    // never wait on them past this per-statement bound: a held row degrades
    // to a named, retryable failure instead of out-waiting the caller's own
    // request budget (#13800).
    static final int GUARD_ACQUIRE_TIMEOUT_SECONDS = 5;
    private static final Pattern DIGEST = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern WRITER_TOKEN = Pattern.compile(
            "^[A-Za-z0-9_-]{"
                    + ManagedSessionStoreModels.MIN_WRITER_TOKEN_LENGTH + ","
                    + ManagedSessionStoreModels.MAX_WRITER_TOKEN_LENGTH + "}$");
    private static final Set<String> HEAD_STATES = Set.of(
            "ACTIVE", "SEALED", "DELETING", "DELETED");
    private static final Set<String> RECOVERY_STATES = Set.of(
            "READY", "BLOCKED_RESOURCE", "BLOCKED_WORKSPACE",
            "BLOCKED_EXECUTION");
    private final JdbcTemplate jdbc;
    private ToolPublicationObjectStore publicationObjects;
    private ManagedToolResultStore toolResults;
    private JournalEventTransport journalEventTransport;
    private WriterCredentialPolicy credentials = WriterCredentialPolicy.unbound();
    private JdbcRuntimeBindingRepository csiBindings;
    private final ManagedExtensionRecordStore extensionRecords;
    private final ManagedActionStore actions;
    private final ToolPublicationRetentionStore outputRetention;
    private final org.springframework.transaction.support.TransactionTemplate ownerReads;
    private final RowMapper<HeadRow> headMapper = (result, row) ->
            new HeadRow(result.getString("tenant_id"),
                    result.getString("workspace_id"),
                    result.getString("session_id"),
                    result.getString("state"),
                    result.getInt("storage_version"),
                    result.getLong("writer_generation"),
                    result.getString("writer_id"),
                    ManagedSchemaTime.timestamp(result, "writer_lease_until"),
                    result.getString("lease_token_hash"),
                    result.getLong("journal_revision"),
                    result.getLong("committed_sequence"),
                    result.getString("last_commit_digest"),
                    result.getLong("activation_epoch"),
                    result.getString("latest_checkpoint_resource_id"),
                    result.getLong("compacted_through_revision"),
                    result.getString("recovery_status"),
                    result.getString("recovery_detail_code"),
                    result.getString("activation_id"),
                    result.getString("activation_phase"),
                    result.getObject("activation_event_epoch", Long.class),
                    result.getObject("activation_expires_at", Long.class),
                    result.getObject("activation_head_revision", Long.class));
    private final RowMapper<TransactionRow> transactionMapper =
            (result, row) -> transactionRow(result);
    private final RowMapper<ResourceRow> resourceMapper =
            (result, row) ->
                    new ResourceRow(
                            result.getString("tenant_id"),
                            result.getString("workspace_id"),
                            result.getString("session_id"),
                            result.getString("resource_id"),
                            result.getString("kind"),
                            result.getInt("schema_version"),
                            result.getLong("byte_length"),
                            result.getString("sha256"),
                            result.getString("storage_kind"),
                            result.getBytes("inline_bytes"),
                            result.getString("object_key"),
                            result.getString("object_version_id"),
                            result.getString("encryption_key_id"),
                            result.getString("state"),
                            result.getString("capture_state"),
                            result.getString("deletion_operation_key"));

    public ManagedSessionStore(JdbcTemplate jdbc) {
        this(jdbc, new ManagedExtensionRecordStore(jdbc));
    }

    public ManagedSessionStore(JdbcTemplate jdbc,
            ManagedExtensionRecordStore extensionRecords) {
        this(jdbc, extensionRecords, null);
    }

    @Autowired
    public ManagedSessionStore(
            JdbcTemplate jdbc,
            ManagedExtensionRecordStore extensionRecords,
            ManagedActionStore actions) {
        this.jdbc = jdbc;
        this.extensionRecords = extensionRecords;
        this.actions = actions;
        var manager =
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource());
        this.outputRetention = new ToolPublicationRetentionStore(jdbc, manager);
        this.ownerReads = new org.springframework.transaction.support.TransactionTemplate(manager);
        this.ownerReads.setTimeout(10);
    }

    private WorkspaceExecutionStore lifecycleExecution;
    private AgentStateStore lifecycleSessions;

    @Autowired(required = false)
    public void setLifecycleExecution(WorkspaceExecutionStore execution, AgentStateStore sessions) {
        this.lifecycleExecution = execution;
        this.lifecycleSessions = sessions;
    }

    @Transactional
    public void authorizeLifecycle(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        ensureSessionRoot(tenantId, sessionId);
        jdbc.queryForList(
                "SELECT session_id FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR"
                    + " UPDATE",
                tenantId,
                sessionId);
        WorkspaceLifecycleStore.requireClaim(jdbc, tenantId, sessionId, authority, true);
        if (request.kind() != null) {
            String kind =
                    jdbc.queryForObject(
                            "SELECT operation_kind FROM ma_operation WHERE tenant_id = ?"
                                    + " AND session_id = ? AND operation_id = ?",
                            String.class,
                            tenantId,
                            sessionId,
                            authority.operationId());
            if (!kind.toLowerCase(java.util.Locale.ROOT).equals(request.kind())) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_operation_conflict");
            }
        } else if (!"DRAINING"
                .equals(
                        jdbc.queryForObject(
                                "SELECT phase FROM ma_session_head WHERE tenant_key = ? AND"
                                    + " harness_key = ? AND tenant_id = ? AND harness_session_id ="
                                    + " ?",
                                String.class,
                                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                                tenantId,
                                sessionId))) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_hooks_unsettled");
        }
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (request.kind() != null) {
            requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, databaseNow(), true);
        } else if (!List.of("ACTIVE", "SEALED").contains(head.state())
                || request.writerGeneration() != head.writerGeneration()
                || !request.writerId().equals(head.writerId())
                || !secureEquals(tokenHash(writerToken), head.leaseTokenHash())) {
            throw writerConflict();
        }
    }

    private void checkLifecycleWriter(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        // Ordinary traffic fences per Session (head row, drain admission);
        // taking the two tenant-wide rows here would let any long holder of
        // them wedge every Session of the tenant (#13800). No v2 probe may
        // run here: a plain consistent read pins the REPEATABLE READ snapshot
        // before the guard waits below; a row-locking read inverts against
        // the claim order (guards → operation) of a concurrently claiming
        // lifecycle; and borrowing a second pooled connection deadlocks the
        // pool under saturation. The fence
        // that rejects ordinary writes against a v2 Session lives in
        // requireOrdinaryAdmission, where the caller's own guards are already
        // held and the same consistent read layer is established.
        if (authority == null) {
            return;
        }
        lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        WorkspaceLifecycleStore.requireClaim(jdbc, tenantId, sessionId, authority, true);
    }

    private static ManagedAgentException guardContended() {
        return new ManagedAgentException(HttpStatus.SERVICE_UNAVAILABLE,
                "tenant_guard_contended",
                "A tenant-wide Managed Session guard could not be acquired"
                        + " within the hot-path bound; retry.");
    }

    /**
     * Runs one sweep candidate in its own transaction. A guard refusal skips that candidate
     * instead of aborting the sweep; any other failure propagates unchanged.
     */
    static <T> T skipContended(
            org.springframework.transaction.support.TransactionTemplate transactions,
            org.springframework.transaction.support.TransactionCallback<T> body) {
        try {
            return transactions.execute(body);
        } catch (ManagedAgentException refusal) {
            if (!"tenant_guard_contended".equals(refusal.getCode())) {
                throw refusal;
            }
            return null;
        }
    }

    static void lockBounded(Runnable lock) {
        lockBoundedResult(() -> {
            lock.run();
            return null;
        });
    }

    static <T> T lockBoundedResult(Supplier<T> lock) {
        try {
            return lock.get();
        } catch (PessimisticLockingFailureException | QueryTimeoutException error) {
            throw guardContended();
        }
    }

    /**
     * The root-side half of {@link #lockBounded}'s mapping. A pinned CSI
     * Session's continuation holds its root while it waits for the tenant
     * guards, so a guard-first lane on that Session closes an InnoDB cycle
     * when it reaches the root, and InnoDB may roll back either side
     * (#13800 R1-1). The root acquisitions name that rollback the way the
     * guard side does; an ordinary wait on the root stays unbounded and
     * keeps its own failure. The default translator reports a deadlock
     * (MySQL/MariaDB 1213, SQLState 40001) as CannotAcquireLockException,
     * the error-code translator as DeadlockLoserDataAccessException, so the
     * victim is recognized by its vendor code.
     */
    static <T> T namedRootDeadlock(Supplier<T> lock) {
        try {
            return lock.get();
        } catch (PessimisticLockingFailureException error) {
            if (error instanceof DeadlockLoserDataAccessException || deadlockVictim(error)) {
                throw guardContended();
            }
            throw error;
        }
    }

    private static boolean deadlockVictim(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.sql.SQLException sql && sql.getErrorCode() == 1213) {
                return true;
            }
        }
        return false;
    }

    private void requirePhysicalSessionOpen(String tenantId, String workspaceId, String sessionId) {
        // Placement is the tenant-wide row migration admission shares; on
        // these per-turn paths it stays bounded with the shared named-failure
        // mapping, so a held row answers tenant_guard_contended instead of
        // out-waiting the caller (#13800).
        lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        WorkspaceMigrationAdmission.requirePhysicalOpen(jdbc, tenantId,
                WorkspaceMigrationAdmission.sessionStorage(jdbc, tenantId, sessionId, workspaceId));
    }

    private void bindControlSessionStorage(String tenantId, String workspaceId, String sessionId) {
        String storage = WorkspaceMigrationAdmission.sessionStorage(jdbc, tenantId, sessionId, workspaceId);
        if (storage == null) {
            return;
        }
        var rows = jdbc.queryForList("SELECT session_kind, workspace_id, workspace_storage_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", tenantId, sessionId);
        if (rows.size() != 1 || !"CONTROL".equals(rows.getFirst().get("session_kind"))) {
            return;
        }
        var row = rows.getFirst();
        if (row.get("workspace_id") != null && !workspaceId.equals(row.get("workspace_id"))
                || row.get("workspace_storage_id") != null && !storage.equals(row.get("workspace_storage_id"))) {
            throw conflict("managed_session_scope_conflict", "The Managed Session Workspace binding conflicts.");
        }
        jdbc.update(
                "UPDATE ma_session SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", workspace_id = ?, workspace_storage_id = ? WHERE tenant_id ="
                        + " ? AND session_id = ? AND session_kind = 'CONTROL'",
                workspaceId, storage, tenantId, sessionId);
    }

    @Transactional
    public void authorizeOrdinary(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        // Ordinary authorisation fences per Session (drain + head): the
        // tenant-wide guard rows stay with lifecycle/publication paths, or
        // any long holder of them wedges unrelated Sessions (#13800). The
        // Session root is locked before the drain admission reads the head
        // row, keeping the root-then-head order of every other writer.
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        if (!"legacy-close".equals(request.kind()) || !WorkspaceLifecycleStore.legacyClose(jdbc, tenantId, sessionId)) {
            requireOrdinaryAdmission(tenantId, sessionId);
        }
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, databaseNow(), true);
    }

    // An ordinary write against a v2-claimed Session must fail with the
    // claim's name, and the read that names it must never walk the three
    // cliffs the earlier probes hit: no plain consistent read ahead of the
    // guard waits in the calling path (it pins the snapshot before the retry
    // learns its winner), no row lock ahead of the claim order (guards →
    // operation), and no second pooled connection while this transaction
    // holds its own (the pool self-deadlocks at saturation).
    // Every call site invokes this only after its own guard or head row has
    // been taken, so the consistent read layer the flow required is already
    // established and the classification costs one lock-free session-scoped
    // range scan on the caller's own connection.
    private void requireNoLifecycleClaim(String tenantId, String sessionId) {
        if (!jdbc.queryForList("SELECT operation_id FROM ma_operation WHERE scope_key = ?"
                + " AND operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE') AND tenant_id = ? AND session_id = ?"
                + " AND lifecycle_protocol_version = 2", sessionScopeKey(tenantId, sessionId), tenantId, sessionId).isEmpty()) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_claim_fenced");
        }
    }

    private void requireOrdinaryAdmission(String tenantId, String sessionId) {
        requireNoLifecycleClaim(tenantId, sessionId);
        if (lifecycleFenced(tenantId, sessionId)) {
            throw conflict(
                    "managed_session_lifecycle_active", "Ordinary execution admission is closed.");
        }
    }

    private boolean lifecycleFenced(String tenantId, String sessionId) {
        return !jdbc.queryForList(
                        "SELECT phase FROM ma_session_head WHERE phase <> 'OPEN' AND tenant_key = ?"
                            + " AND harness_key = ? AND tenant_id = ? AND harness_session_id = ?"
                            + " FOR UPDATE",
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId)
                .isEmpty();
    }

    private boolean lifecycleProtocolFenced(String tenantId, String sessionId) {
        return !jdbc.queryForList(
                        "SELECT operation_id FROM ma_session_head WHERE tenant_key = ? AND"
                            + " harness_key = ? AND tenant_id = ? AND harness_session_id = ? AND"
                            + " operation_id IS NOT NULL FOR UPDATE",
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId)
                .isEmpty();
    }

    boolean usesDataSource(javax.sql.DataSource source) {
        return source != null && jdbc.getDataSource() == source;
    }

    @Autowired(required = false)
    public void setPublicationObjects(ToolPublicationObjectStore publicationObjects) {
        this.publicationObjects = publicationObjects;
    }

    @Autowired(required = false)
    public void setToolResults(ManagedToolResultStore toolResults) {
        this.toolResults = toolResults;
    }

    // Present only when the journal event transport is enabled; absent by
    // default so a flag-off deployment stays byte-identical (design MQ2b).
    @Autowired(required = false)
    public void setJournalEventTransport(JournalEventTransport transport) {
        this.journalEventTransport = transport;
    }

    // The policy bean is unconditional, so required injection fails closed
    // in a Spring context; direct constructor use keeps the unbound default.
    @Autowired
    public void setCredentials(WriterCredentialPolicy credentials) {
        this.credentials = credentials;
    }

    @Autowired(required = false)
    public void setCsiBindings(RuntimeBindingRepository bindings) {
        this.csiBindings =
                bindings instanceof JdbcRuntimeBindingRepository original
                                && original.usesDataSource(jdbc.getDataSource())
                        ? original
                        : null;
    }

    // A bound credential is checked before any state lookup so a foreign
    // token never learns whether a Session exists.
    private void requireCredential(String tenantId, String workspaceId,
            String sessionId, String writerToken) {
        credentials.require(tenantId, workspaceId, sessionId, writerToken);
    }

    record PublicationWriter(long now, long leaseUntil, long journalRevision,
            long committedSequence, long activationEpoch, String checkpointId, String recoveryStatus,
            String activationId, String activationPhase, Long activationEventEpoch,
            Long activationExpiresAt, Long activationHeadRevision) {
    }

    PublicationWriter lockPublicationWriter(String tenant, String workspace,
            String session, String writer, long generation, String token) {
        validateScope(tenant, workspace, session);
        requireCredential(tenant, workspace, session, token);
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenant, session);
        requirePhysicalSessionOpen(tenant, workspace, session);
        // Publication-lane writer: keeps the tenant CAS row before the
        // Session root the CSI check locks and before the head row, the
        // order retention reads take (CAS row, root, head) and the same as
        // before #13800 decoupled ordinary traffic.
        lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenant,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        var continuation = lockCsiContinuation(tenant, session);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireAdmission();
        }
        HeadRow head = requireHeadForUpdate(tenant, session);
        requireHeadScope(head, tenant, workspace, session);
        Timestamp now = databaseNow();
        requireWriter(head, writer, generation, token, now, true);
        requireInstalledCsiWriter(csiOriginal);
        return new PublicationWriter(epochMillis(now), epochMillis(head.writerLeaseUntil()),
                head.journalRevision(), head.committedSequence(), head.activationEpoch(),
                head.latestCheckpointResourceId(), head.recoveryStatus(), head.activationId(),
                head.activationPhase(), head.activationEventEpoch(), head.activationExpiresAt(),
                head.activationHeadRevision());
    }

    @Transactional
    public WriterGrant acquireWriter(String tenantId, String sessionId,
            String writerToken, AcquireWriterRequest request) {
        return acquireWriter(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public WriterGrant acquireWriter(String tenantId, String sessionId, String writerToken,
            AcquireWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        checkLifecycleWriter(tenantId, sessionId, authority);
        validateStableId(request.writerId(), "writerId");
        validateLeaseMillis(request.leaseMillis());
        // Acquisition stays serialized with an in-flight delete/retire: while
        // a Session has no head row, the tenant CAS row is the only ordering
        // point, so it stays. Both acquisitions run in the codebase-wide
        // placement-before-publication order, bounded — a held row degrades
        // to a named failure instead of a silent wedge or a 1213 (#13800).
        // Placement must precede the drain admission check below: begin paths
        // insert drain rows only after locking placement, so checking the
        // drain first would take its gap lock and deadlock against a
        // lifecycle that already holds placement (#13800).
        // requireSessionOpen must run after the CAS guard: it is this
        // transaction's first consistent read, so its REPEATABLE READ
        // snapshot only sees a retirement committed underneath the CAS wait
        // if it is pinned after that wait (#13800 R2).
        lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc,
                tenantId, GUARD_ACQUIRE_TIMEOUT_SECONDS));
        var csiOriginal = lockCsiOriginal(tenantId, sessionId);
        if (csiOriginal != null) {
            csiOriginal.requireAdmission();
        }
        WorkspaceMigrationAdmission.requireSessionOpen(jdbc, tenantId, sessionId, request.workspaceId());
        ensureSessionRoot(tenantId, sessionId);
        bindControlSessionStorage(tenantId, request.workspaceId(), sessionId);
        // Materialize the key before any locking read: missing-key RR locks can
        // deadlock independent tenants when both first writers insert a head.
        jdbc.update("INSERT IGNORE INTO ma_session_head (tenant_key, harness_key, tenant_id, harness_session_id, session_id, head_kind, phase, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, 'HARNESS', 'OPEN', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId), JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId, sessionId, sessionId);
        if (authority != null) {
            WorkspaceLifecycleStore.requireClaim(jdbc, tenantId, sessionId, authority,
                    WorkspaceLifecycleStore.resourceClaim(jdbc, tenantId, sessionId, authority));
        } else {
            requireOrdinaryAdmission(tenantId, sessionId);
        }
        ToolPublicationRetentionStore.requireLive(jdbc, tenantId, sessionId);
        List<String> closed = jdbc.query(
                        "SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ? AND"
                                + " (workspace_id IS NOT NULL OR session_kind = 'PUBLIC') FOR UPDATE",
                (row, index) -> row.getString("status"), tenantId, sessionId);
        if (authority == null && !closed.isEmpty() && !"ACTIVE".equals(closed.getFirst())) {
            throw conflict("managed_session_not_writable", "The Session is closing or closed.");
        }
        String tokenHash = tokenHash(writerToken);
        ManagedSessionReaderVersion.requireReadable(1);
        Timestamp createdAt = databaseNow();
        Timestamp initialLeaseUntil = plusMillis(createdAt,
                request.leaseMillis());
        List<String> kinds =
                jdbc.queryForList(
                        "SELECT head_kind FROM ma_session_head WHERE tenant_key = ? AND harness_key"
                            + " = ? AND tenant_id = ? AND session_id = ? FOR UPDATE",
                        String.class,
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        if (!kinds.isEmpty() && "HARNESS".equals(kinds.getFirst())) {
            jdbc.update(
                    "UPDATE ma_session_head SET head_kind = 'MANAGED_SESSION', workspace_id = ?, storage_version = ?, state = 'ACTIVE', writer_generation = 1, writer_id = ?, writer_lease_until = ?, lease_token_hash = ?, journal_revision = 0, wake_head_revision = 0, committed_sequence = 0, activation_epoch = 0, compacted_through_revision = 0, recovery_status = 'READY', o3_backfill_through = 0, o3_backfill_pending = FALSE, gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND head_kind = 'HARNESS'",
                    request.workspaceId(),
                    STORAGE_VERSION,
                    request.writerId(),
                    initialLeaseUntil.getTime(),
                    tokenHash,
                    createdAt.getTime(),
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId,
                    sessionId);
            return new WriterGrant(1, epochMillis(initialLeaseUntil), 0, 0, null, 0, false);
        }
        try {
            jdbc.update(
                    "INSERT INTO ma_session_head (tenant_key, harness_key, harness_session_id, head_kind, tenant_id, workspace_id, session_id, storage_version, state, writer_generation, writer_id, writer_lease_until, lease_token_hash, journal_revision, wake_head_revision, committed_sequence, activation_epoch, compacted_through_revision, recovery_status, o3_backfill_through, o3_backfill_pending, gmt_create, gmt_modified) VALUES (?, ?, ?, 'MANAGED_SESSION', ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?, 0, 0, 0, 0, 0, 'READY', 0, FALSE, ?, ?)",
                    com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository
                            .harnessDrainKey(tenantId),
                    com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository
                            .harnessDrainKey(sessionId),
                    sessionId,
                    tenantId,
                    request.workspaceId(),
                    sessionId,
                    STORAGE_VERSION,
                    request.writerId(),
                    initialLeaseUntil.getTime(),
                    tokenHash,
                    createdAt.getTime(),
                    createdAt.getTime());
            return new WriterGrant(1, epochMillis(initialLeaseUntil), 0, 0,
                    null, 0, false);
        } catch (DuplicateKeyException ignored) {
            // A prior acquire created the row; lock and inspect it below.
        }
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        requireCsiWriter(csiOriginal, head);
        if ("DELETING".equals(head.state())
                || "DELETED".equals(head.state())) {
            throw conflict("managed_session_not_writable",
                    "The Managed Session does not accept a writer.");
        }
        if (!"ACTIVE".equals(head.state())
                && !"SEALED".equals(head.state())) {
            throw conflict("managed_session_not_writable",
                    "The Managed Session state is not writable.");
        }
        Timestamp now = databaseNow();
        if ("ACTIVE".equals(head.state())
                && head.writerLeaseUntil() != null
                && head.writerLeaseUntil().after(now)) {
            if (!request.writerId().equals(head.writerId())
                    || !secureEquals(tokenHash, head.leaseTokenHash())) {
                throw writerConflict();
            }
            Timestamp leaseUntil = laterOf(head.writerLeaseUntil(),
                    plusMillis(now, request.leaseMillis()));
            jdbc.update(
                    "UPDATE ma_session_head SET writer_lease_until = ?, gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                    leaseUntil.getTime(),
                    now.getTime(),
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId,
                    sessionId);
            return grant(head, leaseUntil, true);
        }
        long generation = increment(head.writerGeneration(),
                "writer generation");
        if (csiOriginal != null) {
            if (!"ACTIVE".equals(head.state()) || head.storageVersion() != STORAGE_VERSION
                    || head.compactedThroughRevision() != 0 || !"READY".equals(head.recoveryStatus())
                    || head.writerLeaseUntil() == null || head.journalRevision() < 2 || head.activationEpoch() < 1) {
                throw conflict("csi_original_writer_unavailable", "The original CSI writer cannot be replaced.");
            }
            requireCsiHistoryOwner(csiOriginal);
            jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                JdbcCsiActivationAdmission.qualifyColdWriter(connection, csiOriginal, csiBindings,
                        head.journalRevision(), head.committedSequence(), head.lastCommitDigest(), head.writerId(),
                        head.writerGeneration(), head.activationEpoch(), epochMillis(head.writerLeaseUntil()),
                        request.writerId());
                return null;
            });
            now = databaseNow();
        }
        Timestamp leaseUntil = plusMillis(now, request.leaseMillis());
        jdbc.update(
                "UPDATE ma_session_head SET state = 'ACTIVE', writer_generation = ?, writer_id = ?, writer_lease_until = ?, lease_token_hash = ?, gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                generation,
                request.writerId(),
                leaseUntil.getTime(),
                tokenHash,
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        return new WriterGrant(generation, epochMillis(leaseUntil),
                head.journalRevision(), head.committedSequence(),
                head.lastCommitDigest(), head.activationEpoch(), false);
    }

    @Transactional
    public WriterGrant renewWriter(String tenantId, String sessionId,
            String writerToken, RenewWriterRequest request) {
        return renewWriter(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public WriterGrant renewWriter(String tenantId, String sessionId, String writerToken,
            RenewWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        checkLifecycleWriter(tenantId, sessionId, authority);
        validateStableId(request.writerId(), "writerId");
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        validateLeaseMillis(request.leaseMillis());
        var continuation = lockCsiContinuation(tenantId, sessionId);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        HeadRow head = continuation == null ? requireHeartbeatHead(tenantId, sessionId) : requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (authority == null) {
            requireNoLifecycleClaim(tenantId, sessionId);
        }
        requireCsiWriter(csiOriginal, head);
        Timestamp now = databaseNow();
        boolean cleanup = authority != null && WorkspaceLifecycleStore.resourceClaim(jdbc, tenantId, sessionId, authority);
        // A resident cleanup writer may outlive its lease while the coordinator
        // is down; its token and generation must still own the locked head.
        requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, !cleanup);
        Timestamp leaseUntil = laterOf(head.writerLeaseUntil(),
                plusMillis(now, request.leaseMillis()));
        requireCsiLease(continuation, epochMillis(head.writerLeaseUntil()), epochMillis(leaseUntil));
        jdbc.update(
                "UPDATE ma_session_head SET writer_lease_until = ?, gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                leaseUntil.getTime(),
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        return grant(head, leaseUntil, false);
    }

    @Transactional
    public SealReceipt sealWriter(String tenantId, String sessionId,
            String writerToken, SealWriterRequest request) {
        return sealWriter(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public SealReceipt sealWriter(String tenantId, String sessionId, String writerToken,
            SealWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        checkLifecycleWriter(tenantId, sessionId, authority);
        validateStableId(request.writerId(), "writerId");
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        if (lockCsiOriginal(tenantId, sessionId) != null) {
            throw conflict(
                    "csi_finalize_required",
                    "The original CSI writer requires retirement finalization.");
        }
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (authority == null) {
            requireNoLifecycleClaim(tenantId, sessionId);
        }
        if ("SEALED".equals(head.state())
                && request.writerGeneration() == head.writerGeneration()
                && request.writerId().equals(head.writerId())
                && secureEquals(tokenHash(writerToken),
                        head.leaseTokenHash())) {
            return new SealReceipt(head.writerGeneration(), "SEALED", true);
        }
        Timestamp now = databaseNow();
        requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, false);
        jdbc.update(
                "UPDATE ma_session_head SET state = 'SEALED', gmt_modified = ? WHERE tenant_key = ?"
                    + " AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        return new SealReceipt(head.writerGeneration(), "SEALED", false);
    }

    @Transactional
    public RecoveryStateReceipt blockRecovery(String tenantId,
            String sessionId, String writerToken,
            BlockRecoveryRequest request) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        validateStableId(request.writerId(), "writerId");
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        if (!RECOVERY_STATES.contains(request.recoveryStatus())
                || "READY".equals(request.recoveryStatus())) {
            throw invalid("recoveryStatus must be a blocked state.");
        }
        // The 128-character column width is enforced one layer up by
        // @Size(max = 128) on BlockRecoveryRequest — byte-counting here
        // would reject non-ASCII codes that legitimately fit VARCHAR(128).
        validateText(request.recoveryDetailCode(), "recoveryDetailCode",
                MAX_TEXT_BYTES);
        var continuation = lockCsiContinuation(tenantId, sessionId);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        requireCsiWriter(csiOriginal, head);
        Timestamp now = databaseNow();
        requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, true);
        requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        if (request.recoveryStatus().equals(head.recoveryStatus())
                && request.recoveryDetailCode()
                        .equals(head.recoveryDetailCode())) {
            return new RecoveryStateReceipt(head.writerGeneration(),
                    head.recoveryStatus(), head.recoveryDetailCode(), true);
        }
        if (!"READY".equals(head.recoveryStatus())) {
            throw conflict(
                    ManagedSessionStoreModels.ERROR_RECOVERY_CONFLICT,
                    "The Managed Session already has a different recovery"
                            + " block.");
        }
        requireCsiWriterCurrent(continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        jdbc.update(
                "UPDATE ma_session_head SET recovery_status = ?, recovery_detail_code = ?,"
                    + " gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ?"
                    + " AND session_id = ?",
                request.recoveryStatus(),
                request.recoveryDetailCode(),
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        return new RecoveryStateReceipt(head.writerGeneration(),
                request.recoveryStatus(), request.recoveryDetailCode(),
                false);
    }

    @Transactional
    public CommitReceipt commit(String tenantId, String sessionId,
            String writerToken, CommitTransactionRequest request) {
        return commit(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public CommitReceipt commit(String tenantId, String sessionId, String writerToken,
            CommitTransactionRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        checkLifecycleWriter(tenantId, sessionId, authority);
        // Ordinary record commits still hold the placement guard while they
        // fly: a begin/lifecycle admission serializes with only that row, so
        // without it an admission sails through mid-commit. The acquisition
        // stays bounded — a held row degrades to a named failure within the
        // hot-path budget rather than waiting out the caller (#13800).
        lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        validateStableId(request.writerId(), "writerId");
        ValidatedCommit validated = validateCommit(request);
        boolean promotes = ManagedHostedRecoveryRecords.requiresVersionTwo(validated.recordBytes(), request.resources())
                || validated.resources().stream().anyMatch(resource -> {
                    if (!"managed-action-options".equals(resource.resource().kind()) || resource.bytes() == null) {
                        return false;
                    }
                    JsonNode body = ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
                    return body != null && body.path("v").asInt() == 3;
                });
        if (promotes) {
            ManagedSessionReaderVersion.requireReadable(2);
        }
        var continuation = lockCsiContinuation(tenantId, sessionId);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        HeadRow csiHead = csiOriginal == null ? null : requireHeadForUpdate(tenantId, sessionId);
        requireCsiWriter(csiOriginal, csiHead);
        if (csiOriginal != null
                && ("commitFileHistory".equals(request.operation())
                        || !jdbc.query(
                                        "SELECT journal_revision FROM ma_session_journal_tx WHERE"
                                            + " tenant_id = ? AND session_id = ? AND operation ="
                                            + " 'commitFileHistory' ORDER BY journal_revision LIMIT"
                                            + " 1 FOR UPDATE",
                                        (row, index) -> row.getLong(1),
                                        tenantId,
                                        sessionId)
                                .isEmpty())) {
            requireCsiHistoryOwner(csiOriginal);
        }
        TransactionRow existing = findTransactionByCommand(tenantId,
                sessionId, commandKeyHash(request.operation(),
                        request.commandId()));
        if (existing != null) {
            requireTransactionWorkspace(existing, request.workspaceId());
            if (csiOriginal != null) {
                requireWriter(
                        csiHead,
                        request.writerId(),
                        request.writerGeneration(),
                        writerToken,
                        databaseNow(),
                        true);
                jdbc.execute(
                        (org.springframework.jdbc.core.ConnectionCallback<Void>)
                                connection -> {
                                    JdbcCsiActivationAdmission.requireReplay(
                                            connection,
                                            csiOriginal,
                                            csiHead.journalRevision(),
                                            csiHead.committedSequence(),
                                            csiHead.lastCommitDigest(),
                                            csiHead.writerId());
                                    return null;
                                });
                requireCsiCurrentTime(continuation);
            }
            // A duplicate is fenced like a first attempt: before #13800 the
            // v2 claim check ran ahead of this lookup.
            if (authority == null) {
                requireNoLifecycleClaim(tenantId, sessionId);
            }
            return replay(existing, request, validated.recordDigest(),
                    writerToken);
        }
        requirePhysicalSessionOpen(tenantId, request.workspaceId(), sessionId);
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (authority == null) {
            requireNoLifecycleClaim(tenantId, sessionId);
        }
        Timestamp now = databaseNow();
        requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, true);
        validateHead(head, request);
        long revision = increment(head.journalRevision(),
                "journal revision");
        String scopeKey = sessionScopeKey(tenantId, sessionId);
        if (csiOriginal != null
                && java.util.Set.of("commitFileHistory", "toolIntent", "commitCheckpoint")
                        .contains(request.operation())) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                JdbcCsiActivationAdmission.preflightCommit(
                                        connection,
                                        csiOriginal,
                                        CSI_JSON.valueToTree(request),
                                        com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof
                                                .records(validated.recordBytes()),
                                        head.journalRevision(),
                                        head.committedSequence(),
                                        head.lastCommitDigest(),
                                        head.writerId());
                                return null;
                            });
            requireWriter(
                    head,
                    request.writerId(),
                    request.writerGeneration(),
                    writerToken,
                    databaseNow(),
                    true);
        }
        commitResources(scopeKey, tenantId, sessionId, request, revision,
                now, validated.resources(),
                () -> requireCsiCurrentTime(continuation));
        Set<String> declaredResources = new HashSet<>();
        for (var resource : request.resources() == null ? List.<CommitResource>of() : request.resources()) {
            declaredResources.add(resource.resourceId());
        }
        var resourceCache = new HashMap<String, StoredResource>();
        var hostedReferences = new HashMap<String, JsonNode>();
        java.util.function.Function<String, StoredResource> reader = resourceId -> resourceCache.computeIfAbsent(resourceId,
                id -> storedResource(scopeKey, tenantId, request.workspaceId(), sessionId, id));
        java.util.function.Function<String, StoredResource> closureReader = resourceId -> {
            if (!declaredResources.contains(resourceId)) {
                throw invalid("Hosted nested reference is absent from the transaction census.");
            }
            return reader.apply(resourceId);
        };
        for (var resource : request.resources() == null ? List.<CommitResource>of() : request.resources()) {
            if (ManagedHostedRecoveryRecords.KINDS.contains(resource.kind()) || "managed-action-options".equals(resource.kind())) {
                ManagedHostedRecoveryRecords.validateResource(closureReader.apply(resource.resourceId()), tenantId,
                        request.workspaceId(), sessionId, closureReader, hostedReferences);
            }
        }
        boolean wakeInput = false;
        for (String line :
                new String(validated.recordBytes(), StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = ManagedExtensionRecordStore.parse(line);
            if (record != null && record.has("managedSession")) {
                JsonNode event = record.get("managedSession");
                wakeInput |= WakeRecoveryStore.isWakeInput(event);
                ManagedHostedRecoveryRecords.validateEvent(
                        event.path("kind").asText(),
                        event.path("payload"),
                        tenantId,
                        request.workspaceId(),
                        sessionId,
                        closureReader,
                        hostedReferences);
            }
        }
        boolean v2 = authority != null && jdbc.queryForObject(
                                        "SELECT lifecycle_protocol_version FROM ma_operation WHERE"
                                            + " operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')"
                                            + " AND tenant_id = ? AND session_id = ? AND"
                                            + " operation_id = ?", Integer.class,
                tenantId, sessionId, authority.operationId()) == 2;
        boolean resourcePhase = v2 && WorkspaceLifecycleStore.resourceClaim(jdbc, tenantId, sessionId, authority);
        if (authority != null && extensionRecords.hasNewLifecycleDispatch(tenantId, sessionId, validated.recordBytes(),
                reader, v2, resourcePhase)) {
            if (lifecycleExecution == null || lifecycleSessions == null) {
                throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_protocol_unavailable");
            }
            try {
                lifecycleExecution.authorizeLifecycle(lifecycleSessions.requireSession(tenantId, sessionId), authority);
            } catch (com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException refusal) {
                if (refusal.getStatusCode() == 409 && "workspace_unavailable".equals(refusal.getCode())) {
                    throw WorkspaceLifecycleStore.blocked(
                            "workspace_lifecycle_authorization_revoked");
                }
                if (refusal.getStatusCode() == 409) {
                    throw new ManagedAgentException(HttpStatus.CONFLICT, refusal.getCode(), refusal.getMessage());
                }
                throw refusal;
            }
        }
        if (authority == null && lifecycleProtocolFenced(tenantId, sessionId)) {
            extensionRecords.requireLifecycleSettlement(tenantId, sessionId, validated.recordBytes(),
                    reader);
        }
        var applied =
                csiOriginal == null
                        ? extensionRecords.apply(tenantId, request.workspaceId(), sessionId,
                request.firstSequence(), request.eventCount(),
                validated.recordBytes(), reader, now.getTime())
                        : extensionRecords.applyNative(
                                tenantId,
                                request.workspaceId(),
                                sessionId,
                                request.firstSequence(),
                                request.eventCount(),
                                validated.recordBytes(),
                                reader,
                                now.getTime());
        if (csiOriginal != null) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                JdbcCsiActivationAdmission.acceptCommit(
                                        org.springframework.jdbc.datasource.DataSourceUtils
                                                .getTargetConnection(connection),
                                        csiOriginal,
                                        CSI_JSON.valueToTree(request),
                                        applied.records(),
                                        head.journalRevision(),
                                        head.committedSequence(),
                                        head.lastCommitDigest(),
                                        head.writerId(),
                                        now.toInstant().toEpochMilli(),
                                        continuation.progress());
                                return null;
                            });
            requireWriter(
                    head,
                    request.writerId(),
                    request.writerGeneration(),
                    writerToken,
                    databaseNow(),
                    true);
        }
        var receiptEvents = applied.receipts();
        if (actions != null) {
            actions.apply(
                    tenantId,
                    request.workspaceId(),
                    sessionId, request.firstSequence(), request.eventCount(),
                    validated.recordBytes(),
                    reader, hostedReferences);
        }
        requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        jdbc.update("INSERT INTO ma_session_journal_tx"
                        + " (tenant_id, workspace_id, session_id,"
                        + " journal_revision, command_key_hash,"
                        + " transaction_id, operation, command_id,"
                        + " content_digest, first_sequence, last_sequence,"
                        + " event_count, events_digest,"
                        + " previous_commit_digest, commit_digest,"
                        + " writer_generation, writer_id,"
                        + " writer_token_hash, activation_epoch,"
                        + " latest_checkpoint_resource_id,"
                        + " record_encoding, record_bytes, byte_length,"
                        + " record_digest, gmt_create) VALUES (?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                        + " ?,"
                        + " 'identity', ?, ?, ?, ?)",
                tenantId, request.workspaceId(), sessionId, revision,
                commandKeyHash(request.operation(), request.commandId()),
                request.transactionId(), request.operation(),
                request.commandId(), request.contentDigest(),
                request.firstSequence(), request.lastSequence(),
                request.eventCount(), request.eventsDigest(),
                request.previousCommitDigest(), request.commitDigest(),
                request.writerGeneration(), request.writerId(),
                tokenHash(writerToken), request.activationEpoch(),
                request.latestCheckpointResourceId(),
                validated.recordBytes(), validated.recordBytes().length,
                validated.recordDigest(), now.getTime());
        ActivationChange activation = activationChange(
                applied.lastActivation());
        // A payload wider than the columns blanks them instead of
        // failing the commit: authorization then reads the journal
        // directly, exactly as before the columns existed.
        boolean fits = activation == null
                || (activation.id() == null || activation.id().length()
                        <= ManagedSessionStoreModels.MAX_ACTIVATION_ID_CHARS)
                        && (activation.phase() == null
                                || activation.phase().length()
                                        <= ManagedSessionStoreModels.MAX_ACTIVATION_PHASE_CHARS);
        // activation_head_revision stamps which journal revision the
        // columns reflect, so a head written by a binary that does not
        // maintain the columns is detected (stamp lags journal_revision)
        // and rescanned instead of trusted. A commit that keeps the
        // existing columns advances their stamp only when they were
        // current at the previous revision — re-stamping a skewed set
        // would certify it as fresh.
        Long activationHeadRevision = head.activationHeadRevision();
        if (activation != null || (activationHeadRevision != null
                && activationHeadRevision == head.journalRevision())) {
            activationHeadRevision = revision;
        }
        requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        jdbc.update("UPDATE ma_session_head SET"
                        + " journal_revision = ?, committed_sequence = ?,"
                        + " wake_pending = wake_pending OR ?,"
                        + " wake_head_revision = CASE WHEN wake_head_revision = ? THEN ? ELSE wake_head_revision END,"
                        + " last_commit_digest = ?, activation_epoch = ?,"
                        + " latest_checkpoint_resource_id = COALESCE(?,"
                        + " latest_checkpoint_resource_id),"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?,"
                        + " activation_head_revision = ?, storage_version = ?, gmt_modified = ?"
                        + " WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ?"
                        + " AND session_id = ?",
                revision, request.lastSequence(),
                wakeInput,
                head.journalRevision(), revision, request.commitDigest(),
                request.activationEpoch(),
                request.latestCheckpointResourceId(),
                activation == null ? head.activationId()
                        : fits ? activation.id() : null,
                activation == null ? head.activationPhase()
                        : fits ? activation.phase() : null,
                activation == null ? head.activationEventEpoch()
                        : fits ? activation.epoch() : null,
                activation == null ? head.activationExpiresAt()
                        : fits ? activation.expiresAt() : null,
                activationHeadRevision, Math.max(head.storageVersion(), promotes ? 2 : 1), now.getTime(), JdbcRuntimeBindingRepository.harnessDrainKey(tenantId), JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), tenantId, sessionId);
        if (toolResults != null && csiOriginal == null) {
            toolResults.captureEvents(tenantId, request.workspaceId(), sessionId, revision, receiptEvents);
        }
        publishJournalAfterCommit(validated.recordBytes());
        return new CommitReceipt(revision, request.transactionId(),
                request.commandId(), request.operation(),
                request.firstSequence(), request.lastSequence(),
                request.lastSequence(), request.commitDigest(), false);
    }

    // The authoritative-journal wire (design 2026-10-04-managed-agent-event-transport,
    // MQ2b): hands the committed journal record to the transport only after the
    // transaction is durable, and never from a replayed commit (those return
    // before this point). A no-op when no transport is enabled.
    private void publishJournalAfterCommit(byte[] recordBytes) {
        JournalEventTransport transport = journalEventTransport;
        if (transport == null) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            transport.publishCommitted(recordBytes);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(
                new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        transport.publishCommitted(recordBytes);
                    }
                });
    }

    @Transactional(readOnly = true)
    public RestoreHead restore(String tenantId, String workspaceId,
            String sessionId, String writerToken) {
        validateScope(tenantId, workspaceId, sessionId);
        requireCredential(tenantId, workspaceId, sessionId, writerToken);
        HeadRow head = requireHead(tenantId, sessionId);
        requireHeadScope(head, tenantId, workspaceId, sessionId);
        requireReadGrant(head, writerToken);
        return new RestoreHead(head.state(), head.storageVersion(),
                head.writerGeneration(), head.journalRevision(),
                head.committedSequence(), head.lastCommitDigest(),
                head.activationEpoch(), head.latestCheckpointResourceId(),
                head.compactedThroughRevision(), head.recoveryStatus(),
                head.recoveryDetailCode());
    }

    @Transactional(readOnly = true)
    public TransactionPage transactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, long afterRevision,
            int limit) {
        validateScope(tenantId, workspaceId, sessionId);
        requireCredential(tenantId, workspaceId, sessionId, writerToken);
        if (afterRevision < 0
                || afterRevision > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || limit < 1 || limit > 100) {
            throw invalid("afterRevision and limit are outside their bounds.");
        }
        HeadRow head = requireHead(tenantId, sessionId);
        requireHeadScope(head, tenantId, workspaceId, sessionId);
        requireReadGrant(head, writerToken);
        List<TransactionSize> candidates = jdbc.query(
                "SELECT journal_revision, byte_length"
                        + " FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND journal_revision > ?"
                        + " ORDER BY journal_revision LIMIT ?",
                (result, row) -> new TransactionSize(
                        result.getLong("journal_revision"),
                        result.getLong("byte_length")),
                tenantId, sessionId, afterRevision,
                limit + 1);
        int selectedCount = 0;
        long selectedBytes = 0;
        long expectedRevision = afterRevision + 1;
        for (TransactionSize candidate : candidates) {
            if (candidate.journalRevision() != expectedRevision
                    || candidate.journalRevision()
                            > head.journalRevision()
                    || candidate.byteLength() < 1 || candidate.byteLength()
                    > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES) {
                throw journalCorrupt();
            }
            expectedRevision++;
            if (selectedCount == limit || selectedCount > 0
                    && selectedBytes + candidate.byteLength()
                            > ManagedSessionStoreModels
                                    .MAX_TRANSACTION_BYTES) {
                break;
            }
            selectedBytes += candidate.byteLength();
            selectedCount++;
        }
        if (afterRevision < head.journalRevision()
                && (candidates.isEmpty()
                        || candidates.size() < limit + 1
                                && candidates.get(candidates.size() - 1)
                                        .journalRevision()
                                        != head.journalRevision())) {
            throw journalCorrupt();
        }
        List<TransactionRow> rows = selectedCount == 0 ? List.of()
                : jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + ""
                                + " FROM ma_session_journal_tx"
                                + " WHERE tenant_id = ? AND session_id = ?"
                                + " AND journal_revision > ?"
                                + " ORDER BY journal_revision LIMIT ?",
                        transactionMapper, tenantId, sessionId,
                        afterRevision, selectedCount);
        if (rows.size() != selectedCount) {
            throw journalCorrupt();
        }
        for (int index = 0; index < rows.size(); index++) {
            TransactionRow row = rows.get(index);
            TransactionSize candidate = candidates.get(index);
            if (row.journalRevision() != candidate.journalRevision()
                    || row.byteLength() != candidate.byteLength()) {
                throw journalCorrupt();
            }
        }
        boolean hasMore = candidates.size() > selectedCount;
        rows.forEach(row -> requireTransactionWorkspace(row, workspaceId));
        List<StoredTransaction> transactions = rows.stream()
                .map(this::storedTransaction).toList();
        long nextRevision = transactions.isEmpty() ? afterRevision
                : transactions.get(transactions.size() - 1)
                        .journalRevision();
        return new TransactionPage(transactions, nextRevision, hasMore);
    }

    public StoredResource readResource(String tenantId, String workspaceId,
            String sessionId, String resourceId, String writerToken) {
        validateScope(tenantId, workspaceId, sessionId);
        requireCredential(tenantId, workspaceId, sessionId, writerToken);
        validateStableId(resourceId, "resourceId");
        HeadRow head = requireHead(tenantId, sessionId);
        requireHeadScope(head, tenantId, workspaceId, sessionId);
        requireReadGrant(head, writerToken);
        try (var lease = outputRetention.read(tenantId, sessionId)) {
            String scopeKey = sessionScopeKey(tenantId, sessionId);
            ResourceRow resource = findResource(scopeKey, resourceId);
            if (resource == null) {
                throw new ManagedAgentException(HttpStatus.NOT_FOUND,
                        ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND,
                        "The Managed Session resource does not exist.");
            }
            requireResourceScope(resource, tenantId, workspaceId, sessionId,
                    resourceId);
            verifyStoredResource(resource);
            jdbc.update("UPDATE ma_resource SET"
                            + " last_verified_at = ? WHERE session_scope_key = ?"
                            + " AND resource_id = ?",
                    databaseNow(), scopeKey, resourceId);
            byte[] bytes = "TOOL_PUBLICATION".equals(resource.storageKind())
                    ? readPublicationObject(resource, lease) : resource.bytes();
            var result = new StoredResource(resource.resourceId(), resource.kind(),
                    resource.schemaVersion(), resource.byteLength(),
                    resource.digest(), bytes);
            lease.check();
            return result;
        }
    }

    public StoredResource readOwnerResource(
            String tenantId,
            String workspaceId,
            String sessionId,
            String resourceId,
            String writerToken) {
        if (org.springframework.transaction.support.TransactionSynchronizationManager
                        .isActualTransactionActive()
                || org.springframework.transaction.support.TransactionSynchronizationManager
                        .hasResource(jdbc.getDataSource())) {
            throw new IllegalStateException(
                    "Owner resource reads require a fresh transaction boundary");
        }
        validateScope(tenantId, workspaceId, sessionId);
        requireCredential(tenantId, workspaceId, sessionId, writerToken);
        validateStableId(resourceId, "resourceId");
        var guarded =
                jdbc.queryForList(
                        "SELECT csi_guard FROM ma_session"
                                + " WHERE tenant_id = ? AND session_id = ? AND csi_guard = TRUE",
                        tenantId,
                        sessionId);
        if (guarded.isEmpty()) {
            return readResource(tenantId, workspaceId, sessionId, resourceId, writerToken);
        }
        NativeRead admission =
                ownerReads.execute(
                        status -> {
                            var continuation = lockCsiContinuation(tenantId, sessionId);
                            var original = continuation == null ? null : continuation.original();
                            if (original == null) {
                                throw nativeReadConflict();
                            }
                            if (original.state() == com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.DRAINING) {
                                jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                                    JdbcCsiActivationAdmission.requireCheckpointContinuationRead(
                                            org.springframework.jdbc.datasource.DataSourceUtils.getTargetConnection(connection),
                                            original, continuation.progress(), resourceId);
                                    return null;
                                });
                            } else {
                                original.requireAdmission();
                            }
                            HeadRow head = requireHeadForUpdate(tenantId, sessionId);
                            requireHeadScope(head, tenantId, workspaceId, sessionId);
                            requireCsiWriter(original, head);
                            requireReadGrant(head, writerToken);
                            ResourceRow resource =
                                    nativeResourceMetadata(tenantId, sessionId, resourceId);
                            if (resource == null) {
                                throw new ManagedAgentException(
                                        HttpStatus.NOT_FOUND,
                                        ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND,
                                        "The Managed Session resource does not exist.");
                            }
                            requireResourceScope(
                                    resource, tenantId, workspaceId, sessionId, resourceId);
                            if (!"MYSQL_INLINE".equals(resource.storageKind())
                                    || resource.objectKey() != null
                                    || resource.objectVersionId() != null
                                    || resource.encryptionKeyId() != null) {
                                throw conflict(
                                        "csi_inline_resource_required",
                                        "The original owner reader requires an inline resource.");
                            }
                            String id = java.util.UUID.randomUUID().toString();
                            requireCsiReadGrant(continuation, head, writerToken);
                            long started = ToolPublicationRetentionStore.now(jdbc);
                            long expires =
                                    Math.addExact(
                                            started,
                                            ToolPublicationRetentionStore.READ_BUDGET_MILLIS);
                            requireCsiLease(continuation, expires, expires);
                            long readBindingVersion = continuation.progress().sealedBindingVersion() == null ? original.version() : continuation.progress().sealedBindingVersion();
                            var evidence =
                                    CSI_JSON.createObjectNode()
                                            .put("read_id", id)
                                            .put("tenant_id", tenantId)
                                            .put("workspace_id", workspaceId)
                                            .put("session_id", sessionId)
                                            .put("request_key", original.request().requestKey())
                                            .put("binding_id", original.bindingId())
                                            .put("runtime_generation", original.generation())
                                            .put("binding_version", readBindingVersion)
                                            .put("writer_id", head.writerId())
                                            .put("writer_generation", head.writerGeneration())
                                            .put("writer_token_hash", head.leaseTokenHash())
                                            .put("journal_revision", head.journalRevision())
                                            .put("activation_id", head.activationId())
                                            .put("activation_epoch", head.activationEpoch())
                                            .put("resource_id", resourceId)
                                            .put("kind", resource.kind())
                                            .put("schema_version", resource.schemaVersion())
                                            .put("byte_length", resource.byteLength())
                                            .put("sha256", resource.digest())
                                            .put("storage_kind", resource.storageKind())
                                            .put("resource_state", resource.state())
                                            .put("started_at", started)
                                            .put("delivery_expires_at", expires);
                            String encoded = evidence.toString();
                            String receipt =
                                    com.alibaba.qwen.code.runtimebroker.managedschema
                                            .ManagedSchemaKeys.key("csi-read", id);
                            jdbc.update(
                                    "INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id, scope_kind, scope_key, scope_id, idempotency_key, idempotency_digest, request_digest, operation, state, session_id, result_json, gmt_create, gmt_modified) VALUES (?, 'SESSION_COMMAND', ?, ?, 'SESSION', ?, ?, ?, ?, ?, 'CSI_RESOURCE_READ', 'OPEN', ?, ?, ?, ?)",
                                    receipt,
                                    com.alibaba.qwen.code.runtimebroker.managedschema
                                            .ManagedSchemaKeys.key(tenantId),
                                    tenantId,
                                    com.alibaba.qwen.code.runtimebroker.managedschema
                                            .ManagedSchemaKeys.key("csi-read", tenantId, sessionId),
                                    sessionId,
                                    id,
                                    com.alibaba.qwen.code.runtimebroker.managedschema
                                            .ManagedSchemaKeys.key(id),
                                    sha256(encoded.getBytes(StandardCharsets.UTF_8)),
                                    sessionId,
                                    encoded,
                                    started,
                                    started);
                            requireCsiReadGrant(continuation, head, writerToken);
                            jdbc.update(
                                    "INSERT INTO ma_read_lease (lease_id, tenant_key, session_key,"
                                        + " retirement_generation, expires_at) VALUES (?, ?, ?, 0,"
                                        + " ?)",
                                    id,
                                    ToolPublicationRetentionStore.hash(tenantId),
                                    ToolPublicationRetentionStore.hash(sessionId),
                                    expires);
                            var persisted = nativeReadReceipt(id, false);
                            return new NativeRead(id, original, head, resource, persisted, expires);
                        });
        ResourceRow fetched;
        try {
            fetched = fetchNativeResource(admission);
        } catch (RuntimeException | Error failure) {
            try {
                finishNativeRead(admission, null, false, writerToken);
            } catch (RuntimeException | Error completion) {
                failure.addSuppressed(completion);
            }
            throw failure;
        }
        ManagedAgentException failure = finishNativeRead(admission, fetched, true, writerToken);
        if (failure != null) {
            throw failure;
        }
        return new StoredResource(
                fetched.resourceId(),
                fetched.kind(),
                fetched.schemaVersion(),
                fetched.byteLength(),
                fetched.digest(),
                fetched.bytes());
    }

    private java.util.Map<String, Object> nativeReadReceipt(String id, boolean lock) {
        return jdbc.queryForMap(
                "SELECT " + ManagedSchemaProjection.REQUEST_RECEIPT.columns() + " FROM ma_request_receipt WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND' AND operation = 'CSI_RESOURCE_READ'"
                        + (lock ? " FOR UPDATE" : ""),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                        "csi-read", id));
    }

    private void completeNativeRead(
            NativeRead admission, String state, Long endedAt, String outcome) {
        com.fasterxml.jackson.databind.node.ObjectNode evidence;
        try {
            evidence =
                    (com.fasterxml.jackson.databind.node.ObjectNode)
                            CSI_JSON.readTree((String) admission.persisted().get("result_json"));
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Original read receipt is corrupt", error);
        }
        evidence.put("ended_at", endedAt).put("outcome_code", outcome);
        if (jdbc.update(
                        "UPDATE ma_request_receipt SET state = ?, result_json = ?, gmt_modified = ? WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND' AND operation = 'CSI_RESOURCE_READ' AND state = 'OPEN'",
                        state,
                        evidence.toString(),
                        ToolPublicationRetentionStore.now(jdbc),
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                "csi-read", admission.id()))
                != 1) {
            throw nativeReadConflict();
        }
    }

    private ResourceRow nativeResourceMetadata(String tenant, String session, String resource) {
        var rows =
                jdbc.query(
                        "SELECT tenant_id, workspace_id, session_id, resource_id, kind,"
                            + " schema_version, byte_length, sha256, storage_kind, NULL AS"
                            + " inline_bytes, object_key, object_version_id, encryption_key_id,"
                            + " state, capture_state, deletion_operation_key FROM ma_resource WHERE"
                            + " session_scope_key = ? AND resource_id = ? AND resource_key = ? FOR"
                            + " UPDATE",
                        resourceMapper,
                        sessionScopeKey(tenant, session),
                        resource,
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                sessionScopeKey(tenant, session), resource));
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private ResourceRow fetchNativeResource(NativeRead admission) {
        try (var connection = jdbc.getDataSource().getConnection();
                var statement =
                        connection.prepareStatement(
                                "SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE session_scope_key = ? AND resource_id = ? AND resource_key = ?")) {
            statement.setQueryTimeout(10);
            statement.setString(
                    1, sessionScopeKey(admission.head().tenantId(), admission.head().sessionId()));
            statement.setBytes(
                    2,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(
                            admission.resource().resourceId()));
            statement.setString(
                    3,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            sessionScopeKey(
                                    admission.head().tenantId(), admission.head().sessionId()),
                            admission.resource().resourceId()));
            try (var rows = statement.executeQuery()) {
                return rows.next() ? resourceMapper.mapRow(rows, 0) : null;
            }
        } catch (SQLException failure) {
            throw new org.springframework.dao.DataAccessResourceFailureException(
                    "Original resource fetch did not complete", failure);
        }
    }

    private ManagedAgentException finishNativeRead(
            NativeRead admission, ResourceRow fetched, boolean returned, String writerToken) {
        return ownerReads.execute(
                status -> {
                    HeadRow admittedHead = admission.head();
                    var continuation =
                            lockCsiContinuation(admittedHead.tenantId(), admittedHead.sessionId());
                    var original = continuation == null ? null : continuation.original();
                    if (original == null
                            || !original.request().equals(admission.original().request())
                            || !original.bindingId().equals(admission.original().bindingId())
                            || original.generation() != admission.original().generation()
                            || original.version() < admission.original().version()) {
                        throw nativeReadConflict();
                    }
                    original.requireAdmission();
                    HeadRow head =
                            requireHeadForUpdate(admittedHead.tenantId(), admittedHead.sessionId());
                    var persisted = nativeReadReceipt(admission.id(), true);
                    if (!persisted.equals(admission.persisted())) {
                        throw nativeReadConflict();
                    }
                    if (!returned) {
                        requireCsiReadGrant(continuation, head, writerToken);
                        completeNativeRead(admission, "UNKNOWN", null, "jdbc_fetch_unknown");
                        return null;
                    }
                    ManagedAgentException failure = null;
                    try {
                        requireHeadScope(
                                head,
                                admittedHead.tenantId(),
                                admittedHead.workspaceId(),
                                admittedHead.sessionId());
                        requireReadGrant(head, writerToken);
                        if (!Objects.equals(head.writerId(), admittedHead.writerId())
                                || head.writerGeneration() != admittedHead.writerGeneration()) {
                            throw writerConflict();
                        }
                        var lease =
                                jdbc.queryForList(
                                        "SELECT expires_at, retirement_generation FROM"
                                            + " ma_read_lease WHERE lease_id = ? AND tenant_key = ?"
                                            + " AND session_key = ? FOR UPDATE",
                                        admission.id(),
                                        ToolPublicationRetentionStore.hash(head.tenantId()),
                                        ToolPublicationRetentionStore.hash(head.sessionId()));
                        long now = ToolPublicationRetentionStore.now(jdbc);
                        if (lease.size() != 1
                                || ((Number) lease.getFirst().get("expires_at")).longValue()
                                        != admission.expires()
                                || admission.expires() <= now
                                || ((Number) lease.getFirst().get("retirement_generation"))
                                                .longValue()
                                        != 0) {
                            throw conflict(
                                    "tool_output_read_expired",
                                    "The original output read delivery lease expired.");
                        }
                        ResourceRow current =
                                nativeResourceMetadata(
                                        head.tenantId(),
                                        head.sessionId(),
                                        admission.resource().resourceId());
                        if (!sameNativeResource(admission.resource(), fetched)
                                || !sameNativeResource(admission.resource(), current)) {
                            throw resourceCorrupt();
                        }
                        verifyStoredResource(fetched);
                        requireCsiReadGrant(continuation, head, writerToken);
                        if (admission.expires() <= ToolPublicationRetentionStore.now(jdbc)) {
                            throw nativeReadConflict();
                        }
                        jdbc.update(
                                "UPDATE ma_resource SET last_verified_at = ?"
                                        + " WHERE session_scope_key = ? AND resource_id = ?",
                                databaseNow(),
                                sessionScopeKey(head.tenantId(), head.sessionId()),
                                fetched.resourceId());
                    } catch (ManagedAgentException rejected) {
                        failure = rejected;
                    }
                    requireCsiReadGrant(continuation, head, writerToken);
                    if (admission.expires() <= ToolPublicationRetentionStore.now(jdbc)) {
                        throw nativeReadConflict();
                    }
                    completeNativeRead(
                            admission,
                            "RETURNED",
                            ToolPublicationRetentionStore.now(jdbc),
                            failure == null ? "verified" : failure.getCode());
                    requireCsiReadGrant(continuation, head, writerToken);
                    jdbc.update("DELETE FROM ma_read_lease WHERE lease_id = ?", admission.id());
                    return failure;
                });
    }

    private static boolean sameNativeResource(ResourceRow expected, ResourceRow actual) {
        return actual != null
                && Objects.equals(expected.tenantId(), actual.tenantId())
                && Objects.equals(expected.workspaceId(), actual.workspaceId())
                && Objects.equals(expected.sessionId(), actual.sessionId())
                && Objects.equals(expected.resourceId(), actual.resourceId())
                && Objects.equals(expected.kind(), actual.kind())
                && expected.schemaVersion() == actual.schemaVersion()
                && expected.byteLength() == actual.byteLength()
                && Objects.equals(expected.digest(), actual.digest())
                && Objects.equals(expected.storageKind(), actual.storageKind())
                && Objects.equals(expected.state(), actual.state())
                && actual.objectKey() == null
                && actual.objectVersionId() == null
                && actual.encryptionKeyId() == null;
    }

    private static ManagedAgentException nativeReadConflict() {
        return conflict(
                "csi_resource_read_conflict",
                "The original resource read identity is unavailable.");
    }

    private record NativeRead(
            String id,
            JdbcCsiFilesRetirementGuard.Original original,
            HeadRow head,
            ResourceRow resource,
            java.util.Map<String, Object> persisted,
            long expires) {}

    @Transactional
    public ToolResultResourceRef publishAgentInstructions(String tenantId,
            String workspaceId, String sessionId, String instructions) {
        validateScope(tenantId, workspaceId, sessionId);
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
        byte[] bytes = instructions.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES) {
            throw payloadTooLarge("Agent instructions exceed 64 KiB.");
        }
        return publishAgentResource(tenantId, workspaceId, sessionId,
                "managed-agent-instructions", "agent-instructions-", bytes);
    }

    @Transactional
    public ToolResultResourceRef publishAgentSkills(String tenantId,
            String workspaceId, String sessionId, List<java.util.Map<String, Object>> skills) {
        validateScope(tenantId, workspaceId, sessionId);
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
        return publishAgentResource(tenantId, workspaceId, sessionId,
                "managed-agent-skills", "agent-skills-", AgentDefinitionExtensions.skillsBytes(skills));
    }

    private ToolResultResourceRef publishAgentResource(String tenantId,
            String workspaceId, String sessionId, String kind, String prefix, byte[] bytes) {
        String digest = sha256(bytes);
        String resourceId = prefix + digest;
        String scopeKey = sessionScopeKey(tenantId, sessionId);
        Timestamp now = databaseNow();
        ResourceRow existing = findResource(scopeKey, resourceId);
        if (existing == null) {
            jdbc.update(
                    "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                        + " state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, ?, ?,"
                        + " ?, 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'PUBLISHED', ?, ?)",
                    resourceKey(scopeKey, resourceId),
                    scopeKey,
                    tenantId,
                    workspaceId,
                    sessionId,
                    resourceId,
                    kind,
                    bytes.length,
                    digest,
                    bytes,
                    resourceId,
                    now.getTime(),
                    now.getTime());
        } else {
            requireResourceScope(existing, tenantId, workspaceId, sessionId, resourceId);
            verifyStoredResource(existing);
            if (!kind.equals(existing.kind())
                    || existing.schemaVersion() != 1
                    || existing.byteLength() != bytes.length
                    || !digest.equals(existing.digest())) {
                throw conflict("managed_session_resource_conflict",
                        "Agent configuration resource does not match.");
            }
        }
        return new ToolResultResourceRef(resourceId, kind, 1, bytes.length, digest);
    }

    @Transactional
    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request) {
        return publishToolResult(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        checkLifecycleWriter(tenantId, sessionId, authority);
        validateStableId(request.writerId(), "writerId");
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        validateStableId(request.resourceId(), "resourceId");
        validateDigest(request.digest(), "resource digest", false);
        int limit = toolResultLimit(request.kind());
        if (limit == 0 || request.schemaVersion() != 1 || request.byteLength() < 1) {
            throw invalid("Tool result resource kind, version or length is invalid.");
        }
        if (request.byteLength() > limit || request.bytesBase64() != null
                && request.bytesBase64().length() > 4 * ((limit + 2) / 3)) {
            throw payloadTooLarge("Tool result resource exceeds its byte limit.");
        }
        byte[] bytes = decodeBase64(request.bytesBase64(), limit, "resource bytesBase64");
        if (bytes.length != request.byteLength() || !sha256(bytes).equals(request.digest())) {
            throw invalid("Tool result bytes do not match their length or digest.");
        }
        requirePhysicalSessionOpen(tenantId, request.workspaceId(), sessionId);
        // Tool-result publication lane: keeps the tenant CAS row before the
        // Session root the CSI check locks and before the head row, the
        // order retention reads take (CAS row, root, head) and the same as
        // before #13800 decoupled ordinary traffic.
        lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        // After both bounded waits, so the CSI check's read does not pin this
        // transaction's snapshot ahead of them.
        var continuation = lockCsiContinuation(tenantId, sessionId);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        // Unlike the other writer paths, a v2 claim fences this lane even
        // for the claiming lifecycle authority: tool results are never
        // published against a Session claimed under lifecycle protocol v2.
        requireNoLifecycleClaim(tenantId, sessionId);
        requireCsiWriter(csiOriginal, head);
        Timestamp now = databaseNow();
        requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, now, true);
        requireInstalledCsiWriter(csiOriginal);
        String scopeKey = sessionScopeKey(tenantId, sessionId);
        ResourceRow existing = findResource(scopeKey, request.resourceId());
        requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        if (existing == null) {
            jdbc.update(
                    "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                        + " state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, 'MYSQL_INLINE', ?, ?, 'PUBLISHED', ?, ?)",
                    resourceKey(scopeKey, request.resourceId()),
                    scopeKey,
                    tenantId,
                    request.workspaceId(),
                    sessionId,
                    request.resourceId(),
                    request.kind(),
                    request.schemaVersion(),
                    request.byteLength(),
                    request.digest(),
                    bytes,
                    request.resourceId(),
                    now.getTime(),
                    now.getTime());
        } else {
            requireResourceScope(existing, tenantId, request.workspaceId(), sessionId, request.resourceId());
            verifyStoredResource(existing);
            if (!request.kind().equals(existing.kind()) || request.schemaVersion() != existing.schemaVersion()
                    || request.byteLength() != existing.byteLength() || !request.digest().equals(existing.digest())) {
                throw conflict(
                        "managed_session_resource_conflict",
                        "A resourceId was reused with different content metadata.");
            }
        }
        requireCsiCurrentTime(continuation);
        return new ToolResultResourceRef(request.resourceId(), request.kind(), request.schemaVersion(),
                request.byteLength(), request.digest());
    }

    static int toolResultLimit(String kind) {
        if (kind == null) {
            return 0;
        }
        return switch (kind) {
            case "managed-tool-result-content" -> 1024 * 1024;
            case "managed-tool-result-page" -> 256 * 1024;
            case "managed-tool-result-manifest" -> 64 * 1024;
            default -> 0;
        };
    }

    /** A committed resource of this transaction's Session, verified. */
    private StoredResource storedResource(String scopeKey, String tenantId,
            String workspaceId, String sessionId, String resourceId) {
        ResourceRow resource = findResource(scopeKey, resourceId);
        if (resource == null) {
            throw conflict(ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                    "A referenced Managed Session resource is missing.");
        }
        requireResourceScope(resource, tenantId, workspaceId, sessionId,
                resourceId);
        if (!"REFERENCED".equals(resource.state())
                && !("PUBLISHED".equals(resource.state())
                    && Set.of("managed-agent-instructions", "managed-agent-skills").contains(resource.kind()))) {
            throw conflict(ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                    "A referenced Managed Session resource is missing.");
        }
        verifyStoredResource(resource);
        return new StoredResource(resource.resourceId(), resource.kind(),
                resource.schemaVersion(), resource.byteLength(),
                resource.digest(), resource.bytes());
    }

    private void persistTransaction(
            String tenantId,
            String sessionId,
            String writerTokenHash,
            CommitTransactionRequest request,
            long revision,
            ValidatedCommit validated,
            Timestamp now) {
        jdbc.update(
                "INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision, command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence, event_count, events_digest, previous_commit_digest, commit_digest, writer_generation, writer_id, writer_token_hash, activation_epoch, latest_checkpoint_resource_id, record_encoding, record_bytes, byte_length, record_digest, gmt_create) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'identity', ?, ?, ?, ?)",
                tenantId,
                request.workspaceId(),
                sessionId,
                revision,
                commandKeyHash(request.operation(), request.commandId()),
                request.transactionId(),
                request.operation(),
                request.commandId(),
                request.contentDigest(),
                request.firstSequence(),
                request.lastSequence(),
                request.eventCount(),
                request.eventsDigest(),
                request.previousCommitDigest(),
                request.commitDigest(),
                request.writerGeneration(),
                request.writerId(),
                writerTokenHash,
                request.activationEpoch(),
                request.latestCheckpointResourceId(),
                validated.recordBytes(),
                validated.recordBytes().length,
                validated.recordDigest(),
                now.getTime());
    }

    record TerminalCandidate(CommitTransactionRequest request,
            com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.TerminalProof proof, String writerTokenSha256) {
    }

    void requireCsiApplicationCredential(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken) throws SQLException {
        authority.requireConnection(target);
        if (!org.springframework.jdbc.datasource.DataSourceUtils.isConnectionTransactional(
                org.springframework.jdbc.datasource.DataSourceUtils.getTargetConnection(target), jdbc.getDataSource())) {
            throw nativeReadConflict();
        }
        var scope = authority.original().request().getScope();
        String session = authority.original().request().getIsolationKey();
        requireCredential(scope.getTenantId(), scope.getWorkspaceId(), session, writerToken);
        requireCsiJournalIsolation();
        HeadRow head = requireHeadForUpdate(scope.getTenantId(), session);
        requireHeadScope(head, scope.getTenantId(), scope.getWorkspaceId(), session);
        requireCsiWriter(authority.original(), head);
        if (!secureEquals(head.leaseTokenHash(), tokenHash(writerToken))) {
            throw nativeReadConflict();
        }
    }

    void requireCsiHistoricalCredential(String tenant, String workspace, String session, String token, String retainedHash) {
        requireCredential(tenant, workspace, session, token);
        String presented = tokenHash(token);
        if (retainedHash == null || !retainedHash.matches("[0-9a-f]{64}") || !secureEquals(retainedHash, presented)) {
            throw nativeReadConflict();
        }
    }

    TerminalCandidate preflightCsiTerminal(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken, byte[] exactBody, JdbcRuntimeBindingRepository bindings) throws SQLException {
        authority.requirePreCut(target);
        if (!org.springframework.jdbc.datasource.DataSourceUtils.isConnectionTransactional(
                org.springframework.jdbc.datasource.DataSourceUtils.getTargetConnection(target), jdbc.getDataSource())
                || bindings == null || !bindings.usesDataSource(jdbc.getDataSource())
                || exactBody == null || exactBody.length == 0 || exactBody.length > 128 * 1024) {
            throw nativeReadConflict();
        }
        var original = authority.original();
        CommitTransactionRequest request = csiTerminalRequest(exactBody);
        String tenant = original.request().getScope().getTenantId();
        String session = original.request().getIsolationKey();
        validateScope(tenant, request.workspaceId(), session);
        requireCredential(tenant, request.workspaceId(), session, writerToken);
        requireCsiJournalIsolation();
        validateCommit(request);
        HeadRow head = requireHeadForUpdate(tenant, session);
        requireHeadScope(head, tenant, request.workspaceId(), session);
        requireCsiWriter(original, head);
        requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, databaseNow(), true);
        validateHead(head, request);
        var proof = JdbcCsiActivationAdmission.terminalPreflight(target, authority, CSI_JSON.valueToTree(request), bindings);
        return new TerminalCandidate(request, proof, head.leaseTokenHash());
    }

    String commitCsiTerminal(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken, byte[] exactBody, JdbcRuntimeBindingRepository bindings) throws SQLException {
        authority.requireConnection(target);
        if (authority.stage() != com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.FROZEN) {
            throw nativeReadConflict();
        }
        var frozen = WorkspaceCsiApplicationJson.object(authority.frozenBytes(), WorkspaceCsiApplicationInventory.MAX_BYTES);
        byte[] saved = WorkspaceCsiApplicationJson.base64(frozen.path("commitBodyBase64"), 128 * 1024);
        if (!java.util.Arrays.equals(saved, exactBody)
                || !com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.sha256(saved)
                        .equals(frozen.path("preparedCommitSha256").textValue())) {
            throw nativeReadConflict();
        }
        var candidate = preflightCsiTerminal(target, authority, writerToken, exactBody, bindings);
        var request = candidate.request();
        String tenant = authority.original().request().getScope().getTenantId();
        String session = authority.original().request().getIsolationKey();
        HeadRow head = requireHeadForUpdate(tenant, session);
        var validated = validateCommit(request);
        Timestamp now = databaseNow();
        String writtenAt = now.toInstant().toString();
        long revision = increment(head.journalRevision(), "journal revision");
        Runnable fence = () -> {
            try {
                authority.requireCurrentTime(target);
            } catch (SQLException error) {
                throw new org.springframework.dao.DataAccessResourceFailureException("Original terminal time is unavailable", error);
            }
            requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, databaseNow(), true);
        };
        commitResources(sessionScopeKey(tenant, session), tenant, session, request, revision, now, validated.resources(), fence);
        fence.run();
        persistTransaction(tenant, session, candidate.writerTokenSha256(), request, revision, validated, now);
        fence.run();
        int changed = jdbc.update("UPDATE ma_session_head SET state = 'SEALED',"
                        + " journal_revision = ?, wake_head_revision = CASE WHEN wake_head_revision = ? THEN ? ELSE wake_head_revision END, committed_sequence = ?, last_commit_digest = ?,"
                        + " activation_phase = 'released', activation_head_revision = ?, gmt_modified = ?"
                        + " WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND state = 'ACTIVE'"
                        + " AND journal_revision = ? AND committed_sequence = ? AND last_commit_digest = ?",
                revision, head.journalRevision(), revision, candidate.proof().terminalSequence(), request.commitDigest(), revision, now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session), tenant, session,
                head.journalRevision(), head.committedSequence(), head.lastCommitDigest());
        if (changed != 1) {
            throw nativeReadConflict();
        }
        authority.requireCurrentTime(target);
        return writtenAt;
    }

    private static CommitTransactionRequest csiTerminalRequest(byte[] bytes) {
        WorkspaceCsiApplicationJson.object(bytes, 128 * 1024);
        try {
            return CSI_TERMINAL_JSON.readValue(bytes, CommitTransactionRequest.class);
        } catch (IOException malformed) {
            throw invalid("Invalid original terminal request.");
        }
    }

    static CommitTransactionRequest validateCsiTerminalBytes(byte[] bytes) {
        var request = csiTerminalRequest(bytes);
        validateCommit(request);
        return request;
    }

    private void commitResources(String scopeKey, String tenantId,
            String sessionId, CommitTransactionRequest request,
            long revision, Timestamp now,
            List<ValidatedResource> resources,
            Runnable writeFence) {
        Set<String> resourceIds = new HashSet<>();
        for (ValidatedResource input : resources) {
            CommitResource resource = input.resource();
            if (!resourceIds.add(resource.resourceId())) {
                throw invalid("resources contains a duplicate resourceId.");
            }
            ResourceRow existing = findResource(scopeKey,
                    resource.resourceId());
            writeFence.run();
            if (existing == null) {
                if (input.bytes() == null) {
                    throw conflict(
                            ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                            "A referenced Managed Session resource is"
                                    + " missing.");
                }
                jdbc.update("INSERT INTO ma_resource"
                                + " (resource_key, session_scope_key, tenant_id,"
                                + " workspace_id, session_id, resource_id,"
                                + " kind, schema_version, byte_length, sha256,"
                                + " storage_kind, inline_bytes,"
                                + " publish_command_id, state, gmt_create,"
                                + " last_verified_at) VALUES (?, ?, ?, ?, ?, ?,"
                                + " ?, ?, ?, ?, 'MYSQL_INLINE', ?, ?,"
                                + " 'REFERENCED', ?, ?)",
                        resourceKey(scopeKey, resource.resourceId()), scopeKey, tenantId, request.workspaceId(), sessionId,
                        resource.resourceId(), resource.kind(),
                        resource.schemaVersion(), resource.byteLength(),
                        resource.digest(), input.bytes(), request.commandId(),
                        now.getTime(), now.getTime());
            } else {
                requireResourceScope(existing, tenantId,
                        request.workspaceId(), sessionId,
                        resource.resourceId());
                verifyStoredResource(existing);
                if (!resource.kind().equals(existing.kind())
                        || resource.schemaVersion()
                                != existing.schemaVersion()
                        || resource.byteLength() != existing.byteLength()
                        || !resource.digest().equals(existing.digest())) {
                    throw conflict("managed_session_resource_conflict",
                            "A resourceId was reused with different"
                                    + " content metadata.");
                }
            }
            jdbc.update(
                    "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                        + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                        + " journal_revision, resource_id, gmt_create) VALUES (?, 'JOURNAL', ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?)",
                    scopeKey,
                    scopeKey,
                    revision,
                    resourceKey(scopeKey, resource.resourceId()),
                    tenantId,
                    request.workspaceId(),
                    sessionId,
                    revision,
                    resource.resourceId(),
                    now.getTime());
        }
    }

    private static ValidatedCommit validateCommit(
            CommitTransactionRequest request) {
        validateStableId(request.transactionId(), "transactionId");
        validateText(request.operation(), "operation", MAX_TEXT_BYTES);
        validateStableId(request.commandId(), "commandId");
        validateDigest(request.contentDigest(), "contentDigest", false);
        validateDigest(request.eventsDigest(), "eventsDigest", true);
        validateDigest(request.previousCommitDigest(),
                "previousCommitDigest", true);
        validateDigest(request.commitDigest(), "commitDigest", true);
        validateDigest(request.recordDigest(), "recordDigest", false);
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        validateCounter(request.expectedJournalRevision(),
                "expectedJournalRevision", 0);
        validateCounter(request.expectedCommittedSequence(),
                "expectedCommittedSequence", 0);
        validateCounter(request.firstSequence(), "firstSequence", 0);
        validateCounter(request.lastSequence(), "lastSequence", 0);
        validateCounter(request.activationEpoch(), "activationEpoch", 0);
        if (request.latestCheckpointResourceId() != null) {
            validateStableId(request.latestCheckpointResourceId(),
                    "latestCheckpointResourceId");
        }
        if (request.eventCount() < 0
                || request.eventCount()
                        > ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS
                || request.recordCount() < 1
                || request.recordCount()
                        > ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS
                                + 1) {
            throw invalid("eventCount or recordCount is outside its bound.");
        }
        byte[] recordBytes = decodeBase64(request.recordBytesBase64(),
                ManagedSessionStoreModels.MAX_TRANSACTION_BYTES,
                "recordBytesBase64");
        if (!sha256(recordBytes).equals(request.recordDigest())) {
            throw invalid("recordDigest does not match recordBytesBase64.");
        }
        validateUtf8JsonLines(recordBytes, request.recordCount());
        if ("session.create".equals(request.operation())) {
            if (request.eventCount() != 0 || request.firstSequence() != 0
                    || request.lastSequence() != 0
                    || request.recordCount() != 2
                    || request.eventsDigest() != null
                    || request.previousCommitDigest() != null
                    || request.commitDigest() != null
                    || request.latestCheckpointResourceId() != null) {
                throw invalid("The session.create transaction must use"
                        + " sequence zero and no commit digest chain.");
            }
        } else {
            if (request.eventCount() < 1
                    || request.firstSequence() < 1
                    || request.lastSequence() < request.firstSequence()
                    || request.lastSequence() - request.firstSequence() + 1
                            != request.eventCount()
                    || request.eventsDigest() == null
                    || request.commitDigest() == null
                    || request.recordCount() != request.eventCount() + 1) {
                throw invalid("The transaction event range or record count"
                        + " is invalid.");
            }
        }
        List<ValidatedResource> resources = new ArrayList<>();
        long inlineBytes = 0;
        List<CommitResource> requestedResources = request.resources() == null
                ? List.of() : request.resources();
        if (requestedResources.size()
                > ManagedSessionStoreModels.MAX_RESOURCES_PER_TRANSACTION) {
            throw invalid("resources exceeds its item limit.");
        }
        for (CommitResource resource : requestedResources) {
            if (resource == null) {
                throw invalid("resources must not contain null entries.");
            }
            validateStableId(resource.resourceId(), "resourceId");
            validateStableId(resource.kind(), "resource kind");
            validateDigest(resource.digest(), "resource digest", false);
            if (resource.schemaVersion() < 1 || resource.byteLength() < 0) {
                throw invalid("Resource version or length is invalid.");
            }
            int maxResourceBytes = ManagedSessionStoreModels.inlineResourceBytes(resource.kind());
            if (resource.byteLength() > maxResourceBytes
                    && !("managed-tool-outcome".equals(resource.kind())
                    && resource.bytesBase64() == null)) {
                throw new ManagedAgentException(HttpStatus.NOT_IMPLEMENTED,
                        ManagedSessionStoreModels.ERROR_OSS_DISABLED,
                        "Resources larger than " + (maxResourceBytes / 1024) + " KiB require the disabled"
                                + " OSS storage path.");
            }
            byte[] bytes = resource.bytesBase64() == null ? null
                    : decodeBase64(resource.bytesBase64(),
                            maxResourceBytes,
                            "resource bytesBase64");
            if (bytes != null && (bytes.length != resource.byteLength()
                    || !sha256(bytes).equals(resource.digest()))) {
                throw invalid("Resource bytes do not match their length or"
                        + " digest.");
            }
            if (bytes != null) {
                inlineBytes += bytes.length;
                if (inlineBytes
                        > ManagedSessionStoreModels.MAX_INLINE_TRANSACTION_BYTES) {
                    throw payloadTooLarge("Inline resources exceed their"
                            + " transaction byte limit.");
                }
            }
            resources.add(new ValidatedResource(resource, bytes));
        }
        if (request.latestCheckpointResourceId() != null
                && resources.stream().map(ValidatedResource::resource)
                        .noneMatch(resource -> request
                                .latestCheckpointResourceId()
                                .equals(resource.resourceId())
                                && "managed-checkpoint"
                                        .equals(resource.kind()))) {
            throw invalid("latestCheckpointResourceId must identify a"
                    + " managed-checkpoint resource in this transaction.");
        }
        return new ValidatedCommit(recordBytes, request.recordDigest(),
                resources);
    }

    private void validateHead(HeadRow head,
            CommitTransactionRequest request) {
        if (request.expectedJournalRevision() != head.journalRevision()
                || request.expectedCommittedSequence()
                        != head.committedSequence()
                || !Objects.equals(request.previousCommitDigest(),
                        head.lastCommitDigest())) {
            throw conflict("managed_session_head_conflict",
                    "The Managed Session head changed; reload before"
                            + " retrying.");
        }
        if (request.activationEpoch() < head.activationEpoch()) {
            throw conflict("managed_session_activation_conflict",
                    "The activation epoch is stale.");
        }
        if (!"READY".equals(head.recoveryStatus())) {
            throw conflict("managed_session_recovery_blocked",
                    "The Managed Session is blocked from new commits.");
        }
        if ("session.create".equals(request.operation())) {
            if (head.journalRevision() != 0
                    || head.committedSequence() != 0) {
                throw conflict("managed_session_head_conflict",
                        "The Managed Session genesis is already committed.");
            }
        } else if (head.journalRevision() == 0
                || request.firstSequence()
                        != increment(head.committedSequence(),
                                "committed sequence")) {
            throw conflict("managed_session_head_conflict",
                    "The transaction does not extend the committed"
                            + " sequence.");
        }
    }

    private CommitReceipt replay(TransactionRow existing,
            CommitTransactionRequest request, String recordDigest,
            String writerToken) {
        if (!existing.operation().equals(request.operation())
                || !existing.commandId().equals(request.commandId())
                || !existing.transactionId()
                        .equals(request.transactionId())
                || !existing.contentDigest().equals(request.contentDigest())
                || !existing.recordDigest().equals(recordDigest)
                || existing.firstSequence() != request.firstSequence()
                || existing.lastSequence() != request.lastSequence()
                || existing.eventCount() != request.eventCount()
                || !Objects.equals(existing.eventsDigest(),
                        request.eventsDigest())
                || !Objects.equals(existing.previousCommitDigest(),
                        request.previousCommitDigest())
                || existing.writerGeneration()
                        != request.writerGeneration()
                || !existing.writerId().equals(request.writerId())
                || !secureEquals(existing.writerTokenHash(),
                        tokenHash(writerToken))
                || existing.activationEpoch() != request.activationEpoch()
                || !Objects.equals(existing.latestCheckpointResourceId(),
                        request.latestCheckpointResourceId())
                || !Objects.equals(existing.commitDigest(),
                        request.commitDigest())) {
            throw conflict(
                    ManagedSessionStoreModels.ERROR_IDEMPOTENCY_CONFLICT,
                    "The command key was reused with different content.");
        }
        return new CommitReceipt(existing.journalRevision(),
                existing.transactionId(), existing.commandId(),
                existing.operation(), existing.firstSequence(),
                existing.lastSequence(), existing.lastSequence(),
                existing.commitDigest(), true);
    }

    private void requireWriter(HeadRow head, String writerId,
            long writerGeneration, String writerToken, Timestamp now,
            boolean requireUnexpired) {
        if (!"ACTIVE".equals(head.state())
                || writerGeneration != head.writerGeneration()
                || !writerId.equals(head.writerId())
                || !secureEquals(tokenHash(writerToken),
                        head.leaseTokenHash())
                || requireUnexpired && (head.writerLeaseUntil() == null
                        || !head.writerLeaseUntil().after(now))) {
            throw writerConflict();
        }
    }

    private void requireReadGrant(HeadRow head, String writerToken) {
        ToolPublicationRetentionStore.requireLive(jdbc, head.tenantId(), head.sessionId());
        Timestamp now = databaseNow();
        if (!"ACTIVE".equals(head.state())
                || !secureEquals(tokenHash(writerToken),
                        head.leaseTokenHash())
                || head.writerLeaseUntil() == null
                || !head.writerLeaseUntil().after(now)) {
            throw writerConflict();
        }
    }

    /**
     * Converts the last activation.changed payload of a committed transaction, so the head row can
     * answer authorization reads without rescanning the journal. The payload was already parsed by
     * the extension record pass of this commit. Text fields read with the same leniency as the
     * authorization scans, so the two never disagree.
     */
    private static ActivationChange activationChange(JsonNode payload) {
        if (payload == null) {
            return null;
        }
        return new ActivationChange(
                ToolPublicationContract.text(payload, "activationId"),
                ToolPublicationContract.text(payload, "phase"),
                payload.path("epoch").asLong(),
                ManagedExtensionRecords.millisLenient(
                        payload.path("expiresAt")));
    }

    private HeadRow findHeadForUpdate(String tenantId, String sessionId) {
        // Ordinary writers serialize on their own Session's rows only: the
        // Session root, then the head — the per-Session order retirement
        // also takes behind its tenant guard. Both are locking reads, so
        // neither pins this transaction's REPEATABLE READ snapshot, and
        // requireLive below reads after the waits end. The tenant-wide CAS
        // row stays with explicit publication paths so ordinary writes never
        // queue on it (#13800).
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        List<HeadRow> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                        headMapper,
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        ToolPublicationRetentionStore.requireLive(jdbc, tenantId, sessionId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private HeadRow requireHeartbeatHead(String tenantId, String sessionId) {
        // An ordinary heartbeat holds no tenant fence (#13800): retirement
        // serializes with it on the Session root, which the CSI check locked
        // before its first consistent read, and on the head row, locked here
        // before requireLive reads.
        var heads =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND"
                            + " tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'"
                            + " FOR UPDATE",
                        headMapper,
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        ToolPublicationRetentionStore.requireLive(jdbc, tenantId, sessionId);
        if (heads.isEmpty()) {
            throw sessionNotFound();
        }
        return heads.getFirst();
    }

    JdbcCsiFilesRetirementGuard.Original lockCsiOriginal(String tenantId, String sessionId) {
        var continuation = lockCsiContinuation(tenantId, sessionId);
        return continuation == null ? null : continuation.original();
    }

    private CsiContinuation lockCsiContinuation(String tenantId, String sessionId) {
        Boolean pinned = jdbc.execute(
                (org.springframework.jdbc.core.ConnectionCallback<Boolean>)
                        connection -> {
                            var target =
                                    org.springframework.jdbc.datasource.DataSourceUtils
                                            .getTargetConnection(connection);
                            if (!org.springframework.jdbc.datasource.DataSourceUtils
                                    .isConnectionTransactional(target, jdbc.getDataSource())) {
                                var privatePins =
                                        jdbc.query(
                                                "SELECT csi_guard FROM ma_session WHERE tenant_id ="
                                                    + " ? AND session_id = ? AND csi_guard = TRUE",
                                                (row, index) -> row.getBoolean("csi_guard"),
                                                tenantId,
                                                sessionId);
                                if (!privatePins.isEmpty()) {
                                    throw new IllegalStateException(
                                            "CSI mutation requires its original transaction"
                                                    + " connection");
                                }
                                return null;
                            }
                            // An ordinary Session stops here, before the
                            // tenant-wide guard rows and the slot/binding
                            // range locks: taking them on every writer path
                            // would couple per-turn traffic of unrelated
                            // Sessions again (#13800). The root is locked
                            // first, by primary key once it exists, so its pin
                            // is read as committed now even under an older
                            // REPEATABLE READ snapshot, no gap is taken that
                            // another tenant's first writer inserts into, and
                            // no consistent read below runs before this wait.
                            // The runtime rows are then read plainly: a CSI
                            // slot or binding is only created under a pinned
                            // root, a pin never changes after its row is
                            // inserted, and roots are never deleted, so an
                            // unpinned root can only have legacy markers,
                            // which no snapshot here is older than.
                            return ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId)
                                    || JdbcCsiFilesRetirementGuard.hasCsiRuntimeMarker(
                                            target, tenantId, sessionId);
                        });
        if (!Boolean.TRUE.equals(pinned)) {
            return null;
        }
        // A pinned Session takes the tenant guards behind its root, bounded
        // and named like every other per-turn lane: on renew, commit and
        // recovery state these are the first tenant-wide waits (#13800).
        // Every other lane takes the guards before the root, so a guard-first
        // operation on this same Session meanwhile resolves as an InnoDB
        // deadlock. Either side may be rolled back: this side's waits are
        // named by lockBounded, the other side's root wait by
        // namedRootDeadlock (#13800 R1-1).
        lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        return jdbc.execute(
                (org.springframework.jdbc.core.ConnectionCallback<CsiContinuation>)
                        connection -> {
                            var target =
                                    org.springframework.jdbc.datasource.DataSourceUtils
                                            .getTargetConnection(connection);
                            var original =
                                    JdbcCsiFilesRetirementGuard.lockManagedSession(
                                            target, tenantId, sessionId);
                            if (original != null) {
                                requireCsiJournalIsolation();
                            }
                            return original == null
                                    ? null
                                    : new CsiContinuation(
                                            original,
                                            com.alibaba.qwen.code.runtimebroker
                                                    .JdbcCsiApplicationProgress.lock(target, original));
                        });
    }

    private void requireCsiJournalIsolation() {
        if (journalEventTransport != null) {
            throw conflict("csi_journal_transport_unsupported",
                    "The private CSI lane requires an isolated journal without an event transport.");
        }
    }

    private void requireCsiCurrentTime(CsiContinuation continuation) {
        if (continuation != null) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                continuation
                                        .progress()
                                        .requireCurrentTime(
                                                org.springframework.jdbc.datasource.DataSourceUtils
                                                        .getTargetConnection(connection));
                                return null;
                            });
        }
    }

    private void requireCsiLease(
            CsiContinuation continuation, long existingExpiry, long targetExpiry) {
        if (continuation != null) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                continuation
                                        .progress()
                                        .requireLease(
                                                org.springframework.jdbc.datasource.DataSourceUtils
                                                        .getTargetConnection(connection),
                                                existingExpiry,
                                                targetExpiry);
                                return null;
                            });
        }
    }

    private void requireCsiWriterCurrent(
            CsiContinuation continuation,
            HeadRow head,
            String writerId,
            long generation,
            String token) {
        if (continuation != null) {
            requireCsiLease(
                    continuation,
                    epochMillis(head.writerLeaseUntil()),
                    epochMillis(head.writerLeaseUntil()));
            requireWriter(head, writerId, generation, token, databaseNow(), true);
        }
    }

    private void requireCsiReadGrant(CsiContinuation continuation, HeadRow head, String token) {
        requireReadGrant(head, token);
        requireCsiLease(
                continuation,
                epochMillis(head.writerLeaseUntil()),
                epochMillis(head.writerLeaseUntil()));
    }

    private record CsiContinuation(
            JdbcCsiFilesRetirementGuard.Original original,
            com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationProgress.Continuation progress) {}

    private static void requireCsiWriter(
            JdbcCsiFilesRetirementGuard.Original original, HeadRow head) {
        if (original != null && head.writerGeneration() < 1) {
            throw conflict(
                    "csi_original_writer_unavailable",
                    "The original CSI writer cannot be replaced.");
        }
    }

    private void requireInstalledCsiWriter(JdbcCsiFilesRetirementGuard.Original original) {
        if (original != null) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                JdbcCsiActivationAdmission.lockNativeHead(connection, original);
                                return null;
                            });
        }
    }

    private void requireCsiHistoryOwner(JdbcCsiFilesRetirementGuard.Original original) {
        if (csiBindings == null) {
            throw conflict(
                    "csi_native_identity_unavailable",
                    "CSI history requires original encrypted Runtime identity");
        }
        jdbc.execute(
                (org.springframework.jdbc.core.ConnectionCallback<Void>)
                        connection -> {
                            var target =
                                    org.springframework.jdbc.datasource.DataSourceUtils
                                            .getTargetConnection(connection);
                            var binding =
                                    csiBindings.findByIdForUpdate(target, original.bindingId());
                            if (binding == null
                                    || !binding.getRequest().equals(original.request())
                                    || binding.getGeneration() != original.generation()
                                    || binding.getVersion() != original.version()) {
                                throw conflict(
                                        "csi_native_identity_unavailable",
                                        "Original execution bootstrap is unavailable");
                            }
                            WorkspaceCsiRuntimeIdentity.fileHistoryBoot(binding);
                            return null;
                        });
    }

    private HeadRow requireHeadForUpdate(String tenantId, String sessionId) {
        HeadRow head = findHeadForUpdate(tenantId, sessionId);
        if (head == null) {
            throw sessionNotFound();
        }
        return head;
    }

    private HeadRow requireHead(String tenantId, String sessionId) {
        List<HeadRow> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND"
                            + " tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                        headMapper,
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        if (rows.isEmpty()) {
            throw sessionNotFound();
        }
        return rows.get(0);
    }

    private TransactionRow findTransactionByCommand(String tenantId,
            String sessionId, String commandKeyHash) {
        List<TransactionRow> rows = jdbc.query(
                "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + " FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND command_key_hash = ?",
                transactionMapper, tenantId, sessionId, commandKeyHash);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private ResourceRow findResource(String scopeKey, String resourceId) {
        List<ResourceRow> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE resource_key = ? AND session_scope_key = ?"
                            + " AND resource_id = ? FOR UPDATE",
                        resourceMapper,
                        resourceKey(scopeKey, resourceId),
                        scopeKey,
                        resourceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static TransactionRow transactionRow(ResultSet result)
            throws SQLException {
        return new TransactionRow(result.getString("workspace_id"),
                result.getLong("journal_revision"),
                result.getString("transaction_id"),
                result.getString("operation"),
                result.getString("command_id"),
                result.getString("content_digest"),
                result.getLong("first_sequence"),
                result.getLong("last_sequence"),
                result.getInt("event_count"),
                result.getString("events_digest"),
                result.getString("previous_commit_digest"),
                result.getString("commit_digest"),
                result.getLong("writer_generation"),
                result.getString("writer_id"),
                result.getString("writer_token_hash"),
                result.getLong("activation_epoch"),
                result.getString("latest_checkpoint_resource_id"),
                result.getString("record_encoding"),
                result.getBytes("record_bytes"),
                result.getLong("byte_length"),
                result.getString("record_digest"));
    }

    private StoredTransaction storedTransaction(TransactionRow row) {
        if (!"identity".equals(row.recordEncoding())
                || row.recordBytes() == null
                || row.recordBytes().length != row.byteLength()
                || !sha256(row.recordBytes()).equals(row.recordDigest())) {
            throw journalCorrupt();
        }
        return new StoredTransaction(row.journalRevision(),
                row.transactionId(), row.operation(), row.commandId(),
                row.contentDigest(), row.firstSequence(),
                row.lastSequence(), row.eventCount(), row.eventsDigest(),
                row.previousCommitDigest(), row.commitDigest(),
                row.writerGeneration(), row.activationEpoch(),
                row.latestCheckpointResourceId(),
                row.recordEncoding(), Base64.getEncoder()
                        .encodeToString(row.recordBytes()),
                row.byteLength(), row.recordDigest());
    }

    /**
     * Whether a writer still holds the Session's journal under a lease that has not expired by
     * database time. A Harness renews that lease while it holds the Session and seals the writer
     * when it closes the Session.
     */
    @Transactional
    public boolean hasLiveWriter(String tenantId, String sessionId) {
        List<Timestamp> leases =
                jdbc.query(
                        "SELECT writer_lease_until FROM ma_session_head WHERE tenant_key = ? AND"
                            + " harness_key = ? AND tenant_id = ? AND session_id = ? AND state ="
                            + " 'ACTIVE' FOR UPDATE",
                        (result, row) -> ManagedSchemaTime.timestamp(result, "writer_lease_until"),
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        return !leases.isEmpty() && leases.getFirst() != null
                && leases.getFirst().after(databaseNow());
    }

    private Timestamp databaseNow() {
        Timestamp now = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW,
                (row, index) -> ManagedSchemaTime.timestamp(row, 1));
        if (now == null) {
            throw new IllegalStateException("Database time is unavailable");
        }
        return now;
    }

    private WriterGrant grant(HeadRow head, Timestamp leaseUntil,
            boolean replayed) {
        return new WriterGrant(head.writerGeneration(), epochMillis(leaseUntil),
                head.journalRevision(), head.committedSequence(),
                head.lastCommitDigest(), head.activationEpoch(), replayed);
    }

    private static long epochMillis(Timestamp timestamp) {
        return timestamp.getTime();
    }

    private static Timestamp plusMillis(Timestamp timestamp, long millis) {
        return Timestamp.from(timestamp.toInstant().plusMillis(millis));
    }

    private static Timestamp laterOf(Timestamp left, Timestamp right) {
        return left != null && left.after(right) ? left : right;
    }

    private static long increment(long value, String label) {
        if (value < 0
                || value >= ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw conflict("managed_session_counter_exhausted",
                    "The " + label + " cannot advance.");
        }
        return value + 1;
    }

    private static void validateScope(String tenantId, String workspaceId,
            String sessionId) {
        validateText(tenantId, "tenantId", 128);
        validateKeyComponent(workspaceId, "workspaceId");
        validateKeyComponent(sessionId, "sessionId");
    }

    private static void validateKeyComponent(String value, String label) {
        validateStableId(value, label);
        if (value.contains("/") || value.contains("\\")
                || value.chars().allMatch(character -> character == '.')) {
            throw invalid(label + " is not a safe key component.");
        }
    }

    private static void validateStableId(String value, String label) {
        validateText(value, label, MAX_ID_BYTES);
    }

    private static void validateText(String value, String label,
            int maxBytes) {
        if (!isValidText(value, maxBytes)) {
            throw invalid(label + " is invalid.");
        }
    }

    private static boolean isValidText(String value, int maxBytes) {
        if (value == null || value.isEmpty() || value.chars().anyMatch(character -> character < 32 || character == 127)) {
            return false;
        }
        try {
            return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(value).length <= maxBytes;
        } catch (IllegalArgumentException invalidUnicode) {
            return false;
        }
    }

    private static void validateDigest(String value, String label,
            boolean nullable) {
        if (value == null && nullable) {
            return;
        }
        if (value == null || !DIGEST.matcher(value).matches()) {
            throw invalid(label + " must be a lowercase SHA-256 digest.");
        }
    }

    private static byte[] decodeBase64(String value, int maxBytes,
            String label) {
        if (value == null) {
            throw invalid(label + " is required.");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(value);
        } catch (IllegalArgumentException error) {
            throw invalid(label + " is not valid Base64.");
        }
        if (decoded.length > maxBytes) {
            throw payloadTooLarge(label + " exceeds its byte limit.");
        }
        return decoded;
    }

    private void verifyStoredResource(ResourceRow resource) {
        if (resource.deletionOperation() != null
                || resource.captureState() != null && !"VERIFIED".equals(resource.captureState())
                || resource.resourceId().startsWith("capture-segment-")
                || resource.resourceId().startsWith("capture-seal-")) {
            throw resourceCorrupt();
        }
        if ("TOOL_PUBLICATION".equals(resource.storageKind())) {
            if (!"REFERENCED".equals(resource.state()) || resource.bytes() != null
                    || resource.objectKey() == null || resource.objectVersionId() != null
                    || resource.encryptionKeyId() != null
                    || !"managed-tool-outcome".equals(resource.kind())
                    || resource.byteLength() > 2L * 1024 * 1024) {
                throw resourceCorrupt();
            }
            Long matching =
                    jdbc.queryForObject(
                            "SELECT COUNT(*) FROM ma_output_capture p JOIN ma_resource o ON"
                                + " o.scope_key = p.scope_key AND o.publication_id ="
                                + " p.publication_id WHERE p.tenant_id = ? AND p.workspace_id = ?"
                                + " AND p.session_id = ? AND p.admission_resource_id = ? AND"
                                + " p.producer_phase IN ('FINISHED', 'REFERENCED') AND"
                                + " p.quarantined = FALSE AND o.slot_key = X'61646d697373696f6e'"
                                + " AND o.capture_state = 'VERIFIED' AND o.resource_id = ? AND"
                                + " o.capture_object_key = ? AND o.sha256 = ? AND o.byte_length ="
                                + " ?",
                            Long.class,
                            resource.tenantId(),
                            resource.workspaceId(),
                            resource.sessionId(),
                            resource.resourceId(),
                            resource.resourceId(),
                            resource.objectKey(),
                            resource.digest(),
                            resource.byteLength());
            if (matching == null || matching != 1) {
                throw resourceCorrupt();
            }
            return;
        }
        if (!"MYSQL_INLINE".equals(resource.storageKind())
                || !("REFERENCED".equals(resource.state())
                    || "PUBLISHED".equals(resource.state()) && resource.schemaVersion() == 1
                        && (resource.byteLength() > 0 && resource.byteLength() <= toolResultLimit(resource.kind())
                            || "managed-agent-instructions".equals(resource.kind())
                                && resource.byteLength() >= 0
                                && resource.byteLength() <= ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES
                            || "managed-agent-skills".equals(resource.kind())
                                && resource.byteLength() > 0
                                && resource.byteLength() <= ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES))
                || resource.bytes() == null
                || resource.objectKey() != null
                || resource.objectVersionId() != null
                || resource.encryptionKeyId() != null
                || resource.bytes().length != resource.byteLength()
                || !sha256(resource.bytes()).equals(resource.digest())) {
            throw resourceCorrupt();
        }
        if ("managed-tool-outcome".equals(resource.kind())) {
            Long quarantined = jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture"
                            + " WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?"
                            + " AND admission_resource_id = ? AND quarantined = TRUE",
                    Long.class, resource.tenantId(), resource.workspaceId(),
                    resource.sessionId(), resource.resourceId());
            if (quarantined != null && quarantined > 0) {
                throw resourceCorrupt();
            }
        }
    }

    private InputStream guardedPublicationResource(ResourceRow resource, ToolPublicationRetentionStore.ReadLease lease) {
        lease.requireScope(resource.tenantId(), resource.sessionId());
        var rows = jdbc.queryForList("SELECT scope_key, publication_id FROM ma_resource"
                + " WHERE scope_key = ? AND resource_id = ? AND object_key = ?",
                ToolPublicationDataStore.scope(resource.tenantId(), resource.workspaceId(), resource.sessionId()),
                resource.resourceId(), resource.objectKey());
        if (rows.size() != 1) {
            throw resourceCorrupt();
        }
        return outputRetention.open(resource.objectKey(), publicationObjects, lease, () -> {});
    }

    private byte[] readPublicationObject(ResourceRow resource, ToolPublicationRetentionStore.ReadLease lease) {
        if (publicationObjects == null) {
            throw resourceCorrupt();
        }
        try (InputStream stream = guardedPublicationResource(resource, lease)) {
            byte[] bytes = stream.readNBytes(Math.toIntExact(resource.byteLength()) + 1);
            if (bytes.length != resource.byteLength()
                    || !sha256(bytes).equals(resource.digest())) {
                var error = resourceCorrupt();
                try {
                    outputRetention.quarantineResource(
                            ToolPublicationDataStore.scope(resource.tenantId(), resource.workspaceId(), resource.sessionId()),
                            resource.resourceId(), resource.objectKey());
                } catch (RuntimeException cleanup) {
                    error.addSuppressed(cleanup);
                }
                throw error;
            }
            return bytes;
        } catch (IOException error) {
            throw new IllegalStateException("Tool publication object read failed", error);
        }
    }

    private static ManagedAgentException resourceCorrupt() {
        return new ManagedAgentException(HttpStatus.INTERNAL_SERVER_ERROR,
                "managed_session_resource_corrupt",
                "The Managed Session resource failed verification.");
    }

    private static void validateCounter(long value, String label,
            long minimum) {
        if (value < minimum
                || value > ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw invalid(label + " is outside its safe integer bound.");
        }
    }

    private static void validateLeaseMillis(Long leaseMillis) {
        if (leaseMillis == null
                || leaseMillis < ManagedSessionStoreModels.MIN_LEASE_MILLIS
                || leaseMillis > ManagedSessionStoreModels.MAX_LEASE_MILLIS) {
            throw invalid("leaseMillis is outside its bound.");
        }
    }

    private static void validateUtf8JsonLines(byte[] bytes,
            int expectedRecords) {
        try {
            StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes));
        } catch (CharacterCodingException error) {
            throw invalid("recordBytesBase64 is not valid UTF-8.");
        }
        int records = 0;
        int lineLength = 0;
        for (byte value : bytes) {
            if (value == '\n') {
                if (lineLength == 0) {
                    throw invalid("recordBytesBase64 contains a blank line.");
                }
                if (lineLength > ManagedSessionStoreModels.MAX_EVENT_BYTES) {
                    throw payloadTooLarge("A Managed Session record exceeds"
                            + " its byte limit.");
                }
                records++;
                lineLength = 0;
            } else {
                lineLength++;
            }
        }
        if (lineLength != 0 || records != expectedRecords) {
            throw invalid("recordBytesBase64 must end with a newline and"
                    + " match recordCount.");
        }
    }

    private static void requireHeadScope(HeadRow head, String tenantId,
            String workspaceId, String sessionId) {
        if (!tenantId.equals(head.tenantId())
                || !workspaceId.equals(head.workspaceId())
                || !sessionId.equals(head.sessionId())) {
            throw sessionNotFound();
        }
        if (head.storageVersion() < 1 || head.storageVersion() > ManagedSessionReaderVersion.SUPPORTED) {
            throw conflict("managed_session_storage_version_unsupported",
                    "The Managed Session storage version is unsupported.");
        }
        ManagedSessionReaderVersion.requireReadable(head.storageVersion());
        if (!HEAD_STATES.contains(head.state())
                || !RECOVERY_STATES.contains(head.recoveryStatus())
                || head.writerGeneration() < 1
                || head.writerGeneration()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.journalRevision() < 0
                || head.journalRevision()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.committedSequence() < 0
                || head.committedSequence()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.activationEpoch() < 0
                || head.activationEpoch()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.compactedThroughRevision() < 0
                || head.compactedThroughRevision()
                        > head.journalRevision()
                || head.lastCommitDigest() != null
                        && !DIGEST.matcher(head.lastCommitDigest()).matches()
                || head.latestCheckpointResourceId() != null
                        && !isValidText(head.latestCheckpointResourceId(),
                                MAX_ID_BYTES)
                || ("ACTIVE".equals(head.state())
                        || "SEALED".equals(head.state()))
                        && (!isValidText(head.writerId(), MAX_ID_BYTES)
                                || head.writerLeaseUntil() == null
                                || head.leaseTokenHash() == null
                                || !DIGEST.matcher(head.leaseTokenHash())
                                        .matches())) {
            throw headCorrupt();
        }
    }

    private static void requireResourceScope(ResourceRow resource,
            String tenantId, String workspaceId, String sessionId,
            String resourceId) {
        if (!tenantId.equals(resource.tenantId())
                || !workspaceId.equals(resource.workspaceId())
                || !sessionId.equals(resource.sessionId())
                || !resourceId.equals(resource.resourceId())) {
            throw sessionNotFound();
        }
    }

    private static void requireTransactionWorkspace(TransactionRow row,
            String workspaceId) {
        if (!workspaceId.equals(row.workspaceId())) {
            throw new ManagedAgentException(HttpStatus.INTERNAL_SERVER_ERROR,
                    ManagedSessionStoreModels.ERROR_JOURNAL_CORRUPT,
                    "The Managed Session transaction scope is corrupt.");
        }
    }

    private static String tokenHash(String writerToken) {
        if (writerToken == null
                || !WRITER_TOKEN.matcher(writerToken).matches()) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                    "invalid_writer_token",
                    ManagedSessionStoreModels.WRITER_TOKEN_HEADER
                            + " must contain 32-512 Base64URL characters.");
        }
        return sha256(writerToken.getBytes(StandardCharsets.UTF_8));
    }

    private void ensureSessionRoot(String tenantId, String sessionId) {
        // Take the root row exclusively first: ordinary writers lock it
        // without a tenant guard (#13800); keep that order before
        // initializing the session event stream.
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        long now = epochMillis(databaseNow());
        jdbc.update(
                "INSERT IGNORE INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id,"
                        + " gmt_modified) VALUES (?, ?, 'SESSION', X'', ?)",
                tenantId,
                sessionId,
                now);
    }

    public static String sessionScopeKey(String tenantId, String sessionId) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(tenantId, sessionId);
    }

    public static String resourceKey(String scopeKey, String resourceId) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(scopeKey, resourceId);
    }

    static String commandKeyHash(String operation,
            String commandId) {
        return sha256((operation + "\u0000" + commandId)
                .getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(byte[] value) {
        return DigestUtils.sha256Hex(value);
    }

    private static boolean secureEquals(String left, String right) {
        return left != null && right != null && MessageDigest.isEqual(
                left.getBytes(StandardCharsets.US_ASCII),
                right.getBytes(StandardCharsets.US_ASCII));
    }

    private static ManagedAgentException sessionNotFound() {
        return new ManagedAgentException(HttpStatus.NOT_FOUND,
                "managed_session_not_found",
                "The Managed Session does not exist.");
    }

    private static ManagedAgentException writerConflict() {
        return conflict(ManagedSessionStoreModels.ERROR_WRITER_CONFLICT,
                "The Managed Session writer grant is stale or unavailable.");
    }

    // Package-private: ToolPublicationStore's evidence reads answer a
    // damaged journal with the same fault the session store raises.
    static ManagedAgentException journalCorrupt() {
        return new ManagedAgentException(HttpStatus.INTERNAL_SERVER_ERROR,
                ManagedSessionStoreModels.ERROR_JOURNAL_CORRUPT,
                "The Managed Session transaction failed verification.");
    }

    private static ManagedAgentException headCorrupt() {
        return new ManagedAgentException(HttpStatus.INTERNAL_SERVER_ERROR,
                ManagedSessionStoreModels.ERROR_HEAD_CORRUPT,
                "The Managed Session head failed verification.");
    }

    private static ManagedAgentException invalid(String message) {
        return new ManagedAgentException(HttpStatus.BAD_REQUEST,
                ManagedSessionStoreModels.ERROR_INVALID_REQUEST, message);
    }

    private static ManagedAgentException payloadTooLarge(String message) {
        return new ManagedAgentException(HttpStatus.PAYLOAD_TOO_LARGE,
                ManagedSessionStoreModels.ERROR_PAYLOAD_TOO_LARGE, message);
    }

    private static ManagedAgentException conflict(String code, String message) {
        return new ManagedAgentException(HttpStatus.CONFLICT, code, message);
    }

    private record HeadRow(String tenantId, String workspaceId,
            String sessionId, String state, int storageVersion,
            long writerGeneration, String writerId,
            Timestamp writerLeaseUntil, String leaseTokenHash,
            long journalRevision, long committedSequence,
            String lastCommitDigest, long activationEpoch,
            String latestCheckpointResourceId,
            long compactedThroughRevision, String recoveryStatus,
            String recoveryDetailCode, String activationId,
            String activationPhase, Long activationEventEpoch,
            Long activationExpiresAt, Long activationHeadRevision) {
    }

    private record TransactionRow(String workspaceId, long journalRevision,
            String transactionId, String operation, String commandId,
            String contentDigest, long firstSequence, long lastSequence,
            int eventCount, String eventsDigest,
            String previousCommitDigest, String commitDigest,
            long writerGeneration, String writerId, String writerTokenHash,
            long activationEpoch, String latestCheckpointResourceId,
            String recordEncoding, byte[] recordBytes, long byteLength,
            String recordDigest) {
    }

    private record ActivationChange(String id, String phase, long epoch,
            Long expiresAt) {
    }

    private record TransactionSize(long journalRevision, long byteLength) {
    }

    private record ResourceRow(String tenantId, String workspaceId,
            String sessionId, String resourceId, String kind,
            int schemaVersion, long byteLength, String digest,
            String storageKind, byte[] bytes, String objectKey,
            String objectVersionId, String encryptionKeyId, String state, String captureState, String deletionOperation) {
    }

    private record ValidatedResource(CommitResource resource, byte[] bytes) {
    }

    private record ValidatedCommit(byte[] recordBytes, String recordDigest,
            List<ValidatedResource> resources) {
    }
}
