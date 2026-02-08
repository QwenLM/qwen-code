package com.alibaba.qwen.code.cli.protocol.data;

import com.alibaba.fastjson2.annotation.JSONField;

/**
 * Represents the capabilities of the Qwen Code CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class Capabilities {
    /**
     * Whether the CLI can handle can_use_tool requests.
     */
    @JSONField(name = "can_handle_can_use_tool")
    boolean canHandleCanUseTool;

    /**
     * Whether the CLI can handle hook callbacks.
     */
    @JSONField(name = "can_handle_hook_callback")
    boolean canHandleHookCallback;

    /**
     * Whether the CLI can set permission mode.
     */
    @JSONField(name = "can_set_permission_mode")
    boolean canSetPermissionMode;

    /**
     * Whether the CLI can set the model.
     */
    @JSONField(name = "can_set_model")
    boolean canSetModel;

    /**
     * Whether the CLI can handle MCP messages.
     */
    @JSONField(name = "can_handle_mcp_message")
    boolean canHandleMcpMessage;

    /**
     * Checks if the CLI can handle can_use_tool requests.
     *
     * @return true if the CLI can handle can_use_tool requests, false otherwise
     */
    public boolean isCanHandleCanUseTool() {
        return canHandleCanUseTool;
    }

    /**
     * Sets whether the CLI can handle can_use_tool requests.
     *
     * @param canHandleCanUseTool Whether the CLI can handle can_use_tool requests
     */
    public void setCanHandleCanUseTool(boolean canHandleCanUseTool) {
        this.canHandleCanUseTool = canHandleCanUseTool;
    }

    /**
     * Checks if the CLI can handle hook callbacks.
     *
     * @return true if the CLI can handle hook callbacks, false otherwise
     */
    public boolean isCanHandleHookCallback() {
        return canHandleHookCallback;
    }

    /**
     * Sets whether the CLI can handle hook callbacks.
     *
     * @param canHandleHookCallback Whether the CLI can handle hook callbacks
     */
    public void setCanHandleHookCallback(boolean canHandleHookCallback) {
        this.canHandleHookCallback = canHandleHookCallback;
    }

    /**
     * Checks if the CLI can set permission mode.
     *
     * @return true if the CLI can set permission mode, false otherwise
     */
    public boolean isCanSetPermissionMode() {
        return canSetPermissionMode;
    }

    /**
     * Sets whether the CLI can set permission mode.
     *
     * @param canSetPermissionMode Whether the CLI can set permission mode
     */
    public void setCanSetPermissionMode(boolean canSetPermissionMode) {
        this.canSetPermissionMode = canSetPermissionMode;
    }

    /**
     * Checks if the CLI can set the model.
     *
     * @return true if the CLI can set the model, false otherwise
     */
    public boolean isCanSetModel() {
        return canSetModel;
    }

    /**
     * Sets whether the CLI can set the model.
     *
     * @param canSetModel Whether the CLI can set the model
     */
    public void setCanSetModel(boolean canSetModel) {
        this.canSetModel = canSetModel;
    }

    /**
     * Checks if the CLI can handle MCP messages.
     *
     * @return true if the CLI can handle MCP messages, false otherwise
     */
    public boolean isCanHandleMcpMessage() {
        return canHandleMcpMessage;
    }

    /**
     * Sets whether the CLI can handle MCP messages.
     *
     * @param canHandleMcpMessage Whether the CLI can handle MCP messages
     */
    public void setCanHandleMcpMessage(boolean canHandleMcpMessage) {
        this.canHandleMcpMessage = canHandleMcpMessage;
    }
}
