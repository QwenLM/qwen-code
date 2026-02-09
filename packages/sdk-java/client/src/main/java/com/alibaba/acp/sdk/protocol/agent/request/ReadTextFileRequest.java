package com.alibaba.acp.sdk.protocol.agent.request;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.ReadTextFileRequest.ReadTextFileRequestParams;

@JSONType(typeName = "fs/read_text_file")
public class ReadTextFileRequest extends Request<ReadTextFileRequestParams> {
    public ReadTextFileRequest() {
        this(new ReadTextFileRequestParams());
    }

    public ReadTextFileRequest(ReadTextFileRequestParams requestParams) {
        super("fs/read_text_file", requestParams);
    }

    public static class ReadTextFileRequestParams extends Meta {
        private String sessionId;
        private String path;
        private Integer line;
        private Integer limit;

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

        public Integer getLine() {
            return line;
        }

        public void setLine(Integer line) {
            this.line = line;
        }

        public Integer getLimit() {
            return limit;
        }

        public void setLimit(Integer limit) {
            this.limit = limit;
        }
    }
}
