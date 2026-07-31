package com.alibaba.acp.sdk.protocol.client.response.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.client.response.terminal.ReleaseTerminalResponse.ReleaseTerminalResponseResult;

public class ReleaseTerminalResponse extends Response<ReleaseTerminalResponseResult> {
    public static class ReleaseTerminalResponseResult {
        // Empty result class as per schema
    }
}
