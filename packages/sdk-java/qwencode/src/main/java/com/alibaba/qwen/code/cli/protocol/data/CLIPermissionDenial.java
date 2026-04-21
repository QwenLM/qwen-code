package com.alibaba.qwen.code.cli.protocol.data;

import com.alibaba.fastjson2.annotation.JSONField;

/**
 * Represents a permission denial from the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class CLIPermissionDenial {
    /**
     * The name of the denied tool.
     */
    @JSONField(name = "tool_name")
    private String toolName;

    /**
     * The ID of the denied tool use.
     */
    @JSONField(name = "tool_use_id")
    private String toolUseId;

    /**
     * The input for the denied tool.
     */
    @JSONField(name = "tool_input")
    private Object toolInput;

    /**
     * Gets the name of the denied tool.
     *
     * @return The name of the denied tool
     */
    public String getToolName() {
        return toolName;
    }

    /**
     * Sets the name of the denied tool.
     *
     * @param toolName The name of the denied tool
     */
    public void setToolName(String toolName) {
        this.toolName = toolName;
    }

    /**
     * Gets the ID of the denied tool use.
     *
     * @return The ID of the denied tool use
     */
    public String getToolUseId() {
        return toolUseId;
    }

    /**
     * Sets the ID of the denied tool use.
     *
     * @param toolUseId The ID of the denied tool use
     */
    public void setToolUseId(String toolUseId) {
        this.toolUseId = toolUseId;
    }

    /**
     * Gets the input for the denied tool.
     *
     * @return The input for the denied tool
     */
    public Object getToolInput() {
        return toolInput;
    }

    /**
     * Sets the input for the denied tool.
     *
     * @param toolInput The input for the denied tool
     */
    public void setToolInput(Object toolInput) {
        this.toolInput = toolInput;
    }
}
