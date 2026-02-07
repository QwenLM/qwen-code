package com.alibaba.acp.sdk.protocol.client.request;

import java.util.ArrayList;
import java.util.List;

import com.alibaba.acp.sdk.protocol.domain.mcp.McpServer;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.client.request.NewSessionRequest.NewSessionRequestParams;

@JSONType(typeName = "session/new")
public class NewSessionRequest extends Request<NewSessionRequestParams> {
    public NewSessionRequest() {
        this(new NewSessionRequestParams());
    }

    public NewSessionRequest(NewSessionRequestParams requestParams) {
        super("session/new", requestParams);
    }

    public static class NewSessionRequestParams extends Meta {
        private String cwd = System.getProperty("user.dir");
        private List<McpServer> mcpServers = new ArrayList<>();

        // Getters and setters
        public String getCwd() {
            return cwd;
        }

        public void setCwd(String cwd) {
            this.cwd = cwd;
        }

        public List<McpServer> getMcpServers() {
            return mcpServers;
        }

        public void setMcpServers(List<McpServer> mcpServers) {
            this.mcpServers = mcpServers;
        }

        // Inner class for McpServer
    }
}
