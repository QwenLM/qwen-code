package com.alibaba.acp.sdk.protocol.client.response;

import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.client.response.WriteTextFileResponse.WriteTextFileResponseResult;

public class WriteTextFileResponse extends Response<WriteTextFileResponseResult> {
    public static class WriteTextFileResponseResult {
        // Empty result class as per schema
    }
}
