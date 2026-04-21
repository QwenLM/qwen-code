package com.alibaba.acp.sdk.protocol.agent.request;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.WriteTextFileRequest.WriteTextFileRequestParams;

@JSONType(typeName = "fs/write_text_file")
public class WriteTextFileRequest extends Request<WriteTextFileRequestParams> {
    public WriteTextFileRequest() {
        this(new WriteTextFileRequestParams());
    }

    public WriteTextFileRequest(WriteTextFileRequestParams requestParams) {
        super("fs/write_text_file", requestParams);
    }

    public static class WriteTextFileRequestParams extends Meta {
        private String sessionId;
        private String path;
        private String content;

        // Getters and setters
        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }

        public String getPath() {
            return path;
        }

        public void setPath(String path) {
            this.path = path;
        }

        public String getContent() {
            return content;
        }

        public void setContent(String content) {
            this.content = content;
        }
    }
}
