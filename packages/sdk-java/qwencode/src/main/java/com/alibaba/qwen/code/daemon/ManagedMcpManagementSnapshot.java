package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;

/** Available and selected MCP server definitions and the current configuration revision. */
public final class ManagedMcpManagementSnapshot extends ManagedJson {
    ManagedMcpManagementSnapshot(Map<String, Object> json) {
        super(json);
    }

    public String getSessionId() {
        return string("sessionId");
    }

    /** Current configuration revision to pass as the next command's expected revision. */
    public long getRevision() {
        return number("revision");
    }

    public boolean isSupported() {
        return flag("supported");
    }

    public List<PublishedServer> getAvailableServers() {
        return objects("availableServers", PublishedServer::new);
    }

    public List<SelectedServer> getServers() {
        return objects("servers", SelectedServer::new);
    }

    /** Operation returned by command submission or operation lookup, when present. */
    public Operation getOperation() {
        return optionalObject("operation", Operation::new);
    }

    /** Identity fields shared by available and selected server entries. */
    public abstract static class Server extends ManagedJson {
        private Server(Map<String, Object> json) {
            super(json);
        }

        public String getServerId() {
            return string("serverId");
        }

        public long getServerRevision() {
            return number("serverRevision");
        }

        public String getDefinitionDigest() {
            return string("definitionDigest");
        }

        public ManagedMcpServerPin getPin() {
            return new ManagedMcpServerPin(getServerId(), getServerRevision(), getDefinitionDigest());
        }
    }

    /** An available published definition. */
    public static final class PublishedServer extends Server {
        private PublishedServer(Map<String, Object> json) {
            super(json);
        }

        /** Transport name, such as stdio, streamable-http or sse. */
        public String getTransport() {
            return string("transport");
        }
    }

    /** A selected definition, including retained entries in the removed state. */
    public static final class SelectedServer extends Server {
        private SelectedServer(Map<String, Object> json) {
            super(json);
        }

        /** Current selection state, such as enabled, disabled or removed. */
        public String getState() {
            return string("state");
        }
    }

    /** An MCP configuration change and its settlement state. */
    public static final class Operation extends ManagedJson {
        private Operation(Map<String, Object> json) {
            super(json);
        }

        public String getOperationId() {
            return string("operationId");
        }

        public String getAction() {
            return string("action");
        }

        public String getServerId() {
            return string("serverId");
        }

        public long getRevision() {
            return number("revision");
        }

        /** Current operation state, such as pending, settled, failed or recovery_required. */
        public String getState() {
            return string("state");
        }

        /** Failure code when the operation reports an error, otherwise null. */
        public String getErrorCode() {
            Map<String, Object> error = optionalObject("error");
            return error == null ? null : JsonSupport.requiredString(error, "code", "MCP operation error");
        }
    }
}
