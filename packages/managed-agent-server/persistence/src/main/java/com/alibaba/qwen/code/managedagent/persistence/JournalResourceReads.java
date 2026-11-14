package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiFilesRetirementGuard;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.Objects;

final class JournalResourceReads {
    private final JournalFencing fencing;
    private final JournalStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final ToolPublicationObjectStore publicationObjects;
    private final ToolPublicationRetentionStore outputRetention;
    private final org.springframework.transaction.support.TransactionTemplate ownerReads;

    JournalResourceReads(JournalFencing fencing,
            JournalStoreRows storeRows,
            JdbcTemplate jdbc,
            ToolPublicationObjectStore publicationObjects,
            ToolPublicationRetentionStore outputRetention,
            org.springframework.transaction.support.TransactionTemplate ownerReads) {
        this.fencing = fencing;
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.publicationObjects = publicationObjects;
        this.outputRetention = outputRetention;
        this.ownerReads = ownerReads;
    }

    StoredResource readResource(String tenantId, String workspaceId,
            String sessionId, String resourceId, String writerToken) {
        return readResource(tenantId, workspaceId, sessionId, resourceId, writerToken, true);
    }

    StoredResource readSnapshotResource(String tenantId, String workspaceId, String sessionId,
            String resourceId, String writerToken) {
        return readResource(tenantId, workspaceId, sessionId, resourceId, writerToken, false);
    }

    StoredResource readResource(String tenantId, String workspaceId,
            String sessionId, String resourceId, String writerToken, boolean updateVerification) {
        JournalStoreRows.validateScope(tenantId, workspaceId, sessionId);
        fencing.requireCredential(tenantId, workspaceId, sessionId, writerToken);
        if (updateVerification && ManagedNativeJournalSnapshots.isSnapshotId(resourceId)) {
            throw JournalStoreRows.invalid("Native snapshot resources require the journal-snapshots read API.");
        }
        JournalStoreRows.validateStableId(resourceId, "resourceId");
        JournalStoreRows.HeadRow head = storeRows.requireHead(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, workspaceId, sessionId);
        fencing.requireReadGrant(head, writerToken);
        try (var lease = outputRetention.read(tenantId, sessionId)) {
            String scopeKey = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
            JournalStoreRows.ResourceRow resource = storeRows.findResource(scopeKey, resourceId, updateVerification);
            if (resource == null) {
                throw new ManagedAgentException(404,
                        ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND,
                        "The Managed Session resource does not exist.");
            }
            JournalStoreRows.requireResourceScope(resource, tenantId, workspaceId, sessionId,
                    resourceId);
            storeRows.verifyStoredResource(resource);
            if (updateVerification) {
                jdbc.update("UPDATE ma_resource SET"
                            + " last_verified_at = ? WHERE session_scope_key = ?"
                            + " AND resource_id = ?",
                        storeRows.databaseNow(), scopeKey, resourceId);
            }
            byte[] bytes = "TOOL_PUBLICATION".equals(resource.storageKind())
                    ? readPublicationObject(resource, lease, updateVerification)
                    : "OSS_OBJECT".equals(resource.storageKind())
                            ? readSessionObject(resource) : resource.bytes();
            var result = new StoredResource(resource.resourceId(), resource.kind(),
                    resource.schemaVersion(), resource.byteLength(),
                    resource.digest(), bytes);
            lease.check();
            return result;
        }
    }

    private byte[] readSessionObject(JournalStoreRows.ResourceRow resource) {
        byte[] bytes;
        try (java.io.InputStream stream = publicationObjects.open(resource.objectKey(), () -> {})) {
            bytes = stream.readAllBytes();
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Session resource read failed", error);
        }
        if (bytes.length != resource.byteLength()
                || !JournalStoreRows.sha256(bytes).equals(resource.digest())) {
            throw JournalStoreRows.conflict(ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                    "The external resource object is missing or corrupt.");
        }
        return bytes;
    }

    StoredResource readOwnerResource(
            String tenantId,
            String workspaceId,
            String sessionId,
            String resourceId,
            String writerToken) {
        if (ManagedNativeJournalSnapshots.isSnapshotId(resourceId)) {
            fencing.requireCredential(tenantId, workspaceId, sessionId, writerToken);
            throw JournalStoreRows.invalid("Native snapshot resources require the journal-snapshots read API.");
        }
        if (org.springframework.transaction.support.TransactionSynchronizationManager
                        .isActualTransactionActive()
                || org.springframework.transaction.support.TransactionSynchronizationManager
                        .hasResource(jdbc.getDataSource())) {
            throw new IllegalStateException(
                    "Owner resource reads require a fresh transaction boundary");
        }
        JournalStoreRows.validateScope(tenantId, workspaceId, sessionId);
        fencing.requireCredential(tenantId, workspaceId, sessionId, writerToken);
        JournalStoreRows.validateStableId(resourceId, "resourceId");
        var guarded =
                jdbc.queryForList(
                        "SELECT is_csi_guard FROM ma_session"
                                + " WHERE tenant_id = ? AND session_id = ? AND is_csi_guard = TRUE",
                        tenantId,
                        sessionId);
        if (guarded.isEmpty()) {
            return readResource(tenantId, workspaceId, sessionId, resourceId, writerToken);
        }
        NativeRead admission =
                ownerReads.execute(
                        status -> {
                            var continuation = fencing.lockCsiContinuation(tenantId, sessionId);
                            var original = continuation == null ? null : continuation.original();
                            if (original == null) {
                                throw JournalFencing.nativeReadConflict();
                            }
                            if (original.state() == com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.DRAINING) {
                                jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                                    JdbcCsiActivationAdmission.requireCheckpointContinuationRead(
                                            org.springframework.jdbc.datasource.DataSourceUtils.getTargetConnection(connection),
                                            original, continuation.progress(), resourceId,
                                            new JdbcJournalPacks(jdbc, publicationObjects, null));
                                    return null;
                                });
                            } else {
                                original.requireAdmission();
                            }
                            JournalStoreRows.HeadRow head = fencing.requireHeadAfterCsiCheck(tenantId, sessionId);
                            storeRows.requireHeadScope(head, tenantId, workspaceId, sessionId);
                            JournalFencing.requireCsiWriter(original, head);
                            fencing.requireReadGrant(head, writerToken);
                            JournalStoreRows.ResourceRow resource =
                                    nativeResourceMetadata(tenantId, sessionId, resourceId);
                            if (resource == null) {
                                throw new ManagedAgentException(
                                        404,
                                        ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND,
                                        "The Managed Session resource does not exist.");
                            }
                            JournalStoreRows.requireResourceScope(
                                    resource, tenantId, workspaceId, sessionId, resourceId);
                            if (!"MYSQL_INLINE".equals(resource.storageKind())
                                    || resource.objectKey() != null
                                    || resource.objectVersionId() != null
                                    || resource.encryptionKeyId() != null) {
                                throw JournalStoreRows.conflict(
                                        "csi_inline_resource_required",
                                        "The original owner reader requires an inline resource.");
                            }
                            String id = java.util.UUID.randomUUID().toString();
                            fencing.requireCsiReadGrant(continuation, head, writerToken);
                            long started = ToolPublicationRetentionStore.now(jdbc);
                            long expires =
                                    Math.addExact(
                                            started,
                                            ToolPublicationRetentionStore.READ_BUDGET_MILLIS);
                            fencing.requireCsiLease(continuation, expires, expires);
                            long readBindingVersion = continuation.progress().sealedBindingVersion() == null ? original.version() : continuation.progress().sealedBindingVersion();
                            var evidence =
                                    JournalStoreRows.CSI_JSON.createObjectNode()
                                            .put("read_id", id)
                                            .put("tenant_id", tenantId)
                                            .put("workspace_id", workspaceId)
                                            .put("session_id", sessionId)
                                            .put("request_key", original.request().requestKey())
                                            .put("binding_id", original.bindingId())
                                            .put("runtime_generation", original.generation())
                                            .put("binding_version", readBindingVersion)
                                            .put("writer_id", head.writerId())
                                            .put("writer_generation", head.writerGeneration())
                                            .put("writer_token_hash", head.leaseTokenHash())
                                            .put("journal_revision", head.journalRevision())
                                            .put("activation_id", head.activationId())
                                            .put("activation_epoch", head.activationEpoch())
                                            .put("resource_id", resourceId)
                                            .put("kind", resource.kind())
                                            .put("schema_version", resource.schemaVersion())
                                            .put("byte_length", resource.byteLength())
                                            .put("sha256", resource.digest())
                                            .put("storage_kind", resource.storageKind())
                                            .put("resource_state", resource.state())
                                            .put("started_at", started)
                                            .put("delivery_expires_at", expires);
                            String encoded = evidence.toString();
                            String receipt =
                                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key("csi-read", id);
                            jdbc.update(
                                    "INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id, scope_kind, scope_key, scope_id, idempotency_key, idempotency_digest, request_digest, operation, state, session_id, result_json, gmt_create, gmt_modified) VALUES (?, 'SESSION_COMMAND', ?, ?, 'SESSION', ?, ?, ?, ?, ?, 'CSI_RESOURCE_READ', 'OPEN', ?, ?, ?, ?)",
                                    receipt,
                                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(tenantId),
                                    tenantId,
                                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key("csi-read", tenantId, sessionId),
                                    sessionId,
                                    id,
                                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(id),
                                    JournalStoreRows.sha256(encoded.getBytes(StandardCharsets.UTF_8)),
                                    sessionId,
                                    encoded,
                                    started,
                                    started);
                            fencing.requireCsiReadGrant(continuation, head, writerToken);
                            jdbc.update(
                                    "INSERT INTO ma_read_lease (lease_id, tenant_key, session_key,"
                                        + " retirement_generation, expires_at) VALUES (?, ?, ?, 0,"
                                        + " ?)",
                                    id,
                                    ToolPublicationRetentionStore.hash(tenantId),
                                    ToolPublicationRetentionStore.hash(sessionId),
                                    expires);
                            var persisted = nativeReadReceipt(id, false);
                            return new NativeRead(id, original, head, resource, persisted, expires);
                        });
        JournalStoreRows.ResourceRow fetched;
        try {
            fetched = fetchNativeResource(admission);
        } catch (RuntimeException | Error failure) {
            try {
                finishNativeRead(admission, null, false, writerToken);
            } catch (RuntimeException | Error completion) {
                failure.addSuppressed(completion);
            }
            throw failure;
        }
        ManagedAgentException failure = finishNativeRead(admission, fetched, true, writerToken);
        if (failure != null) {
            throw failure;
        }
        return new StoredResource(
                fetched.resourceId(),
                fetched.kind(),
                fetched.schemaVersion(),
                fetched.byteLength(),
                fetched.digest(),
                fetched.bytes());
    }

    java.util.Map<String, Object> nativeReadReceipt(String id, boolean lock) {
        return jdbc.queryForMap(
                "SELECT " + ManagedSchemaProjection.REQUEST_RECEIPT.columns() + " FROM ma_request_receipt WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND' AND operation = 'CSI_RESOURCE_READ'"
                        + (lock ? " FOR UPDATE" : ""),
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                        "csi-read", id));
    }

    void completeNativeRead(
            NativeRead admission, String state, Long endedAt, String outcome) {
        com.fasterxml.jackson.databind.node.ObjectNode evidence;
        try {
            evidence =
                    (com.fasterxml.jackson.databind.node.ObjectNode)
                            JournalStoreRows.CSI_JSON.readTree((String) admission.persisted().get("result_json"));
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Original read receipt is corrupt", error);
        }
        evidence.put("ended_at", endedAt).put("outcome_code", outcome);
        if (jdbc.update(
                        "UPDATE ma_request_receipt SET state = ?, result_json = ?, gmt_modified = ? WHERE receipt_key = ? AND namespace = 'SESSION_COMMAND' AND operation = 'CSI_RESOURCE_READ' AND state = 'OPEN'",
                        state,
                        evidence.toString(),
                        ToolPublicationRetentionStore.now(jdbc),
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                                "csi-read", admission.id()))
                != 1) {
            throw JournalFencing.nativeReadConflict();
        }
    }

    JournalStoreRows.ResourceRow nativeResourceMetadata(String tenant, String session, String resource) {
        var rows =
                jdbc.query(
                        "SELECT tenant_id, workspace_id, session_id, resource_id, kind,"
                            + " schema_version, byte_length, sha256, storage_kind, NULL AS"
                            + " inline_bytes, object_key, object_version_id, encryption_key_id,"
                            + " state, capture_state, deletion_operation_key FROM ma_resource WHERE"
                            + " session_scope_key = ? AND resource_id = ? AND resource_key = ? FOR"
                            + " UPDATE",
                        storeRows.resourceMapper,
                        ManagedSessionStore.sessionScopeKey(tenant, session),
                        resource,
                        com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                                ManagedSessionStore.sessionScopeKey(tenant, session), resource));
        return rows.isEmpty() ? null : rows.getFirst();
    }

    JournalStoreRows.ResourceRow fetchNativeResource(NativeRead admission) {
        try (var connection = jdbc.getDataSource().getConnection();
                var statement =
                        connection.prepareStatement(
                                "SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE session_scope_key = ? AND resource_id = ? AND resource_key = ?")) {
            statement.setQueryTimeout(10);
            statement.setString(
                    1, ManagedSessionStore.sessionScopeKey(admission.head().tenantId(), admission.head().sessionId()));
            statement.setBytes(
                    2,
                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.identity(
                            admission.resource().resourceId()));
            statement.setString(
                    3,
                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                            ManagedSessionStore.sessionScopeKey(
                                    admission.head().tenantId(), admission.head().sessionId()),
                            admission.resource().resourceId()));
            try (var rows = statement.executeQuery()) {
                return rows.next() ? storeRows.resourceMapper.mapRow(rows, 0) : null;
            }
        } catch (SQLException failure) {
            throw new org.springframework.dao.DataAccessResourceFailureException(
                    "Original resource fetch did not complete", failure);
        }
    }

    ManagedAgentException finishNativeRead(
            NativeRead admission, JournalStoreRows.ResourceRow fetched, boolean returned, String writerToken) {
        return ownerReads.execute(
                status -> {
                    JournalStoreRows.HeadRow admittedHead = admission.head();
                    var continuation =
                            fencing.lockCsiContinuation(admittedHead.tenantId(), admittedHead.sessionId());
                    var original = continuation == null ? null : continuation.original();
                    if (original == null
                            || !original.request().equals(admission.original().request())
                            || !original.bindingId().equals(admission.original().bindingId())
                            || original.generation() != admission.original().generation()
                            || original.version() < admission.original().version()) {
                        throw JournalFencing.nativeReadConflict();
                    }
                    original.requireAdmission();
                    JournalStoreRows.HeadRow head =
                            fencing.requireHeadAfterCsiCheck(admittedHead.tenantId(), admittedHead.sessionId());
                    var persisted = nativeReadReceipt(admission.id(), true);
                    if (!persisted.equals(admission.persisted())) {
                        throw JournalFencing.nativeReadConflict();
                    }
                    if (!returned) {
                        fencing.requireCsiReadGrant(continuation, head, writerToken);
                        completeNativeRead(admission, "UNKNOWN", null, "jdbc_fetch_unknown");
                        return null;
                    }
                    ManagedAgentException failure = null;
                    try {
                        storeRows.requireHeadScope(
                                head,
                                admittedHead.tenantId(),
                                admittedHead.workspaceId(),
                                admittedHead.sessionId());
                        fencing.requireReadGrant(head, writerToken);
                        if (!Objects.equals(head.writerId(), admittedHead.writerId())
                                || head.writerGeneration() != admittedHead.writerGeneration()) {
                            throw JournalFencing.writerConflict();
                        }
                        var lease =
                                jdbc.queryForList(
                                        "SELECT expires_at, retirement_generation FROM"
                                            + " ma_read_lease WHERE lease_id = ? AND tenant_key = ?"
                                            + " AND session_key = ? FOR UPDATE",
                                        admission.id(),
                                        ToolPublicationRetentionStore.hash(head.tenantId()),
                                        ToolPublicationRetentionStore.hash(head.sessionId()));
                        long now = ToolPublicationRetentionStore.now(jdbc);
                        if (lease.size() != 1
                                || ((Number) lease.getFirst().get("expires_at")).longValue()
                                        != admission.expires()
                                || admission.expires() <= now
                                || ((Number) lease.getFirst().get("retirement_generation"))
                                                .longValue()
                                        != 0) {
                            throw JournalStoreRows.conflict(
                                    "tool_output_read_expired",
                                    "The original output read delivery lease expired.");
                        }
                        JournalStoreRows.ResourceRow current =
                                nativeResourceMetadata(
                                        head.tenantId(),
                                        head.sessionId(),
                                        admission.resource().resourceId());
                        if (!sameNativeResource(admission.resource(), fetched)
                                || !sameNativeResource(admission.resource(), current)) {
                            throw JournalStoreRows.resourceCorrupt();
                        }
                        storeRows.verifyStoredResource(fetched);
                        fencing.requireCsiReadGrant(continuation, head, writerToken);
                        if (admission.expires() <= ToolPublicationRetentionStore.now(jdbc)) {
                            throw JournalFencing.nativeReadConflict();
                        }
                        jdbc.update(
                                "UPDATE ma_resource SET last_verified_at = ?"
                                        + " WHERE session_scope_key = ? AND resource_id = ?",
                                storeRows.databaseNow(),
                                ManagedSessionStore.sessionScopeKey(head.tenantId(), head.sessionId()),
                                fetched.resourceId());
                    } catch (ManagedAgentException rejected) {
                        failure = rejected;
                    }
                    fencing.requireCsiReadGrant(continuation, head, writerToken);
                    if (admission.expires() <= ToolPublicationRetentionStore.now(jdbc)) {
                        throw JournalFencing.nativeReadConflict();
                    }
                    completeNativeRead(
                            admission,
                            "RETURNED",
                            ToolPublicationRetentionStore.now(jdbc),
                            failure == null ? "verified" : failure.getCode());
                    fencing.requireCsiReadGrant(continuation, head, writerToken);
                    jdbc.update("DELETE FROM ma_read_lease WHERE lease_id = ?", admission.id());
                    return failure;
                });
    }

    static boolean sameNativeResource(JournalStoreRows.ResourceRow expected, JournalStoreRows.ResourceRow actual) {
        return actual != null
                && Objects.equals(expected.tenantId(), actual.tenantId())
                && Objects.equals(expected.workspaceId(), actual.workspaceId())
                && Objects.equals(expected.sessionId(), actual.sessionId())
                && Objects.equals(expected.resourceId(), actual.resourceId())
                && Objects.equals(expected.kind(), actual.kind())
                && expected.schemaVersion() == actual.schemaVersion()
                && expected.byteLength() == actual.byteLength()
                && Objects.equals(expected.digest(), actual.digest())
                && Objects.equals(expected.storageKind(), actual.storageKind())
                && Objects.equals(expected.state(), actual.state())
                && actual.objectKey() == null
                && actual.objectVersionId() == null
                && actual.encryptionKeyId() == null;
    }

    record NativeRead(
            String id,
            JdbcCsiFilesRetirementGuard.Original original,
            JournalStoreRows.HeadRow head,
            JournalStoreRows.ResourceRow resource,
            java.util.Map<String, Object> persisted,
            long expires) {}

    InputStream guardedPublicationResource(JournalStoreRows.ResourceRow resource, ToolPublicationRetentionStore.ReadLease lease) {
        lease.requireScope(resource.tenantId(), resource.sessionId());
        var rows = jdbc.queryForList("SELECT scope_key, publication_id FROM ma_resource"
                + " WHERE scope_key = ? AND resource_id = ? AND object_key = ?",
                ToolPublicationDataStore.scope(resource.tenantId(), resource.workspaceId(), resource.sessionId()),
                resource.resourceId(), resource.objectKey());
        if (rows.size() != 1) {
            throw JournalStoreRows.resourceCorrupt();
        }
        return outputRetention.open(resource.objectKey(), publicationObjects, lease, () -> {});
    }

    byte[] readPublicationObject(JournalStoreRows.ResourceRow resource, ToolPublicationRetentionStore.ReadLease lease, boolean quarantine) {
        if (publicationObjects == null) {
            throw JournalStoreRows.resourceCorrupt();
        }
        try (InputStream stream = guardedPublicationResource(resource, lease)) {
            byte[] bytes = stream.readNBytes(Math.toIntExact(resource.byteLength()) + 1);
            if (bytes.length != resource.byteLength()
                    || !JournalStoreRows.sha256(bytes).equals(resource.digest())) {
                var error = JournalStoreRows.resourceCorrupt();
                try {
                    if (quarantine) {
                        outputRetention.quarantineResource(
                                ToolPublicationDataStore.scope(resource.tenantId(), resource.workspaceId(), resource.sessionId()),
                                resource.resourceId(), resource.objectKey());
                    }
                } catch (RuntimeException cleanup) {
                    error.addSuppressed(cleanup);
                }
                throw error;
            }
            return bytes;
        } catch (IOException error) {
            throw new IllegalStateException("Tool publication object read failed", error);
        }
    }
}
