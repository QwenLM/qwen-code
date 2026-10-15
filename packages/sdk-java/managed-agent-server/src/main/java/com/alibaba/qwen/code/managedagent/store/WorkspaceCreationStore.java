package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry.WorkspaceSummary;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCreationRoots.Details;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

@Repository
public class WorkspaceCreationStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard guard;
    private final ManagedWorkspaceRegistry registry;
    private final WorkspaceCreationRoots roots;
    private final ObjectMapper json;
    private final Clock clock;

    public WorkspaceCreationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            WorkspaceStorageGuard guard, ManagedWorkspaceRegistry registry,
            ManagedAgentProperties properties, ObjectMapper json, Clock clock) {
        this.jdbc = jdbc;
        transaction = new TransactionTemplate(manager);
        this.guard = guard;
        this.registry = registry;
        roots = new WorkspaceCreationRoots(jdbc, properties);
        this.json = json;
        this.clock = clock;
    }

    public boolean enabled() {
        return roots.enabled() && guard.enabled();
    }

    public WorkspaceSummary create(String tenant, String actor, String displayName, String key) {
        if (!enabled()) {
            throw new ApiException(HttpStatus.CONFLICT, "workspace_creation_unavailable",
                    "Workspace creation is not enabled.");
        }
        String name = displayName == null ? "" : displayName.strip();
        if (name.isEmpty() || name.length() > 128
                || name.codePoints().anyMatch(Character::isISOControl)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_workspace_name",
                    "Workspace name must contain 1-128 characters without control characters.");
        }
        if (key == null || !key.matches("[\\x21-\\x7e]{1,128}")) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_idempotency_key",
                    "Idempotency-Key must contain 1-128 visible characters.");
        }
        WorkspaceStorageKindGuard.requireFreshTransaction();
        byte[] actorKey = ManagedWorkspaceRegistry.actorKey(tenant, actor);
        String scope = ManagedReceipts.actorScope(actorKey);
        String receiptKey = ManagedSchemaKeys.receiptKey(ReceiptNamespace.WORKSPACE_CREATE,
                tenant, ReceiptScope.ACTOR, scope, key);
        String digest = ManagedSchemaKeys.key(name);
        Map<String, Object> receipt;
        try {
            receipt = transaction.execute(status -> {
                long now = clock.millis();
                ManagedReceipts.insert(jdbc, ReceiptNamespace.WORKSPACE_CREATE, tenant,
                        ReceiptScope.ACTOR, scope, key, digest, "CREATE_WORKSPACE", actorKey,
                        null, null, "PENDING", null, null, now);
                Details details = new Details("workspace-" + receiptKey, "created-" + receiptKey,
                        name, UUID.randomUUID().toString());
                jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?",
                        encode(details), receiptKey);
                return find(tenant, scope, key, true);
            });
        } catch (DuplicateKeyException race) {
            receipt = find(tenant, scope, key, false);
            if (receipt == null) {
                throw race;
            }
            requireDigest(receipt, digest);
        }
        Details details = roots.details(Objects.requireNonNull(receipt));
        if ("COMPLETED".equals(receipt.get("state"))) {
            return replay(tenant, actor, details);
        }
        if (!"PENDING".equals(receipt.get("state"))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try {
            roots.prepare(tenant, receiptKey);
            guard.registerCreated(tenant, details.storageId(), details.registrationId());
        } catch (RuntimeException error) {
            Map<String, Object> current = find(tenant, scope, key, false);
            if (current != null && "COMPLETED".equals(current.get("state"))) {
                requireDigest(current, digest);
                return replay(tenant, actor, roots.details(current));
            }
            throw error;
        }
        transaction.executeWithoutResult(status -> {
            Map<String, Object> current = find(tenant, scope, key, true);
            requireDigest(Objects.requireNonNull(current), digest);
            if ("COMPLETED".equals(current.get("state"))) {
                return;
            }
            if (!"PENDING".equals(current.get("state"))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            long now = clock.millis();
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                            + " storage_id, display_name, config_ref, policy_ref, state, created_at, updated_at)"
                            + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE', ?, ?)",
                    tenant, details.workspaceId(), details.storageId(), details.displayName(),
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF, now, now);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                            + " VALUES (?, ?, ?, 'OWNER')", tenant, details.workspaceId(), actorKey);
            jdbc.update("UPDATE ma_request_receipt SET state = 'COMPLETED', updated_at = ?"
                    + " WHERE receipt_key = ?", now, receiptKey);
        });
        return replay(tenant, actor, details);
    }

    private WorkspaceSummary replay(String tenant, String actor, Details details) {
        WorkspaceSummary found = registry.findReadable(tenant, actor, details.workspaceId());
        if (found == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "workspace_not_found", "Workspace not found.");
        }
        return found;
    }

    private Map<String, Object> find(String tenant, String scope, String key, boolean lock) {
        return ManagedReceipts.find(jdbc, ReceiptNamespace.WORKSPACE_CREATE, tenant,
                ReceiptScope.ACTOR, scope, key, lock);
    }

    private static void requireDigest(Map<String, Object> receipt, String digest) {
        if (!digest.equals(receipt.get("request_digest"))) {
            throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict",
                    "Idempotency key was already used for another Workspace name.");
        }
    }

    private String encode(Details details) {
        try {
            return json.writeValueAsString(details);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }
}
