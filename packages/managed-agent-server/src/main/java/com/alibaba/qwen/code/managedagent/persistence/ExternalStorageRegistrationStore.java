package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public final class ExternalStorageRegistrationStore {
    private static final ReceiptNamespace NAMESPACE = ReceiptNamespace.EXTERNAL_STORAGE;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    // Strict parsing (duplicate/unknown/trailing rejection) lives at the controller
    // boundary; this mapper only encodes/decodes payloads this store produced itself.
    private final ObjectMapper json = new ObjectMapper();

    public ExternalStorageRegistrationStore(JdbcTemplate jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
    }

    public record Receipt(String registrationId, String storageKind,
            ExternalStorageRegistration registration, long registeredAt) {
    }

    public Receipt registerExternalStorage(String tenant, String idempotencyKey,
            ExternalStorageRegistration registration) {
        if (tenant == null || !tenant.matches("[A-Za-z0-9._:-]{1,128}")
                || idempotencyKey == null || !idempotencyKey.matches("[A-Za-z0-9._:-]{1,128}")
                || registration == null) {
            throw new RuntimeBrokerException(400, "invalid_external_storage_registration",
                    "Invalid external storage registration.", false);
        }
        WorkspaceStorageKindGuard.requireFreshTransaction();
        String encoded = encode(registration);
        String digest = ManagedSchemaKeys.key(encoded);
        String workspace = registration.alias().tenantWorkspaceId();
        String aliasKey = JdbcRuntimeBindingRepository.storageAliasKey(tenant, workspace);
        String physical = registration.identity().ownerKey();
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant, 10);
            // Operator registration is infrequent. Serialize its cross-tenant alias check with a
            // deliberate GLOBAL lock row (not a tenant) in tenant-keyed ma_tenant_guard.
            WorkspaceStorageKindGuard.lockDomain(jdbc, "external-storage-registration/1", 10);
            var prior = ManagedReceipts.find(jdbc, NAMESPACE, tenant, ReceiptScope.TENANT,
                    tenant, idempotencyKey, true);
            if (prior != null) {
                if (!digest.equals(prior.requestDigest())) {
                    throw conflict("idempotency_conflict");
                }
                return decode(prior.resultJson(), Receipt.class);
            }
            if (!jdbc.queryForList("SELECT alias_key FROM ma_storage WHERE alias_key = ?", aliasKey).isEmpty()
                    || !jdbc.queryForList("SELECT workspace_id FROM ma_workspace WHERE tenant_id = ? AND (storage_id = ? OR workspace_id = ?)", tenant, workspace, workspace).isEmpty()
                    || !jdbc.queryForList("SELECT binding_id FROM ma_runtime_binding WHERE storage_alias_key = ?", aliasKey).isEmpty()
                    || !jdbc.queryForList("SELECT physical_key FROM ma_storage_owner WHERE physical_key = ?", physical).isEmpty()) {
                throw conflict("alias_conflict");
            }
            for (String saved : jdbc.queryForList("SELECT registration_json FROM ma_storage WHERE storage_kind = 'EXTERNAL'", String.class)) {
                var other = decode(saved, ExternalStorageRegistration.class);
                if (registration.alias().aliasPath().equals(other.alias().aliasPath())) {
                    throw conflict("alias_conflict");
                }
            }
            try {
                jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, tenant_id, storage_id,"
                        + " storage_kind, mount_root, mount_revision) VALUES (?, ?, ?, ?, 'EXTERNAL', ?, ?)",
                        physical, physical, tenant, workspace, registration.alias().mountRoot(),
                        registration.identity().registrationRevision());
                jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                        + " storage_kind, registration_state, registration_revision, registration_json, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 'EXTERNAL', 'REGISTERED', ?, ?, " + ManagedSchemaTime.SQL_NOW
                        + ", " + ManagedSchemaTime.SQL_NOW + ")", aliasKey,
                        JdbcRuntimeBindingRepository.storageFenceKey(tenant), JdbcRuntimeBindingRepository.storageFenceKey(workspace),
                        tenant, workspace, physical, registration.identity().registrationRevision(), encoded);
            } catch (DuplicateKeyException duplicate) {
                // The global lock serializes registration, so the pre-checks above
                // win first; translate any residual duplicate-key race (or a lock
                // bypass) into the contract 409 instead of leaking a 500.
                throw conflict("alias_conflict");
            }
            long now = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW, Long.class);
            String receiptKey = ManagedSchemaKeys.receiptKey(NAMESPACE, tenant, ReceiptScope.TENANT, tenant, idempotencyKey);
            Receipt receipt = new Receipt(receiptKey, "EXTERNAL", registration, now);
            ManagedReceipts.insert(jdbc, NAMESPACE, tenant, ReceiptScope.TENANT, tenant, idempotencyKey,
                    digest, "REGISTER_EXTERNAL_STORAGE", null, null, null, "COMPLETED", null, null, now);
            jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", encode(receipt), receiptKey);
            return receipt;
        });
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private <T> T decode(String value, Class<T> type) {
        try {
            return json.readValue(value, type);
        } catch (JsonProcessingException | IllegalArgumentException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private static RuntimeBrokerException conflict(String code) {
        return new RuntimeBrokerException(409, code, "External storage registration conflicts with existing ownership.", false);
    }
}
