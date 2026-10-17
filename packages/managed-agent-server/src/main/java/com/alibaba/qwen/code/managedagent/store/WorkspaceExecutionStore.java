package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.List;

@Repository
public class WorkspaceExecutionStore {
    static final String ORIGINAL_HOLDER_SQL = "SELECT storage_key FROM ma_storage_owner WHERE binding_id = ? AND runtime_generation = ? FOR UPDATE";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard storageGuard;
    private final ResidentWorkspaces residents;

    @Autowired
    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, WorkspaceStorageGuard storageGuard,
            com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties properties) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        this.storageGuard = storageGuard;
        this.residents = new ResidentWorkspaces(properties.getRuntimeBroker().getResidentWorkspaces());
    }

    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, WorkspaceStorageGuard storageGuard) {
        this(jdbc, transactionManager, storageGuard,
                new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties());
    }

    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        // Offline saved-owner cleanup must not require the current mount.
        this.storageGuard = null;
        this.residents = new ResidentWorkspaces(List.of());
    }

    public java.nio.file.Path createdStorageRoot(String tenantId, String storageId) {
        return storageGuard == null ? null : storageGuard.createdStorageRoot(tenantId, storageId);
    }

    public boolean verifiedRecoveryEnabled() {
        return storageGuard != null && storageGuard.enabled();
    }

    private void requireResidentHeld(ContextBinding binding, RuntimeSessionRecord session, boolean releasing) {
        var selected = residents.find(binding);
        if (selected == null || !com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile.selects(session.getSession().getScope())
                || !ResidentWorkspaces.scope(selected).equals(session.getSession().getScope())) {
            throw unavailable();
        }
        ResidentWorkspaces.requireRegistration(jdbc, selected);
        var rows = jdbc.queryForList("SELECT rs.runtime_session_id FROM ma_runtime_session rs"
                + " JOIN ma_runtime_binding b ON b.binding_id = rs.binding_id AND b.runtime_generation = rs.runtime_generation"
                + " JOIN ma_runtime_slot slot ON slot.active_binding_id = b.binding_id AND slot.request_key = b.request_key"
                + " JOIN ma_storage_owner o ON o.binding_id = b.binding_id AND o.runtime_generation = b.runtime_generation"
                + " WHERE rs.binding_id = ? AND rs.runtime_generation = ? AND rs.runtime_session_id = ?"
                + " AND rs.harness_session_id = ? AND rs.session_state IN (" + (releasing
                        ? "'ACQUIRING', 'READY', 'RELEASING', 'RELEASED'" : "'ACQUIRING', 'READY'") + ")"
                + " AND b.request_key = ? AND b.binding_state = 'READY' AND b.drain_requested = FALSE"
                + " AND o.storage_key = ? AND o.storage_kind = 'CSI' AND o.csi_phase = 'RESERVED'"
                + " AND o.csi_revision = 1 AND o.csi_registration_key = ? AND o.csi_registration_revision = ?"
                + " AND o.csi_provision_request_id = b.provision_request_id AND o.holder_key IS NULL"
                + " AND o.runtime_session_id IS NULL", String.class, session.getBindingId(), session.getRuntimeGeneration(),
                session.getRuntimeSessionId(), session.getSession().getHarnessSessionId(), residents.request(binding).requestKey(),
                selected.registration().physicalKey(), selected.registration().aliasKey(), selected.registration().revision());
        if (rows.size() != 1 || !session.getRuntimeSessionId().equals(rows.getFirst())
                || !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id <> ? AND session_state <> 'RELEASED'",
                String.class, session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId()).isEmpty()) {
            throw busy();
        }
    }

    public void authorize(SessionRecord session) {
        authorizePassiveAttachment(session);
        if (storageGuard != null && residents.find(session.workspace()) == null) {
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
        if (storageGuard != null && residents.find(session.workspace()) == null) {
            storageGuard.verify(session.workspace());
        }
    }

    public void authorizeLegacyClose(SessionRecord session) {
        if (!WorkspaceLifecycleStore.legacyClose(jdbc, session.tenantId(), session.sessionId())) {
            throw unavailable();
        }
        authorizePassiveAttachment(session, null, true);
        if (storageGuard != null && residents.find(session.workspace()) == null) {
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

    public void authorizeRecoveryCancellation(SessionRecord session,
            String turnId, String dispatchOwner) {
        if (turnId == null || dispatchOwner == null
                || jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ? AND status = 'RUNNING'"
                        + " AND submission_attempted = TRUE AND harness_event_epoch IS NOT NULL"
                        + " AND dispatch_owner = ? AND dispatch_lease_until >= " + ManagedSchemaTime.SQL_NOW,
                        Long.class, session.tenantId(), session.sessionId(), turnId, dispatchOwner) != 1) {
            throw unavailable();
        }
        authorizeAttachment(session, false, false, null, false, true);
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
                || session.deletedAt() != null || !executableAgent(session.agentId(), session.agentDefinitionDigest())
                || !session.tenantId().equals(binding.getTenantId())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw unavailable();
        }
        var resident = residents.find(binding);
        if (resident == null) {
            WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        } else {
            if (!WorkspaceToolProfiles.FILES.equals(session.toolProfile())
                    || jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                            + " AND parent_session_id IS NULL", Long.class, session.tenantId(), session.sessionId()) != 1) {
                throw unavailable();
            }
            ResidentWorkspaces.requireRegistration(jdbc, resident);
        }
        // Verdicts per matched row: 0 structural mismatch, 1 refused only by
        // operator-mutable grant or registry state, 2 authorized.
        byte[] executionActor = cancellation || committedStop ? null
                : inheritedExecutionActor(jdbc, binding, session.sessionId());
        List<Integer> grants = jdbc.query("SELECT s.tenant_id, s.session_id,"
                + " s.agent_id AS session_agent,"
                + " s.agent_definition_digest AS session_definition_digest,"
                + " s.status AS session_status,"
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
                + " s.tenant_id AS command_tenant, s.session_id AS command_session,"
                + " a.tenant_id AS access_tenant, a.workspace_id AS access_workspace,"
                + " a.role")
                + " FROM ma_session s"
                + (cancellation
                        ? " JOIN ma_turn t ON t.tenant_id = s.tenant_id"
                                + " AND t.session_id = s.session_id AND t.status = 'CANCELLING'"
                                + " AND (t.submission_attempted = TRUE OR t.harness_event_epoch IS NOT NULL)"
                        : committedStop ? ""
                        : " JOIN ma_workspace r ON r.tenant_id = s.tenant_id"
                + " AND r.workspace_id = s.workspace_id"
                + " JOIN ma_workspace_access a ON a.tenant_id = r.tenant_id"
                + " AND a.workspace_id = r.workspace_id AND a.actor_id = ?"
                + " AND a.role IN ('READER', 'OPERATOR', 'OWNER')")
                + " WHERE s.tenant_id = ? AND s.session_id = ?",
                (row, index) -> {
                    boolean structural = session.tenantId().equals(row.getString("tenant_id"))
                            && session.sessionId().equals(row.getString("session_id"))
                            && executableAgent(row.getString("session_agent"),
                                    row.getString("session_definition_digest"))
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
                cancellation || committedStop ? new Object[] {session.tenantId(), session.sessionId()}
                        : new Object[] {executionActor, session.tenantId(), session.sessionId()});
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

    static byte[] inheritedExecutionActor(JdbcTemplate jdbc, ContextBinding binding, String sessionId) {
        java.util.Set<String> visited = new java.util.HashSet<>();
        String current = sessionId;
        while (visited.add(current)) {
            var rows = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, parent_session_id, creator_actor_key,"
                    + " workspace_id, workspace_generation, workspace_storage_id FROM ma_session"
                    + " WHERE tenant_id = ? AND session_id = ?", binding.getTenantId(), current);
            if (rows.size() != 1) {
                throw unavailable();
            }
            var row = rows.getFirst();
            if (!binding.getTenantId().equals(row.get("tenant_id")) || !current.equals(row.get("session_id"))
                    || !binding.getWorkspaceId().equals(row.get("workspace_id"))
                    || !(row.get("workspace_generation") instanceof Number generation)
                    || binding.getWorkspaceGeneration() != generation.longValue()
                    || !binding.getStorageId().equals(row.get("workspace_storage_id"))) {
                throw unavailable();
            }
            String parent = (String) row.get("parent_session_id");
            if (parent == null) {
                if (!(row.get("creator_actor_key") instanceof byte[] actor)) {
                    throw unavailable();
                }
                return actor;
            }
            current = parent;
        }
        throw unavailable();
    }

    public void claim(ContextBinding binding, RuntimeSessionRecord session) {
        WorkspaceStorageKindGuard.requireFreshTransaction();
        if (residents.find(binding) != null) {
            transaction.executeWithoutResult(status -> {
                WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
                requireResidentHeld(binding, session, false);
            });
            return;
        }
        String holder = holderKey(session);
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
            String key = storageKey(binding);
            WorkspaceMigrationAdmission.requireOpen(jdbc, binding.getTenantId(), binding.getStorageId());
            List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state, drain_requested,"
                    + " tenant_id, workspace_id, workspace_generation, storage_id FROM ma_runtime_binding"
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
                    + " harness_session_id, session_state FROM ma_runtime_session"
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
            jdbc.update("INSERT INTO ma_storage_owner"
                    + " (storage_key, storage_kind) VALUES (?, ?) ON DUPLICATE KEY UPDATE"
                    + " storage_key = storage_key", key, SshWorkspaceStore.physicalKey(jdbc, binding.getTenantId(), binding.getStorageId()) == null ? "LOCAL" : "SSH_LOCAL");
            String current = jdbc.queryForObject("SELECT holder_key FROM"
                    + " ma_storage_owner WHERE storage_key = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL') FOR UPDATE",
                    String.class, key);
            if (storageGuard != null) {
                storageGuard.verifyLocked(binding);
            }
            if (current != null && !holder.equals(current)) {
                throw busy();
            }
            jdbc.update("UPDATE ma_storage_owner SET holder_key = ?,"
                    + " binding_id = ?, runtime_generation = ?, runtime_session_id = ?"
                    + " WHERE storage_key = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL')", holder, session.getBindingId(),
                    session.getRuntimeGeneration(), session.getRuntimeSessionId(), key);
        });
    }

    public void assertHeld(ContextBinding binding, RuntimeSessionRecord session) {
        if (residents.find(binding) != null) {
            requireResidentHeld(binding, session, false);
            return;
        }
        if (storageGuard != null) {
            storageGuard.verify(binding);
        }
        if (!isHeld(binding, session)) {
            throw busy();
        }
    }

    public boolean isHeld(ContextBinding binding, RuntimeSessionRecord session) {
        if (residents.find(binding) != null) {
            requireResidentHeld(binding, session, true);
            return session.getState() != RuntimeSessionRecord.State.RELEASED;
        }
        WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        List<String> holders = jdbc.queryForList("SELECT holder_key FROM"
                + " ma_storage_owner WHERE storage_key = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL')",
                String.class, storageKey(binding));
        return holders.size() == 1 && holderKey(session).equals(holders.getFirst());
    }

    public void release(ContextBinding binding, RuntimeSessionRecord session) {
        if (residents.find(binding) != null) {
            transaction.executeWithoutResult(status -> {
                WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
                requireResidentHeld(binding, session, true);
                if (session.getState() != RuntimeSessionRecord.State.RELEASING
                        && session.getState() != RuntimeSessionRecord.State.RELEASED) {
                    throw unavailable();
                }
            });
            return;
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
            List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state"
                    + " FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE",
                    (row, index) -> session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && ("READY".equals(row.getString("binding_state"))
                                    || "DRAINING".equals(row.getString("binding_state"))),
                    session.getBindingId());
            if (live.size() != 1 || !live.getFirst()) {
                throw unavailable();
            }
            jdbc.update("UPDATE ma_storage_owner SET holder_key = NULL,"
                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL"
                    + " WHERE storage_key = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL') AND holder_key = ?",
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
     * different generation cannot take it over. A physical step releases
     * only its own generation after returning; claim expiry leaves the
     * original holder in place until its process is reconciled.
     */
    public String holdForMaintenance(ContextBinding binding, String maintenanceId,
            long claimGeneration) {
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        WorkspaceStorageKindGuard.requireFreshTransaction();
        String holder = maintenanceHolderKey(maintenanceId, claimGeneration);
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
            String key = storageKey(binding);
            WorkspaceMigrationAdmission.requireOpen(jdbc, binding.getTenantId(), binding.getStorageId());
            List<Long> generations = jdbc.queryForList("SELECT claim_generation FROM ma_operation WHERE operation_key = ? AND operation_kind = 'CHILD_WORKSPACE' AND claim_until > " + ManagedSchemaTime.SQL_NOW + " FOR UPDATE",
                    Long.class, WorkspaceOperations.key(WorkspaceOperations.Kind.CHILD_WORKSPACE, binding.getTenantId(), maintenanceId));
            if (generations.size() != 1 || generations.getFirst() != claimGeneration) {
                throw unavailable();
            }
            jdbc.update("INSERT INTO ma_storage_owner"
                    + " (storage_key, storage_kind) VALUES (?, 'LOCAL') ON DUPLICATE KEY UPDATE"
                    + " storage_key = storage_key", key);
            List<String[]> rows = jdbc.query("SELECT holder_key, maintenance_id FROM"
                    + " ma_storage_owner WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE",
                    (row, index) -> new String[] {row.getString("holder_key"), row.getString("maintenance_id")},
                    key);
            if (rows.size() != 1) {
                throw unavailable();
            }
            if (storageGuard != null) {
                storageGuard.verifyLocked(binding);
            }
            String current = rows.getFirst()[0];
            if (current != null && !holder.equals(current)) {
                throw busy();
            }
            jdbc.update("UPDATE ma_storage_owner SET holder_key = ?,"
                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL,"
                    + " maintenance_id = ?, maintenance_generation = ? WHERE storage_key = ? AND storage_kind = 'LOCAL'",
                    holder, maintenanceId, claimGeneration, key);
            return WorkspaceMaintenanceRecovery.recordStart(jdbc, binding, maintenanceId, claimGeneration);
        });
    }

    /** Releases a maintenance hold, and only the one this claim took. */
    public void releaseMaintenance(ContextBinding binding, String maintenanceId,
            long claimGeneration, String executionId) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            if (!WorkspaceMaintenanceRecovery.recordReturned(jdbc, binding, maintenanceId, claimGeneration, executionId)) {
                return;
            }
            int released = jdbc.update("UPDATE ma_storage_owner SET holder_key = NULL,"
                    + " maintenance_id = NULL, maintenance_generation = NULL WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                    + " AND holder_key = ? AND maintenance_id = ? AND maintenance_generation = ?", storageKey(binding),
                    maintenanceHolderKey(maintenanceId, claimGeneration), maintenanceId, claimGeneration);
            if (released != 1) {
                status.setRollbackOnly();
            }
        });
    }

    /** Expired claims cannot prove that the original physical worker stopped. */
    public int releaseStaleMaintenance(long now, long resumableGraceMillis) {
        return 0;
    }

    public boolean hasHolder(RuntimeBindingRecord saved) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner"
                + " WHERE binding_id = ? AND runtime_generation = ? AND holder_key IS NOT NULL",
                Integer.class, saved.getBindingId(), saved.getGeneration());
        return count != null && count > 0;
    }

    public boolean canStopDrained(RuntimeBindingRecord saved) {
        if ((saved.getState() != RuntimeBindingRecord.State.DRAINING && saved.getState() != RuntimeBindingRecord.State.LOST)
                || !saved.isDrainRequested() || !saved.getRequest().isManagedContext() || saved.getOperationOwner() == null
                || !java.util.Set.of(LocalProcessRuntimeProvisioner.KIND, com.alibaba.qwen.code.runtimebroker.SshRuntimeProvisioner.KIND).contains(saved.getRequest().getProvisionerKind())
                || !(WorkspaceExecutionProfile.admitsIsolationClass(saved.getRequest().getScope().getIsolationClass())
                        || HarnessOwnership.sharesRuntimeSessions(saved.getRequest()))) {
            return false;
        }
        var claims = jdbc.query("SELECT binding_state, drain_requested, operation_owner, operation_generation,"
                + " operation_lease_until, tenant_id, storage_id, UNIX_TIMESTAMP() AS db_seconds,"
                + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) AS db_micros FROM ma_runtime_binding"
                + " WHERE binding_id = ? AND runtime_generation = ?", (row, index) ->
                        saved.getState().name().equals(row.getString("binding_state")) && row.getBoolean("drain_requested")
                        && saved.getOperationOwner().equals(row.getString("operation_owner"))
                        && saved.getOperationGeneration() == row.getLong("operation_generation")
                        && ManagedSchemaTime.timestamp(row, "operation_lease_until") != null
                        && ManagedSchemaTime.timestamp(row, "operation_lease_until").toInstant().isAfter(java.time.Instant.ofEpochMilli(
                                        row.getLong("db_seconds") * 1000 + row.getLong("db_micros") / 1000))
                        && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                        && saved.getRequest().getStorageId().equals(row.getString("storage_id")),
                saved.getBindingId(), saved.getGeneration());
        if (claims.size() != 1 || !claims.getFirst()
                || jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE binding_id = ?"
                        + " AND runtime_generation = ? AND execution_state NOT IN ('SETTLED', 'ABANDONED')",
                        Long.class, saved.getBindingId(), saved.getGeneration()) != 0) {
            return false;
        }
        var holders = jdbc.query("SELECT holder_key, binding_id, runtime_generation, runtime_session_id"
                + " FROM ma_storage_owner WHERE storage_key = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL')", (row, index) -> {
                    String holder = row.getString("holder_key");
                    String binding = row.getString("binding_id");
                    String session = row.getString("runtime_session_id");
                    long generation = row.getLong("runtime_generation");
                    if (holder == null) {
                        return binding == null && session == null && row.getObject("runtime_generation") == null;
                    }
                    return saved.getBindingId().equals(binding) && saved.getGeneration() == generation && session != null
                            && holder.equals(digest(binding + "\u0000" + generation + "\u0000" + session))
                            && (HarnessOwnership.sharesRuntimeSessions(saved.getRequest())
                                    ? jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE binding_id = ?"
                                            + " AND runtime_generation = ? AND runtime_session_id = ?",
                                            Long.class, binding, generation, session) == 1
                                    : jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE binding_id = ?"
                                            + " AND runtime_generation = ? AND runtime_session_id = ? AND harness_session_id = ?",
                                            Long.class, binding, generation, session, saved.getRequest().getIsolationKey()) == 1);
                }, storageKey(saved.getRequest().getScope().getTenantId(), saved.getRequest().getStorageId()));
        return holders.isEmpty() || holders.size() == 1 && holders.getFirst();
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
                    + " FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE", (row, index) ->
                            saved.getBindingId().equals(row.getString("binding_id"))
                            && saved.getGeneration() == row.getLong("runtime_generation")
                            && "LOST".equals(row.getString("binding_state"))
                            && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                            && saved.getRequest().getScope().getWorkspaceId().equals(row.getString("workspace_id"))
                            && saved.getRequest().getStorageId().equals(row.getString("storage_id"))
                            && saved.getVersion() == row.getLong("record_version")
                            && saved.getOperationOwner().equals(row.getString("operation_owner"))
                            && saved.getOperationGeneration() == row.getLong("operation_generation")
                            && ManagedSchemaTime.timestamp(row, "operation_lease_until") != null
                            && ManagedSchemaTime.timestamp(row, "operation_lease_until").toInstant().isAfter(java.time.Instant.ofEpochMilli(
                                            row.getLong("db_seconds") * 1000 + row.getLong("db_micros") / 1000))
                            && row.getString("loss_evidence_json") != null && row.getString("stop_evidence_json") != null,
                    saved.getBindingId());
            if (exact.size() != 1 || !exact.getFirst()
                    || jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE binding_id = ?"
                            + " AND runtime_generation = ? AND execution_state NOT IN ('SETTLED', 'ABANDONED')",
                            Long.class, saved.getBindingId(), saved.getGeneration()) != 0) {
                throw unavailable();
            }
            if (jdbc.queryForList(ORIGINAL_HOLDER_SQL, String.class, saved.getBindingId(), saved.getGeneration()).isEmpty()) {
                return;
            }
            String key = storageKey(saved.getRequest().getScope().getTenantId(), saved.getRequest().getStorageId());
            jdbc.query("SELECT holder_key, binding_id, runtime_generation, runtime_session_id, maintenance_id"
                    + " FROM ma_storage_owner WHERE storage_key = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL') FOR UPDATE", row -> {
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
                            int changed = jdbc.update("UPDATE ma_storage_owner SET holder_key = NULL,"
                                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL"
                                    + " WHERE storage_key = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL') AND holder_key = ? AND binding_id = ?"
                                    + " AND runtime_generation = ? AND runtime_session_id = ?",
                                    key, holder, bindingId, generation, sessionId);
                            if (changed != 1) {
                                throw unavailable();
                            }
                        }
                    }, key);
        });
    }

    // qwen-code, or a Session that pinned a compiled definition (D8c-1).
    private static boolean executableAgent(String agentId,
            String agentDefinitionDigest) {
        return "qwen-code".equals(agentId) || agentDefinitionDigest != null;
    }

    public static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace execution authority is unavailable.", false);
    }

    // Same structural refusal, with the discarded cause kept for the log:
    // without it a failed mount verification reports nothing but the verdict.
    public static RuntimeBrokerException unavailable(Throwable cause) {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace execution authority is unavailable.", false, cause);
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

    static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_busy",
                "Workspace storage is held by another tool turn.", true);
    }

    private String storageKey(ContextBinding binding) {
        return storageKey(jdbc, binding);
    }

    private String storageKey(String tenant, String storage) {
        String ssh = SshWorkspaceStore.physicalKey(jdbc, tenant, storage);
        return ssh == null ? LocalStorageOwners.key(jdbc, tenant, storage) : ssh;
    }

    static String storageKey(JdbcTemplate jdbc, ContextBinding binding) {
        String ssh = SshWorkspaceStore.physicalKey(jdbc, binding.getTenantId(), binding.getStorageId());
        return ssh == null ? LocalStorageOwners.key(jdbc, binding.getTenantId(), binding.getStorageId()) : ssh;
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
            return DigestUtils.sha256Hex(value.getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
