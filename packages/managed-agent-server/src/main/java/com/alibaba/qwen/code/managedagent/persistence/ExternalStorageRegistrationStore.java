package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.Optional;

@Component
public final class ExternalStorageRegistrationStore implements ExternalStorageRegistry {
    private static final ReceiptNamespace NAMESPACE = ReceiptNamespace.EXTERNAL_STORAGE;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    // Strict parsing (duplicate/unknown/trailing rejection) lives at the controller
    // boundary; this mapper only encodes/decodes payloads this store produced itself.
    private final ObjectMapper json = new ObjectMapper();

    public ExternalStorageRegistrationStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager) {
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

    /**
     * Reads one tenant-bound registration for the external Workspace profile.
     *
     * <p>Read-only by construction: no lock, no write, no idempotency record. The
     * lookup uses the same primary key the write path inserts
     * ({@link JdbcRuntimeBindingRepository#storageAliasKey}), joins the owner row
     * on the owner's primary key, and admits only a {@code REGISTERED} row. It
     * then enforces exactly these fields: the decoded record's alias id equals the
     * requested alias, its identity owner key equals the stored physical key, its
     * revision equals the stored {@code registration_revision}, and its mount root
     * equals the owner row's {@code mount_root}. {@code mount_revision} is not
     * compared: the owner row tracks the registered revision while
     * {@code ma_storage.mount_revision} is a separate mount counter with its own
     * default.
     *
     * <p>Anything that cannot be read to completion is retryable
     * ({@code runtime_external_unavailable}) so the Broker keeps the placement
     * adoptable; a row that was read but disagrees with itself is a permanent
     * refusal instead of a pick-one guess.
     */
    @Override
    public Optional<RegisteredExternalStorage> find(String tenant,
            String tenantWorkspaceId) {
        if (tenant == null || tenant.isEmpty() || tenantWorkspaceId == null
                || tenantWorkspaceId.isEmpty()) {
            throw new RuntimeBrokerException(400,
                    "invalid_external_storage_registration",
                    "Invalid external storage registration lookup.", false);
        }
        String aliasKey = JdbcRuntimeBindingRepository.storageAliasKey(tenant,
                tenantWorkspaceId);
        List<Map<String, Object>> rows;
        try {
            rows = jdbc.queryForList(
                    "SELECT s.registration_json, s.registration_revision,"
                            + " s.physical_key, o.mount_root"
                            + " FROM ma_storage s JOIN ma_storage_owner o"
                            + " ON o.storage_key = s.physical_key"
                            + " WHERE s.alias_key = ?"
                            + " AND s.storage_kind = 'EXTERNAL'"
                            + " AND s.registration_state = 'REGISTERED'",
                    aliasKey);
        } catch (RuntimeException failure) {
            // A read that did not complete proves nothing about the registration,
            // so it must not bury a recoverable placement: retry it.
            throw unavailable();
        }
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        if (rows.size() != 1) {
            throw registrationMismatch();
        }
        Map<String, Object> row = rows.get(0);
        ExternalStorageRegistration registration;
        try {
            registration = decode(String.valueOf(row.get("registration_json")),
                    ExternalStorageRegistration.class);
        } catch (RuntimeException failure) {
            // A record this build cannot decode is indistinguishable from an
            // unreadable one; refusing it permanently would pin the placement.
            throw unavailable();
        }
        Object revision = row.get("registration_revision");
        // The primary-key lookup already bound the tenant and alias; these checks
        // catch a row that drifted away from its own persisted record.
        if (registration == null || !(revision instanceof Number number)
                || !tenantWorkspaceId.equals(
                        registration.alias().tenantWorkspaceId())
                || !registration.identity().ownerKey()
                        .equals(String.valueOf(row.get("physical_key")))
                || registration.identity().registrationRevision() != number.longValue()
                || !registration.alias().mountRoot()
                        .equals(String.valueOf(row.get("mount_root")))) {
            throw registrationMismatch();
        }
        return Optional.of(new RegisteredExternalStorage(
                registration.identity().providerId(),
                registration.identity().physicalKey(),
                registration.identity().registrationRevision(),
                registration.alias().tenantWorkspaceId(),
                registration.alias().aliasPath(),
                registration.alias().mountRoot()));
    }

    private static RuntimeBrokerException registrationMismatch() {
        return new RuntimeBrokerException(409,
                "external_storage_registration_mismatch",
                "The external storage registration is inconsistent.", false);
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(503, "runtime_external_unavailable",
                "External Runtime provider is unavailable.", true);
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
