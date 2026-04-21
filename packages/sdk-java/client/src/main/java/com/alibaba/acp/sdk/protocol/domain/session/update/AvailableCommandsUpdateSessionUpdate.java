package com.alibaba.acp.sdk.protocol.domain.session.update;

import java.util.List;

import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeName = "available_commands_update")
public class AvailableCommandsUpdateSessionUpdate extends SessionUpdate {
    private List<AvailableCommand> availableCommands;

    public AvailableCommandsUpdateSessionUpdate() {
        this.setSessionUpdate("available_commands_update");
    }

    public List<AvailableCommand> getAvailableCommands() {
        return availableCommands;
    }

    public void setAvailableCommands(List<AvailableCommand> availableCommands) {
        this.availableCommands = availableCommands;
    }
}
