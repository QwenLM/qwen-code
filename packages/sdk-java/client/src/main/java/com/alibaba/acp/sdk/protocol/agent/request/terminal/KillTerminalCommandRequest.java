package com.alibaba.acp.sdk.protocol.agent.request.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.terminal.KillTerminalCommandRequest.KillTerminalCommandRequestParams;

@JSONType(typeName = "terminal/kill")
public class KillTerminalCommandRequest extends Request<KillTerminalCommandRequestParams> {
    public KillTerminalCommandRequest() {
        this(new KillTerminalCommandRequestParams());
    }

    public KillTerminalCommandRequest(KillTerminalCommandRequestParams requestParams) {
        super("terminal/kill", requestParams);
    }

    public static class KillTerminalCommandRequestParams extends Meta {
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
