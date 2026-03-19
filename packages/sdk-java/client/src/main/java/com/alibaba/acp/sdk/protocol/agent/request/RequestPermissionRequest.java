package com.alibaba.acp.sdk.protocol.agent.request;

import java.util.List;

import com.alibaba.acp.sdk.protocol.domain.permission.PermissionOption;
import com.alibaba.acp.sdk.protocol.domain.tool.ToolCallUpdate;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.RequestPermissionRequest.RequestPermissionRequestParams;

@JSONType(typeName = "session/request_permission")
public class RequestPermissionRequest extends Request<RequestPermissionRequestParams> {
    public RequestPermissionRequest() {
        this(new RequestPermissionRequestParams());
    }

    public RequestPermissionRequest(RequestPermissionRequestParams requestParams) {
        super("session/request_permission", requestParams);
    }

    public static class RequestPermissionRequestParams extends Meta {
        private String sessionId;
        private ToolCallUpdate toolCall;
        private List<PermissionOption> options;

        // Getters and setters
        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }

        public ToolCallUpdate getToolCall() {
            return toolCall;
        }

        public void setToolCall(ToolCallUpdate toolCall) {
            this.toolCall = toolCall;
        }

        public List<PermissionOption> getOptions() {
            return options;
        }

        public void setOptions(List<PermissionOption> options) {
            this.options = options;
        }
    }
}
