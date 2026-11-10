package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Server-proxied OSS externalization of oversized private Session resources (D2).
 *
 * <p>The allocation row in {@code ma_resource} is the durable idempotency record: its unique
 * business key plus digest/length comparison give replay and conflict semantics without a
 * separate receipt. Upload and read are proxied by the server because
 * {@link ToolPublicationObjectStore} exposes no presign operation; integrity is verified at
 * finalize and again on every external read.
 */
@Service
public class JdbcSessionResourceObjects {
    private final JdbcTemplate jdbc;
    private final ToolPublicationObjectStore objects;
    private final ManagedAgentSettings settings;

    public JdbcSessionResourceObjects(JdbcTemplate jdbc, ToolPublicationObjectStore objects,
            ManagedAgentSettings settings) {
        this.jdbc = jdbc;
        this.objects = objects;
        this.settings = settings;
    }

    @org.springframework.beans.factory.annotation.Autowired
    public JdbcSessionResourceObjects(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            ObjectProvider<ToolPublicationObjectStore> objects, ManagedAgentSettings settings) {
        this(jdbc, objects.getIfAvailable(), settings);
    }

    public record AllocateRequest(String workspaceId, String writerId, long writerGeneration,
            String resourceId, String kind, int schemaVersion, long byteLength, String digest) { }

    public record Allocation(String resourceId, String objectKey, long byteLength, String digest) { }

    private ManagedAgentSettings.SessionResources config() {
        ManagedAgentSettings.SessionResources config = settings.getSessionResources();
        if (config == null || !config.isEnabled()) {
            throw new ManagedAgentException(501, ManagedSessionStoreModels.ERROR_OSS_DISABLED,
                    "Session resource OSS storage is disabled.");
        }
        return config;
    }

    private ToolPublicationObjectStore store() {
        if (objects == null) {
            throw new ManagedAgentException(501, ManagedSessionStoreModels.ERROR_OSS_DISABLED,
                    "Session resource OSS storage requires a configured object store.");
        }
        return objects;
    }

    /** Body resolution for external reads; the caller has already authorized the writer. */
    public ManagedSessionStoreModels.StoredResource readExternal(String tenantId,
            String workspaceId, String sessionId, String resourceId) {
        config();
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT kind, schema_version, byte_length, sha256, object_key FROM ma_resource"
                        + " WHERE session_scope_key = ? AND resource_id = ? AND storage_kind ="
                        + " 'OSS_OBJECT' AND state IN ('PUBLISHED', 'REFERENCED')",
                scope, resourceId);
        if (rows.isEmpty()) {
            throw new ManagedAgentException(404, ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND,
                    "The Managed Session resource does not exist.");
        }
        Map<String, Object> row = rows.getFirst();
        byte[] bytes;
        try (InputStream stream = store().open(text(row.get("object_key")), () -> { })) {
            bytes = stream.readAllBytes();
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Session resource read failed", error);
        }
        if (bytes.length != ((Number) row.get("byte_length")).longValue()
                || !JournalStoreRows.sha256(bytes).equals(row.get("sha256"))) {
            throw JournalStoreRows.conflict(ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                    "The external resource object is missing or corrupt.");
        }
        return new ManagedSessionStoreModels.StoredResource(resourceId,
                text(row.get("kind")), ((Number) row.get("schema_version")).intValue(),
                bytes.length, text(row.get("sha256")), bytes);
    }

    @Transactional
    public Allocation allocate(String tenantId, String sessionId, AllocateRequest request) {
        ManagedAgentSettings.SessionResources config = config();
        JournalStoreRows.validateStableId(request.resourceId(), "resourceId");
        JournalStoreRows.validateStableId(request.kind(), "resource kind");
        JournalStoreRows.validateDigest(request.digest(), "resource digest", false);
        if (request.schemaVersion() < 1 || request.byteLength() < 0) {
            throw JournalStoreRows.invalid("Resource version or length is invalid.");
        }
        int cap = ManagedSessionStoreModels.inlineResourceBytes(request.kind());
        if (request.byteLength() <= cap) {
            throw JournalStoreRows.invalid("Resource fits inline storage; allocate is only for"
                    + " oversized resources.");
        }
        if (request.byteLength() > ManagedSessionStoreModels.MAX_INLINE_TRANSACTION_BYTES) {
            throw JournalStoreRows.payloadTooLarge("Resource exceeds its byte limit.");
        }
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        List<Map<String, Object>> existing = jdbc.queryForList(
                "SELECT storage_kind, state, object_key, byte_length, sha256 FROM ma_resource"
                        + " WHERE session_scope_key = ? AND resource_id = ? FOR UPDATE",
                scope, request.resourceId());
        if (!existing.isEmpty()) {
            Map<String, Object> row = existing.getFirst();
            if ("OSS_OBJECT".equals(row.get("storage_kind"))
                    && ((Number) row.get("byte_length")).longValue() == request.byteLength()
                    && request.digest().equals(row.get("sha256"))) {
                return new Allocation(request.resourceId(), text(row.get("object_key")),
                        request.byteLength(), request.digest());
            }
            throw JournalStoreRows.conflict("managed_session_resource_conflict",
                    "A resourceId was reused with different content metadata.");
        }
        String objectKey = config.getOssKeyPrefix() + scope + "/" + request.resourceId() + "/"
                + UUID.randomUUID();
        long now = System.currentTimeMillis();
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, object_key, state, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OSS_OBJECT', ?, 'ALLOCATED', ?)",
                ManagedSessionStore.resourceKey(scope, request.resourceId()), scope, tenantId,
                request.workspaceId(), sessionId, request.resourceId(), request.kind(),
                request.schemaVersion(), request.byteLength(), request.digest(), objectKey, now);
        return new Allocation(request.resourceId(), objectKey, request.byteLength(),
                request.digest());
    }

    @Transactional
    public void upload(String tenantId, String sessionId, String resourceId, byte[] bytes) {
        config();
        Map<String, Object> row = lockAllocation(tenantId, sessionId, resourceId);
        if (!"ALLOCATED".equals(row.get("state"))) {
            throw JournalStoreRows.conflict("managed_session_resource_conflict",
                    "The resource allocation is no longer uploadable.");
        }
        if (bytes.length != ((Number) row.get("byte_length")).longValue()) {
            throw JournalStoreRows.invalid("Uploaded bytes do not match the allocated length.");
        }
        store().putIfAbsent(text(row.get("object_key")), bytes);
    }

    @Transactional
    public void finalize(String tenantId, String sessionId, String resourceId) {
        config();
        Map<String, Object> row = lockAllocation(tenantId, sessionId, resourceId);
        if ("PUBLISHED".equals(row.get("state")) || "REFERENCED".equals(row.get("state"))) {
            return;
        }
        if (!"ALLOCATED".equals(row.get("state"))) {
            throw JournalStoreRows.conflict("managed_session_resource_conflict",
                    "The resource allocation is no longer finalizable.");
        }
        String objectKey = text(row.get("object_key"));
        byte[] bytes;
        try (InputStream stream = store().open(objectKey, () -> { })) {
            bytes = stream.readAllBytes();
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Session resource read failed", error);
        }
        long now = System.currentTimeMillis();
        if (bytes.length != ((Number) row.get("byte_length")).longValue()
                || !JournalStoreRows.sha256(bytes).equals(row.get("sha256"))) {
            jdbc.update("UPDATE ma_resource SET quarantine_reason = 'digest_mismatch',"
                            + " last_verified_at = ? WHERE session_scope_key = ? AND resource_id = ?",
                    now, ManagedSessionStore.sessionScopeKey(tenantId, sessionId), resourceId);
            throw JournalStoreRows.conflict("managed_session_resource_conflict",
                    "The uploaded object does not match its allocated digest or length.");
        }
        jdbc.update("UPDATE ma_resource SET state = 'PUBLISHED', last_verified_at = ?"
                        + " WHERE session_scope_key = ? AND resource_id = ? AND state = 'ALLOCATED'",
                now, ManagedSessionStore.sessionScopeKey(tenantId, sessionId), resourceId);
    }

    private static String text(Object value) {
        return value instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8)
                : (String) value;
    }

    private Map<String, Object> lockAllocation(String tenantId, String sessionId,
            String resourceId) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT state, object_key, byte_length, sha256 FROM ma_resource"
                        + " WHERE session_scope_key = ? AND resource_id = ? AND storage_kind ="
                        + " 'OSS_OBJECT' FOR UPDATE",
                scope, resourceId);
        if (rows.isEmpty()) {
            throw new ManagedAgentException(404, ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND,
                    "The Managed Session resource allocation does not exist.");
        }
        return rows.getFirst();
    }
}
