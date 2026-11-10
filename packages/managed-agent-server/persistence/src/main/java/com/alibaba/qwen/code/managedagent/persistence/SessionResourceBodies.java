package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import javax.sql.DataSource;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/** Object IO stays outside SQL; a scoped, immutable read set supplies locked validators. */
public final class SessionResourceBodies {
    private static final ThreadLocal<Prepared> PREPARED = new ThreadLocal<>();
    private static final long PREPARE_LIMIT = 128L * 1024 * 1024;
    private final JdbcTemplate jdbc;
    private final ImmutableObjectStore objects;

    public SessionResourceBodies(JdbcTemplate jdbc, ImmutableObjectStore objects) {
        this.jdbc = jdbc;
        this.objects = objects;
    }

    public String identity() {
        if (objects == null) {
            throw unavailable();
        }
        return objects.identity();
    }

    static boolean hasPrepared() {
        return PREPARED.get() != null;
    }

    static void requireJournal(String tenant, String session) {
        Prepared prepared = PREPARED.get();
        if (prepared != null && !prepared.journals.contains(
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session))) {
            throw new JournalPreparationRequired(tenant, session);
        }
    }

    static void authorizeDependency(String tenant, String session, Runnable authorize) {
        authorize.run();
        if (PREPARED.get() != null) {
            PREPARED.get().dependencies.put(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), authorize);
        }
    }

    public static byte[] preparedBody(Map<String, Object> fields) {
        if (!"OBJECT_STORE".equals(fields.get("storage_kind"))) {
            return (byte[]) fields.get("inline_bytes");
        }
        var row = new JournalStoreRows.ResourceRow((String) fields.get("tenant_id"), (String) fields.get("workspace_id"),
                (String) fields.get("session_id"), (String) fields.get("resource_id"), (String) fields.get("kind"),
                ((Number) fields.get("schema_version")).intValue(), ((Number) fields.get("byte_length")).longValue(),
                (String) fields.get("sha256"), (String) fields.get("storage_kind"), (byte[]) fields.get("inline_bytes"),
                (String) fields.get("object_key"), (String) fields.get("object_version_id"), (String) fields.get("encryption_key_id"),
                (String) fields.get("state"), (String) fields.get("capture_state"), (String) fields.get("deletion_operation_key"), (String) fields.get("store_id"));
        verifyLayout(row);
        Prepared prepared = PREPARED.get();
        if (prepared == null) {
            throw unavailable();
        }
        Saved saved = prepared.values.get(key(row));
        if (saved == null) {
            throw new PreparationRequired(row);
        }
        if (!same(saved.row(), row)) {
            throw JournalStoreRows.resourceCorrupt();
        }
        return saved.bytes();
    }

    byte[] read(JournalStoreRows.ResourceRow resource, Runnable guard) {
        if (!"OBJECT_STORE".equals(resource.storageKind())) {
            return resource.bytes();
        }
        verifyLayout(resource);
        Prepared prepared = PREPARED.get();
        if (prepared != null && prepared.source == jdbc.getDataSource()) {
            Saved saved = prepared.values.get(key(resource));
            if (saved != null) {
                if (!same(saved.row(), resource)) {
                    throw JournalStoreRows.conflict("managed_session_resource_conflict", "The prepared resource changed.");
                }
                guard.run();
                return saved.bytes();
            }
            if (TransactionSynchronizationManager.isActualTransactionActive()) {
                throw new PreparationRequired(resource);
            }
        }
        requireOutsideTransaction(jdbc);
        return fetch(resource, guard);
    }

    public byte[] read(String tenant, String workspace, String session, String resourceId, Runnable guard) {
        var rows = new JournalStoreRows(com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy.inProcess(), jdbc);
        var row = rows.findResource(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), resourceId, false);
        if (row == null) {
            throw JournalStoreRows.conflict("managed_session_resource_missing", "A committed resource is missing.");
        }
        JournalStoreRows.requireResourceScope(row, tenant, workspace, session, resourceId);
        rows.verifyStoredResource(row);
        byte[] bytes = read(row, guard);
        var current = rows.findResource(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), resourceId, false);
        if (current == null || !same(row, current)) {
            throw JournalStoreRows.resourceCorrupt();
        }
        rows.verifyStoredResource(current);
        guard.run();
        return bytes;
    }

    Prepared prepare() {
        requireOutsideTransaction(jdbc);
        if (PREPARED.get() != null) {
            throw new IllegalStateException("A resource preparation scope is already installed");
        }
        Prepared result = new Prepared(jdbc.getDataSource());
        PREPARED.set(result);
        return result;
    }

    void prepare(Prepared prepared, JournalStoreRows.ResourceRow row, Runnable guard) {
        if (!"OBJECT_STORE".equals(row.storageKind()) || prepared.values.containsKey(key(row))) {
            return;
        }
        if (row.byteLength() > PREPARE_LIMIT - prepared.bytes) {
            throw JournalStoreRows.payloadTooLarge("Prepared resource bodies exceed the 128 MiB commit budget.");
        }
        byte[] bytes = fetch(row, guard);
        prepared.bytes += bytes.length;
        prepared.values.put(key(row), new Saved(row, bytes));
    }

    private byte[] fetch(JournalStoreRows.ResourceRow row, Runnable guard) {
        verifyLayout(row);
        if (!identity().equals(row.storeId())) {
            throw new ManagedAgentException(503, "managed_session_object_store_mismatch", "The configured object store does not own this resource.");
        }
        guard.run();
        try (InputStream input = objects.open(row.objectKey(), row.byteLength() + 1, guard)) {
            byte[] bytes = verifiedBytes(input, row.byteLength(), row.digest(), guard);
            guard.run();
            return bytes;
        } catch (ObjectStorageException failure) {
            if (failure.reason() == ObjectStorageException.Reason.NOT_FOUND) {
                throw JournalStoreRows.resourceCorrupt();
            }
            throw unavailable();
        } catch (IOException failure) {
            throw unavailable();
        }
    }

    static byte[] verifiedBytes(InputStream input, long length, String digest, Runnable guard) throws IOException {
        if (length < 0 || length > ManagedSessionStoreModels.MAX_OBJECT_RESOURCE_BYTES) {
            throw JournalStoreRows.resourceCorrupt();
        }
        var hash = DigestUtils.getSha256Digest();
        var output = new ByteArrayOutputStream((int) Math.min(length, 64 * 1024));
        byte[] buffer = new byte[64 * 1024];
        long count = 0;
        for (;;) {
            guard.run();
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, length - count + 1));
            if (read == -1) {
                break;
            }
            count += read;
            if (count > length) {
                throw JournalStoreRows.resourceCorrupt();
            }
            hash.update(buffer, 0, read);
            output.write(buffer, 0, read);
        }
        if (count != length || !org.apache.commons.codec.binary.Hex.encodeHexString(hash.digest()).equals(digest)) {
            throw JournalStoreRows.resourceCorrupt();
        }
        return output.toByteArray();
    }

    static void verifyLayout(JournalStoreRows.ResourceRow row) {
        if (!"OBJECT_STORE".equals(row.storageKind()) || row.bytes() != null || row.storeId() == null
                || row.objectKey() == null || row.objectVersionId() != null || row.encryptionKeyId() != null
                || row.deletionOperation() != null || row.captureState() != null
                || !("PUBLISHED".equals(row.state()) || "REFERENCED".equals(row.state()))
                || row.byteLength() < 0 || row.byteLength() > ManagedSessionStoreModels.resourceBytes(row.kind())) {
            throw JournalStoreRows.resourceCorrupt();
        }
    }

    static void requireOutsideTransaction(JdbcTemplate jdbc) {
        if (TransactionSynchronizationManager.isActualTransactionActive()
                || TransactionSynchronizationManager.hasResource(jdbc.getDataSource())) {
            throw new IllegalStateException("Object IO requires a transaction-free caller");
        }
    }

    static boolean same(JournalStoreRows.ResourceRow first, JournalStoreRows.ResourceRow second) {
        return Objects.equals(first.tenantId(), second.tenantId()) && Objects.equals(first.workspaceId(), second.workspaceId())
                && Objects.equals(first.sessionId(), second.sessionId()) && Objects.equals(first.resourceId(), second.resourceId())
                && Objects.equals(first.kind(), second.kind()) && first.schemaVersion() == second.schemaVersion()
                && first.byteLength() == second.byteLength() && Objects.equals(first.digest(), second.digest())
                && Objects.equals(first.storageKind(), second.storageKind()) && Objects.equals(first.storeId(), second.storeId())
                && Objects.equals(first.objectKey(), second.objectKey()) && Objects.equals(first.objectVersionId(), second.objectVersionId())
                && Objects.equals(first.encryptionKeyId(), second.encryptionKeyId()) && second.deletionOperation() == null;
    }

    private static String key(JournalStoreRows.ResourceRow row) {
        return com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(row.tenantId(), row.sessionId()), row.resourceId());
    }

    static ManagedAgentException unavailable() {
        return new ManagedAgentException(503, "managed_session_object_store_unavailable", "The Session object store is unavailable.");
    }

    private record Saved(JournalStoreRows.ResourceRow row, byte[] bytes) { }

    public static final class PreparationRequired extends RuntimeException {
        private final JournalStoreRows.ResourceRow resource;

        private PreparationRequired(JournalStoreRows.ResourceRow resource) {
            super("The SQL read set requires an immutable resource", null, false, false);
            this.resource = resource;
        }

        JournalStoreRows.ResourceRow resource() {
            return resource;
        }
    }

    static final class JournalPreparationRequired extends RuntimeException {
        final String tenant;
        final String session;

        private JournalPreparationRequired(String tenant, String session) {
            super("The SQL inventory requires a HOT journal lease", null, false, false);
            this.tenant = tenant;
            this.session = session;
        }
    }

    static final class Prepared implements AutoCloseable {
        private final DataSource source;
        private final Map<String, Saved> values = new HashMap<>();
        final Map<String, Runnable> dependencies = new HashMap<>();
        final java.util.Set<String> journals = new java.util.HashSet<>();
        private long bytes;

        private Prepared(DataSource source) {
            this.source = source;
        }

        @Override
        public void close() {
            if (PREPARED.get() != this) {
                throw new IllegalStateException("Resource preparation scope changed");
            }
            PREPARED.remove();
        }
    }
}
