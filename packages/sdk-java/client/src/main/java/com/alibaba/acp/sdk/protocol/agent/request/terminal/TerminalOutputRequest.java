package com.alibaba.acp.sdk.protocol.agent.request.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.terminal.TerminalOutputRequest.TerminalOutputRequestParams;

@JSONType(typeName = "terminal/output")
public class TerminalOutputRequest extends Request<TerminalOutputRequestParams> {
    public TerminalOutputRequest() {
        this(new TerminalOutputRequestParams());
    }

    public TerminalOutputRequest(TerminalOutputRequestParams requestParams) {
        super("terminal/output", requestParams);
    }

    public static class TerminalOutputRequestParams extends Meta {
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
