package com.alibaba.acp.sdk.protocol.client.response;

import com.alibaba.acp.sdk.protocol.jsonrpc.Error;
import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.client.response.ReadTextFileResponse.ReadTextFileResponseResult;

public class ReadTextFileResponse extends Response<ReadTextFileResponseResult> {
    public ReadTextFileResponse() {
    }

    public ReadTextFileResponse(Object id, ReadTextFileResponseResult result) {
        super(id, result);
    }

    public ReadTextFileResponse(Object id, Error error) {
        super(id, error);
    }

    public static class ReadTextFileResponseResult {
        private String content;

        // Getters and setters
        public String getContent() {
            return content;
        }

        public ReadTextFileResponseResult setContent(String content) {
            this.content = content;
            return this;
        }
    }
}
