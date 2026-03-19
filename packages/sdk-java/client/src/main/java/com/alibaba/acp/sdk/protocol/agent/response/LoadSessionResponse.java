package com.alibaba.acp.sdk.protocol.agent.response;

import com.alibaba.acp.sdk.protocol.domain.session.SessionModeState;
import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.agent.response.LoadSessionResponse.LoadSessionResponseResult;

public class LoadSessionResponse extends Response<LoadSessionResponseResult> {
    public static class LoadSessionResponseResult {
        private SessionModeState modes;

        // Getters and setters
        public SessionModeState getModes() {
            return modes;
        }

        public void setModes(SessionModeState modes) {
            this.modes = modes;
        }
    }
}
