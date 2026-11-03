package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.PublishToolResultRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class JournalResourceWrites {
    private final JournalFencing fencing;
    private final JournalStoreRows storeRows;
    private final JdbcTemplate jdbc;

    JournalResourceWrites(JournalFencing fencing,
            JournalStoreRows storeRows,
            JdbcTemplate jdbc) {
        this.fencing = fencing;
        this.storeRows = storeRows;
        this.jdbc = jdbc;
    }

    ToolResultResourceRef publishAgentInstructions(String tenantId,
            String workspaceId, String sessionId, String instructions) {
        JournalStoreRows.validateScope(tenantId, workspaceId, sessionId);
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
        byte[] bytes = instructions.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES) {
            throw JournalStoreRows.payloadTooLarge("Agent instructions exceed 64 KiB.");
        }
        return publishAgentResource(tenantId, workspaceId, sessionId,
                "managed-agent-instructions", "agent-instructions-", bytes);
    }

    ToolResultResourceRef publishAgentSkills(String tenantId,
            String workspaceId, String sessionId, List<java.util.Map<String, Object>> skills) {
        JournalStoreRows.validateScope(tenantId, workspaceId, sessionId);
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
        return publishAgentResource(tenantId, workspaceId, sessionId,
                "managed-agent-skills", "agent-skills-", AgentDefinitionExtensions.skillsBytes(skills));
    }

    ToolResultResourceRef publishInheritedExtensionResource(String tenantId, String workspaceId, String sessionId, StoredResource source) {
        JournalStoreRows.validateScope(tenantId, workspaceId, sessionId);
        if (ManagedNativeJournalSnapshots.isSnapshotId(source.resourceId())) {
            throw JournalStoreRows.invalid("Native snapshot resources require fenced snapshot publication.");
        }
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
        if (!Set.of("managed-extension-config-bundle", "managed-extension-contributions", "managed-extension-contributions-part").contains(source.kind())
                || source.schemaVersion() != 1 || source.byteLength() > ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES
                || source.bytes().length != source.byteLength() || !JournalStoreRows.sha256(source.bytes()).equals(source.digest())) {
            throw JournalStoreRows.invalid("Invalid inherited extension resource");
        }
        return publishAgentResource(tenantId, workspaceId, sessionId, source.kind(), source.bytes(), source.resourceId());
    }

    ToolResultResourceRef publishAgentResource(String tenantId,
            String workspaceId, String sessionId, String kind, String prefix, byte[] bytes) {
        return publishAgentResource(tenantId, workspaceId, sessionId, kind, bytes, prefix + JournalStoreRows.sha256(bytes));
    }

    ToolResultResourceRef publishAgentResource(String tenantId, String workspaceId, String sessionId,
            String kind, byte[] bytes, String resourceId) {
        String digest = JournalStoreRows.sha256(bytes);
        String scopeKey = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        Timestamp now = storeRows.databaseNow();
        JournalStoreRows.ResourceRow existing = storeRows.findResource(scopeKey, resourceId);
        if (existing == null) {
            jdbc.update(
                    "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                        + " state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, ?, ?,"
                        + " ?, 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'PUBLISHED', ?, ?)",
                    com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scopeKey, resourceId),
                    scopeKey,
                    tenantId,
                    workspaceId,
                    sessionId,
                    resourceId,
                    kind,
                    bytes.length,
                    digest,
                    bytes,
                    resourceId,
                    now.getTime(),
                    now.getTime());
        } else {
            JournalStoreRows.requireResourceScope(existing, tenantId, workspaceId, sessionId, resourceId);
            storeRows.verifyStoredResource(existing);
            if (!kind.equals(existing.kind())
                    || existing.schemaVersion() != 1
                    || existing.byteLength() != bytes.length
                    || !digest.equals(existing.digest())) {
                throw JournalStoreRows.conflict("managed_session_resource_conflict",
                        "Agent configuration resource does not match.");
            }
        }
        return new ToolResultResourceRef(resourceId, kind, 1, bytes.length, digest);
    }

    ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        fencing.checkLifecycleWriter(tenantId, sessionId, authority);
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        JournalStoreRows.validateCounter(request.writerGeneration(), "writerGeneration", 1);
        JournalStoreRows.validateStableId(request.resourceId(), "resourceId");
        if (ManagedNativeJournalSnapshots.isSnapshotId(request.resourceId())) {
            throw JournalStoreRows.invalid("Native snapshot resources require fenced snapshot publication.");
        }
        JournalStoreRows.validateDigest(request.digest(), "resource digest", false);
        int limit = JournalStoreRows.toolResultLimit(request.kind());
        if (limit == 0 || request.schemaVersion() != 1 || request.byteLength() < 1) {
            throw JournalStoreRows.invalid("Tool result resource kind, version or length is invalid.");
        }
        if (request.byteLength() > limit || request.bytesBase64() != null
                && request.bytesBase64().length() > 4 * ((limit + 2) / 3)) {
            throw JournalStoreRows.payloadTooLarge("Tool result resource exceeds its byte limit.");
        }
        byte[] bytes = JournalStoreRows.decodeBase64(request.bytesBase64(), limit, "resource bytesBase64");
        if (bytes.length != request.byteLength() || !JournalStoreRows.sha256(bytes).equals(request.digest())) {
            throw JournalStoreRows.invalid("Tool result bytes do not match their length or digest.");
        }
        fencing.requirePhysicalSessionOpen(tenantId, request.workspaceId(), sessionId);
        // Tool-result publication lane: keeps the tenant CAS row before the
        // Session root the CSI check locks and before the head row, the
        // order retention reads take (CAS row, root, head) and the same as
        // before #13800 decoupled ordinary traffic.
        JournalFencing.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId,
                JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        // After both bounded waits, so the CSI check's read does not pin this
        // transaction's snapshot ahead of them.
        fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), false);
        var continuation = fencing.lockCsiContinuation(tenantId, sessionId);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        JournalStoreRows.HeadRow head = fencing.requireHeadAfterCsiCheck(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        // Unlike the other writer paths, a v2 claim fences this lane even
        // for the claiming lifecycle authority: tool results are never
        // published against a Session claimed under lifecycle protocol v2.
        fencing.requireNoLifecycleClaim(tenantId, sessionId);
        JournalFencing.requireCsiWriter(csiOriginal, head);
        Timestamp now = storeRows.databaseNow();
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, now, true);
        fencing.requireInstalledCsiWriter(csiOriginal);
        String scopeKey = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        JournalStoreRows.ResourceRow existing = storeRows.findResource(scopeKey, request.resourceId());
        fencing.requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        if (existing == null) {
            jdbc.update(
                    "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                        + " state, gmt_create, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,"
                        + " ?, 'MYSQL_INLINE', ?, ?, 'PUBLISHED', ?, ?)",
                    com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scopeKey, request.resourceId()),
                    scopeKey,
                    tenantId,
                    request.workspaceId(),
                    sessionId,
                    request.resourceId(),
                    request.kind(),
                    request.schemaVersion(),
                    request.byteLength(),
                    request.digest(),
                    bytes,
                    request.resourceId(),
                    now.getTime(),
                    now.getTime());
        } else {
            JournalStoreRows.requireResourceScope(existing, tenantId, request.workspaceId(), sessionId, request.resourceId());
            storeRows.verifyStoredResource(existing);
            if (!request.kind().equals(existing.kind()) || request.schemaVersion() != existing.schemaVersion()
                    || request.byteLength() != existing.byteLength() || !request.digest().equals(existing.digest())) {
                throw JournalStoreRows.conflict(
                        "managed_session_resource_conflict",
                        "A resourceId was reused with different content metadata.");
            }
        }
        fencing.requireCsiCurrentTime(continuation);
        return new ToolResultResourceRef(request.resourceId(), request.kind(), request.schemaVersion(),
                request.byteLength(), request.digest());
    }

    void commitResources(String scopeKey, String tenantId,
            String sessionId, CommitTransactionRequest request,
            long revision, Timestamp now,
            List<ValidatedResource> resources,
            Runnable writeFence) {
        Set<String> resourceIds = new HashSet<>();
        for (ValidatedResource input : resources) {
            CommitResource resource = input.resource();
            if (!resourceIds.add(resource.resourceId())) {
                throw JournalStoreRows.invalid("resources contains a duplicate resourceId.");
            }
            JournalStoreRows.ResourceRow existing = storeRows.findResource(scopeKey,
                    resource.resourceId());
            writeFence.run();
            if (existing == null) {
                if (input.bytes() == null) {
                    throw JournalStoreRows.conflict(
                            ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                            "A referenced Managed Session resource is"
                                    + " missing.");
                }
                jdbc.update("INSERT INTO ma_resource"
                                + " (resource_key, session_scope_key, tenant_id,"
                                + " workspace_id, session_id, resource_id,"
                                + " kind, schema_version, byte_length, sha256,"
                                + " storage_kind, inline_bytes,"
                                + " publish_command_id, state, gmt_create,"
                                + " last_verified_at) VALUES (?, ?, ?, ?, ?, ?,"
                                + " ?, ?, ?, ?, 'MYSQL_INLINE', ?, ?,"
                                + " 'REFERENCED', ?, ?)",
                        com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scopeKey, resource.resourceId()), scopeKey, tenantId, request.workspaceId(), sessionId,
                        resource.resourceId(), resource.kind(),
                        resource.schemaVersion(), resource.byteLength(),
                        resource.digest(), input.bytes(), request.commandId(),
                        now.getTime(), now.getTime());
            } else {
                JournalStoreRows.requireResourceScope(existing, tenantId,
                        request.workspaceId(), sessionId,
                        resource.resourceId());
                storeRows.verifyStoredResource(existing);
                if (!resource.kind().equals(existing.kind())
                        || resource.schemaVersion()
                                != existing.schemaVersion()
                        || resource.byteLength() != existing.byteLength()
                        || !resource.digest().equals(existing.digest())) {
                    throw JournalStoreRows.conflict("managed_session_resource_conflict",
                            "A resourceId was reused with different"
                                    + " content metadata.");
                }
            }
            jdbc.update(
                    "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                        + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                        + " journal_revision, resource_id, gmt_create) VALUES (?, 'JOURNAL', ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?)",
                    scopeKey,
                    scopeKey,
                    revision,
                    com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scopeKey, resource.resourceId()),
                    tenantId,
                    request.workspaceId(),
                    sessionId,
                    revision,
                    resource.resourceId(),
                    now.getTime());
        }
    }

    record ValidatedResource(CommitResource resource, byte[] bytes) {
    }
}
