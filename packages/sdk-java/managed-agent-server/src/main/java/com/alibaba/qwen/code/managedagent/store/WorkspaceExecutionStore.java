package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Repository
public class WorkspaceExecutionStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard storageGuard;

    @Autowired
    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, WorkspaceStorageGuard storageGuard) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        this.storageGuard = storageGuard;
    }

    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        // Offline saved-owner cleanup must not require the current mount.
        this.storageGuard = null;
    }

    public boolean verifiedRecoveryEnabled() {
        return storageGuard != null && storageGuard.enabled();
    }

    public void authorize(SessionRecord session) {
        authorizePassiveAttachment(session);
        if (storageGuard != null) {
            storageGuard.verify(session.workspace());
        }
    }

    public void authorizeLifecycle(SessionRecord session, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        try {
            WorkspaceLifecycleStore.requireClaim(jdbc, session.tenantId(), session.sessionId(), authority, false);
        } catch (ApiException error) {
            throw new RuntimeBrokerException(error.getStatus().value(), error.getCode(), error.getMessage(), false, error);
        }
        authorizePassiveAttachment(session, authority);
        if (storageGuard != null) {
            storageGuard.verify(session.workspace());
        }
    }

    public void authorizeLegacyClose(SessionRecord session) {
        if (!WorkspaceLifecycleStore.legacyClose(jdbc, session.tenantId(), session.sessionId())) {
            throw unavailable();
        }
        authorizePassiveAttachment(session, null, true);
        if (storageGuard != null) {
            storageGuard.verify(session.workspace());
        }
    }

    // The mount guard of an execution authority, without the Session-level
    // checks; the W2 settlement probe must not fail a Session it only
    // reads. It uses the guard's probe-only entry: momentary I/O failures
    // classify retryable-with-cause, structural refusals keep the terminal
    // verdict, and the shared acquire path (claim/assertHeld) is untouched.
    public void verifyMountForProbe(ContextBinding binding) {
        if (storageGuard != null) {
            storageGuard.verifyProbe(binding);
        }
    }

    public void authorizePassiveAttachment(SessionRecord session) {
        authorizeAttachment(session, false, false, null, false);
    }

    private void authorizePassiveAttachment(SessionRecord session,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        authorizeAttachment(session, false, false, authority, false);
    }

    private void authorizePassiveAttachment(SessionRecord session,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority, boolean legacyClose) {
        authorizeAttachment(session, false, false, authority, legacyClose);
    }

    public void authorizeCancellation(SessionRecord session) {
        authorizeAttachment(session, true, false, null, false);
    }

    /**
     * H4f × H4d-b: the attachment that carries a stopped run's message
     * stop. Like a persisted cancellation it was authorized when the stop
     * request committed on the parent, which its caller (the child result
     * relay) has read, so it needs no CANCELLING Turn (message work never
     * makes one) and no operator-mutable grant: only the Session's own
     * structural binding is checked.
     */
    public void authorizeCommittedStop(SessionRecord session) {
        authorizeAttachment(session, false, false, null, false, true);
    }

    // Action-response delivery only: a refusal stemming solely from
    // operator-mutable grants or registry state must not certify the
    // terminal verdict, so it answers with the retryable variant instead.
    public void authorizeActionResponse(SessionRecord session) {
        authorizeAttachment(session, false, true, null, false);
    }

    private void authorizeAttachment(SessionRecord session, boolean cancellation,
            boolean actionResponse, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority,
            boolean legacyClose) {
        authorizeAttachment(session, cancellation, actionResponse, authority,
                legacyClose, false);
    }

    private void authorizeAttachment(SessionRecord session, boolean cancellation,
            boolean actionResponse, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority,
            boolean legacyClose, boolean committedStop) {
        ContextBinding binding = session.workspace();
        String expectedStatus = authority == null && !legacyClose ? "ACTIVE" : session.status();
        if (binding == null || !(legacyClose ? "CLOSING".equals(session.status()) : authority == null ? "ACTIVE".equals(session.status())
                : java.util.List.of("CLOSING", "DELETING").contains(session.status()))
                || session.deletedAt() != null || !"qwen-code".equals(session.agentId())
                || !session.tenantId().equals(binding.getTenantId())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw unavailable();
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        // Verdicts per matched row: 0 structural mismatch, 1 refused only by
        // operator-mutable grant or registry state, 2 authorized.
        List<Integer> grants = jdbc.query("SELECT s.tenant_id, s.session_id,"
                + " s.agent_id AS session_agent, s.status AS session_status,"
                + " s.deleted_at AS session_deleted_at,"
                + " s.workspace_id AS session_workspace,"
                + " s.workspace_generation AS session_generation,"
                + " s.workspace_storage_id AS session_storage,"
                + " s.cwd_relative AS session_cwd,"
                + " s.context_config_ref AS session_context,"
                + " s.context_revision AS session_revision,"
                + " s.workspace_config_ref, s.workspace_policy_ref"
                + (cancellation
                        ? ", t.tenant_id AS cancellation_tenant, t.session_id AS cancellation_session"
                        : committedStop ? ""
                        : ", r.tenant_id AS registry_tenant, r.workspace_id,"
                + " r.workspace_generation, r.storage_id, r.state,"
                + " c.tenant_id AS command_tenant, c.session_id AS command_session,"
                + " a.tenant_id AS access_tenant, a.workspace_id AS access_workspace,"
                + " a.role")
                + " FROM managed_agent_session s"
                + (cancellation
                        ? " JOIN managed_agent_turn t ON t.tenant_id = s.tenant_id"
                                + " AND t.session_id = s.session_id AND t.status = 'CANCELLING'"
                                + " AND (t.submission_attempted = TRUE OR t.harness_event_epoch IS NOT NULL)"
                        : committedStop ? ""
                        : " JOIN managed_workspace_registry r ON r.tenant_id = s.tenant_id"
                + " AND r.workspace_id = s.workspace_id"
                + " JOIN managed_workspace_create_command c ON c.tenant_id = s.tenant_id"
                + " AND c.session_id = s.session_id"
                + " JOIN managed_workspace_access a ON a.tenant_id = r.tenant_id"
                + " AND a.workspace_id = r.workspace_id AND a.actor_id = c.actor_id"
                + " AND a.role IN ('READER', 'OPERATOR', 'OWNER')")
                + " WHERE s.tenant_id = ? AND s.session_id = ?",
                (row, index) -> {
                    boolean structural = session.tenantId().equals(row.getString("tenant_id"))
                            && session.sessionId().equals(row.getString("session_id"))
                            && "qwen-code".equals(row.getString("session_agent"))
                            && expectedStatus.equals(row.getString("session_status"))
                            && row.getObject("session_deleted_at") == null
                            && binding.getWorkspaceId().equals(row.getString("session_workspace"))
                            && binding.getWorkspaceGeneration() == row.getLong("session_generation")
                            && binding.getStorageId().equals(row.getString("session_storage"))
                            && binding.getCwdRelative().equals(row.getString("session_cwd"))
                            && binding.getContextConfigRef().equals(row.getString("session_context"))
                            && binding.getContextRevision() == row.getLong("session_revision")
                            && WorkspaceExecutionProfile.CONFIG_REF.equals(
                                    row.getString("workspace_config_ref"))
                            && WorkspaceExecutionProfile.POLICY_REF.equals(
                                    row.getString("workspace_policy_ref"))
                            // Cancellation was authorized when it was persisted;
                            // retries must not depend on mutable creation grants.
                            && (cancellation
                                    ? session.tenantId().equals(row.getString("cancellation_tenant"))
                                            && session.sessionId().equals(row.getString("cancellation_session"))
                                    : committedStop
                                    || session.tenantId().equals(row.getString("registry_tenant"))
                            && session.tenantId().equals(row.getString("command_tenant"))
                            && session.sessionId().equals(row.getString("command_session"))
                            && session.tenantId().equals(row.getString("access_tenant"))
                            && binding.getWorkspaceId().equals(row.getString("workspace_id"))
                            && binding.getWorkspaceId().equals(row.getString("access_workspace"))
                            && binding.getWorkspaceGeneration() == row.getLong("workspace_generation")
                            && binding.getStorageId().equals(row.getString("storage_id")));
                    if (!structural) {
                        return 0;
                    }
                    // Grants and registry state are operator-mutable: a
                    // refusal stemming only from them is not the structural
                    // verdict the terminal exit promises.
                    return cancellation || committedStop
                            || ("ACTIVE".equals(row.getString("state"))
                                    && WorkspaceAccess.valueOf(row.getString("role"))
                                            .atLeast(WorkspaceAccess.OPERATOR))
                            ? 2 : 1;
                },
                session.tenantId(), session.sessionId());
        if (grants.size() != 1) {
            throw unavailable();
        }
        if (grants.getFirst() == 1) {
            throw actionResponse ? unavailablePendingGrant() : unavailable();
        }
        if (grants.getFirst() != 2) {
            throw unavailable();
        }
    }

    public void claim(ContextBinding binding, RuntimeSessionRecord session) {
        WorkspaceStorageKindGuard.requireFreshTransaction();
        String key = storageKey(binding);
        String holder = holderKey(session);
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
            List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state, drain_requested,"
                    + " tenant_id, workspace_id, workspace_generation, storage_id FROM qwen_runtime_binding"
                    + " WHERE binding_id = ? FOR UPDATE", (row, index) ->
                            session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && "READY".equals(row.getString("binding_state")) && !row.getBoolean("drain_requested")
                            && binding.getTenantId().equals(row.getString("tenant_id"))
                            && binding.getWorkspaceId().equals(row.getString("workspace_id"))
                            && Long.toString(binding.getWorkspaceGeneration()).equals(row.getString("workspace_generation"))
                            && binding.getStorageId().equals(row.getString("storage_id")), session.getBindingId());
            if (live.size() != 1 || !live.getFirst()) {
                throw unavailable();
            }
            List<Boolean> active = jdbc.query("SELECT binding_id, runtime_generation, runtime_session_id,"
                    + " harness_session_id, session_state FROM qwen_runtime_session"
                    + " WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_id = ? FOR UPDATE",
                    (row, index) -> session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && session.getRuntimeSessionId().equals(row.getString("runtime_session_id"))
                            && session.getSession().getHarnessSessionId().equals(row.getString("harness_session_id"))
                            && ("ACQUIRING".equals(row.getString("session_state"))
                                    || "READY".equals(row.getString("session_state"))),
                    session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId());
            if (active.size() != 1 || !active.getFirst()) {
                throw unavailable();
            }
            jdbc.update("INSERT INTO managed_workspace_execution_lease"
                    + " (storage_key, storage_kind) VALUES (?, 'LOCAL') ON DUPLICATE KEY UPDATE"
                    + " storage_key = storage_key", key);
            String current = jdbc.queryForObject("SELECT holder_key FROM"
                    + " managed_workspace_execution_lease WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE",
                    String.class, key);
            if (storageGuard != null) {
                storageGuard.verifyLocked(binding);
            }
            if (current != null && !holder.equals(current)) {
                throw busy();
            }
            jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = ?,"
                    + " binding_id = ?, runtime_generation = ?, runtime_session_id = ?"
                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL'", holder, session.getBindingId(),
                    session.getRuntimeGeneration(), session.getRuntimeSessionId(), key);
        });
    }

    public void assertHeld(ContextBinding binding, RuntimeSessionRecord session) {
        if (storageGuard != null) {
            storageGuard.verify(binding);
        }
        if (!isHeld(binding, session)) {
            throw busy();
        }
    }

    public boolean isHeld(ContextBinding binding, RuntimeSessionRecord session) {
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        List<String> holders = jdbc.queryForList("SELECT holder_key FROM"
                + " managed_workspace_execution_lease WHERE storage_key = ? AND storage_kind = 'LOCAL'",
                String.class, storageKey(binding));
        return holders.size() == 1 && holderKey(session).equals(holders.getFirst());
    }

    public void release(ContextBinding binding, RuntimeSessionRecord session) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
            List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state"
                    + " FROM qwen_runtime_binding WHERE binding_id = ? FOR UPDATE",
                    (row, index) -> session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && ("READY".equals(row.getString("binding_state"))
                                    || "DRAINING".equals(row.getString("binding_state"))),
                    session.getBindingId());
            if (live.size() != 1 || !live.getFirst()) {
                throw unavailable();
            }
            jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL,"
                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL"
                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL' AND holder_key = ?",
                    storageKey(binding), holderKey(session));
        });
    }

    /**
     * The child Workspace maintenance holder (#13753 I1): a physical step
     * of a child Workspace holds the storage exactly as a tool turn does,
     * so a turn meets it as workspace_busy and polls, while W1a fence and
     * registration, which need an idle lease, refuse. The Runtime holder
     * columns stay null and maintenance_id names the child Workspace. The
     * hold belongs to the child Workspace's current claim generation: a
     * newer generation takes it over, an older one is refused, and a hold
     * whose claim has since expired is freed by
     * {@link #releaseStaleMaintenance}.
     */
    public void holdForMaintenance(ContextBinding binding, String maintenanceId,
            long claimGeneration) {
        WorkspaceStorageKindGuard.requireFreshTransaction();
        String key = storageKey(binding);
        String holder = maintenanceHolderKey(maintenanceId, claimGeneration);
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
            List<Long> generations = jdbc.queryForList("SELECT claim_generation FROM"
                    + " qwen_managed_child_workspace WHERE child_workspace_id = ? FOR UPDATE",
                    Long.class, maintenanceId);
            if (generations.size() != 1 || generations.getFirst() != claimGeneration) {
                throw unavailable();
            }
            jdbc.update("INSERT INTO managed_workspace_execution_lease"
                    + " (storage_key, storage_kind) VALUES (?, 'LOCAL') ON DUPLICATE KEY UPDATE"
                    + " storage_key = storage_key", key);
            List<String[]> rows = jdbc.query("SELECT holder_key, maintenance_id FROM"
                    + " managed_workspace_execution_lease WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE",
                    (row, index) -> new String[] {row.getString("holder_key"), row.getString("maintenance_id")},
                    key);
            if (rows.size() != 1) {
                throw unavailable();
            }
            if (storageGuard != null) {
                storageGuard.verifyLocked(binding);
            }
            String current = rows.getFirst()[0];
            if (current != null && !holder.equals(current)
                    && !maintenanceId.equals(rows.getFirst()[1])) {
                throw busy();
            }
            jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = ?,"
                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL,"
                    + " maintenance_id = ? WHERE storage_key = ? AND storage_kind = 'LOCAL'",
                    holder, maintenanceId, key);
        });
    }

    /** The child Workspace states a physical step runs in, and that a scan resumes. */
    private static final java.util.Set<String> RESUMABLE_STATES = java.util.Set.of(ChildWorkspaceStore.PREPARING,
            ChildWorkspaceStore.MERGING, ChildWorkspaceStore.APPLYING, ChildWorkspaceStore.APPLIED,
            ChildWorkspaceStore.DISCARDING);

    /** Releases a maintenance hold, and only the one this claim took. */
    public void releaseMaintenance(ContextBinding binding, String maintenanceId,
            long claimGeneration) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL,"
                    + " maintenance_id = NULL WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                    + " AND holder_key = ? AND maintenance_id = ?", storageKey(binding),
                    maintenanceHolderKey(maintenanceId, claimGeneration), maintenanceId);
        });
    }

    /**
     * Clears the maintenance holds no step owns any more: their child
     * Workspace has no live claim, because the worker died (or failed to
     * release) after its last step. A live step renews its claim, so the
     * hold of any step still going is never touched. A hold whose child
     * Workspace is still in a step's state waits {@code resumableGraceMillis}
     * past its claim (forever with {@code Long.MAX_VALUE}): a scan that
     * resumes the row lets its new claimant take the hold over without a
     * gap.
     */
    public int releaseStaleMaintenance(long now, long resumableGraceMillis) {
        // Every maintenance hold is a candidate; the claim is judged once,
        // under the child Workspace's row lock, so a claim taken meanwhile
        // keeps its hold.
        List<String[]> holds = jdbc.query("SELECT w.tenant_id, l.storage_key, l.maintenance_id"
                + " FROM managed_workspace_execution_lease l JOIN qwen_managed_child_workspace w"
                + " ON w.child_workspace_id = l.maintenance_id WHERE l.maintenance_id IS NOT NULL",
                (row, index) -> new String[] {row.getString(1), row.getString(2), row.getString(3)});
        int released = 0;
        for (String[] hold : holds) {
            Integer cleared = transaction.execute(status -> {
                WorkspaceStorageKindGuard.lockDomain(jdbc, hold[0]);
                List<Boolean> unclaimed = jdbc.query("SELECT claimed_until, state FROM qwen_managed_child_workspace"
                        + " WHERE child_workspace_id = ? FOR UPDATE", (row, index) -> {
                            long until = row.getLong(1);
                            if (row.wasNull()) {
                                return true;
                            }
                            if (!RESUMABLE_STATES.contains(row.getString(2))) {
                                return until <= now;
                            }
                            return resumableGraceMillis != Long.MAX_VALUE
                                    && until <= now - resumableGraceMillis;
                        }, hold[2]);
                if (unclaimed.size() != 1 || !unclaimed.getFirst()) {
                    return 0;
                }
                return jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL,"
                        + " maintenance_id = NULL WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                        + " AND maintenance_id = ?", hold[1], hold[2]);
            });
            released += cleared == null ? 0 : cleared;
        }
        return released;
    }

    public boolean hasHolder(RuntimeBindingRecord saved) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease"
                + " WHERE binding_id = ? AND runtime_generation = ? AND holder_key IS NOT NULL",
                Integer.class, saved.getBindingId(), saved.getGeneration());
        return count != null && count > 0;
    }

    public void releaseLost(RuntimeBindingRecord saved) {
        if (!saved.getRequest().isManagedContext() || saved.getState() != RuntimeBindingRecord.State.LOST
                || !saved.hasStoppedWriters() || saved.getOperationOwner() == null) {
            throw unavailable();
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, saved.getRequest().getScope().getTenantId());
            List<Boolean> exact = jdbc.query("SELECT binding_id, runtime_generation, binding_state, tenant_id,"
                    + " workspace_id, storage_id, record_version, operation_owner, operation_generation,"
                    + " operation_lease_until, loss_evidence_json, stop_evidence_json, UNIX_TIMESTAMP() AS db_seconds,"
                    + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) AS db_micros"
                    + " FROM qwen_runtime_binding WHERE binding_id = ? FOR UPDATE", (row, index) ->
                            saved.getBindingId().equals(row.getString("binding_id"))
                            && saved.getGeneration() == row.getLong("runtime_generation")
                            && "LOST".equals(row.getString("binding_state"))
                            && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                            && saved.getRequest().getScope().getWorkspaceId().equals(row.getString("workspace_id"))
                            && saved.getRequest().getStorageId().equals(row.getString("storage_id"))
                            && saved.getVersion() == row.getLong("record_version")
                            && saved.getOperationOwner().equals(row.getString("operation_owner"))
                            && saved.getOperationGeneration() == row.getLong("operation_generation")
                            && row.getTimestamp("operation_lease_until") != null
                            && row.getTimestamp("operation_lease_until", java.util.Calendar.getInstance(
                                    java.util.TimeZone.getTimeZone("UTC"))).toInstant().isAfter(java.time.Instant.ofEpochSecond(
                                            row.getLong("db_seconds"), row.getLong("db_micros") * 1000))
                            && row.getString("loss_evidence_json") != null && row.getString("stop_evidence_json") != null,
                    saved.getBindingId());
            if (exact.size() != 1 || !exact.getFirst()
                    || jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE binding_id = ?"
                            + " AND runtime_generation = ? AND execution_state NOT IN ('SETTLED', 'ABANDONED')",
                            Long.class, saved.getBindingId(), saved.getGeneration()) != 0) {
                throw unavailable();
            }
            String key = digest(saved.getRequest().getScope().getTenantId() + "\u0000" + saved.getRequest().getStorageId());
            jdbc.query("SELECT holder_key, binding_id, runtime_generation, runtime_session_id, maintenance_id"
                    + " FROM managed_workspace_execution_lease WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE", row -> {
                        String holder = row.getString("holder_key");
                        String bindingId = row.getString("binding_id");
                        String sessionId = row.getString("runtime_session_id");
                        long generation = row.getLong("runtime_generation");
                        String maintenanceId = row.getString("maintenance_id");
                        if (maintenanceId != null) {
                            // A child Workspace step holds the storage: it is
                            // not the lost binding's hold, and its own claim
                            // releases it. Anything else in the Runtime holder
                            // columns beside it is corrupt.
                            if (holder == null || bindingId != null || sessionId != null
                                    || row.getObject("runtime_generation") != null) {
                                throw unavailable();
                            }
                        } else if (holder == null) {
                            if (bindingId != null || sessionId != null || row.getObject("runtime_generation") != null) {
                                throw unavailable();
                            }
                        } else if (bindingId == null || sessionId == null || generation <= 0
                                || !holder.equals(digest(bindingId + "\u0000" + generation + "\u0000" + sessionId))) {
                            throw unavailable();
                        } else if (saved.getBindingId().equals(bindingId) && saved.getGeneration() == generation) {
                            java.time.Instant now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(),"
                                    + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))", (clock, index) ->
                                            java.time.Instant.ofEpochSecond(clock.getLong(1), clock.getLong(2) * 1000));
                            if (now == null || !saved.getOperationLeaseUntil().isAfter(now)) {
                                throw unavailable();
                            }
                            int changed = jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL,"
                                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL"
                                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL' AND holder_key = ? AND binding_id = ?"
                                    + " AND runtime_generation = ? AND runtime_session_id = ?",
                                    key, holder, bindingId, generation, sessionId);
                            if (changed != 1) {
                                throw unavailable();
                            }
                        }
                    }, key);
        });
    }

    public static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace execution authority is unavailable.", false);
    }

    // A probe's momentary I/O failure is not the structural verdict the
    // terminal refusal promises: it retries through the delivery machine,
    // keeping the cause for the log. Structural refusals keep
    // unavailable().
    public static RuntimeBrokerException unavailableTransient(
            Throwable cause) {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace mount cannot be verified right now.", true,
                cause);
    }

    // A creation grant or the registry state changes under operator
    // control: refusing a committed decision over it is not the
    // structural verdict of unavailable(), and the delivery machine must
    // retry so a restored grant still reaches the Harness. Structural
    // refusals keep unavailable().
    public static RuntimeBrokerException unavailablePendingGrant() {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace access grant or registry state is changing.", true);
    }

    private static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_busy",
                "Workspace storage is held by another tool turn.", true);
    }

    private static String storageKey(ContextBinding binding) {
        return digest(binding.getTenantId() + "\u0000" + binding.getStorageId());
    }

    private static String maintenanceHolderKey(String maintenanceId, long claimGeneration) {
        return digest("child-workspace\u0000" + maintenanceId + "\u0000" + claimGeneration);
    }

    private static String holderKey(RuntimeSessionRecord session) {
        return digest(session.getBindingId() + "\u0000" + session.getRuntimeGeneration()
                + "\u0000" + session.getRuntimeSessionId());
    }

    private static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
