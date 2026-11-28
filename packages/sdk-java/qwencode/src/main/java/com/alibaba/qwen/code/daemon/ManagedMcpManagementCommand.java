package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/** A change to the MCP configuration of an existing Managed session. */
public final class ManagedMcpManagementCommand {
    public enum Action {
        ADD,
        EDIT,
        REMOVE,
        ENABLE,
        DISABLE,
        RELOAD,
        RESTART
    }

    private final Action action;
    private final String serverId;
    private final long expectedRevision;
    private final ManagedMcpServerPin server;

    /** Creates a command for REMOVE, ENABLE, DISABLE, RELOAD or RESTART. */
    public ManagedMcpManagementCommand(Action action, String serverId, long expectedRevision) {
        this(action, serverId, expectedRevision, null);
    }

    /**
     * Creates a command against the revision returned by the current management snapshot.
     * ADD and EDIT require an exact published server pin for the same server ID.
     */
    public ManagedMcpManagementCommand(Action action, String serverId, long expectedRevision, ManagedMcpServerPin server) {
        this.action = Objects.requireNonNull(action, "action");
        this.serverId = ManagedMcpServerPin.requireServerId(serverId);
        if (expectedRevision < 0 || expectedRevision >= ManagedMcpServerPin.MAX_REVISION) {
            throw new IllegalArgumentException("expectedRevision must be between 0 and "
                    + (ManagedMcpServerPin.MAX_REVISION - 1));
        }
        boolean requiresPin = action == Action.ADD || action == Action.EDIT;
        if (requiresPin && (server == null || !serverId.equals(server.getServerId()))) {
            throw new IllegalArgumentException("ADD and EDIT require a published pin for serverId");
        }
        if (!requiresPin && server != null) {
            throw new IllegalArgumentException("Only ADD and EDIT accept a server pin");
        }
        this.expectedRevision = expectedRevision;
        this.server = server;
    }

    public Action getAction() {
        return action;
    }

    public String getServerId() {
        return serverId;
    }

    public long getExpectedRevision() {
        return expectedRevision;
    }

    public ManagedMcpServerPin getServer() {
        return server;
    }

    Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("action", action.name().toLowerCase(Locale.ROOT));
        json.put("serverId", serverId);
        json.put("expectedRevision", expectedRevision);
        if (server != null) {
            json.put("server", server.toManagementJson());
        }
        return json;
    }
}
