package com.alibaba.acp.sdk.protocol.agent.response;

import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.agent.response.AuthenticateResponse.AuthenticateResponseResult;

public class AuthenticateResponse extends Response<AuthenticateResponseResult> {
    public static class AuthenticateResponseResult {
        // Empty result class as per schema
    }
}
