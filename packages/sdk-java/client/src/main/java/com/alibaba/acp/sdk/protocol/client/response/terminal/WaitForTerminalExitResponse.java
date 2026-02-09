package com.alibaba.acp.sdk.protocol.client.response.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.client.response.terminal.WaitForTerminalExitResponse.WaitForTerminalExitResponseResult;

public class WaitForTerminalExitResponse extends Response<WaitForTerminalExitResponseResult> {
    public static class WaitForTerminalExitResponseResult {
        private Long exitCode;
        private String signal;

        // Getters and setters
        public Long getExitCode() {
            return exitCode;
        }

        public void setExitCode(Long exitCode) {
            this.exitCode = exitCode;
        }

        public String getSignal() {
            return signal;
        }

        public void setSignal(String signal) {
            this.signal = signal;
        }
    }
}
