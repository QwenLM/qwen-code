package com.alibaba.acp.sdk.protocol.agent.request.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.terminal.WaitForTerminalExitRequest.WaitForTerminalExitRequestParams;

@JSONType(typeName = "terminal/wait_for_exit")
public class WaitForTerminalExitRequest extends Request<WaitForTerminalExitRequestParams> {
    public WaitForTerminalExitRequest() {
        this(new WaitForTerminalExitRequestParams());
    }

    public WaitForTerminalExitRequest(WaitForTerminalExitRequestParams requestParams) {
        super("terminal/wait_for_exit", requestParams);
    }

    public static class WaitForTerminalExitRequestParams extends Meta {
        private String sessionId;
        private String terminalId;

        // Getters and setters
        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }

        public String getTerminalId() {
            return terminalId;
        }

        public void setTerminalId(String terminalId) {
            this.terminalId = terminalId;
        }
    }
}
