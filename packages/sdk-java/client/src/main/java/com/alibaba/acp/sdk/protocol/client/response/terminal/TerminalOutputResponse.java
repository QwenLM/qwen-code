package com.alibaba.acp.sdk.protocol.client.response.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.client.response.terminal.TerminalOutputResponse.TerminalOutputResponseResult;

public class TerminalOutputResponse extends Response<TerminalOutputResponseResult> {
    public static class TerminalOutputResponseResult {
        private String output;
        private Boolean truncated;
        private TerminalExitStatus exitStatus;

        // Getters and setters
        public String getOutput() {
            return output;
        }

        public void setOutput(String output) {
            this.output = output;
        }

        public Boolean getTruncated() {
            return truncated;
        }

        public void setTruncated(Boolean truncated) {
            this.truncated = truncated;
        }

        public TerminalExitStatus getExitStatus() {
            return exitStatus;
        }

        public void setExitStatus(TerminalExitStatus exitStatus) {
            this.exitStatus = exitStatus;
        }

        public static class TerminalExitStatus {
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
}
