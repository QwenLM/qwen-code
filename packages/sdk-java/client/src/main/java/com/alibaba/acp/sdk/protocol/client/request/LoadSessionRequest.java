package com.alibaba.acp.sdk.protocol.client.request;

import java.util.List;

import com.alibaba.acp.sdk.protocol.domain.mcp.McpServer;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.client.request.LoadSessionRequest.LoadSessionRequestParams;

@JSONType(typeName = "session/load")
public class LoadSessionRequest extends Request<LoadSessionRequestParams> {
    public LoadSessionRequest() {
        this(new LoadSessionRequestParams());
    }

    public LoadSessionRequest(LoadSessionRequestParams requestParams) {
        super("session/load", requestParams);
    }

    public static class LoadSessionRequestParams extends Meta {
        private String sessionId;
        private String cwd;
        private List<McpServer> mcpServers;

        public String getSessionId() {
            return sessionId;
        }

        public LoadSessionRequestParams setSessionId(String sessionId) {
            this.sessionId = sessionId;
            return this;
        }

        public String getCwd() {
            return cwd;
        }

        public LoadSessionRequestParams setCwd(String cwd) {
            this.cwd = cwd;
            return this;
        }

        public List<McpServer> getMcpServers() {
            return mcpServers;
        }

        public LoadSessionRequestParams setMcpServers(List<McpServer> mcpServers) {
            this.mcpServers = mcpServers;
            return this;
        }
    }
}
