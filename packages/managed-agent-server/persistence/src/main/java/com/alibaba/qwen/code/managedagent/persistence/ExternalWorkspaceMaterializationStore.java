package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration.ExternalStorageIdentity;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Optional;

@Component
public final class ExternalWorkspaceMaterializationStore {
    private static final ReceiptNamespace NAMESPACE = ReceiptNamespace.EXTERNAL_WORKSPACE;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper json = new ObjectMapper();

    public ExternalWorkspaceMaterializationStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
    }

    public record Receipt(String materializationId, String workspaceId, String storageId,
            long workspaceGeneration, String displayName, String ownerActorId, String state, long materializedAt) {
    }

    public Receipt materialize(String tenant, String registeredAliasId, String displayName,
            String ownerActorId, String idempotencyKey) {
        try {
            if (tenant == null || !tenant.matches("[A-Za-z0-9._:-]{1,128}")
                    || registeredAliasId == null || !registeredAliasId.matches("[A-Za-z0-9._-]{1,128}")
                    || displayName == null || displayName.isBlank() || displayName.length() > 128
                    || displayName.codePoints().anyMatch(Character::isISOControl)
                    || ownerActorId == null || ownerActorId.isBlank()
                    || idempotencyKey == null || !idempotencyKey.matches("[A-Za-z0-9._:-]{1,128}")) {
                throw new IllegalArgumentException();
            }
            // The grantee is the operator's actor, not an authenticated
            // request actor; it passes the same identity admission.
            com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenant, ownerActorId);
        } catch (IllegalArgumentException error) {
            throw new RuntimeBrokerException(400, "invalid_external_workspace_materialization",
                    "Invalid external Workspace materialization.", false);
        }
        WorkspaceStorageKindGuard.requireFreshTransaction();
        String digest = ManagedSchemaKeys.key(registeredAliasId, displayName, ownerActorId);
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant, 10);
            var prior = ManagedReceipts.find(jdbc, NAMESPACE, tenant, ReceiptScope.TENANT,
                    tenant, idempotencyKey, true);
            if (prior != null) {
                if (!digest.equals(prior.requestDigest())) {
                    throw conflict("idempotency_conflict");
                }
                return decode(prior.resultJson(), Receipt.class);
            }
            var registrations = jdbc.queryForList("SELECT registration_json FROM ma_storage"
                    + " WHERE tenant_id = ? AND storage_id = ?"
                    + " AND storage_kind IN ('EXTERNAL', 'EPHEMERAL')"
                    + " AND registration_state = 'REGISTERED' FOR UPDATE",
                    String.class, tenant, registeredAliasId);
            if (registrations.size() != 1) {
                throw conflict("external_workspace_conflict");
            }
            com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry.RegisteredExternalStorage registration;
            try {
                registration =
                        com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry.decodeRegistration(
                                registrations.getFirst());
            } catch (RuntimeException failure) {
                // A stored registration this build cannot read is a permanent
                // ownership refusal, not a malformed request: keep the 409 the
                // sibling shape checks answer instead of a mapper 400.
                throw conflict("external_workspace_conflict");
            }
            if (registration == null) {
                throw conflict("external_workspace_conflict");
            }
            String physical = registration.ownerKey();
            long revision = registration.registrationRevision();
            if (registration.ephemeral() && !tenant.equals(registration.ephemeralTenantId())
                    || !registeredAliasId.equals(registration.tenantWorkspaceId())
                    || jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage"
                            + " WHERE tenant_id = ? AND storage_id = ? AND physical_id = ?"
                            + " AND registration_revision = ? AND storage_kind = ?",
                            Long.class, tenant, registeredAliasId,
                            ManagedSchemaKeys.identity(physical), revision,
                            registration.storageKind()) != 1
                    || jdbc.queryForList("SELECT physical_id FROM ma_storage_owner WHERE physical_id = ?"
                            + " AND tenant_id = ? AND storage_id = ? AND storage_kind = ?"
                            + " AND mount_revision = ? AND mount_root = ? AND mount_state = 'UNVERIFIED'"
                            + " AND holder_id IS NULL AND binding_id IS NULL AND runtime_generation IS NULL"
                            + " AND runtime_session_id IS NULL AND maintenance_id IS NULL AND maintenance_generation IS NULL FOR UPDATE",
                            String.class, ManagedSchemaKeys.identity(physical), tenant,
                            registeredAliasId, registration.storageKind(), revision,
                            registration.mountRoot()).size() != 1
                    || !jdbc.queryForList("SELECT workspace_id FROM ma_workspace WHERE tenant_id = ?"
                            + " AND (workspace_id = ? OR storage_id = ?)", tenant,
                            registeredAliasId, registeredAliasId).isEmpty()
                    || !jdbc.queryForList("SELECT binding_id FROM ma_runtime_binding"
                            + " WHERE (tenant_id = ? AND storage_id = ?)"
                            + " OR (tenant_id = ? AND (workspace_id = ? OR storage_id = ?))",
                            tenant, registeredAliasId, tenant,
                            registeredAliasId, registeredAliasId).isEmpty()) {
                throw conflict("external_workspace_conflict");
            }
            long now = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW, Long.class);
            String receiptKey = ManagedSchemaKeys.receiptKey(NAMESPACE, tenant, ReceiptScope.TENANT, tenant, idempotencyKey);
            Receipt receipt = new Receipt(receiptKey, registeredAliasId, registeredAliasId, 1,
                    displayName, ownerActorId, "ACTIVE", now);
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, materialization_receipt_key,"
                    + " state, workspace_kind, is_default, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'ACTIVE', 'ROOT', FALSE, ?, ?)", tenant,
                    registeredAliasId, registeredAliasId, displayName, WorkspaceExecutionProfile.CONFIG_REF,
                    WorkspaceExecutionProfile.POLICY_REF, receiptKey, now, now);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES (?, ?, ?, 'OWNER')", tenant, registeredAliasId, ownerActorId);
            ManagedReceipts.insert(jdbc, NAMESPACE, tenant, ReceiptScope.TENANT, tenant, idempotencyKey,
                    digest, "MATERIALIZE_EXTERNAL_WORKSPACE", null, null, null, "COMPLETED", null, null, now);
            jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", encode(receipt), receiptKey);
            return receipt;
        });
    }

    public Optional<Receipt> findByPhysicalKey(String tenant, String providerId, String physicalKey) {
        String owner = new ExternalStorageIdentity(providerId, physicalKey, 1).ownerKey();
        return transaction.execute(status -> {
            List<String> records = jdbc.queryForList("SELECT r.result_json FROM ma_workspace w"
                    + " JOIN ma_request_receipt r ON r.receipt_key = w.materialization_receipt_key"
                    + " AND r.tenant_id = w.tenant_id AND r.namespace = ? AND r.scope_kind = ?"
                    + " JOIN ma_storage_owner o ON o.tenant_id = w.tenant_id AND o.storage_id = w.workspace_id"
                    + " WHERE o.physical_id = ? AND w.tenant_id = ? AND w.state = 'ACTIVE' AND w.workspace_kind = 'ROOT'",
                    String.class, NAMESPACE.name(), ReceiptScope.TENANT.name(), owner, tenant);
            if (records.isEmpty()) {
                return Optional.empty();
            }
            if (records.size() != 1) {
                throw new RuntimeBrokerException(409, "external_workspace_conflict",
                        "External Workspace storage ownership is ambiguous.", false);
            }
            Receipt receipt = decode(records.getFirst(), Receipt.class);
            if (!receipt.storageId().equals(receipt.workspaceId())) {
                throw new RuntimeBrokerException(409, "external_workspace_conflict",
                        "External Workspace receipt does not match its registered alias.", false);
            }
            return Optional.of(receipt);
        });
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore
                    .unavailable();
        }
    }

    private <T> T decode(String value, Class<T> type) {
        try {
            return json.readValue(value, type);
        } catch (JsonProcessingException | IllegalArgumentException error) {
            throw conflict("external_workspace_conflict");
        }
    }

    private static RuntimeBrokerException conflict(String code) {
        return new RuntimeBrokerException(409, code, "External Workspace materialization conflicts with existing ownership.", false);
    }
}
