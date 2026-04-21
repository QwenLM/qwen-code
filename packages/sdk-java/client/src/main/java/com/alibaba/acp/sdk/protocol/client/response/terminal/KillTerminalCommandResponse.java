package com.alibaba.acp.sdk.protocol.client.response.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.client.response.terminal.KillTerminalCommandResponse.KillTerminalCommandResponseResult;

public class KillTerminalCommandResponse extends Response<KillTerminalCommandResponseResult> {
    public static class KillTerminalCommandResponseResult {
        // Empty result class as per schema
    }
}
