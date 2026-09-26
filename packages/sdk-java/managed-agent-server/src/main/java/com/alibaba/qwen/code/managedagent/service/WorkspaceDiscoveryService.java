package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry.WorkspaceSummary;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class WorkspaceDiscoveryService {
    private final ManagedWorkspaceRegistry registry;
    private final ObjectMapper mapper;

    public WorkspaceDiscoveryService(ManagedWorkspaceRegistry registry,
            ObjectMapper mapper) {
        this.registry = registry;
        this.mapper = mapper;
    }

    public WorkspacePage list(String tenantId, String actorId,
            String cursor, Integer requestedLimit) {
        int limit = requestedLimit == null ? 50 : requestedLimit;
        if (limit < 1 || limit > 100) {
            throw invalidCursor();
        }
        String after = null;
        if (cursor != null) {
            try {
                if (cursor.length() > 2048) {
                    throw new IllegalArgumentException();
                }
                Cursor decoded = mapper.readValue(Base64.getUrlDecoder()
                        .decode(cursor), Cursor.class);
                if (!scope(tenantId, actorId).equals(decoded.scope())
                        || limit != decoded.limit()
                        || decoded.afterId() == null
                        || decoded.afterId().isEmpty()) {
                    throw new IllegalArgumentException();
                }
                after = decoded.afterId();
            } catch (Exception error) {
                throw invalidCursor();
            }
        }
        List<WorkspaceSummary> fetched = registry.listReadable(tenantId,
                actorId, after, limit + 1);
        boolean hasMore = fetched.size() > limit;
        List<WorkspaceSummary> data = hasMore ? fetched.subList(0, limit)
                : fetched;
        String next = null;
        if (hasMore) {
            try {
                Cursor nextValue = new Cursor(scope(tenantId, actorId), limit,
                        data.getLast().workspaceId());
                next = Base64.getUrlEncoder().withoutPadding()
                        .encodeToString(mapper.writeValueAsString(nextValue)
                                .getBytes(StandardCharsets.UTF_8));
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }
        return new WorkspacePage(data,
                registry.readableDefault(tenantId, actorId), hasMore, next);
    }

    public WorkspaceSummary get(String tenantId, String actorId,
            String workspaceId) {
        WorkspaceSummary found = registry.findReadable(tenantId, actorId,
                workspaceId);
        if (found == null) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "workspace_not_found", "Workspace not found.");
        }
        return found;
    }

    private static ApiException invalidCursor() {
        return new ApiException(HttpStatus.BAD_REQUEST,
                "invalid_workspace_cursor", "Workspace cursor or limit is invalid.");
    }

    private static String scope(String tenantId, String actorId) {
        try {
            byte[] tenant = tenantId.getBytes(StandardCharsets.UTF_8);
            byte[] actor = actorId.getBytes(StandardCharsets.UTF_8);
            byte[] value = ByteBuffer.allocate(Integer.BYTES + tenant.length
                    + actor.length).putInt(tenant.length).put(tenant)
                    .put(actor).array();
            return HexFormat.of().formatHex(MessageDigest
                    .getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    public record WorkspacePage(List<WorkspaceSummary> data,
            WorkspaceSummary defaultWorkspace, boolean hasMore,
            String nextCursor) {
    }

    private record Cursor(String scope, int limit,
            String afterId) {
    }
}
