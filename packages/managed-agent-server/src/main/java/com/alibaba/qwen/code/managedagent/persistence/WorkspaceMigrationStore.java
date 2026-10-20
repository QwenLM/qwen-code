package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.provisioning.LocalProcessRuntimeProvisioner;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceRecoveryStore.*;

/** Offline storage transition; public Session and journal evidence remain immutable. */
public final class WorkspaceMigrationStore {
    private final JdbcTemplate jdbc;
    private final PlatformTransactionManager manager;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard guard;
    private final RuntimeBindingRepository bindings;
    private final JsonNode request;
    private final String id;
    private final String tenant;
    private final String storage;

    private final WorkspaceOperations operations;
    private static final WorkspaceOperations.Kind KIND = WorkspaceOperations.Kind.STORAGE_MIGRATION;

    public WorkspaceMigrationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            WorkspaceStorageGuard guard, RuntimeBindingRepository bindings, byte[] bytes, boolean create) {
        this.jdbc = jdbc;
        this.manager = manager;
        this.transaction = new TransactionTemplate(manager);
        this.guard = guard;
        this.bindings = bindings;
        request = parse(bytes);
        check(request.path("version").isIntegralNumber() && request.path("version").canConvertToInt()
                && request.path("version").asInt() == 1, "invalid_request");
        id = uuid(request, "migrationOperationId");
        tenant = text(request, "tenantId");
        storage = text(request, "storageId");
        operations = new WorkspaceOperations(jdbc, tenant);
        check(tenant.length() <= 128 && storage.length() <= 256, "invalid_request");
        var existing = row(false);
        if (existing != null) {
            check(tenant.equals(existing.get("tenant_id")) && storage.equals(existing.get("storage_id"))
                    && hash(bytes).equals(existing.get("request_digest")), "operation_conflict");
            return;
        }
        check(create, "migration_not_found");
        String fence = uuid(request, "fenceOperationId");
        String capture = uuid(request, "captureOperationId");
        check(!id.equals(fence) && !id.equals(capture) && !fence.equals(capture), "invalid_request");
        long revision = positive(request, "mountRevision");
        check(revision < ManagedSessionStoreModels.MAX_SAFE_COUNTER, "invalid_request");
        for (String field : List.of("sourceRoot", "targetRoot", "bundleRoot", "fileHistoryRoot", "stateDirectory",
                "nodeExecutable", "cliEntry")) {
            Path path = Path.of(text(request, field));
            check(path.isAbsolute() && path.normalize().equals(path), "invalid_request");
        }
        List<Path> roots = List.of(path("sourceRoot"), path("targetRoot"), path("bundleRoot"),
                path("fileHistoryRoot"), path("stateDirectory"));
        for (int left = 0; left < roots.size(); left++) {
            for (int right = left + 1; right < roots.size(); right++) {
                check(!roots.get(left).startsWith(roots.get(right)) && !roots.get(right).startsWith(roots.get(left)),
                        "overlapping_roots");
            }
        }
        for (String field : List.of("stateDirectory", "fileHistoryRoot")) {
            String code = "stateDirectory".equals(field) ? "migration_state_unavailable" : "migration_history_unverified";
            Path directory = path(field);
            try {
                check(Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                        && directory.equals(directory.toRealPath()), code);
                if ("stateDirectory".equals(field)) {
                    LocalProcessRuntimeProvisioner.validateStateDirectory(directory);
                }
            } catch (IOException error) {
                throw failure(code);
            }
        }
        try {
            guard.migrationIdentity(path("fileHistoryRoot"));
        } catch (RuntimeBrokerException error) {
            throw failure("migration_history_unverified");
        }
        var source = guard.migrationSource(tenant, storage, revision, fence);
        check(source.root().equals(text(request, "sourceRoot")), "migration_identity_conflict");
        transaction.executeWithoutResult(status -> {
            lockAuthority();
            guard.migrationSource(tenant, storage, revision, fence);
            requireIdle();
            requireFilesProfiles();
            var raced = row(true);
            if (raced != null) {
                check(hash(bytes).equals(raced.get("request_digest")), "operation_conflict");
                return;
            }
            String owner = WorkspaceMigrationAdmission.owner(jdbc, tenant, storage);
            check(owner == null || owner.equals(id), "migration_conflict");
            operations.create(KIND, id, WorkspaceOperations.values("storage_id", storage, "request_digest", hash(bytes),
                    "request_json", request.toString(), "state", "RETIRING",
                    "source_registration_json", JSON.valueToTree(source).toString(),
                    "target_registration_id", UUID.randomUUID().toString()));
            jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, fence_operation_id, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE"
                    + " gmt_modified = CASE WHEN fence_operation_id IS NULL THEN VALUES(gmt_modified) ELSE gmt_modified END,"
                    + " fence_operation_id = COALESCE(fence_operation_id, VALUES(fence_operation_id))",
                    JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage),
                    JdbcRuntimeBindingRepository.storageFenceKey(tenant), JdbcRuntimeBindingRepository.storageFenceKey(storage),
                    tenant, storage, id);
            requireOwner();
        });
    }

    public JsonNode inspect() {
        var saved = requireRow(false);
        ObjectNode result = JSON.createObjectNode().put("migrationOperationId", id)
                .put("state", (String) saved.get("state"));
        for (String field : List.of("source_registration_json", "target_identity_json", "history_identity_json", "result_json")) {
            result.set(field, saved.get(field) == null ? JSON.nullNode() : parse((String) saved.get(field)));
        }
        result.set("lastErrorCode", JSON.valueToTree(saved.get("last_error_code")));
        result.set("verifyOperationId", JSON.valueToTree(saved.get("verify_operation_id")));
        return result;
    }

    public void retire(RuntimeBrokerService broker) {
        String state = (String) requireRow(false).get("state");
        if (Set.of("RETIRED", "PREPARING", "PREPARED", "COMPLETED").contains(state)) {
            return;
        }
        check("RETIRING".equals(state), "migration_not_writable");
        requireOwner();
        requireIdle();
        String after = null;
        while (true) {
            var page = bindings.findByStorage(tenant, storage, after, 50);
            for (var binding : page) {
                requireOwner();
                broker.retireStorageBinding(tenant, storage, id, binding.getBindingId(), binding.getGeneration())
                        .toCompletableFuture().join();
                after = binding.getBindingId();
            }
            if (page.size() < 50) {
                break;
            }
        }
        transaction.executeWithoutResult(status -> {
            lockAuthority();
            requireOwner();
            requireIdle();
            assertRetired();
            check("RETIRING".equals(requireRow(true).get("state")), "migration_not_writable");
            operations.update(KIND, id, WorkspaceOperations.values("state", "RETIRED", "last_error_code", null));
        });
    }

    public void verify(boolean promote) throws Exception {
        var saved = requireRow(false);
        if ("COMPLETED".equals(saved.get("state")) || !promote && "PREPARED".equals(saved.get("state"))) {
            return;
        }
        check(promote ? "PREPARED".equals(saved.get("state"))
                : Set.of("RETIRED", "PREPARING").contains(saved.get("state")), "migration_not_ready");
        requireOwner();
        var source = source(saved);
        check(guard.recoveryRegistration(tenant, storage, source.mountRevision(), source.fenceOperationId()).equals(source),
                "source_drift");
        var target = guard.migrationIdentity(path("targetRoot"));
        var history = guard.migrationIdentity(path("fileHistoryRoot"));
        check(source.hostId().equals(target.hostId()) && source.hostId().equals(history.hostId()), "migration_identity_conflict");
        check(!(source.device().equals(target.device()) && source.inode().equals(target.inode()))
                && !(source.device().equals(history.device()) && source.inode().equals(history.inode()))
                && !(target.device().equals(history.device()) && target.inode().equals(history.inode())),
                "overlapping_roots");
        if (saved.get("target_identity_json") != null) {
            check(JSON.valueToTree(target).equals(parse((String) saved.get("target_identity_json")))
                    && JSON.valueToTree(history).equals(parse((String) saved.get("history_identity_json"))), "source_drift");
        }
        String previousAttempt = (String) saved.get("verify_operation_id");
        var previous = previousAttempt == null ? null
                : operations.find(WorkspaceOperations.Kind.WORKSPACE_RECOVERY, previousAttempt, false);
        String attempt = previous != null && "VERIFYING".equals(previous.get("state"))
                ? previousAttempt : UUID.randomUUID().toString();
        transaction.executeWithoutResult(status -> {
            lockAuthority();
            requireOwner();
            var current = requireRow(true);
            check(current.get("state").equals(saved.get("state")), "migration_not_writable");
            operations.update(KIND, id, WorkspaceOperations.values("target_identity_json", JSON.valueToTree(target).toString(),
                    "history_identity_json", JSON.valueToTree(history).toString(), "verify_operation_id", attempt,
                    "state", promote ? "PREPARED" : "PREPARING", "last_error_code", null));
        });
        ObjectNode verifyRequest = ((ObjectNode) request).deepCopy();
        verifyRequest.remove(List.of("migrationOperationId", "targetRoot", "stateDirectory"));
        verifyRequest.put("operationId", attempt);
        var recovery = new WorkspaceRecoveryStore(jdbc, manager, guard, null, "verify",
                verifyRequest.toString().getBytes(StandardCharsets.UTF_8));
        byte[] marker = guard.migrationMarker(tenant, storage, target, (String) saved.get("target_registration_id"));
        String temporary = WorkspaceStorageGuard.migrationTemporary(path("targetRoot"), id).getFileName().toString();
        String assetKey = hash(JSON.valueToTree(List.of("qwen-workspace-recovery-asset-v1", "entry", "workspace/" + temporary))
                .toString());
        check(operations.findWork(WorkspaceOperations.Kind.WORKSPACE_RECOVERY,
                text(request, "captureOperationId"), "RESOURCE", assetKey, false) == null, "migration_marker_conflict");
        guard.discardMigrationTemporary(path("targetRoot"), marker, id);
        var workerFailure = new AtomicReference<String>();
        try {
            WorkspaceRecoveryMain.executeWorker(verifyRequest, recovery, (method, params) -> {
                JsonNode reply = recovery.call(method, params);
                if ("failure".equals(method)) {
                    workerFailure.set(text(params, "code"));
                }
                if ("context".equals(method)) {
                    ObjectNode migration = ((ObjectNode) reply).putObject("migration");
                    migration.put("targetRoot", target.root()).putObject("targetMarker")
                            .put("digest", hash(marker)).put("byteLength", marker.length);
                }
                return reply;
            });
        } catch (RecoveryFailure error) {
            if ("worker_failed".equals(error.code) && workerFailure.get() != null) {
                throw failure(workerFailure.get());
            }
            throw error;
        }
        check(recovery.inspect().path("result").path("authorityCompatible").asBoolean(false), "source_drift");
        if (promote) {
            requireOwner();
            guard.publishMigrationMarker(path("targetRoot"), marker, source, id);
        }
        transaction.executeWithoutResult(status -> {
            lockAuthority();
            requireOwner();
            var current = requireRow(true);
            check(attempt.equals(current.get("verify_operation_id"))
                    && (promote ? "PREPARED" : "PREPARING").equals(current.get("state")), "migration_not_writable");
            requireIdle();
            recovery.assertCompatible();
            assertRetired();
            check(target.equals(guard.migrationIdentity(path("targetRoot")))
                    && history.equals(guard.migrationIdentity(path("fileHistoryRoot"))), "source_drift");
            ObjectNode result = JSON.createObjectNode().put("contentVerified", true).put("authorityCompatible", true)
                    .put("activation", false).put("mountRevision", source.mountRevision() + (promote ? 1 : 0))
                    .put("captureOperationId", text(request, "captureOperationId")).put("verifyOperationId", attempt)
                    .put("manifestDigest", recovery.inspect().path("manifestDigest").asText());
            if (promote) {
                guard.promoteMigration(source, target, (String) saved.get("target_registration_id"), id);
                clearFence();
            }
            operations.update(KIND, id, WorkspaceOperations.values("state", promote ? "COMPLETED" : "PREPARED",
                    "result_json", result.toString(), "last_error_code", null));
        });
    }

    public void abort() {
        transaction.executeWithoutResult(status -> {
            lockAuthority();
            var current = requireRow(true);
            if ("ABORTED".equals(current.get("state"))) {
                return;
            }
            check(!"COMPLETED".equals(current.get("state")), "migration_already_completed");
            requireOwner();
            requireIdle();
            assertRetired();
            guard.recoveryRegistration(tenant, storage, positive(request, "mountRevision"), text(request, "fenceOperationId"));
            clearFence();
            operations.update(KIND, id, WorkspaceOperations.values("state", "ABORTED"));
        });
    }

    public void failed(String code) {
        String stable = code.matches("[a-z0-9_]{1,64}") ? code : "migration_failed";
        transaction.executeWithoutResult(status -> {
            var current = row(true);
            if (current != null && !Set.of("COMPLETED", "ABORTED").contains(current.get("state"))) {
                operations.update(KIND, id, WorkspaceOperations.values("last_error_code", stable,
                        "state", Set.of("source_drift", "resource_collected").contains(stable)
                                ? "INVALIDATED" : current.get("state")));
            }
        });
    }

    private void requireFilesProfiles() {
        String after = "";
        var reader = new WorkspaceRecoveryReader(jdbc, null);
        while (true) {
            var page = jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ?"
                    + " AND workspace_storage_id = ? AND session_id > ? ORDER BY session_id LIMIT 32",
                    String.class, tenant, storage, after);
            for (String session : page) {
                jdbc.query("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                        (row, index) -> ManagedAgentStore.readBinding(row), tenant, session);
                JsonNode source = WorkspaceRecoveryStore.currentSource(jdbc, tenant, storage, session, true);
                after = session;
                if (source.path("head").isNull() && !source.path("retirement").isNull()) {
                    continue;
                }
                check(!source.path("head").isNull(), "migration_member_uninitialized");
                JsonNode transaction = reader.transaction(source, 1);
                String genesis = new String(java.util.Base64.getDecoder().decode(text(transaction, "recordBytesBase64")),
                        StandardCharsets.UTF_8);
                String[] records = genesis.split("\n");
                check(records.length == 2 && "session.create".equals(transaction.path("operation").asText()),
                        "migration_profile_unverified");
                JsonNode header = parse(records[1]).path("managedSession");
                JsonNode ref = header.path("definitionRef");
                JsonNode definition = parse(java.util.Base64.getDecoder().decode(
                        reader.resource(source, ref).path("bytesBase64").asText()));
                check("managed".equals(definition.path("engine").asText())
                        && session.equals(definition.path("sessionId").asText())
                        && "hosted-workspace-files/1".equals(definition.path("toolProfile").asText())
                        && !definition.has("mcpServers") && !definition.has("hookCatalog") && !definition.has("captureBytes"),
                        "migration_profile_unsupported");
                after = session;
            }
            if (page.size() < 32) {
                return;
            }
        }
    }

    private void requireIdle() {
        check(count("SELECT COUNT(*) FROM ma_session s JOIN ma_turn t"
                + " ON t.tenant_id = s.tenant_id AND t.session_id = s.session_id WHERE s.tenant_id = ?"
                + " AND s.workspace_storage_id = ? AND t.status IN ('ACCEPTED', 'RUNNING', 'CANCELLING')") == 0,
                "migration_work_unsettled");
        // A parked task cancel counts here although it holds no lifecycle
        // hostage: its acceptance is unknown and its task may still use this
        // storage, so the move waits for the reconciler (D7-2).
        check(count("SELECT COUNT(*) FROM ma_session s JOIN ma_operation o"
                + " ON o.session_scope_key = s.session_scope_key AND o.tenant_id = s.tenant_id AND o.session_id = s.session_id WHERE s.tenant_id = ?"
                + " AND s.workspace_storage_id = ? AND o.operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'ACTION_RESPONSE', 'CWD_CHANGE', 'TASK_CANCEL') AND o.state NOT IN ('COMPLETED', 'FAILED')") == 0,
                "migration_work_unsettled");
        check(count("SELECT COUNT(*) FROM ma_session s JOIN ma_request_receipt c"
                + " ON c.tenant_id = s.tenant_id AND c.session_id = s.session_id WHERE s.tenant_id = ?"
                + " AND s.workspace_storage_id = ? AND c.namespace = 'SESSION_COMMAND' AND c.state = 'PENDING'") == 0,
                "migration_work_unsettled");
        // An open or parked title waits; one a later title superseded, or
        // one proven never delivered, has settled.
        check(count("SELECT COUNT(*) FROM ma_session s JOIN ma_operation r"
                + " ON r.session_scope_key = s.session_scope_key AND r.tenant_id = s.tenant_id AND r.session_id = s.session_id WHERE s.tenant_id = ?"
                + " AND s.workspace_storage_id = ? AND r.operation_kind = 'RENAME' AND r.state IN ('PENDING', 'RUNNING', 'RECOVERY_BLOCKED', 'UNKNOWN')") == 0,
                "migration_work_unsettled");
        // A child Workspace's worktree records absolute paths of this root
        // (#13753 I1): it must be merged or discarded before the storage
        // moves. A conflicted one keeps only refs, which move with it.
        check(count("SELECT COUNT(*) FROM ma_workspace WHERE workspace_kind = 'CHILD_GIT' AND tenant_id = ?"
                + " AND storage_id = ? AND child_state NOT IN ('merged', 'discarded', 'failed', 'conflicted')") == 0,
                "migration_work_unsettled");
        long now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Math.addExact(Math.multiplyExact(row.getLong(1), 1000), row.getLong(2) / 1000));
        String after = "";
        while (true) {
            var sessions = jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ?"
                    + " AND workspace_storage_id = ? AND session_id > ? ORDER BY session_id LIMIT 32", String.class,
                    tenant, storage, after);
            for (String session : sessions) {
                for (String options : jdbc.queryForList("SELECT options_json FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ? AND record_kind = 'ACTION' AND state = 'requested'", String.class, tenant, session)) {
                    check(parse(options).path("expiresAt").asLong(Long.MAX_VALUE) <= now, "migration_work_unsettled");
                }
                after = session;
            }
            if (sessions.size() < 32) {
                break;
            }
        }
        check(count("SELECT COUNT(*) FROM ma_session s JOIN ma_session_head h ON h.tenant_key = s.tenant_key AND h.harness_key = s.session_key AND h.tenant_id = s.tenant_id AND h.session_id = s.session_id WHERE s.tenant_id = ? AND s.workspace_storage_id = ? AND h.state = 'ACTIVE' AND (h.writer_lease_until IS NULL OR h.writer_lease_until > " + ManagedSchemaTime.SQL_NOW + ")") == 0,
                "migration_writer_active");
    }

    private long count(String sql) {
        return jdbc.queryForObject(sql, Long.class, tenant, storage);
    }

    private void assertRetired() {
        String cursor = null;
        while (true) {
            var page = bindings.findByStorage(tenant, storage, cursor, 50);
            for (RuntimeBindingRecord binding : page) {
                check(binding.getState() == RuntimeBindingRecord.State.RELEASED
                        && (binding.getDrainReceipt() != null || binding.hasStoppedWriters()), "migration_stop_unverified");
                check(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_session WHERE binding_id = ?"
                        + " AND runtime_generation = ? AND session_state NOT IN ('RELEASED', 'FAILED')", Long.class,
                        binding.getBindingId(), binding.getGeneration()) == 0, "migration_work_unsettled");
                check(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE binding_id = ?"
                        + " AND runtime_generation = ? AND execution_state NOT IN ('SETTLED', 'ABANDONED')", Long.class,
                        binding.getBindingId(), binding.getGeneration()) == 0, "migration_work_unsettled");
                cursor = binding.getBindingId();
            }
            if (page.size() < 50) {
                return;
            }
        }
    }

    private void lockAuthority() {
        WorkspaceMigrationAdmission.lockTenant(jdbc, tenant);
        ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
    }

    private void requireOwner() {
        check(id.equals(WorkspaceMigrationAdmission.owner(jdbc, tenant, storage)), "migration_conflict");
    }

    private void clearFence() {
        check(jdbc.update("UPDATE ma_storage SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", fence_operation_id = NULL WHERE tenant_key = ? AND storage_key = ? AND fence_operation_id = ?", JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                JdbcRuntimeBindingRepository.storageFenceKey(storage), id) == 1, "migration_conflict");
    }

    private Map<String, Object> requireRow(boolean lock) {
        var value = row(lock);
        check(value != null, "migration_not_found");
        return value;
    }

    private Map<String, Object> row(boolean lock) {
        return operations.find(KIND, id, lock);
    }

    private WorkspaceStorageGuard.RecoveryRegistration source(Map<String, Object> row) {
        try {
            return JSON.treeToValue(parse((String) row.get("source_registration_json")),
                    WorkspaceStorageGuard.RecoveryRegistration.class);
        } catch (java.io.IOException error) {
            throw failure("migration_identity_conflict");
        }
    }

    private Path path(String field) {
        return Path.of(text(request, field));
    }
}
