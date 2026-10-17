package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.SshRuntimeStorage;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

@Repository
public class SshWorkspaceStore {
    public static final String KIND = "SSH_LOCAL";
    public static final String OPERATION = "WORKSPACE_CREATE";
    /**
     * D7-2: how long a registration that may have reached its node parks
     * before its node is read again. A register-storage still running on the
     * node when its caller gave up finishes well within it.
     */
    static final long PARK_DELAY_MILLIS = 300_000;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<LinkedHashMap<String, Object>> MAP = new TypeReference<>() { };
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public SshWorkspaceStore(JdbcTemplate jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
    }

    public record Operation(String operationId, String type, String status,
            String workspaceId, String failureCode, boolean replayed) {
    }

    public record Intent(String operationId, String tenantId, String actorId,
            String nodeId, String path, String displayName, String workspaceId,
            String storageId, String registrationId, Map<String, Object> registration) {
    }

    /**
     * D7-2: a registration parked recovery_blocked. Only a reserved one can
     * have reached its node; its registration names the identity and the
     * marker the node would hold.
     */
    public record Parked(Intent intent, String failureCode) {
        public boolean reserved() {
            return !intent.registration().isEmpty();
        }
    }

    public Operation begin(String tenant, String actor, String key,
            String node, String path, String name) {
        validateRequest(key, node, path, name);
        String id = "wop_" + ManagedSchemaKeys.key(tenant, actor, key);
        String digest = ManagedSchemaKeys.key(node, path, name);
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant);
            var rows = operationRows(tenant, actor, id, true);
            if (!rows.isEmpty()) {
                if (!digest.equals(rows.getFirst().get("request_digest"))) {
                    throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict", "Registration key was used for another request.");
                }
                return operation(rows.getFirst(), true);
            }
            String workspace = "ws_" + UUID.randomUUID();
            String storage = "ssh_" + UUID.randomUUID();
            Map<String, Object> request = Map.of("actorId", actor, "nodeId", node, "path", path,
                    "displayName", name, "workspaceId", workspace, "storageId", storage,
                    "registrationId", UUID.randomUUID().toString());
            jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, operation_kind, operation_id, tenant_id,"
                            + " target_kind, target_key, target_id, actor_key, actor_id, idempotency_key, idempotency_digest,"
                            + " request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, ?, ?, ?, 'WORKSPACE', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING', "
                            + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                    operationKey(tenant, id), ManagedSchemaKeys.key(tenant), OPERATION, bytes(id), bytes(tenant),
                    ManagedSchemaKeys.key(workspace), bytes(workspace), ManagedWorkspaceRegistry.actorKey(tenant, actor),
                    bytes(actor), bytes(key), ManagedSchemaKeys.key(key), digest, encode(request));
            return new Operation(id, "workspace_create", "pending", null, null, false);
        });
    }

    public Operation get(String tenant, String actor, String id) {
        var rows = operationRows(tenant, actor, id, false);
        if (rows.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "operation_not_found", "Workspace registration not found.");
        }
        return operation(rows.getFirst(), true);
    }

    public Operation replay(String tenant, String actor, String key,
            String node, String path, String name) {
        validateRequest(key, node, path, name);
        var rows = operationRows(tenant, actor, "wop_" + ManagedSchemaKeys.key(tenant, actor, key), false);
        if (rows.isEmpty()) {
            return null;
        }
        if (!ManagedSchemaKeys.key(node, path, name).equals(rows.getFirst().get("request_digest"))) {
            throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict", "Registration key was used for another request.");
        }
        return operation(rows.getFirst(), true);
    }

    private static void validateRequest(String key, String node, String path, String name) {
        if (key == null || key.isBlank() || key.length() > 512
                || node == null || node.isBlank() || node.length() > 128
                || path == null || path.isBlank() || path.length() > 512
                || name == null || name.isBlank() || name.length() > 512) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request", "Workspace registration request is invalid.");
        }
    }

    public Intent claim(String tenant, String actor, String id, String owner) {
        return transaction.execute(status -> {
            var rows = operationRows(tenant, actor, id, true);
            if (rows.isEmpty() || !List.of("PENDING", "RUNNING").contains(rows.getFirst().get("state"))) {
                return null;
            }
            int updated = jdbc.update("UPDATE ma_operation SET state = 'RUNNING', phase = 'RUNNING', claim_owner = ?,"
                            + " claim_generation = claim_generation + 1, claim_until = " + ManagedSchemaTime.SQL_NOW + " + 120000,"
                            + " gmt_modified = " + ManagedSchemaTime.SQL_NOW
                            + " WHERE operation_key = ? AND (claim_until IS NULL OR claim_until < " + ManagedSchemaTime.SQL_NOW + ")",
                    owner, operationKey(tenant, id));
            if (updated != 1) {
                return null;
            }
            return intent(id, tenant, rows.getFirst());
        });
    }

    private static Intent intent(String id, String tenant, Map<String, Object> row) {
        Map<String, Object> value = decode((String) row.get("request_json"));
        Map<String, Object> registration = decode((String) row.get("result_json"));
        return new Intent(id, tenant, string(value, "actorId"), string(value, "nodeId"), string(value, "path"),
                string(value, "displayName"), string(value, "workspaceId"), string(value, "storageId"),
                string(value, "registrationId"), registration);
    }

    public void reserve(Intent intent, String owner, Map<String, Object> registration) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, intent.tenantId());
            requireClaim(intent, owner);
            Map<String, Object> identity = object(registration, "identity");
            LocalStorageOwners.requireNonOverlapping(jdbc, physicalIdentity(identity));
            String physical = physicalKey(identity);
            String root = string(identity, "root");
            jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind, tenant_id, storage_id,"
                            + " mount_root, mount_host_id, mount_device, mount_inode, mount_birth_time, mount_registration_id)"
                            + " VALUES (?, ?, 'SSH_LOCAL', ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE storage_key = storage_key",
                    physical, physical, intent.tenantId(), intent.storageId(), root, string(identity, "hostId"),
                    string(identity, "device"), string(identity, "inode"), string(identity, "birthTime"), intent.registrationId());
            var rows = jdbc.queryForList("SELECT storage_kind, mount_registration_id FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE", physical);
            if (rows.size() != 1 || !KIND.equals(rows.getFirst().get("storage_kind"))
                    || !intent.registrationId().equals(rows.getFirst().get("mount_registration_id"))) {
                throw new ApiException(HttpStatus.CONFLICT, "storage_already_registered", "Physical directory already has an owner.");
            }
            String alias = JdbcRuntimeBindingRepository.storageAliasKey(intent.tenantId(), intent.storageId());
            jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                            + " storage_kind, registration_state, registration_revision, registration_json)"
                            + " VALUES (?, ?, ?, ?, ?, ?, 'SSH_LOCAL', 'FENCE_ONLY', 1, ?)"
                            + " ON DUPLICATE KEY UPDATE alias_key = alias_key", alias,
                    JdbcRuntimeBindingRepository.storageFenceKey(intent.tenantId()), JdbcRuntimeBindingRepository.storageFenceKey(intent.storageId()),
                    bytes(intent.tenantId()), bytes(intent.storageId()), physical, encode(registration));
            jdbc.update("UPDATE ma_operation SET result_json = ? WHERE operation_key = ?", encode(registration),
                    operationKey(intent.tenantId(), intent.operationId()));
        });
    }

    public void complete(Intent intent, String owner) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, intent.tenantId());
            requireClaim(intent, owner);
            publish(intent);
            if (finish(intent, owner, "COMPLETED", null) != 1) {
                throw new ApiException(HttpStatus.CONFLICT, "operation_claim_lost", "Registration claim expired.");
            }
        });
    }

    /** Turns the reserved storage into the registered Workspace. */
    private void publish(Intent intent) {
        String alias = JdbcRuntimeBindingRepository.storageAliasKey(intent.tenantId(), intent.storageId());
        var rows = jdbc.queryForList("SELECT registration_json FROM ma_storage WHERE alias_key = ? AND storage_kind = 'SSH_LOCAL' FOR UPDATE", alias);
        if (rows.size() != 1) {
            throw WorkspaceExecutionStore.unavailable();
        }
        jdbc.update("UPDATE ma_storage SET registration_state = 'REGISTERED', mount_revision = 1 WHERE alias_key = ?", alias);
        jdbc.update("UPDATE ma_storage_owner SET mount_state = 'READY', mount_revision = 1,"
                        + " mount_completed_operation_id = ?, mount_operation_id = NULL WHERE mount_registration_id = ? AND storage_kind = 'SSH_LOCAL'",
                intent.registrationId(), intent.registrationId());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')", intent.tenantId(), intent.workspaceId(), intent.storageId(),
                intent.displayName(), WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, ?, ?, 'OWNER')",
                intent.tenantId(), intent.workspaceId(), ManagedWorkspaceRegistry.actorKey(intent.tenantId(), intent.actorId()));
    }

    /**
     * D7-2: a retryable failure returns to pending. Otherwise only a
     * reservation can have reached the node, since register-storage runs
     * after it: an unreserved registration never left Java, so its refusal
     * is final, while a reserved one parks recovery_blocked until its node
     * proves whether the marker landed.
     */
    public void fail(Intent intent, String owner, String code, boolean retryable) {
        transaction.executeWithoutResult(status -> {
            if (retryable) {
                finish(intent, owner, "PENDING", code);
                return;
            }
            String key = operationKey(intent.tenantId(), intent.operationId());
            boolean reserved = !jdbc.queryForList("SELECT operation_key FROM ma_operation WHERE operation_key = ?"
                    + " AND result_json IS NOT NULL FOR UPDATE", String.class, key).isEmpty();
            if (!reserved) {
                finish(intent, owner, "FAILED", code);
                return;
            }
            jdbc.update("UPDATE ma_operation SET state = 'RECOVERY_BLOCKED', phase = 'RECOVERY_BLOCKED',"
                            + " admission_stage = 'JAVA_DURABLE', delivery_state = 'BLOCKED', failure_code = ?,"
                            + " available_at = " + ManagedSchemaTime.SQL_NOW + " + ?, claim_owner = NULL, claim_until = NULL,"
                            + " gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE operation_key = ? AND claim_owner = ?"
                            + " AND state = 'RUNNING' AND claim_until > " + ManagedSchemaTime.SQL_NOW,
                    code, PARK_DELAY_MILLIS, key, owner);
        });
    }

    /** D7-2: parked registrations due for their node to be read again. */
    public List<StoreModels.ParkedOperation> findParked(int limit) {
        return WorkspaceOperations.rows(jdbc, "SELECT tenant_id, operation_id FROM ma_operation WHERE operation_kind ="
                        + " 'WORKSPACE_CREATE' AND state = 'RECOVERY_BLOCKED' AND available_at <= "
                        + ManagedSchemaTime.SQL_NOW + " ORDER BY available_at LIMIT ?", limit).stream()
                .map(row -> new StoreModels.ParkedOperation(text(row.get("tenant_id")), null,
                        text(row.get("operation_id")), OPERATION))
                .toList();
    }

    /** A parked registration, or empty once it left the parked state. */
    public java.util.Optional<Parked> parked(String tenant, String operationId) {
        return parkedRow(tenant, operationId, false);
    }

    /**
     * D7-2: its node holds the marker, so the registration landed: finish it
     * as the original attempt would have, while it is still parked.
     */
    public boolean completeParked(String tenant, String operationId) {
        return Boolean.TRUE.equals(transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant);
            Parked parked = parkedRow(tenant, operationId, true).orElse(null);
            if (parked == null || !parked.reserved()) {
                return false;
            }
            publish(parked.intent());
            return settleParked(tenant, operationId, "COMPLETED", null) == 1;
        }));
    }

    /**
     * D7-2: the registration can no longer land. Fail it and release what it
     * reserved, the storage alias and the physical directory's owner, only
     * while both are still this registration's unfinished reservation.
     */
    public boolean releaseParked(String tenant, String operationId, String code) {
        return Boolean.TRUE.equals(transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant);
            Parked parked = parkedRow(tenant, operationId, true).orElse(null);
            if (parked == null) {
                return false;
            }
            Intent intent = parked.intent();
            if (parked.reserved()) {
                jdbc.update("DELETE FROM ma_storage WHERE alias_key = ? AND storage_kind = 'SSH_LOCAL'"
                                + " AND registration_state = 'FENCE_ONLY'",
                        JdbcRuntimeBindingRepository.storageAliasKey(tenant, intent.storageId()));
                jdbc.update("DELETE FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'SSH_LOCAL'"
                                + " AND mount_registration_id = ? AND mount_state = 'UNVERIFIED'",
                        physicalKey(object(intent.registration(), "identity")), intent.registrationId());
            }
            return settleParked(tenant, operationId, "FAILED", code) == 1;
        }));
    }

    /** D7-2: nothing is proven yet; read the node again after the delay. */
    public boolean reparkParked(String tenant, String operationId, long delayMillis) {
        return jdbc.update("UPDATE ma_operation SET available_at = " + ManagedSchemaTime.SQL_NOW + " + ?,"
                        + " attempt_count = attempt_count + 1, gmt_modified = " + ManagedSchemaTime.SQL_NOW
                        + " WHERE operation_key = ? AND state = 'RECOVERY_BLOCKED'",
                Math.max(0, delayMillis), operationKey(tenant, operationId)) == 1;
    }

    private java.util.Optional<Parked> parkedRow(String tenant, String operationId, boolean lock) {
        var rows = WorkspaceOperations.rows(jdbc, "SELECT * FROM ma_operation WHERE operation_key = ?"
                        + " AND operation_kind = 'WORKSPACE_CREATE' AND tenant_id = ? AND state = 'RECOVERY_BLOCKED'"
                        + (lock ? " FOR UPDATE" : ""),
                operationKey(tenant, operationId), tenant);
        return rows.isEmpty() ? java.util.Optional.empty()
                : java.util.Optional.of(new Parked(intent(operationId, tenant, rows.getFirst()),
                        (String) rows.getFirst().get("failure_code")));
    }

    private int settleParked(String tenant, String operationId, String state, String code) {
        return jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, failure_code = ?,"
                        + " delivery_state = CASE WHEN ? = 'COMPLETED' THEN 'CONFIRMED' ELSE 'BLOCKED' END,"
                        + " gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", completed_at = " + ManagedSchemaTime.SQL_NOW
                        + " WHERE operation_key = ? AND state = 'RECOVERY_BLOCKED'",
                state, state, code, state, operationKey(tenant, operationId));
    }

    public SshRuntimeStorage runtimeStorage(RuntimeScope scope) {
        var rows = jdbc.queryForList("SELECT storage_id, workspace_generation FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                scope.getTenantId(), scope.getWorkspaceId());
        if (rows.isEmpty()) {
            return null;
        }
        var storage = runtimeStorage(scope.getTenantId(), text(rows.getFirst().get("storage_id")));
        if (storage != null && !scope.getWorkspaceGeneration().equals(rows.getFirst().get("workspace_generation").toString())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return storage;
    }

    public SshRuntimeStorage runtimeStorage(String tenant, String storage) {
        var rows = jdbc.queryForList("SELECT storage_kind, registration_state, registration_json FROM ma_storage WHERE alias_key = ?",
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (rows.isEmpty() || !KIND.equals(rows.getFirst().get("storage_kind"))) {
            return null;
        }
        if (!"REGISTERED".equals(rows.getFirst().get("registration_state"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Map<String, Object> registration = decode((String) rows.getFirst().get("registration_json"));
        return new SshRuntimeStorage(string(registration, "nodeId"), storage,
                string(object(registration, "identity"), "root"), registration);
    }

    public boolean verify(ContextBinding binding) {
        SshRuntimeStorage storage = runtimeStorage(binding.getTenantId(), binding.getStorageId());
        if (storage == null) {
            return false;
        }
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE alias_key = ? AND fence_operation_id IS NULL",
                Long.class, JdbcRuntimeBindingRepository.storageAliasKey(binding.getTenantId(), binding.getStorageId())) != 1) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Map<String, Object> identity = object(storage.registration(), "identity");
        var rows = jdbc.queryForList("SELECT mount_state, mount_registration_id FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'SSH_LOCAL'",
                physicalKey(identity));
        if (rows.size() != 1 || !"READY".equals(rows.getFirst().get("mount_state"))
                || !string(object(storage.registration(), "marker"), "registrationId").equals(rows.getFirst().get("mount_registration_id"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return true;
    }

    private void requireClaim(Intent intent, String owner) {
        if (jdbc.queryForList("SELECT operation_key FROM ma_operation WHERE operation_key = ? AND claim_owner = ?"
                + " AND state = 'RUNNING' AND claim_until > " + ManagedSchemaTime.SQL_NOW + " FOR UPDATE", String.class,
                operationKey(intent.tenantId(), intent.operationId()), owner).size() != 1) {
            throw new ApiException(HttpStatus.CONFLICT, "operation_claim_lost", "Registration claim expired.");
        }
    }

    private int finish(Intent intent, String owner, String state, String code) {
        return jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, failure_code = ?, claim_owner = NULL, claim_until = NULL,"
                        + " gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", completed_at = CASE WHEN ? IN ('COMPLETED', 'FAILED') THEN "
                        + ManagedSchemaTime.SQL_NOW + " ELSE NULL END WHERE operation_key = ? AND claim_owner = ? AND state = 'RUNNING'"
                        + " AND claim_until > " + ManagedSchemaTime.SQL_NOW,
                state, state, code, state,
                operationKey(intent.tenantId(), intent.operationId()), owner);
    }

    private List<Map<String, Object>> operationRows(String tenant, String actor, String id, boolean lock) {
        return WorkspaceOperations.rows(jdbc, "SELECT * FROM ma_operation WHERE operation_key = ? AND operation_kind = 'WORKSPACE_CREATE'"
                        + " AND tenant_id = ? AND actor_key = ?" + (lock ? " FOR UPDATE" : ""),
                operationKey(tenant, id), tenant, ManagedWorkspaceRegistry.actorKey(tenant, actor));
    }

    private static Operation operation(Map<String, Object> row, boolean replayed) {
        var request = decode((String) row.get("request_json"));
        String state = (String) row.get("state");
        return new Operation((String) row.get("operation_id"), "workspace_create", state.toLowerCase(java.util.Locale.ROOT),
                "COMPLETED".equals(state) ? string(request, "workspaceId") : null, (String) row.get("failure_code"), replayed);
    }

    public static Map<String, Object> object(Map<String, Object> value, String key) {
        return JSON.convertValue(Objects.requireNonNull(value.get(key), key), MAP);
    }

    public static String string(Map<String, Object> value, String key) {
        if (!(value.get(key) instanceof String text) || text.isBlank()) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return text;
    }

    public static String physicalKey(Map<String, Object> identity) {
        return LocalStorageOwners.physicalKey(physicalIdentity(identity));
    }

    private static WorkspaceStorageGuard.Identity physicalIdentity(Map<String, Object> identity) {
        return new WorkspaceStorageGuard.Identity(string(identity, "root"), string(identity, "hostId"),
                string(identity, "device"), string(identity, "inode"), string(identity, "birthTime"));
    }

    static String physicalKey(JdbcTemplate jdbc, String tenant, String storage) {
        boolean lock = org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive();
        var rows = jdbc.queryForList("SELECT tenant_id, storage_id, storage_kind, registration_state, physical_key, fence_operation_id"
                + " FROM ma_storage WHERE alias_key = ?" + (lock ? " FOR UPDATE" : ""),
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
        if (rows.isEmpty() || !KIND.equals(rows.getFirst().get("storage_kind"))) {
            return null;
        }
        var row = rows.getFirst();
        if (!tenant.equals(text(row.get("tenant_id"))) || !storage.equals(text(row.get("storage_id")))
                || !"REGISTERED".equals(row.get("registration_state")) || row.get("fence_operation_id") != null
                || !(row.get("physical_key") instanceof String key)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        var owners = jdbc.queryForList("SELECT mount_state, tenant_id, storage_id FROM ma_storage_owner WHERE storage_key = ?"
                + " AND storage_kind = 'SSH_LOCAL'" + (lock ? " FOR UPDATE" : ""), key);
        if (owners.size() != 1 || !"READY".equals(owners.getFirst().get("mount_state"))
                || !tenant.equals(text(owners.getFirst().get("tenant_id")))
                || !storage.equals(text(owners.getFirst().get("storage_id")))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return key;
    }

    private static String text(Object value) {
        return value instanceof byte[] binary ? new String(binary, StandardCharsets.UTF_8) : (String) value;
    }

    private static String operationKey(String tenant, String id) {
        return ManagedSchemaKeys.key(OPERATION, tenant, id);
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static String encode(Map<String, Object> value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    private static Map<String, Object> decode(String value) {
        try {
            return value == null ? new LinkedHashMap<>() : JSON.readValue(value, MAP);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }
}
