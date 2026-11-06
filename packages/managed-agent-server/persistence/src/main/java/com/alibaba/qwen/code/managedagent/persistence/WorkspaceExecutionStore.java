package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcExternalWorkspaceOwnership;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;

import static com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable;

@Repository
public class WorkspaceExecutionStore
        implements com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore {
    private com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles;
    @org.springframework.beans.factory.annotation.Autowired
    public void configureWorktreeFiles(com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles value) { worktreeFiles = value; }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard storageGuard;
    private final ResidentWorkspaces residents;

    @Autowired
    public WorkspaceExecutionStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager transactionManager, WorkspaceStorageGuard storageGuard,
            com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings properties) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        this.storageGuard = storageGuard;
        this.residents = new ResidentWorkspaces(properties.getRuntimeBroker().getResidentWorkspaces());
    }

    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, WorkspaceStorageGuard storageGuard) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        this.storageGuard = storageGuard;
        this.residents = new ResidentWorkspaces(List.of());
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
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        ResidentWorkspaces.requireRegistration(jdbc, selected);
        var rows = jdbc.query("SELECT rs.runtime_session_id, b.resource_handle_json, o.csi_revision, o.csi_reservation_id"
                + " FROM ma_runtime_session rs"
                + " JOIN ma_runtime_binding b ON b.binding_id = rs.binding_id AND b.runtime_generation = rs.runtime_generation"
                + " JOIN ma_runtime_slot slot ON slot.active_binding_id = b.binding_id AND slot.request_key = b.request_key"
                + " JOIN ma_storage_owner o ON o.binding_id = b.binding_id AND o.runtime_generation = b.runtime_generation"
                + " WHERE rs.binding_id = ? AND rs.runtime_generation = ? AND rs.runtime_session_id = ?"
                + " AND rs.execution_storage_key IS NULL AND rs.is_execution_exclusive = FALSE"
                + " AND rs.harness_session_id = ? AND rs.session_state IN (" + (releasing
                        ? "'ACQUIRING', 'READY', 'RELEASING', 'RELEASED'" : "'ACQUIRING', 'READY'") + ")"
                + " AND b.request_key = ? AND b.binding_state = 'READY' AND b.is_drain_requested = FALSE"
                + " AND o.storage_key = ? AND o.storage_kind = 'CSI' AND o.csi_phase = 'RESERVED'"
                + " AND o.csi_registration_key = ? AND o.csi_registration_revision = ?"
                + " AND o.csi_provision_request_id = b.provision_request_id AND o.holder_key IS NULL"
                + " AND o.runtime_session_id IS NULL", (row, index) -> new ResidentHeld(row.getString(1), row.getString(2),
                        row.getLong(3), row.getString(4)), session.getBindingId(), session.getRuntimeGeneration(),
                session.getRuntimeSessionId(), session.getSession().getHarnessSessionId(), residents.request(binding).requestKey(),
                selected.registration().physicalKey(), selected.registration().aliasKey(), selected.registration().revision());
        if (rows.size() != 1 || !session.getRuntimeSessionId().equals(rows.getFirst().sessionId())
                || !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id <> ? AND session_state <> 'RELEASED'",
                String.class, session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId()).isEmpty()) {
            throw busy();
        }
        var held = rows.getFirst();
        var storage = ResidentWorkspaces.heldStorage(held.handle());
        if (!Long.toString(held.revision()).equals(storage.get("reservationRevision"))
                || !held.reservationId().equals(storage.get("reservationId"))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    private record ResidentHeld(String sessionId, String handle, long revision, String reservationId) { }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private ManagedWorkspaceRegistry externalAdmission;

    public void requireExternalExecution(ContextBinding binding) {
        if (isExternal(binding) && (externalAdmission == null
                || !externalAdmission.externalFilesAllowed(binding))) {
            throw unavailable();
        }
    }

    public void authorize(SessionRecord session) {
        requireExternalExecution(session.workspace());
        authorizePassiveAttachment(session);
        if (storageGuard != null && residents.find(session.workspace()) == null
                && !(WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && isExternal(session.workspace()))) {
            storageGuard.verify(session.workspace());
        }
    }

    public void authorizeLifecycle(SessionRecord session, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        try {
            WorkspaceLifecycleStore.requireClaim(jdbc, session.tenantId(), session.sessionId(), authority, false);
        } catch (ManagedAgentException error) {
            throw lifecycleFailure(error);
        }
        authorizePassiveAttachment(session, authority);
        if (storageGuard != null && residents.find(session.workspace()) == null
                && !(WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && isExternal(session.workspace()))) {
            storageGuard.verify(session.workspace());
        }
    }

    public void authorizeLegacyClose(SessionRecord session) {
        if (!WorkspaceLifecycleStore.legacyClose(jdbc, session.tenantId(), session.sessionId())) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        authorizePassiveAttachment(session, null, true);
        if (storageGuard != null && residents.find(session.workspace()) == null
                && !(WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && isExternal(session.workspace()))) {
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
                        + " AND is_submission_attempted = TRUE AND harness_event_epoch IS NOT NULL"
                        + " AND dispatch_owner = ? AND dispatch_lease_until >= " + ManagedSchemaTime.SQL_NOW,
                        Long.class, session.tenantId(), session.sessionId(), turnId, dispatchOwner) != 1) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
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
        boolean external = WorkspaceToolProfiles.EXTERNAL_FILES.equals(session.toolProfile()) && isExternal(session.workspace());
        if (external && (!"qwen-code".equals(session.agentId()) || session.agentDefinitionDigest() != null)) {
            throw unavailable();
        }
        authorizeAttachment(session, cancellation, actionResponse, authority, legacyClose, committedStop, external);
    }

    private void authorizeAttachment(SessionRecord session, boolean cancellation,
            boolean actionResponse, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority,
            boolean legacyClose, boolean committedStop, boolean external) {
        ContextBinding binding = session.workspace();
        String expectedStatus = authority == null && !legacyClose ? "ACTIVE" : session.status();
        if (binding == null || !(legacyClose ? "CLOSING".equals(session.status()) : authority == null ? "ACTIVE".equals(session.status())
                : java.util.List.of("CLOSING", "DELETING").contains(session.status()))
                || session.deletedAt() != null || !executableAgent(session.agentId(), session.agentDefinitionDigest())
                || !session.tenantId().equals(binding.getTenantId())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (!cancellation && !committedStop && authority == null && !legacyClose) {
            requireWorktreeAncestorsReady(jdbc, session.tenantId(), session.sessionId());
        }
        var resident = residents.find(binding);
        if (external) {
            if (!isExternal(binding) || !"hosted-workspace-external-files/1".equals(session.toolProfile())) {
                throw unavailable();
            }
        } else if (resident == null) {
            WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        } else {
            if (!WorkspaceToolProfiles.FILES.equals(session.toolProfile())
                    || jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                            + " AND parent_session_id IS NULL", Long.class, session.tenantId(), session.sessionId()) != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            ResidentWorkspaces.requireRegistration(jdbc, resident);
        }
        // Verdicts per matched row: 0 structural mismatch, 1 refused only by
        // operator-mutable grant or registry state, 2 authorized.
        byte[] executionActor = cancellation || committedStop ? null
                : external ? externalExecutionActor(binding, session.sessionId())
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
                                + " AND (t.is_submission_attempted = TRUE OR t.harness_event_epoch IS NOT NULL)"
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
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (grants.getFirst() == 1) {
            throw actionResponse ? com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailablePendingGrant() : com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (grants.getFirst() != 2) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    private void requireWorktreeAncestorsReady(JdbcTemplate jdbc, String tenantId, String sessionId) {
        java.util.Set<String> visited = new java.util.HashSet<>();
        String current = sessionId;
        while (visited.add(current)) {
            SessionWorktreeStore.requireReady(worktreeFiles, jdbc, tenantId, current);
            var parents = jdbc.query("SELECT parent_session_id FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    (row, index) -> row.getString(1), tenantId, current);
            if (parents.size() != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            if (parents.getFirst() == null) {
                return;
            }
            current = parents.getFirst();
        }
        throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
    }

    static byte[] inheritedExecutionActor(JdbcTemplate jdbc, ContextBinding binding, String sessionId) {
        java.util.Set<String> visited = new java.util.HashSet<>();
        String current = sessionId;
        while (visited.add(current)) {
            var rows = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, parent_session_id, creator_actor_key,"
                    + " workspace_id, workspace_generation, workspace_storage_id FROM ma_session"
                    + " WHERE tenant_id = ? AND session_id = ?", binding.getTenantId(), current);
            if (rows.size() != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            var row = rows.getFirst();
            if (!binding.getTenantId().equals(row.get("tenant_id")) || !current.equals(row.get("session_id"))
                    || !binding.getWorkspaceId().equals(row.get("workspace_id"))
                    || !(row.get("workspace_generation") instanceof Number generation)
                    || binding.getWorkspaceGeneration() != generation.longValue()
                    || !binding.getStorageId().equals(row.get("workspace_storage_id"))) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            String parent = (String) row.get("parent_session_id");
            if (parent == null) {
                if (!(row.get("creator_actor_key") instanceof byte[] actor)) {
                    throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                }
                return actor;
            }
            current = parent;
        }
        throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
    }

    public boolean isExternal(ContextBinding binding) {
        return JdbcRuntimeBindingRepository.externalStorage(jdbc, binding);
    }

    public void authorizeExternal(SessionRecord session,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        if (!isExternal(session.workspace()) || !"hosted-workspace-external-files/1".equals(session.toolProfile())
                || !"qwen-code".equals(session.agentId()) || session.agentDefinitionDigest() != null) {
            throw unavailable();
        }
        if (authority != null) {
            try {
                WorkspaceLifecycleStore.requireClaim(jdbc, session.tenantId(), session.sessionId(), authority, false);
            } catch (ManagedAgentException error) {
                throw lifecycleFailure(error);
            }
        }
        authorizeAttachment(session, false, false, authority, false, false, true);
    }

    private static RuntimeBrokerException lifecycleFailure(ManagedAgentException error) {
        return new RuntimeBrokerException(error.getStatus(), error.getCode(), error.getMessage(), false, error);
    }

    private byte[] externalExecutionActor(ContextBinding binding, String sessionId) {
        var actors = jdbc.query("SELECT COALESCE(owner_actor_key, creator_actor_key) AS execution_actor"
                + " FROM ma_session WHERE tenant_id = ? AND session_id = ? AND parent_session_id IS NULL",
                (row, index) -> row.getBytes("execution_actor"),
                binding.getTenantId(), sessionId);
        if (actors.size() != 1 || actors.getFirst() == null) {
            throw unavailable();
        }
        return actors.getFirst();
    }

    public void claim(ContextBinding context, RuntimeSessionRecord session, RuntimeBindingRecord binding,
            RuntimeBindingRepository repository) {
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())) {
            claim(context, session);
            return;
        }
        external(context, binding, repository, session.getSession().getScope(),
                session.getSession().getHarnessSessionId(), true,
                (connection, owner, current) -> {
                JdbcExternalWorkspaceOwnership.claim(connection, owner, current, session);
                return null;
            });
    }

    public boolean isHeld(ContextBinding context, RuntimeSessionRecord session, RuntimeBindingRecord binding,
            RuntimeBindingRepository repository) {
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())) {
            return isHeld(context, session);
        }
        return external(context, binding, repository,
                session.getSession().getScope(),
                session.getSession().getHarnessSessionId(), false,
                (connection, owner, current) ->
                JdbcExternalWorkspaceOwnership.held(connection, owner, current, session, false));
    }

    public void assertHeld(ContextBinding context, RuntimeSessionRecord session, RuntimeBindingRecord binding,
            RuntimeBindingRepository repository) {
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())) {
            assertHeld(context, session);
            return;
        }
        external(context, binding, repository, session.getSession().getScope(),
                session.getSession().getHarnessSessionId(), true,
                (connection, owner, current) -> {
                if (!JdbcExternalWorkspaceOwnership.held(connection, owner, current, session, true)) {
                    throw busy();
                }
                return null;
            });
    }

    public void release(ContextBinding context, RuntimeSessionRecord session, RuntimeBindingRecord binding,
            RuntimeBindingRepository repository) {
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())) {
            release(context, session);
            return;
        }
        external(context, binding, repository, session.getSession().getScope(),
                session.getSession().getHarnessSessionId(), false,
                (connection, owner, current) -> {
                JdbcExternalWorkspaceOwnership.releaseMember(connection, owner, current, session);
                return null;
            });
    }

    public void assertOriginalExternal(ContextBinding context, RuntimeSessionRecord session, RuntimeBindingRecord binding,
            RuntimeBindingRepository repository) {
        external(context, binding, repository, session.getSession().getScope(),
                session.getSession().getHarnessSessionId(), false,
                (connection, owner, current) -> {
                JdbcExternalWorkspaceOwnership.held(connection, owner, current, session, false);
                if (!JdbcExternalWorkspaceOwnership.hasHolder(connection, owner, current)) {
                    throw unavailable();
                }
                return null;
            });
    }

    public void releaseStopped(ContextBinding context, RuntimeSessionRecord session, RuntimeBindingRecord binding,
            RuntimeBindingRepository repository) {
        external(context, binding, repository, session.getSession().getScope(),
                session.getSession().getHarnessSessionId(), false, true,
                (connection, owner, current) -> {
                    JdbcExternalWorkspaceOwnership.releaseStopped(connection, owner, current, binding, session);
                    return null;
                });
    }

    private <T> T external(ContextBinding context, RuntimeBindingRecord binding, RuntimeBindingRepository repository,
            com.alibaba.qwen.code.runtimebroker.RuntimeScope scope,
            String harnessSessionId, boolean acquiring, ExternalWork<T> work) {
        return external(context, binding, repository, scope, harnessSessionId, acquiring, false, work);
    }

    private <T> T external(ContextBinding context, RuntimeBindingRecord binding, RuntimeBindingRepository repository,
            com.alibaba.qwen.code.runtimebroker.RuntimeScope scope,
            String harnessSessionId, boolean acquiring, boolean claimDriftRetryable,
            ExternalWork<T> work) {
        if (!(repository instanceof JdbcRuntimeBindingRepository original) || !original.usesDataSource(jdbc.getDataSource())) {
            throw unavailable();
        }
        WorkspaceStorageKindGuard.requireFreshTransaction();
        return transaction.execute(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<T>) connection -> {
            var owner = JdbcExternalWorkspaceOwnership.lockOwner(connection, binding);
            var saved = JdbcExternalWorkspaceOwnership.savedContext(
                    connection, binding, harnessSessionId, acquiring);
            if (context != null && !context.equals(saved)) {
                throw unavailable();
            }
            JdbcRuntimeBindingRepository.requireExternalHarnessAdmission(
                    connection, binding.getRequest(), scope,
                    harnessSessionId, !acquiring);
            if (claimDriftRetryable) {
                JdbcExternalWorkspaceOwnership.requireUnchangedClaimOrRetry(connection, original, binding);
            }
            var current = JdbcExternalWorkspaceOwnership.requireCurrent(connection, original, binding, acquiring);
            return work.apply(connection, owner, current);
        }));
    }

    @FunctionalInterface
    private interface ExternalWork<T> {
        T apply(java.sql.Connection connection, JdbcExternalWorkspaceOwnership.Owner owner,
                RuntimeBindingRecord current) throws java.sql.SQLException;
    }

    public void claim(ContextBinding binding, RuntimeSessionRecord session) {
        WorkspaceStorageKindGuard.requireFreshTransaction();
        if (residents.find(binding) != null) {
            // Read-only check with no tenant guard: it writes nothing a concurrent transition could
            // observe, so it orders before any transition that commits after its snapshot.
            transaction.executeWithoutResult(status -> requireResidentHeld(binding, session, false));
            return;
        }
        WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        String key = storageKey(binding);
        List<Long> revisions = jdbc.query("SELECT mount_revision FROM ma_storage_owner WHERE storage_key = ?"
                + " AND mount_state = 'READY' AND storage_kind IN ('LOCAL', 'SSH_LOCAL')",
                (row, index) -> row.getLong("mount_revision"), key);
        if (revisions.size() != 1) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        long mountRevision = revisions.getFirst();
        if (storageGuard != null) {
            storageGuard.verify(binding);
        }
        transaction.executeWithoutResult(status -> admit(binding, session, key, mountRevision));
    }

    private void admit(ContextBinding binding, RuntimeSessionRecord session, String key, long mountRevision) {
        WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        if (!key.equals(storageKey(binding))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        WorkspaceMigrationAdmission.requireOpen(jdbc, binding.getTenantId(), binding.getStorageId());
        List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state, is_drain_requested,"
                + " tenant_id, workspace_id, workspace_generation, storage_id FROM ma_runtime_binding"
                + " WHERE binding_id = ? " + bindingShareLock(), (row, index) ->
                        session.getBindingId().equals(row.getString("binding_id"))
                        && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                        && "READY".equals(row.getString("binding_state")) && !row.getBoolean("is_drain_requested")
                        && binding.getTenantId().equals(row.getString("tenant_id"))
                        && binding.getWorkspaceId().equals(row.getString("workspace_id"))
                        && Long.toString(binding.getWorkspaceGeneration()).equals(row.getString("workspace_generation"))
                        && binding.getStorageId().equals(row.getString("storage_id")), session.getBindingId());
        if (live.size() != 1 || !live.getFirst()) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        List<String> held = jdbc.query("SELECT binding_id, runtime_generation, runtime_session_id,"
                + " harness_session_id, session_state, execution_storage_key FROM ma_runtime_session"
                + " WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_id = ? FOR UPDATE",
                (row, index) -> {
                    if (!session.getBindingId().equals(row.getString("binding_id"))
                            || session.getRuntimeGeneration() != row.getLong("runtime_generation")
                            || !session.getRuntimeSessionId().equals(row.getString("runtime_session_id"))
                            || !session.getSession().getHarnessSessionId().equals(row.getString("harness_session_id"))
                            || (!"ACQUIRING".equals(row.getString("session_state"))
                                    && !"READY".equals(row.getString("session_state")))) {
                        throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                    }
                    return row.getString("execution_storage_key");
                },
                session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId());
        if (held.size() != 1) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (key.equals(held.getFirst())) {
            if (!directoryAdmits(key, exclusiveMemberKey(session))) {
                throw busy();
            }
            return;
        }
        if (held.getFirst() != null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        if (jdbc.update("UPDATE ma_storage_owner SET member_count = member_count + 1 WHERE storage_key = ?"
                + " AND mount_state = 'READY' AND mount_revision = ? AND holder_key IS NULL"
                + " AND maintenance_id IS NULL AND exclusive_member_key IS NULL",
                key, mountRevision) != 1) {
            throw busy();
        }
        if (jdbc.update("UPDATE ma_runtime_session SET execution_storage_key = ? WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id = ? AND harness_session_id = ?"
                + " AND session_state IN ('ACQUIRING', 'READY') AND execution_storage_key IS NULL",
                key, session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId(),
                session.getSession().getHarnessSessionId()) != 1) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    /** H2 has no share-lock syntax, so its tests take the stricter point lock. */
    private String bindingShareLock() {
        Boolean h2 = jdbc.execute((ConnectionCallback<Boolean>) connection ->
                "H2".equals(connection.getMetaData().getDatabaseProductName()));
        return Boolean.TRUE.equals(h2) ? "FOR UPDATE" : "FOR SHARE";
    }

    private boolean directoryAdmits(String key, String member) {
        List<Boolean> open = jdbc.query("SELECT holder_key, maintenance_id, mount_state, exclusive_member_key"
                + " FROM ma_storage_owner WHERE storage_key = ?", (row, index) ->
                        row.getString("holder_key") == null && row.getString("maintenance_id") == null
                        && "READY".equals(row.getString("mount_state"))
                        && (row.getString("exclusive_member_key") == null
                                || member.equals(row.getString("exclusive_member_key"))), key);
        return open.size() == 1 && Boolean.TRUE.equals(open.getFirst());
    }

    public boolean beginRewind(ContextBinding binding, RuntimeSessionRecord session) {
        if (storageGuard != null) {
            storageGuard.requireOwnedRoot(binding.getTenantId(), binding.getStorageId());
        }
        return Boolean.TRUE.equals(transaction.execute(status -> {
            String key = storageKey(binding);
            if (!isHeld(binding, session)) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            String member = exclusiveMemberKey(session);
            if (jdbc.update("UPDATE ma_storage_owner SET exclusive_member_key = ? WHERE storage_key = ?"
                    + " AND member_count = 1 AND mount_state = 'READY' AND exclusive_member_key IS NULL",
                    member, key) != 1) {
                if (member.equals(exclusiveMember(key))) {
                    throw new RuntimeBrokerException(409, "workspace_rewind_recovery_required",
                            "An earlier Workspace rewind has an unconfirmed outcome.", false);
                }
                return false;
            }
            if (jdbc.update("UPDATE ma_runtime_session SET is_execution_exclusive = TRUE WHERE binding_id = ?"
                    + " AND runtime_generation = ? AND runtime_session_id = ? AND execution_storage_key = ?",
                    session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId(), key) != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            return true;
        }));
    }

    public void endRewind(ContextBinding binding, RuntimeSessionRecord session) {
        transaction.executeWithoutResult(status -> {
            String key = storageKey(binding);
            int cleared = jdbc.update("UPDATE ma_runtime_session SET is_execution_exclusive = FALSE WHERE binding_id = ?"
                    + " AND runtime_generation = ? AND runtime_session_id = ? AND execution_storage_key = ?"
                    + " AND is_execution_exclusive = TRUE",
                    session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId(), key);
            if (cleared == 1 && jdbc.update("UPDATE ma_storage_owner SET exclusive_member_key = NULL"
                    + " WHERE storage_key = ? AND exclusive_member_key = ?", key, exclusiveMemberKey(session)) != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
        });
    }

    public boolean hasExclusiveClaim(RuntimeSessionRecord session) {
        return !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id = ? AND execution_storage_key IS NOT NULL"
                + " AND is_execution_exclusive = TRUE", String.class, session.getBindingId(), session.getRuntimeGeneration(),
                session.getRuntimeSessionId()).isEmpty();
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
        if (hasExclusiveClaim(session)) {
            throw new RuntimeBrokerException(409, "workspace_rewind_recovery_required",
                    "Workspace rewind is active or has an unconfirmed outcome.", false);
        }
    }

    public boolean isHeld(ContextBinding binding, RuntimeSessionRecord session) {
        if (residents.find(binding) != null) {
            requireResidentHeld(binding, session, true);
            return session.getState() != RuntimeSessionRecord.State.RELEASED;
        }
        WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        String key = storageKey(binding);
        if (jdbc.queryForList("SELECT storage_key FROM ma_storage_owner WHERE storage_key = ?"
                + " AND storage_kind IN ('LOCAL', 'SSH_LOCAL') AND holder_key IS NULL AND maintenance_id IS NULL",
                String.class, key).isEmpty()) {
            return false;
        }
        return !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session WHERE execution_storage_key = ?"
                + " AND binding_id = ? AND runtime_generation = ? AND runtime_session_id = ? AND harness_session_id = ?",
                String.class, key, session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId(),
                session.getSession().getHarnessSessionId()).isEmpty();
    }

    public void release(ContextBinding binding, RuntimeSessionRecord session) {
        if (residents.find(binding) != null) {
            // Read-only like the resident claim: no tenant guard.
            transaction.executeWithoutResult(status -> {
                requireResidentHeld(binding, session, true);
                if (session.getState() != RuntimeSessionRecord.State.RELEASING
                        && session.getState() != RuntimeSessionRecord.State.RELEASED) {
                    throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                }
            });
            return;
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, binding.getTenantId(), binding.getStorageId());
            String key = storageKey(binding);
            List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state"
                    + " FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE",
                    (row, index) -> session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && ("READY".equals(row.getString("binding_state"))
                                    || "DRAINING".equals(row.getString("binding_state"))),
                    session.getBindingId());
            if (live.size() != 1 || !live.getFirst()) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            int cleared = jdbc.update("UPDATE ma_runtime_session SET execution_storage_key = NULL, is_execution_exclusive = FALSE"
                    + " WHERE execution_storage_key = ? AND binding_id = ? AND runtime_generation = ?"
                    + " AND runtime_session_id = ? AND harness_session_id = ?", key, session.getBindingId(),
                    session.getRuntimeGeneration(), session.getRuntimeSessionId(), session.getSession().getHarnessSessionId());
            releaseMembers(jdbc, key, cleared, exclusiveMemberKey(session));
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
            WorkspaceOperations.Kind kind = WorkspaceMaintenanceRecovery.kind(jdbc, binding, maintenanceId);
            List<Long> generations = jdbc.queryForList("SELECT claim_generation FROM ma_operation WHERE operation_key = ? AND operation_kind = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW + " FOR UPDATE",
                    Long.class, WorkspaceOperations.key(kind, binding.getTenantId(), maintenanceId), kind.name());
            if (generations.size() != 1 || generations.getFirst() != claimGeneration) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            if (storageGuard != null) {
                storageGuard.verifyLocked(binding);
            }
            if (jdbc.update("UPDATE ma_storage_owner SET holder_key = ?,"
                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL,"
                    + " maintenance_id = ?, maintenance_generation = ? WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                    + " AND member_count = 0 AND (holder_key IS NULL OR holder_key = ?)",
                    holder, maintenanceId, claimGeneration, key, holder) != 1) {
                throw busy();
            }
            return WorkspaceMaintenanceRecovery.recordStart(jdbc, binding, maintenanceId, claimGeneration);
        });
    }

    /** Releases a maintenance hold, and only the one this claim took. */
    public void releaseMaintenance(ContextBinding binding, String maintenanceId,
            long claimGeneration, String executionId) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            String key = storageKey(binding);
            if (!WorkspaceMaintenanceRecovery.recordReturned(jdbc, binding, maintenanceId, claimGeneration, executionId)) {
                return;
            }
            int released = jdbc.update("UPDATE ma_storage_owner SET holder_key = NULL,"
                    + " maintenance_id = NULL, maintenance_generation = NULL WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                    + " AND holder_key = ? AND maintenance_id = ? AND maintenance_generation = ?", key,
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
        if (com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE.equals(saved.getRequest().getProvisionerKind())) {
            WorkspaceStorageKindGuard.requireFreshTransaction();
            return transaction.execute(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Boolean>) connection ->
                    JdbcExternalWorkspaceOwnership.hasHolder(connection,
                            JdbcExternalWorkspaceOwnership.lockOwner(connection, saved), saved)));
        }
        return !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session"
                + " WHERE binding_id = ? AND runtime_generation = ? AND execution_storage_key IS NOT NULL LIMIT 1",
                String.class, saved.getBindingId(), saved.getGeneration()).isEmpty();
    }

    public boolean canStopExternalDrained(RuntimeBindingRecord saved, RuntimeBindingRepository repository) {
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(saved.getRequest())
                || HarnessOwnership.sharesRuntimeSessions(saved.getRequest())
                || saved.getState() != RuntimeBindingRecord.State.DRAINING && saved.getState() != RuntimeBindingRecord.State.LOST
                || !saved.isDrainRequested()
                || saved.getOperationOwner() == null) {
            return false;
        }
        return external(null, saved, repository,
                saved.getRequest().getScope(),
                saved.getRequest().getIsolationKey(), false,
                (connection, owner, current) -> {
                JdbcExternalWorkspaceOwnership.requireDrainMembers(connection, owner, current);
                return noActiveExecutions(current);
            });
    }

    private boolean noActiveExecutions(RuntimeBindingRecord binding) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE binding_id = ?"
                + " AND runtime_generation = ? AND execution_state NOT IN ('SETTLED', 'ABANDONED')", Long.class,
                binding.getBindingId(), binding.getGeneration()) == 0;
    }

    public boolean canStopDrained(RuntimeBindingRecord saved) {
        if ((saved.getState() != RuntimeBindingRecord.State.DRAINING && saved.getState() != RuntimeBindingRecord.State.LOST)
                || !saved.isDrainRequested() || !saved.getRequest().isManagedContext() || saved.getOperationOwner() == null
                || !java.util.Set.of(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS, com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.SSH_PROCESS).contains(saved.getRequest().getProvisionerKind())
                || !(WorkspaceExecutionProfile.admitsIsolationClass(saved.getRequest().getScope().getIsolationClass())
                        || HarnessOwnership.sharesRuntimeSessions(saved.getRequest()))) {
            return false;
        }
        var claims = jdbc.query("SELECT binding_state, is_drain_requested, operation_owner, operation_generation,"
                + " operation_lease_until, tenant_id, storage_id, UNIX_TIMESTAMP() AS db_seconds,"
                + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) AS db_micros FROM ma_runtime_binding"
                + " WHERE binding_id = ? AND runtime_generation = ?", (row, index) ->
                        saved.getState().name().equals(row.getString("binding_state")) && row.getBoolean("is_drain_requested")
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
        String physical = storageKey(saved.getRequest().getScope().getTenantId(), saved.getRequest().getStorageId());
        var members = jdbc.query("SELECT execution_storage_key, harness_session_id, tenant_id FROM ma_runtime_session"
                + " WHERE binding_id = ? AND runtime_generation = ? AND execution_storage_key IS NOT NULL", (row, index) ->
                        physical.equals(row.getString("execution_storage_key"))
                                && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                                && (HarnessOwnership.sharesRuntimeSessions(saved.getRequest())
                                        || saved.getRequest().getIsolationKey().equals(row.getString("harness_session_id"))),
                saved.getBindingId(), saved.getGeneration());
        if (members.contains(false)) {
            return false;
        }
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE storage_key = ?"
                + " AND storage_kind IN ('LOCAL', 'SSH_LOCAL') AND (holder_key IS NOT NULL OR maintenance_id IS NOT NULL)",
                Long.class, physical) == 0;
    }

    public void releaseLost(RuntimeBindingRecord saved) {
        if (com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE.equals(saved.getRequest().getProvisionerKind())) {
            // LOST cannot bypass the persisted native receipt and DRAINING lifecycle gate.
            throw unavailable();
        }
        if (!saved.getRequest().isManagedContext() || saved.getState() != RuntimeBindingRecord.State.LOST
                || !saved.hasStoppedWriters() || saved.getOperationOwner() == null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, saved.getRequest().getScope().getTenantId());
            String key = hasHolder(saved)
                    ? storageKey(saved.getRequest().getScope().getTenantId(), saved.getRequest().getStorageId()) : null;
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
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            var memberKeys = jdbc.queryForList("SELECT execution_storage_key FROM ma_runtime_session"
                    + " WHERE binding_id = ? AND runtime_generation = ? AND execution_storage_key IS NOT NULL FOR UPDATE",
                    String.class, saved.getBindingId(), saved.getGeneration());
            if (memberKeys.isEmpty()) {
                return;
            }
            if (key == null || memberKeys.stream().anyMatch(member -> !key.equals(member))) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding WHERE binding_id = ?"
                    + " AND runtime_generation = ? AND operation_owner = ? AND operation_generation = ?"
                    + " AND operation_lease_until > " + ManagedSchemaTime.SQL_NOW, Long.class, saved.getBindingId(),
                    saved.getGeneration(), saved.getOperationOwner(), saved.getOperationGeneration()) != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            List<String> exclusiveSessions = jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session"
                    + " WHERE binding_id = ? AND runtime_generation = ? AND execution_storage_key = ?"
                    + " AND is_execution_exclusive = TRUE", String.class, saved.getBindingId(), saved.getGeneration(), key);
            int cleared = jdbc.update("UPDATE ma_runtime_session SET execution_storage_key = NULL, is_execution_exclusive = FALSE"
                    + " WHERE binding_id = ? AND runtime_generation = ? AND execution_storage_key = ?",
                    saved.getBindingId(), saved.getGeneration(), key);
            releaseMembers(jdbc, key, cleared, exclusiveSessions.isEmpty()
                    ? "" : exclusiveMemberKey(saved.getBindingId(), saved.getGeneration(), exclusiveSessions.getFirst()));
        });
    }

    // qwen-code, or a Session that pinned a compiled definition (D8c-1).
    private static boolean executableAgent(String agentId,
            String agentDefinitionDigest) {
        return "qwen-code".equals(agentId) || agentDefinitionDigest != null;
    }

    // Same structural refusal, with the discarded cause kept for the log:
    // without it a failed mount verification reports nothing but the verdict.

    // A probe's momentary I/O failure is not the structural verdict the
    // terminal refusal promises: it retries through the delivery machine,
    // keeping the cause for the log. Structural refusals keep
    // com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable().

    // A creation grant or the registry state changes under operator
    // control: refusing a committed decision over it is not the
    // structural verdict of com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable(), and the delivery machine must
    // retry so a restored grant still reaches the Harness. Structural
    // refusals keep com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable().

    static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_busy",
                "Workspace storage is held by another tool turn.", true);
    }

    static String exclusiveMemberKey(RuntimeSessionRecord session) {
        return exclusiveMemberKey(session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId());
    }

    public static String exclusiveMemberKey(String bindingId, long generation, String runtimeSessionId) {
        return digest(bindingId + "\u0000" + generation + "\u0000" + runtimeSessionId);
    }

    static void releaseMembers(JdbcTemplate jdbc, String storageKey, int count, String exclusiveMemberKey) {
        if (count > 0 && jdbc.update(RELEASE_MEMBERS, count, exclusiveMemberKey, storageKey, count) != 1) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    public static void releaseMembers(Connection connection, String storageKey, int count, String exclusiveMemberKey)
            throws SQLException {
        if (count <= 0) {
            return;
        }
        try (var statement = connection.prepareStatement(RELEASE_MEMBERS)) {
            statement.setInt(1, count);
            statement.setString(2, exclusiveMemberKey);
            statement.setString(3, storageKey);
            statement.setInt(4, count);
            if (statement.executeUpdate() != 1) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
        }
    }

    private String exclusiveMember(String key) {
        List<String> keys = jdbc.query("SELECT exclusive_member_key FROM ma_storage_owner WHERE storage_key = ?",
                (row, index) -> row.getString("exclusive_member_key"), key);
        return keys.size() == 1 ? keys.getFirst() : null;
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

    private static final String RELEASE_MEMBERS = "UPDATE ma_storage_owner SET member_count = member_count - ?,"
            + " exclusive_member_key = CASE WHEN exclusive_member_key = ? THEN NULL ELSE exclusive_member_key END"
            + " WHERE storage_key = ? AND member_count >= ?";

    private static String maintenanceHolderKey(String maintenanceId, long claimGeneration) {
        return digest("child-workspace\u0000" + maintenanceId + "\u0000" + claimGeneration);
    }

    private static String digest(String value) {
        try {
            return DigestUtils.sha256Hex(value.getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
