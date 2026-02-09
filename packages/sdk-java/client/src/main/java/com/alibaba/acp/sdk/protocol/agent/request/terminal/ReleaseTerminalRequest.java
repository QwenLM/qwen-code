package com.alibaba.acp.sdk.protocol.agent.request.terminal;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.terminal.ReleaseTerminalRequest.ReleaseTerminalRequestParams;

@JSONType(typeName = "terminal/release")
public class ReleaseTerminalRequest extends Request<ReleaseTerminalRequestParams> {
    public ReleaseTerminalRequest() {
        this(new ReleaseTerminalRequestParams());
    }

    public ReleaseTerminalRequest(ReleaseTerminalRequestParams requestParams) {
        super("terminal/release", requestParams);
    }

    public static class ReleaseTerminalRequestParams extends Meta {
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
