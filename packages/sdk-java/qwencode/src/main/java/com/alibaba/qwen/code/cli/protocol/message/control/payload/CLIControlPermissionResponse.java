package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Behavior;

/**
 * Represents a control permission response from the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "can_use_tool")
public class CLIControlPermissionResponse extends ControlResponsePayload {
    public CLIControlPermissionResponse() {
        super();
        this.subtype = "can_use_tool";
    }

    /**
     * The behavior for the permission request.
     */
    @JSONField(unwrapped = true)
    Behavior behavior;

    /**
     * Gets the behavior for the permission request.
     *
     * @return The behavior for the permission request
     */
    public Behavior getBehavior() {
        return behavior;
    }

    /**
     * Sets the behavior for the permission request.
     *
     * @param behavior The behavior for the permission request
     * @return This instance for method chaining
     */
    public CLIControlPermissionResponse setBehavior(Behavior behavior) {
        this.behavior = behavior;
        return this;
    }
}
