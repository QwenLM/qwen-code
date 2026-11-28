package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Immutable identity of a published MCP server definition. */
public final class ManagedMcpServerPin {
    static final long MAX_REVISION = 9_007_199_254_740_991L;

    private final String serverId;
    private final long serverRevision;
    private final String definitionDigest;

    public ManagedMcpServerPin(String serverId, long serverRevision, String definitionDigest) {
        this.serverId = requireServerId(serverId);
        if (serverRevision < 1 || serverRevision > MAX_REVISION) {
            throw new IllegalArgumentException("serverRevision must be between 1 and " + MAX_REVISION);
        }
        if (definitionDigest == null || !definitionDigest.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("definitionDigest must have 64 lowercase hexadecimal digits");
        }
        this.serverRevision = serverRevision;
        this.definitionDigest = definitionDigest;
    }

    public String getServerId() {
        return serverId;
    }

    public long getServerRevision() {
        return serverRevision;
    }

    public String getDefinitionDigest() {
        return definitionDigest;
    }

    Map<String, Object> toAgentDefinitionJson() {
        return Map.of("server_id", serverId, "server_revision", serverRevision,
                "definition_digest", definitionDigest);
    }

    Map<String, Object> toManagementJson() {
        return Map.of("serverId", serverId, "serverRevision", serverRevision,
                "definitionDigest", definitionDigest);
    }

    static String requireServerId(String serverId) {
        if (serverId == null || !serverId.matches("[A-Za-z0-9._:-]{1,128}")) {
            throw new IllegalArgumentException("serverId must match [A-Za-z0-9._:-]{1,128}");
        }
        return serverId;
    }
}
