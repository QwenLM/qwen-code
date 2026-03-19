package com.alibaba.acp.sdk.protocol.client.request;

import java.util.List;

import com.alibaba.acp.sdk.protocol.client.request.PromptRequest.PromptRequestParams;
import com.alibaba.acp.sdk.protocol.domain.content.block.ContentBlock;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeName = "session/prompt")
public class PromptRequest extends Request<PromptRequestParams> {
    public PromptRequest() {
        this(new PromptRequestParams());
    }

    public PromptRequest(PromptRequestParams requestParams) {
        super("session/prompt", requestParams);
    }

    public static class PromptRequestParams extends Meta {
        private String sessionId;
        private List<ContentBlock> prompt;

        public PromptRequestParams(String sessionId, List<ContentBlock> prompt) {
            this.sessionId = sessionId;
            this.prompt = prompt;
        }

        public PromptRequestParams() {
        }

        // Getters and setters
        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }

        public List<ContentBlock> getPrompt() {
            return prompt;
        }

        public void setPrompt(List<ContentBlock> prompt) {
            this.prompt = prompt;
        }
    }
}
