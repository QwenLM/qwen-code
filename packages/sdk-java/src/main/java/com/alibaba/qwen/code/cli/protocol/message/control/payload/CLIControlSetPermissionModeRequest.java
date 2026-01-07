package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a control request to set the permission mode in the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "set_permission_mode")
public class CLIControlSetPermissionModeRequest extends ControlRequestPayload {
    public CLIControlSetPermissionModeRequest() {
        super();
        setSubtype("set_permission_mode");
    }

    /**
     * The permission mode to set.
     */
    String mode;

    /**
     * Gets the permission mode to set.
     *
     * @return The permission mode to set
     */
    public String getMode() {
        return mode;
    }

    /**
     * Sets the permission mode to set.
     *
     * @param mode The permission mode to set
     */
    public void setMode(String mode) {
        this.mode = mode;
    }
}
