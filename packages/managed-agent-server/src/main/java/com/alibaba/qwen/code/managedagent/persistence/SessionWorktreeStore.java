package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeGit;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

@Repository
public class SessionWorktreeStore {
    public static final String KIND = "SESSION_WORKTREE";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SELECT = "SELECT w.*, o.claim_owner, o.claim_generation, o.claim_until, o.phase, o.attempt_count"
            + " FROM ma_session_worktree w JOIN ma_operation o ON o.operation_kind = 'SESSION_WORKTREE'"
            + " AND o.tenant_id = w.tenant_id AND o.operation_id = w.operation_id";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ManagedWorkspaceRegistry registry;
    private final WorkspaceStorageGuard guard;
    private String resumeAfter = "";

    @Autowired
    public SessionWorktreeStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            ManagedWorkspaceRegistry registry, WorkspaceStorageGuard guard) {
        this(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), registry, guard);
    }

    public SessionWorktreeStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedWorkspaceRegistry registry, WorkspaceStorageGuard guard) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.registry = registry;
        this.guard = guard;
    }

    public record Plan(String tenantId, String workspaceId, long workspaceGeneration, String storageId,
            String sourceCwdRelative, String contextConfigRef, long contextRevision, String root, String rootIdentity,
            String repositoryRelative, String sourceOffset, String commonDirectory, String commonIdentity,
            String baseRef, String baseCommit, String worktreeId, String worktreeRoot, String cwdRelative, String branch,
            String storageIdentity) {
        public Plan(String tenantId, String workspaceId, long workspaceGeneration, String storageId,
                String sourceCwdRelative, String contextConfigRef, long contextRevision, String root, String rootIdentity,
                String repositoryRelative, String sourceOffset, String commonDirectory, String commonIdentity,
                String baseRef, String baseCommit, String worktreeId, String worktreeRoot, String cwdRelative, String branch) {
            this(tenantId, workspaceId, workspaceGeneration, storageId, sourceCwdRelative, contextConfigRef, contextRevision,
                    root, rootIdentity, repositoryRelative, sourceOffset, commonDirectory, commonIdentity, baseRef,
                    baseCommit, worktreeId, worktreeRoot, cwdRelative, branch, null);
        }
        public ContextBinding source() {
            return new ContextBinding(tenantId, workspaceId, workspaceGeneration, storageId, sourceCwdRelative,
                    contextConfigRef, contextRevision);
        }

        public ResolvedBinding target(ResolvedBinding source) {
            if (!source().equals(source.binding())) {
                throw error("worktree_source_changed");
            }
            return new ResolvedBinding(new ContextBinding(tenantId, workspaceId, workspaceGeneration, storageId,
                    cwdRelative, source.binding().getContextConfigRef(), 1), source.configRef(), source.policyRef());
        }
    }

    public record Descriptor(String id, String sessionId, String workspaceId, String state, String branch,
            String baseCommit, String cwdRelative, String operationId, long revision, String errorCode) {
        public String worktreeId() {
            return id;
        }
    }

    public record Row(String tenantId, String sessionId, String workspaceId, String worktreeId, String state,
            Plan plan, String identityJson, String operationId, String claimedBy, long generation,
            Long claimUntil, String phase, int attempts, long revision, String errorCode, String actor) {
        public Descriptor descriptor() {
            return descriptor(plan.branch());
        }

        public Descriptor descriptor(String branch) {
            return new Descriptor(worktreeId, sessionId, workspaceId, state.toLowerCase(Locale.ROOT), branch,
                    plan.baseCommit(), plan.cwdRelative(), operationId, revision, errorCode);
        }
    }

    public record SourceLocation(ResolvedBinding resolved, Path root, String storageIdentity) { }

    public SourceLocation source(String tenant, String actor, com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection selection) {
        return transaction.execute(status -> {
            WorkspaceMigrationAdmission.lockTenant(jdbc, tenant);
            ResolvedBinding source = registry.resolveForCreation(tenant, actor, selection);
            Path root = guard.verifiedRoot(source.binding());
            return new SourceLocation(source, root, storageIdentity(source.binding()));
        });
    }

    public void authorizeOptions(String tenant, String actor, String workspace) {
        var access = registry.accessOf(tenant, actor, workspace);
        if (!access.canRead()) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND, "workspace_not_found", "Workspace not found.");
        }
        if (!access.canCreate()) {
            throw new ManagedAgentException(HttpStatus.FORBIDDEN, "workspace_forbidden", "Workspace cannot be used.");
        }
    }

    public boolean active(Row row) {
        return jdbc.queryForList("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, row.tenantId(), row.sessionId()).equals(List.of("ACTIVE"));
    }

    public Descriptor describe(String tenant, String session) {
        return descriptor(jdbc, tenant, session);
    }

    public void admit(String tenant, String actor, String session, Plan plan, ResolvedBinding source) {
        plan.target(source);
        if (!tenant.equals(plan.tenantId()) || !guard.verifiedRoot(source.binding()).toString().equals(plan.root())) {
            throw error("worktree_source_changed");
        }
        SessionWorktreeGit.requireRoot(plan);
        if (plan.storageIdentity() != null && !plan.storageIdentity().equals(storageIdentity(source.binding()))) {
            throw error("worktree_source_changed");
        }
        long now = System.currentTimeMillis();
        String physical = WorkspaceExecutionStore.storageKey(jdbc, plan.source());
        jdbc.update("INSERT INTO ma_session_worktree (tenant_id, session_id, workspace_id, storage_id, physical_key,"
                        + " worktree_id, owner_actor_key, state, revision, plan_json, operation_id, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARING', 1, ?, ?, ?, ?)",
                tenant, session, plan.workspaceId(), plan.storageId(), physical, plan.worktreeId(),
                ManagedWorkspaceRegistry.actorKey(tenant, actor), json(plan), plan.worktreeId(), now, now);
        createOperation(tenant, session, plan, plan.worktreeId(), "PREPARING", null);
    }

    private void createOperation(String tenant, String session, Plan plan, String id, String state, String request) {
        new WorkspaceOperations(jdbc, tenant).create(WorkspaceOperations.Kind.SESSION_WORKTREE, id,
                WorkspaceOperations.values("session_id", session, "storage_id", plan.storageId(), "state", state,
                        "phase", state, "delivery_state", "PENDING", "request_json", request == null ? json(plan) : request));
    }

    public static Descriptor descriptor(JdbcTemplate jdbc, String tenant, String session) {
        Row row = find(jdbc, tenant, session);
        return verifiedDescriptor(jdbc, row);
    }

    private static Descriptor verifiedDescriptor(JdbcTemplate jdbc, Row row) {
        if (row != null && "READY".equals(row.state())) {
            try {
                return row.descriptor(SessionWorktreeGit.currentBranch(SessionWorktreeGit.verify(row.plan(), row.identityJson())));
            } catch (ManagedAgentException exception) {
                long revision = blockIdentity(jdbc, row, exception.getCode());
                return new Descriptor(row.worktreeId(), row.sessionId(), row.workspaceId(), "blocked", row.plan().branch(),
                        row.plan().baseCommit(), row.plan().cwdRelative(), row.operationId(), revision, exception.getCode());
            }
        }
        return row == null ? null : row.descriptor();
    }

    public static boolean isReady(JdbcTemplate jdbc, String tenant, String session) {
        Descriptor descriptor = descriptor(jdbc, tenant, session);
        return descriptor == null || "ready".equals(descriptor.state());
    }

    public static Map<String, Descriptor> descriptors(JdbcTemplate jdbc, String tenant, List<String> sessions) {
        if (sessions.isEmpty()) {
            return Map.of();
        }
        var args = new java.util.ArrayList<Object>();
        args.add(tenant);
        args.addAll(sessions);
        return descriptors(jdbc, jdbc.query(SELECT + " WHERE w.tenant_id = ? AND w.session_id IN ("
                        + String.join(",", java.util.Collections.nCopies(sessions.size(), "?")) + ")",
                (record, index) -> row(record, index), args.toArray()));
    }

    static Map<String, Descriptor> descriptors(JdbcTemplate jdbc, List<Row> rows) {
        var result = new java.util.LinkedHashMap<String, Descriptor>();
        rows.forEach(row -> result.put(row.sessionId(), verifiedDescriptor(jdbc, row)));
        return result;
    }

    public static void requireReady(JdbcTemplate jdbc, String tenant, String session) {
        Descriptor descriptor = descriptor(jdbc, tenant, session);
        if (descriptor != null && !"ready".equals(descriptor.state())) {
            throw error(descriptor.errorCode() == null ? "worktree_" + descriptor.state() : descriptor.errorCode());
        }
    }

    public static void requireCwd(JdbcTemplate jdbc, String tenant, String session, String cwd) {
        Row row = find(jdbc, tenant, session);
        if (row != null && !Path.of(cwd).normalize().startsWith(Path.of(row.plan().worktreeRoot()))) {
            throw error("worktree_cwd_outside");
        }
    }

    public static Row find(JdbcTemplate jdbc, String tenant, String session) {
        List<Row> rows = jdbc.query(SELECT + " WHERE w.tenant_id = ? AND w.session_id = ?",
                SessionWorktreeStore::row, tenant, session);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public Row get(String tenant, String actor, String workspace, String id, boolean write) {
        var access = registry.accessOf(tenant, actor, workspace);
        if (!access.canRead() || write && !access.canCreate()) {
            throw notFound();
        }
        List<Row> rows = jdbc.query(SELECT + " WHERE w.tenant_id = ? AND w.workspace_id = ? AND w.worktree_id = ?",
                SessionWorktreeStore::row, tenant, workspace, id);
        if (rows.size() != 1) {
            throw notFound();
        }
        if (write && jdbc.queryForList("SELECT 1 FROM ma_session_worktree WHERE tenant_id = ? AND worktree_id = ?"
                        + " AND owner_actor_key = ?", Integer.class, tenant, id, ManagedWorkspaceRegistry.actorKey(tenant, actor)).isEmpty()) {
            throw notFound();
        }
        return rows.getFirst();
    }

    public List<Descriptor> list(String tenant, String actor, String workspace) {
        if (!registry.accessOf(tenant, actor, workspace).canRead()) {
            throw notFound();
        }
        List<Row> rows = jdbc.query(SELECT + " WHERE w.tenant_id = ? AND w.workspace_id = ? AND w.state <> 'REMOVED' ORDER BY w.gmt_create DESC",
                SessionWorktreeStore::row, tenant, workspace);
        var descriptions = descriptors(jdbc, tenant, rows.stream().map(Row::sessionId).toList());
        return rows.stream().map(row -> descriptions.get(row.sessionId())).toList();
    }

    public List<Row> due() {
        long now = System.currentTimeMillis();
        return jdbc.query(SELECT + " WHERE w.state IN ('PREPARING', 'REMOVING') AND o.delivery_state = 'PENDING'"
                + " AND o.available_at <= ? AND (o.claim_until IS NULL OR o.claim_until <= ?) ORDER BY o.available_at LIMIT 20",
                SessionWorktreeStore::row, now, now);
    }

    public List<String[]> failedInitialSessions() {
        return jdbc.query("SELECT DISTINCT w.tenant_id, w.session_id, w.failure_code FROM ma_session_worktree w"
                + " JOIN ma_turn t ON t.tenant_id = w.tenant_id AND t.session_id = w.session_id"
                + " WHERE w.state IN ('FAILED','BLOCKED') AND t.status = 'ACCEPTED' AND t.submission_attempted = FALSE LIMIT 20",
                (result, index) -> new String[] {result.getString("tenant_id"), result.getString("session_id"), result.getString("failure_code")});
    }

    public Row claim(Row row, String owner, long leaseMillis) {
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, row.tenantId());
            long now = System.currentTimeMillis();
            if (jdbc.queryForList("SELECT 1 FROM ma_operation WHERE operation_key = ? AND delivery_state = 'PENDING'"
                            + " AND (claim_until IS NULL OR claim_until <= ?) FOR UPDATE", Integer.class, key(row), now).isEmpty()) {
                return null;
            }
            String physical = WorkspaceExecutionStore.storageKey(jdbc, storageBinding(row.plan()));
            if (!jdbc.queryForList("SELECT 1 FROM ma_storage_owner WHERE storage_key = ? AND maintenance_id = ?"
                    + " AND holder_key IS NOT NULL FOR UPDATE", Integer.class, physical, row.operationId()).isEmpty()) {
                jdbc.update("UPDATE ma_session_worktree SET state = 'BLOCKED', failure_code = 'maintenance_stop_unverified',"
                        + " revision = revision + 1 WHERE tenant_id = ? AND worktree_id = ?", row.tenantId(), row.worktreeId());
                return null;
            }
            if (jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_until = ?, claim_generation = claim_generation + 1"
                            + " WHERE operation_key = ? AND delivery_state = 'PENDING' AND (claim_until IS NULL OR claim_until <= ?)",
                    owner, now + leaseMillis, key(row), now) != 1) {
                return null;
            }
            return find(jdbc, row.tenantId(), row.sessionId());
        });
    }

    public boolean renew(Row row, String owner, long leaseMillis) {
        return jdbc.update("UPDATE ma_operation SET claim_until = ? WHERE operation_key = ? AND claim_owner = ?"
                        + " AND claim_generation = ? AND claim_until > ?", System.currentTimeMillis() + leaseMillis,
                key(row), owner, row.generation(), System.currentTimeMillis()) == 1;
    }

    public boolean complete(Row row, String owner, String state, String identity, String error) {
        return transaction.execute(status -> {
            if (!lockClaim(row, owner)) {
                return false;
            }
            jdbc.update("UPDATE ma_session_worktree SET state = ?, identity_json = COALESCE(?, identity_json),"
                            + " failure_code = ?, revision = revision + 1, gmt_modified = ? WHERE tenant_id = ? AND session_id = ?",
                    state, identity, error, System.currentTimeMillis(), row.tenantId(), row.sessionId());
            jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, delivery_state = 'DONE', failure_code = ?,"
                            + " completed_at = ?, claim_owner = NULL, claim_until = NULL WHERE operation_key = ?",
                    state, state, error, System.currentTimeMillis(), key(row));
            return true;
        });
    }

    public void defer(Row row, String owner, String error) {
        defer(row, owner, error, false);
    }

    public void retry(Row row, String owner, String error) {
        defer(row, owner, error, true);
    }

    private void defer(Row row, String owner, String error, boolean failure) {
        transaction.executeWithoutResult(status -> {
            if (lockClaim(row, owner)) {
                long delay = failure ? Math.min(60000, 1000L << Math.min(row.attempts(), 6)) : 1000;
                jdbc.update("UPDATE ma_operation SET available_at = ?, attempt_count = attempt_count + ?,"
                                + " claim_owner = NULL, claim_until = NULL WHERE operation_key = ?",
                        System.currentTimeMillis() + delay, failure ? 1 : 0, key(row));
                jdbc.update("UPDATE ma_session_worktree SET failure_code = ? WHERE tenant_id = ? AND session_id = ?",
                        error, row.tenantId(), row.sessionId());
            }
        });
    }

    public void resumeStopped() {
        List<Row> candidates = jdbc.query(SELECT + " WHERE w.state = 'BLOCKED' AND w.failure_code = 'maintenance_stop_unverified'"
                + " AND w.worktree_id > ? ORDER BY w.worktree_id LIMIT 20", SessionWorktreeStore::row, resumeAfter);
        resumeAfter = candidates.isEmpty() ? "" : candidates.getLast().worktreeId();
        for (Row row : candidates) {
            transaction.executeWithoutResult(status -> {
                WorkspaceStorageKindGuard.lockDomain(jdbc, row.tenantId());
                Row current = find(jdbc, row.tenantId(), row.sessionId());
                if (current == null || !"BLOCKED".equals(current.state()) || !current.operationId().equals(row.operationId())
                        || current.generation() != row.generation()) {
                    return;
                }
                var binding = storageBinding(row.plan());
                if (maintenanceHeld(row) || !WorkspaceMaintenanceRecovery.stopped(jdbc, binding, row.operationId(), row.generation())) {
                    return;
                }
                String state = row.operationId().equals(row.worktreeId()) ? "PREPARING" : "REMOVING";
                jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, delivery_state = 'PENDING', available_at = 0,"
                        + " claim_owner = NULL, claim_until = NULL, failure_code = NULL WHERE operation_key = ?", state, state, key(row));
                jdbc.update("UPDATE ma_session_worktree SET state = ?, failure_code = NULL, revision = revision + 1"
                        + " WHERE tenant_id = ? AND session_id = ? AND state = 'BLOCKED'", state, row.tenantId(), row.sessionId());
            });
        }
    }

    public boolean maintenanceHeld(Row row) {
        return !jdbc.queryForList("SELECT 1 FROM ma_storage_owner WHERE storage_key = ? AND maintenance_id = ?"
                        + " AND holder_key IS NOT NULL", Integer.class, WorkspaceExecutionStore.storageKey(jdbc, storageBinding(row.plan())),
                row.operationId()).isEmpty();
    }

    public Row cleanup(String tenant, String actor, String workspace, String id, String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 512) {
            throw error("invalid_idempotency_key");
        }
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant);
            Row row = get(tenant, actor, workspace, id, true);
            String operation = UUID.nameUUIDFromBytes((tenant + "\0" + actor + "\0" + id + "\0" + idempotencyKey)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString().replace("-", "");
            if (row.operationId().equals(operation) || "REMOVED".equals(row.state())) {
                return row;
            }
            if (!jdbc.queryForList("SELECT 1 FROM ma_operation WHERE operation_kind = 'SESSION_WORKTREE'"
                    + " AND tenant_id = ? AND operation_id = ?", Integer.class, tenant, operation).isEmpty()) {
                return row;
            }
            String blocker = cleanupBlocker(row);
            if (!List.of("READY", "FAILED").contains(row.state()) || blocker != null) {
                throw error(blocker == null ? "worktree_not_ready" : blocker);
            }
            createOperation(tenant, row.sessionId(), row.plan(), operation, "REMOVING",
                    json(Map.of("worktreeId", id, "actor", actor, "idempotencyKey", idempotencyKey)));
            jdbc.update("UPDATE ma_session_worktree SET state = 'REMOVING', operation_id = ?, revision = revision + 1,"
                    + " failure_code = NULL WHERE tenant_id = ? AND worktree_id = ?", operation, tenant, id);
            return find(jdbc, tenant, row.sessionId());
        });
    }

    public String cleanupBlocker(Row row) {
        if (!registry.accessOf(row.tenantId(), row.actor(), row.workspaceId()).canCreate()) {
            return "worktree_forbidden";
        }
        var states = jdbc.queryForList("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, row.tenantId(), row.sessionId());
        if (states.size() != 1 || !List.of("CLOSED", "ARCHIVED", "DELETED").contains(states.getFirst())) {
            return "worktree_session_active";
        }
        if (!jdbc.queryForList("SELECT 1 FROM ma_runtime_session WHERE tenant_id = ? AND harness_session_id = ?"
                        + " AND (session_state <> 'RELEASED' OR execution_storage_key IS NOT NULL)", Integer.class,
                row.tenantId(), row.sessionId()).isEmpty()) {
            return "worktree_runtime_busy";
        }
        if (!jdbc.queryForList("SELECT 1 FROM ma_workspace WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND workspace_kind = 'CHILD_GIT' AND child_state IN ('preparing','ready','merging','applying','applied','discarding','blocked')",
                Integer.class, row.tenantId(), row.sessionId()).isEmpty()) {
            return "worktree_children_busy";
        }
        if (!jdbc.queryForList("SELECT 1 FROM ma_operation WHERE tenant_id = ? AND session_id = ?"
                        + " AND operation_kind IN ('WORKSPACE_UPLOAD','CHILD_SESSION_START','CHILD_SESSION_CLOSE')"
                        + " AND completed_at IS NULL AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')",
                Integer.class, row.tenantId(), row.sessionId()).isEmpty()) {
            return "worktree_operations_busy";
        }
        return null;
    }

    private boolean lockClaim(Row row, String owner) {
        return !jdbc.queryForList("SELECT 1 FROM ma_operation WHERE operation_key = ? AND claim_owner = ?"
                        + " AND claim_generation = ? AND claim_until > ? FOR UPDATE", Integer.class,
                key(row), owner, row.generation(), System.currentTimeMillis()).isEmpty();
    }

    private static long blockIdentity(JdbcTemplate jdbc, Row row, String code) {
        // The refused caller may roll back its own admission transaction.
        var update = new TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(
                java.util.Objects.requireNonNull(jdbc.getDataSource())));
        update.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return java.util.Objects.requireNonNull(update.execute(status -> {
            jdbc.update("UPDATE ma_session_worktree SET state = 'BLOCKED', failure_code = ?, revision = revision + 1"
                            + " WHERE tenant_id = ? AND session_id = ? AND state = 'READY'", code, row.tenantId(), row.sessionId());
            return jdbc.queryForObject("SELECT revision FROM ma_session_worktree WHERE tenant_id = ? AND session_id = ?",
                    Long.class, row.tenantId(), row.sessionId());
        }));
    }

    private String storageIdentity(ContextBinding binding) {
        var alias = jdbc.queryForList("SELECT physical_key, registration_revision, mount_revision, fence_operation_id"
                        + " FROM ma_storage WHERE alias_key = ? FOR UPDATE",
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageAliasKey(binding.getTenantId(), binding.getStorageId()));
        var owner = jdbc.queryForList("SELECT mount_revision, mount_registration_id, mount_state, mount_operation_id"
                        + " FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE", WorkspaceExecutionStore.storageKey(jdbc, binding));
        return org.apache.commons.codec.digest.DigestUtils.sha256Hex(json(List.of(alias, owner)));
    }

    private static String key(Row row) {
        return WorkspaceOperations.key(WorkspaceOperations.Kind.SESSION_WORKTREE, row.tenantId(), row.operationId());
    }

    public static ContextBinding storageBinding(Plan plan) {
        return new ContextBinding(plan.tenantId(), plan.workspaceId(), plan.workspaceGeneration(), plan.storageId(),
                ".", plan.contextConfigRef(), plan.contextRevision());
    }

    private static Row row(ResultSet result, int index) throws SQLException {
        return readRow(result, "");
    }

    static Row readRow(ResultSet result, String prefix) throws SQLException {
        try {
            return new Row(result.getString(prefix + "tenant_id"), result.getString(prefix + "session_id"), result.getString(prefix + "workspace_id"),
                    result.getString(prefix + "worktree_id"), result.getString(prefix + "state"), JSON.readValue(result.getString(prefix + "plan_json"), Plan.class),
                    result.getString(prefix + "identity_json"), result.getString(prefix + "operation_id"), result.getString(prefix + "claim_owner"),
                    result.getLong(prefix + "claim_generation"), result.getObject(prefix + "claim_until") instanceof Number claim ? claim.longValue() : null, result.getString(prefix + "phase"),
                    result.getInt(prefix + "attempt_count"), result.getLong(prefix + "revision"), result.getString(prefix + "failure_code"), result.getString(prefix + "owner_actor_key"));
        } catch (java.io.IOException exception) {
            throw new IllegalStateException("Invalid Session worktree record", exception);
        }
    }

    private static String json(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (java.io.IOException exception) {
            throw new IllegalStateException("Invalid Session worktree identity", exception);
        }
    }

    private static ManagedAgentException error(String code) {
        return SessionWorktreeGit.error(code, "The Session worktree cannot perform this operation (" + code + ").");
    }

    private static ManagedAgentException notFound() {
        return new ManagedAgentException(HttpStatus.NOT_FOUND, "worktree_not_found", "Session worktree not found.");
    }
}
