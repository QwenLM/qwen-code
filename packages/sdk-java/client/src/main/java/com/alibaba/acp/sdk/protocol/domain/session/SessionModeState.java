package com.alibaba.acp.sdk.protocol.domain.session;

import java.util.List;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class SessionModeState extends Meta {
    private String currentModeId;
    private List<SessionMode> availableModes;

    // Getters and setters
    public String getCurrentModeId() {
        return currentModeId;
    }

    public void setCurrentModeId(String currentModeId) {
        this.currentModeId = currentModeId;
    }

    public List<SessionMode> getAvailableModes() {
        return availableModes;
    }

    public void setAvailableModes(List<SessionMode> availableModes) {
        this.availableModes = availableModes;
    }
}
