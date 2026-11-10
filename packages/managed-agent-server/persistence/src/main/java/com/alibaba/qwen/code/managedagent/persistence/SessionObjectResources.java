package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AllocateResourceRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ResourceAllocation;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

/** Session-owned immutable uploads. Tool Publication owns its separate admission protocol. */
@Repository
public class SessionObjectResources {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JdbcManagedSessionStore sessions;
    private final ImmutableObjectStore objects;
    private final ManagedAgentSettings properties;
    private final ObjectMapper json;
    private final JournalStoreRows rows;
    private final SessionResourceBodies bodies;
    private final ToolPublicationRetentionStore retention;
    private final SessionResourceTransactions resourceTransactions;
    private final com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readers;

    public SessionObjectResources(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            JdbcManagedSessionStore sessions, @Nullable ImmutableObjectStore objects,
            ManagedAgentSettings properties, @Qualifier("managedAgentObjectMapper") ObjectMapper json,
            com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readers) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.sessions = sessions;
        this.objects = objects;
        this.properties = properties;
        this.json = json;
        this.readers = readers;
        this.rows = new JournalStoreRows(com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy.inProcess(), jdbc);
        this.bodies = new SessionResourceBodies(jdbc, objects);
        this.retention = new ToolPublicationRetentionStore(jdbc, manager);
        this.resourceTransactions = new SessionResourceTransactions(jdbc, manager, objects);
        if ((properties.getObjectStore().isResourceWritesEnabled() || properties.getObjectStore().isJournalColdStorageEnabled())
                && objects == null) {
            throw new IllegalStateException("External Session storage requires an object store provider");
        }
        sessions.installObjectResources(this);
    }

    public boolean writesEnabled() {
        return properties.getObjectStore().isResourceWritesEnabled();
    }

    boolean externalPublication(String tenant, String session, String id, long length) {
        if (length <= ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES) {
            return false;
        }
        var existing = rows.findResource(ManagedSessionStore.sessionScopeKey(tenant, session), id, false);
        return existing == null ? writesEnabled() : "OBJECT_STORE".equals(existing.storageKind());
    }

    SessionResourceBodies bodies() {
        return bodies;
    }

    <T> T readTransaction(String tenant, String session, TransactionTemplate sql, Supplier<T> action) {
        return resourceTransactions.read(tenant, session, sql, action);
    }

    <T> T protectedResources(Supplier<T> action, Runnable authorize) {
        return resourceTransactions.protectedRead(action, authorize);
    }

    public ResourceAllocation allocate(String tenant, String session, String token,
            AllocateResourceRequest request, RuntimeLifecycleAuthority authority) {
        return allocate(tenant, session, token, request, authority, null, false);
    }

    private ResourceAllocation allocate(String tenant, String session, String token,
            AllocateResourceRequest request, RuntimeLifecycleAuthority authority, ManagedNativeJournalSnapshots.PublishRequest snapshot, boolean configuration) {
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        readers.requireReadable(6);
        validate(request, snapshot != null);
        return transactions.execute(status -> {
            authorize(tenant, session, token, request, authority, snapshot, configuration);
            String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
            var existing = rows.findResource(scope, request.resourceId(), false);
            if (existing != null) {
                existing = rows.findResource(scope, request.resourceId());
                requireDescriptor(existing, tenant, session, request);
                String upload = jdbc.queryForObject("SELECT publish_command_id FROM ma_resource WHERE resource_key = ?",
                        String.class, ManagedSessionStore.resourceKey(scope, request.resourceId()));
                requireAttempt(tenant, session, upload, request, token, snapshot, configuration);
                return new ResourceAllocation(upload, ref(request));
            }
            requireWrites();
            String upload = UUID.randomUUID().toString();
            String target = ManagedSessionStore.resourceKey(scope, request.resourceId());
            String objectKey = "sessions/" + scope + "/resources/" + target + "/" + upload;
            long now = ToolPublicationRetentionStore.now(jdbc);
            String encoded = encodedRequest(request, token, snapshot, configuration);
            jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_id, operation_kind,"
                    + " tenant_id, workspace_id, session_id, target_kind, target_key, request_digest, request_json, state, phase,"
                    + " claim_generation, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'OBJECT_PUT', ?, ?, ?, 'RESOURCE', ?, ?, ?, 'PREPARED', 'SESSION_RESOURCE', 1, ?, ?)",
                    operationKey(scope, target, upload), scope, scope, upload, tenant, request.workspaceId(), session, target,
                    JournalStoreRows.sha256(encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8)), encoded, now, now);
            jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id,"
                    + " kind, schema_version, byte_length, sha256, storage_kind, store_id, object_key, publish_command_id, state, gmt_create)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OBJECT_STORE', ?, ?, ?, 'ALLOCATED', ?)",
                    target, scope, tenant, request.workspaceId(), session, request.resourceId(), request.kind(), request.schemaVersion(),
                    request.byteLength(), request.digest(), bodies.identity(), objectKey, upload, now);
            return new ResourceAllocation(upload, ref(request));
        });
    }

    public ToolResultResourceRef upload(String tenant, String session, String resourceId, String upload,
            String token, InputStream input, RuntimeLifecycleAuthority authority) {
        return upload(tenant, session, resourceId, upload, token, input, authority, null, false);
    }

    private ToolResultResourceRef upload(String tenant, String session, String resourceId, String upload,
            String token, InputStream input, RuntimeLifecycleAuthority authority, ManagedNativeJournalSnapshots.PublishRequest snapshot, boolean configuration) {
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        if (objects == null) {
            throw SessionResourceBodies.unavailable();
        }
        JournalStoreRows.validateStableId(resourceId, "resourceId");
        JournalStoreRows.validateStableId(upload, "uploadId");
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String target = ManagedSessionStore.resourceKey(scope, resourceId);
        String operation = operationKey(scope, target, upload);
        Upload admitted = transactions.execute(status -> {
            JsonNode saved = request(operation, tenant, session);
            AllocateResourceRequest descriptor = decode(saved);
            if (saved.path("configuration").asBoolean(false) != configuration
                    || !java.util.Objects.equals(snapshot, json.convertValue(saved.get("snapshot"), ManagedNativeJournalSnapshots.PublishRequest.class))) {
                throw JournalStoreRows.invalid("The upload requires its original snapshot publisher.");
            }
            if (!descriptor.resourceId().equals(resourceId) || !configuration && !JournalFencing.tokenHash(token).equals(saved.path("writerTokenHash").asText())) {
                throw JournalFencing.writerConflict();
            }
            authorize(tenant, session, token, descriptor, authority, snapshot, configuration);
            var resource = rows.findResource(scope, resourceId);
            requireDescriptor(resource, tenant, session, descriptor);
            String state = jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_key = ? FOR UPDATE", String.class, operation);
            if ("PUBLISHED".equals(resource.state()) || "REFERENCED".equals(resource.state())) {
                rows.verifyStoredResource(resource);
                return new Upload(descriptor, resource, false, true);
            }
            if (!"ALLOCATED".equals(resource.state()) || !List.of("PREPARED", "IN_FLIGHT", "UNKNOWN", "RETURNED").contains(state)) {
                throw unresolved();
            }
            boolean create = "PREPARED".equals(state);
            if (create) {
                requireWrites();
                readers.requireReadable(6);
                if (jdbc.update("UPDATE ma_operation SET state = 'IN_FLIGHT', gmt_modified = ? WHERE operation_key = ? AND state = 'PREPARED'",
                        ToolPublicationRetentionStore.now(jdbc), operation) != 1) {
                    throw unresolved();
                }
            }
            return new Upload(descriptor, resource, create, false);
        });
        if (admitted.published()) {
            return ref(admitted.request());
        }
        Runnable guard = () -> transactions.executeWithoutResult(status ->
                authorize(tenant, session, token, admitted.request(), authority, snapshot, configuration));
        try (var lease = retention.readSessionResources(tenant, session)) {
            Runnable held = () -> {
                lease.check();
                guard.run();
            };
            if (admitted.create()) {
                try {
                    var source = new GuardedInput(input, held, admitted.row().byteLength(), admitted.row().digest());
                    objects.putIfAbsent(admitted.row().objectKey(), source, admitted.row().byteLength(), held);
                    source.verify();
                    jdbc.update("UPDATE ma_operation SET state = 'RETURNED', gmt_modified = ? WHERE operation_key = ? AND state = 'IN_FLIGHT'",
                            ToolPublicationRetentionStore.now(jdbc), operation);
                } catch (ObjectStorageException failure) {
                    if (failure.reason() != ObjectStorageException.Reason.ALREADY_EXISTS) {
                        throw failure;
                    }
                }
            }
            try (InputStream stored = objects.open(admitted.row().objectKey(), admitted.row().byteLength() + 1, held)) {
                SessionResourceBodies.verifiedBytes(stored, admitted.row().byteLength(), admitted.row().digest(), held);
            }
            transactions.executeWithoutResult(status -> {
                authorize(tenant, session, token, admitted.request(), authority, snapshot, configuration);
                var current = rows.findResource(scope, resourceId);
                requireDescriptor(current, tenant, session, admitted.request());
                if (!SessionResourceBodies.same(admitted.row(), current)) {
                    throw unresolved();
                }
                long now = ToolPublicationRetentionStore.now(jdbc);
                jdbc.update("UPDATE ma_operation SET state = 'RETURNED', completed_at = ?, gmt_modified = ? WHERE operation_key = ? AND state IN ('IN_FLIGHT', 'UNKNOWN', 'RETURNED')",
                        now, now, operation);
                jdbc.update("UPDATE ma_resource SET state = 'PUBLISHED', last_verified_at = ? WHERE resource_key = ? AND state = 'ALLOCATED' AND deletion_operation_key IS NULL",
                        now, target);
            });
            return ref(admitted.request());
        } catch (IOException | RuntimeException failure) {
            jdbc.update("UPDATE ma_operation SET state = 'UNKNOWN', gmt_modified = ? WHERE operation_key = ? AND state = 'IN_FLIGHT'",
                    ToolPublicationRetentionStore.now(jdbc), operation);
            if (failure instanceof ManagedAgentException rejected) {
                throw rejected;
            }
            throw unresolved();
        }
    }

    <T> T commit(String tenant, String session, String token, CommitTransactionRequest request,
            RuntimeLifecycleAuthority authority, Supplier<T> commit) {
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            return commit.get();
        }
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        if (writesEnabled() && request.resources() != null) {
            JournalCommit.validateCommit(request);
            for (var resource : request.resources()) {
                if (resource.bytesBase64() == null || resource.byteLength() <= ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES) {
                    continue;
                }
                var existing = rows.findResource(ManagedSessionStore.sessionScopeKey(tenant, session), resource.resourceId(), false);
                if (existing != null && !"OBJECT_STORE".equals(existing.storageKind())) {
                    continue;
                }
                var allocation = allocate(tenant, session, token, new AllocateResourceRequest(request.workspaceId(), request.writerId(), request.writerGeneration(),
                        resource.resourceId(), resource.kind(), resource.schemaVersion(), resource.byteLength(), resource.digest()), authority);
                upload(tenant, session, resource.resourceId(), allocation.uploadId(), token, new java.io.ByteArrayInputStream(
                        JournalStoreRows.decodeBase64(resource.bytesBase64(), ManagedSessionStoreModels.resourceBytes(resource.kind()), "resource bytesBase64")), authority);
            }
        }
        return resourceTransactions.read(tenant, session, commit);
    }

    private void authorize(String tenant, String session, String token, AllocateResourceRequest request, RuntimeLifecycleAuthority authority,
            ManagedNativeJournalSnapshots.PublishRequest snapshot, boolean configuration) {
        if (configuration) {
            authorizeConfiguration(tenant, request.workspaceId(), session);
            return;
        }
        var owner = new ManagedSessionStoreModels.AuthorizeLifecycleRequest(request.workspaceId(), request.writerId(), request.writerGeneration(), null);
        if (snapshot != null) {
            sessions.lockSnapshotWriter(tenant, session, token, snapshot);
        } else {
            sessions.authorizeObjectWriter(tenant, session, token, owner, authority);
        }
        checkWriter(tenant, session, token, request);
    }

    private void checkWriter(String tenant, String session, String token, AllocateResourceRequest request) {
        var head = rows.requireHead(tenant, session);
        rows.requireHeadScope(head, tenant, request.workspaceId(), session);
        if (!"ACTIVE".equals(head.state()) || head.writerGeneration() != request.writerGeneration()
                || !request.writerId().equals(head.writerId()) || head.writerLeaseUntil() == null
                || head.writerLeaseUntil().getTime() <= ToolPublicationRetentionStore.now(jdbc)
                || !JournalFencing.secureEquals(JournalFencing.tokenHash(token), head.leaseTokenHash())) {
            throw JournalFencing.writerConflict();
        }
    }

    private void validate(AllocateResourceRequest request, boolean snapshot) {
        JournalStoreRows.validateStableId(request.resourceId(), "resourceId");
        JournalStoreRows.validateStableId(request.kind(), "kind");
        JournalStoreRows.validateDigest(request.digest(), "digest", false);
        if (!snapshot && (ManagedNativeJournalSnapshots.isSnapshotKind(request.kind()) || ManagedNativeJournalSnapshots.isSnapshotId(request.resourceId()))) {
            throw JournalStoreRows.invalid("Native snapshots require their dedicated fenced publisher.");
        }
        if (request.schemaVersion() < 1 || request.byteLength() <= ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES
                || request.byteLength() > ManagedSessionStoreModels.resourceBytes(request.kind())) {
            throw JournalStoreRows.payloadTooLarge("Invalid external resource size or version.");
        }
    }

    private void requireDescriptor(JournalStoreRows.ResourceRow row, String tenant, String session, AllocateResourceRequest request) {
        if (row == null) {
            throw unresolved();
        }
        JournalStoreRows.requireResourceScope(row, tenant, request.workspaceId(), session, request.resourceId());
        if (!"OBJECT_STORE".equals(row.storageKind()) || !bodies.identity().equals(row.storeId())
                || !request.kind().equals(row.kind()) || request.schemaVersion() != row.schemaVersion()
                || request.byteLength() != row.byteLength() || !request.digest().equals(row.digest())
                || row.deletionOperation() != null || !List.of("ALLOCATED", "PUBLISHED", "REFERENCED").contains(row.state())) {
            throw JournalStoreRows.conflict("managed_session_resource_conflict", "The resource identity is already used with different content or storage.");
        }
    }

    private String encodedRequest(AllocateResourceRequest request, String token, ManagedNativeJournalSnapshots.PublishRequest snapshot, boolean configuration) {
        com.fasterxml.jackson.databind.node.ObjectNode encoded = json.valueToTree(request);
        if (snapshot != null) {
            encoded.set("snapshot", json.valueToTree(snapshot));
        }
        if (configuration) {
            return encoded.put("configuration", true).toString();
        }
        return encoded.put("writerTokenHash", JournalFencing.tokenHash(token)).toString();
    }

    private void requireAttempt(String tenant, String session, String upload, AllocateResourceRequest descriptor, String token,
            ManagedNativeJournalSnapshots.PublishRequest snapshot, boolean configuration) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        var saved = request(operationKey(scope, ManagedSessionStore.resourceKey(scope, descriptor.resourceId()), upload), tenant, session);
        if (!saved.toString().equals(encodedRequest(descriptor, token, snapshot, configuration))) {
            AllocateResourceRequest previous = decode(saved);
            if (previous.writerGeneration() >= descriptor.writerGeneration() || !previous.workspaceId().equals(descriptor.workspaceId())
                    || !previous.resourceId().equals(descriptor.resourceId()) || !previous.kind().equals(descriptor.kind())
                    || previous.schemaVersion() != descriptor.schemaVersion() || previous.byteLength() != descriptor.byteLength()
                    || !previous.digest().equals(descriptor.digest()) || saved.has("snapshot") != (snapshot != null)
                    || saved.path("configuration").asBoolean(false) != configuration) {
                throw JournalStoreRows.conflict("managed_session_resource_conflict", "The original upload belongs to another writer.");
            }
            String encoded = encodedRequest(descriptor, token, snapshot, configuration);
            if (jdbc.update("UPDATE ma_operation SET request_json = ?, request_digest = ?, claim_generation = claim_generation + 1, gmt_modified = ?"
                    + " WHERE operation_key = ? AND state IN ('PREPARED','IN_FLIGHT','UNKNOWN','RETURNED')",
                    encoded, JournalStoreRows.sha256(encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8)), ToolPublicationRetentionStore.now(jdbc),
                    operationKey(scope, ManagedSessionStore.resourceKey(scope, descriptor.resourceId()), upload)) != 1) {
                throw unresolved();
            }
        }
    }

    private JsonNode request(String operation, String tenant, String session) {
        var saved = jdbc.query("SELECT request_json FROM ma_operation WHERE operation_key = ? AND operation_kind = 'OBJECT_PUT'"
                        + " AND phase = 'SESSION_RESOURCE' AND tenant_id = ? AND session_id = ?",
                (result, index) -> result.getString(1), operation, tenant, session);
        if (saved.size() != 1) {
            throw unresolved();
        }
        try {
            return json.readTree(saved.getFirst());
        } catch (IOException failure) {
            throw JournalStoreRows.resourceCorrupt();
        }
    }

    private AllocateResourceRequest decode(JsonNode saved) {
        return new AllocateResourceRequest(saved.path("workspaceId").asText(), saved.path("writerId").asText(),
                saved.path("writerGeneration").asLong(), saved.path("resourceId").asText(), saved.path("kind").asText(),
                saved.path("schemaVersion").asInt(), saved.path("byteLength").asLong(), saved.path("digest").asText());
    }

    private static String operationKey(String scope, String target, String upload) {
        return ManagedSchemaKeys.operationKey(OperationKind.OBJECT_PUT, scope, target, upload);
    }

    private static ToolResultResourceRef ref(AllocateResourceRequest request) {
        return new ToolResultResourceRef(request.resourceId(), request.kind(), request.schemaVersion(), request.byteLength(), request.digest());
    }

    ManagedSessionStoreModels.StoredResource publishSnapshot(String tenant, String session, String token,
            ManagedNativeJournalSnapshots.PublishRequest snapshot, byte[] bytes) {
        String digest = JournalStoreRows.sha256(bytes);
        String id = ManagedNativeJournalSnapshots.PAGE_KIND + ":" + digest;
        var request = new AllocateResourceRequest(snapshot.workspaceId(), snapshot.writerId(), snapshot.writerGeneration(), id,
                ManagedNativeJournalSnapshots.PAGE_KIND, 1, bytes.length, digest);
        var existing = rows.findResource(ManagedSessionStore.sessionScopeKey(tenant, session), id, false);
        if (existing != null && List.of("PUBLISHED", "REFERENCED").contains(existing.state())) {
            transactions.executeWithoutResult(status -> sessions.lockSnapshotWriter(tenant, session, token, snapshot));
            JournalStoreRows.requireResourceScope(existing, tenant, snapshot.workspaceId(), session, id);
            rows.verifyStoredResource(existing);
            if (!digest.equals(existing.digest()) || bytes.length != existing.byteLength()) {
                throw JournalStoreRows.resourceCorrupt();
            }
            bodies.read(existing, () -> checkWriter(tenant, session, token, request));
        } else {
            var allocated = allocate(tenant, session, token, request, null, snapshot, false);
            upload(tenant, session, id, allocated.uploadId(), token, new java.io.ByteArrayInputStream(bytes), null, snapshot, false);
        }
        return new ManagedSessionStoreModels.StoredResource(id, request.kind(), 1, bytes.length, digest, bytes);
    }

    ToolResultResourceRef publishConfiguration(String tenant, String workspace, String session, String kind, String id, byte[] bytes) {
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        if (!"managed-agent-skills".equals(kind)) {
            throw JournalStoreRows.invalid("Unsupported server configuration resource.");
        }
        var request = new AllocateResourceRequest(workspace, "server-configuration", 1, id, kind, 1, bytes.length, JournalStoreRows.sha256(bytes));
        String token = null;
        var allocated = allocate(tenant, session, token, request, null, null, true);
        return upload(tenant, session, id, allocated.uploadId(), token, new java.io.ByteArrayInputStream(bytes), null, null, true);
    }

    private void authorizeConfiguration(String tenant, String workspace, String session) {
        JournalStoreRows.validateScope(tenant, workspace, session);
        var roots = jdbc.queryForList("SELECT workspace_id, is_csi_guard, retired_at, deleted_at FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE", tenant, session);
        if (roots.size() != 1 || !workspace.equals(roots.getFirst().get("workspace_id"))
                || roots.getFirst().get("retired_at") != null || roots.getFirst().get("deleted_at") != null) {
            throw JournalStoreRows.conflict("managed_session_storage_unavailable", "The configuration publisher no longer owns a writable Session.");
        }
        ManagedLegacySessionGuard.requireLegacyMutation(ToolPublicationRetentionStore.flag(roots.getFirst(), "is_csi_guard"));
        if (!jdbc.queryForList("SELECT 1 FROM ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION' AND recovery_status <> 'READY' FOR UPDATE", Integer.class, tenant, session).isEmpty()) {
            throw JournalStoreRows.conflict("managed_session_storage_unavailable", "The Session is recovering.");
        }
    }

    private void requireWrites() {
        if (!writesEnabled() || objects == null) {
            throw new ManagedAgentException(501, ManagedSessionStoreModels.ERROR_OSS_DISABLED, "External Session resource writes are disabled.");
        }
    }

    private static ManagedAgentException unresolved() {
        return new ManagedAgentException(409, "managed_session_resource_put_unresolved", "The original resource upload has not been verified.");
    }

    private record Upload(AllocateResourceRequest request, JournalStoreRows.ResourceRow row, boolean create, boolean published) { }

    private static final class GuardedInput extends FilterInputStream {
        private final Runnable guard;
        private final long length;
        private final String digest;
        private final java.security.MessageDigest hash = org.apache.commons.codec.digest.DigestUtils.getSha256Digest();
        private long count;

        private GuardedInput(InputStream input, Runnable guard, long length, String digest) {
            super(input);
            this.guard = guard;
            this.length = length;
            this.digest = digest;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) == -1 ? -1 : one[0] & 255;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) throws IOException {
            guard.run();
            int read = in.read(bytes, offset, (int) Math.min(Math.min(length, 64 * 1024), this.length - count + 1));
            if (read > 0) {
                count += read;
                if (count > this.length) {
                    throw JournalStoreRows.invalid("The upload exceeds its declared length.");
                }
                hash.update(bytes, offset, read);
            }
            return read;
        }

        void verify() throws IOException {
            if (read() != -1 || count != length || !org.apache.commons.codec.binary.Hex.encodeHexString(hash.digest()).equals(digest)) {
                throw JournalStoreRows.invalid("The upload length or digest differs from its allocation.");
            }
        }
    }
}
