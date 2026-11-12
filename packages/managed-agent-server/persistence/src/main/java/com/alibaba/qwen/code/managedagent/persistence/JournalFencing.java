package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceLifecycleStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.function.Supplier;
import java.util.regex.Pattern;

final class JournalFencing {
    private final JournalStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final JournalEventTransport journalEventTransport;
    private final WriterCredentialPolicy credentials;
    private final JdbcRuntimeBindingRepository csiBindings;
    private final JdbcJournalPacks packs;

    JournalFencing(JournalStoreRows storeRows,
            JdbcTemplate jdbc,
            JournalEventTransport journalEventTransport,
            WriterCredentialPolicy credentials,
            JdbcRuntimeBindingRepository csiBindings,
            JdbcJournalPacks packs) {
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.journalEventTransport = journalEventTransport;
        this.credentials = credentials;
        this.csiBindings = csiBindings;
        this.packs = packs;
    }

    // Hot paths touch the tenant-wide guard rows only on admission, and
    // never wait on them past this per-statement bound: a held row degrades
    // to a named, retryable failure instead of out-waiting the caller's own
    // request budget (#13800).
    static final int GUARD_ACQUIRE_TIMEOUT_SECONDS = 5;

    static final Pattern WRITER_TOKEN = Pattern.compile(
            "^[A-Za-z0-9_-]{"
                    + ManagedSessionStoreModels.MIN_WRITER_TOKEN_LENGTH + ","
                    + ManagedSessionStoreModels.MAX_WRITER_TOKEN_LENGTH + "}$");

    void checkLifecycleWriter(String tenantId, String sessionId,
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
        lockBounded(() -> JdbcWorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        JdbcWorkspaceLifecycleStore.requireClaim(jdbc, tenantId, sessionId, authority, true);
    }

    static ManagedAgentException guardContended() {
        return new ManagedAgentException(503,
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

    static boolean deadlockVictim(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.sql.SQLException sql && sql.getErrorCode() == 1213) {
                return true;
            }
        }
        return false;
    }

    void lockPlacementBounded(String tenantId) {
        // Placement is the tenant-wide row migration admission shares; on
        // these per-turn paths it stays bounded with the shared named-failure
        // mapping, so a held row answers tenant_guard_contended instead of
        // out-waiting the caller (#13800).
        lockBounded(() -> JdbcWorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                GUARD_ACQUIRE_TIMEOUT_SECONDS));
    }

    // The fence check: locking reads of the storage's alias and directory
    // rows. Every caller takes them after its Session row and before the
    // head row, the order Turn admission, Session commands and journal
    // commits use without the tenant guard; taking them before the Session
    // row would close a cycle with those lanes on the same Session.
    void requireSessionStorageOpen(String tenantId, String workspaceId, String sessionId) {
        WorkspaceMigrationAdmission.requirePhysicalOpen(jdbc, tenantId,
                WorkspaceMigrationAdmission.sessionStorage(jdbc, tenantId, sessionId, workspaceId));
    }

    void requireSessionStorageOpenForRead(String tenantId, String workspaceId, String sessionId) {
        WorkspaceMigrationAdmission.requirePhysicalOpenForRead(jdbc, tenantId,
                WorkspaceMigrationAdmission.sessionStorage(jdbc, tenantId, sessionId, workspaceId));
    }

    // Locks the Session root by primary key (a record lock, never a gap) as
    // the transaction's first statement and answers its CSI pin, which never
    // changes once the row exists, for lockCsiContinuation to reuse instead
    // of locking the root a second time. Outside a transaction the lock would
    // be released at once, so nothing is taken and null is answered;
    // lockCsiContinuation then keeps its standalone check.
    Boolean lockSessionFirst(String tenantId, String sessionId) {
        return transactional() ? ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId) : null;
    }

    private boolean transactional() {
        Boolean transactional = jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Boolean>) connection -> {
            var target = org.springframework.jdbc.datasource.DataSourceUtils.getTargetConnection(connection);
            return !target.getAutoCommit() && org.springframework.jdbc.datasource.DataSourceUtils
                    .isConnectionTransactional(target, jdbc.getDataSource());
        });
        return Boolean.TRUE.equals(transactional);
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
    void requireNoLifecycleClaim(String tenantId, String sessionId) {
        if (!jdbc.queryForList("SELECT operation_id FROM ma_operation WHERE scope_key = ?"
                + " AND operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE') AND tenant_id = ? AND session_id = ?"
                + " AND lifecycle_protocol_version = 2", ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId).isEmpty()) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_claim_fenced");
        }
    }

    void requireOrdinaryAdmission(String tenantId, String sessionId) {
        requireNoLifecycleClaim(tenantId, sessionId);
        if (lifecycleFenced(tenantId, sessionId)) {
            throw JournalStoreRows.conflict(
                    "managed_session_lifecycle_active", "Ordinary execution admission is closed.");
        }
    }

    boolean lifecycleFenced(String tenantId, String sessionId) {
        return !jdbc.queryForList(
                        "SELECT phase FROM ma_session_head WHERE phase <> 'OPEN' AND tenant_key = ?"
                            + " AND harness_key = ? AND tenant_id = ? AND harness_session_id = ?"
                            + " FOR UPDATE",
                        RuntimeAdmissionFences.harnessDrainKey(tenantId),
                        RuntimeAdmissionFences.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId)
                .isEmpty();
    }

    boolean lifecycleProtocolFenced(String tenantId, String sessionId) {
        return !jdbc.queryForList(
                        "SELECT operation_id FROM ma_session_head WHERE tenant_key = ? AND"
                            + " harness_key = ? AND tenant_id = ? AND harness_session_id = ? AND"
                            + " operation_id IS NOT NULL FOR UPDATE",
                        RuntimeAdmissionFences.harnessDrainKey(tenantId),
                        RuntimeAdmissionFences.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId)
                .isEmpty();
    }

    // A bound credential is checked before any state lookup so a foreign
    // token never learns whether a Session exists.
    void requireCredential(String tenantId, String workspaceId,
            String sessionId, String writerToken) {
        credentials.require(tenantId, workspaceId, sessionId, writerToken);
    }

    JdbcHarnessPlacementStore.Placement requirePlacement(String tenant, String workspace,
            String session, String token, String writer, boolean newWork) {
        return JdbcHarnessPlacementStore.requireCurrent(jdbc, credentials, tenant, workspace, session, token, writer, newWork);
    }

    static ManagedAgentException nativeReadConflict() {
        return JournalStoreRows.conflict(
                "csi_resource_read_conflict",
                "The original resource read identity is unavailable.");
    }

    void requireCsiApplicationCredential(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Authority authority,
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
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(scope.getTenantId(), session);
        storeRows.requireHeadScope(head, scope.getTenantId(), scope.getWorkspaceId(), session);
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

    void requireWriter(JournalStoreRows.HeadRow head, String writerId,
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

    void requireReadGrant(JournalStoreRows.HeadRow head, String writerToken) {
        ToolPublicationRetentionStore.requireLive(jdbc, head.tenantId(), head.sessionId());
        Timestamp now = storeRows.databaseNow();
        if (!"ACTIVE".equals(head.state())
                || !secureEquals(tokenHash(writerToken),
                        head.leaseTokenHash())
                || head.writerLeaseUntil() == null
                || !head.writerLeaseUntil().after(now)) {
            throw writerConflict();
        }
    }

    JournalStoreRows.HeadRow requireHeadAfterCsiCheck(String tenantId, String sessionId) {
        // A null continuation proves nothing in standalone mode. Only the CSI check
        // on this DataSource's transaction connection has retained the root lock.
        return transactional()
                ? storeRows.requireHeadWithRootLocked(tenantId, sessionId)
                : storeRows.requireHeadForUpdate(tenantId, sessionId);
    }

    JdbcCsiFilesRetirementGuard.Original lockCsiOriginal(String tenantId, String sessionId) {
        var continuation = lockCsiContinuation(tenantId, sessionId);
        return continuation == null ? null : continuation.original();
    }

    CsiContinuation lockCsiContinuation(String tenantId, String sessionId) {
        return lockCsiContinuation(tenantId, sessionId, null);
    }

    // rootPin: the pin lockSessionFirst read under its root lock, or null
    // when this transaction has not locked the root yet.
    CsiContinuation lockCsiContinuation(String tenantId, String sessionId, Boolean rootPin) {
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
                                                "SELECT is_csi_guard FROM ma_session WHERE tenant_id ="
                                                    + " ? AND session_id = ? AND is_csi_guard = TRUE",
                                                (row, index) -> row.getBoolean("is_csi_guard"),
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
                            // first, by unique business key once it exists, so its pin
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
                            boolean rootPinned = rootPin != null ? rootPin
                                    : ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
                            return rootPinned
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
        lockBounded(() -> JdbcWorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
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
                                            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationProgress.lock(target, original));
                        });
    }

    void requireCsiJournalIsolation() {
        if (journalEventTransport != null) {
            throw JournalStoreRows.conflict("csi_journal_transport_unsupported",
                    "The private CSI lane requires an isolated journal without an event transport.");
        }
    }

    void requireCsiCurrentTime(CsiContinuation continuation) {
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

    void requireCsiLease(
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

    void requireCsiWriterCurrent(
            CsiContinuation continuation,
            JournalStoreRows.HeadRow head,
            String writerId,
            long generation,
            String token) {
        if (continuation != null) {
            requireCsiLease(
                    continuation,
                    JournalStoreRows.epochMillis(head.writerLeaseUntil()),
                    JournalStoreRows.epochMillis(head.writerLeaseUntil()));
            requireWriter(head, writerId, generation, token, storeRows.databaseNow(), true);
        }
    }

    void requireCsiReadGrant(CsiContinuation continuation, JournalStoreRows.HeadRow head, String token) {
        requireReadGrant(head, token);
        requireCsiLease(
                continuation,
                JournalStoreRows.epochMillis(head.writerLeaseUntil()),
                JournalStoreRows.epochMillis(head.writerLeaseUntil()));
    }

    record CsiContinuation(
            JdbcCsiFilesRetirementGuard.Original original,
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationProgress.Continuation progress) {}

    static void requireCsiWriter(
            JdbcCsiFilesRetirementGuard.Original original, JournalStoreRows.HeadRow head) {
        if (original != null && head.writerGeneration() < 1) {
            throw JournalStoreRows.conflict(
                    "csi_original_writer_unavailable",
                    "The original CSI writer cannot be replaced.");
        }
    }

    void requireInstalledCsiWriter(JdbcCsiFilesRetirementGuard.Original original) {
        if (original != null) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                JdbcCsiActivationAdmission.lockNativeHead(connection, original, packs);
                                return null;
                            });
        }
    }

    void requireCsiHistoryOwner(JdbcCsiFilesRetirementGuard.Original original) {
        if (csiBindings == null) {
            throw JournalStoreRows.conflict(
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
                                throw JournalStoreRows.conflict(
                                        "csi_native_identity_unavailable",
                                        "Original execution bootstrap is unavailable");
                            }
                            WorkspaceCsiRuntimeIdentity.fileHistoryBoot(binding);
                            return null;
                        });
    }

    static String tokenHash(String writerToken) {
        if (writerToken == null
                || !WRITER_TOKEN.matcher(writerToken).matches()) {
            throw new ManagedAgentException(400,
                    "invalid_writer_token",
                    ManagedSessionStoreModels.WRITER_TOKEN_HEADER
                            + " must contain 32-512 Base64URL characters.");
        }
        return JournalStoreRows.sha256(writerToken.getBytes(StandardCharsets.UTF_8));
    }

    static boolean secureEquals(String left, String right) {
        return left != null && right != null && MessageDigest.isEqual(
                left.getBytes(StandardCharsets.US_ASCII),
                right.getBytes(StandardCharsets.US_ASCII));
    }

    static ManagedAgentException writerConflict() {
        return JournalStoreRows.conflict(ManagedSessionStoreModels.ERROR_WRITER_CONFLICT,
                "The Managed Session writer grant is stale or unavailable.");
    }
}
