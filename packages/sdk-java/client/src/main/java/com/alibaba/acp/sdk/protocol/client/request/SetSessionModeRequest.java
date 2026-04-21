package com.alibaba.acp.sdk.protocol.client.request;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.client.request.SetSessionModeRequest.SetSessionModeRequestParams;

@JSONType(typeName = "session/set_mode")
public class SetSessionModeRequest extends Request<SetSessionModeRequestParams> {
    public SetSessionModeRequest() {
        this(new SetSessionModeRequestParams());
    }

    public SetSessionModeRequest(SetSessionModeRequestParams requestParams) {
        super("session/set_mode", requestParams);
    }

    public static class SetSessionModeRequestParams extends Meta {
        private String sessionId;
        private String modeId;

        // Getters and setters
        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }

        public String getModeId() {
            return modeId;
        }

        public void setModeId(String modeId) {
            this.modeId = modeId;
        }
    }
}
