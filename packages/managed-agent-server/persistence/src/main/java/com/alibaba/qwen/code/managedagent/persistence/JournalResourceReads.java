package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.io.InputStream;

final class JournalResourceReads {
    private final JournalFencing fencing;
    private final JournalStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final ToolPublicationObjectStore publicationObjects;
    private final ToolPublicationRetentionStore outputRetention;

    JournalResourceReads(JournalFencing fencing,
            JournalStoreRows storeRows,
            JdbcTemplate jdbc,
            ToolPublicationObjectStore publicationObjects,
            ToolPublicationRetentionStore outputRetention) {
        this.fencing = fencing;
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.publicationObjects = publicationObjects;
        this.outputRetention = outputRetention;
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
        return readResource(tenantId, workspaceId, sessionId, resourceId, writerToken);
    }

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
