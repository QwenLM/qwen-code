package com.alibaba.acp.sdk.protocol.domain.session.update;

import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeName = "current_mode_update")
public class CurrentModeUpdateSessionUpdate extends SessionUpdate {
    private String currentModeId;

    public CurrentModeUpdateSessionUpdate() {
        this.setSessionUpdate("current_mode_update");
    }

    public String getCurrentModeId() {
        return currentModeId;
    }

    public void setCurrentModeId(String currentModeId) {
        this.currentModeId = currentModeId;
    }
}
