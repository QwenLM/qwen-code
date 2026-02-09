package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import java.util.List;
import java.util.Map;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a control permission request to the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "can_use_tool")
public class CLIControlPermissionRequest extends ControlRequestPayload {
    public CLIControlPermissionRequest() {
        super();
        this.subtype = "can_use_tool";
    }

    /**
     * The name of the tool requesting permission.
     */
    @JSONField(name = "tool_name")
    private String toolName;

    /**
     * The ID of the tool use.
     */
    @JSONField(name = "tool_use_id")
    private String toolUseId;

    /**
     * The input for the tool.
     */
    private Map<String, Object> input;

    /**
     * List of permission suggestions.
     */
    @JSONField(name = "permission_suggestions")
    private List<PermissionSuggestion> permissionSuggestions;

    /**
     * The blocked path.
     */
    @JSONField(name = "blocked_path")
    private String blockedPath;

    /**
     * Gets the name of the tool requesting permission.
     *
     * @return The name of the tool requesting permission
     */
    public String getToolName() {
        return toolName;
    }

    /**
     * Sets the name of the tool requesting permission.
     *
     * @param toolName The name of the tool requesting permission
     */
    public void setToolName(String toolName) {
        this.toolName = toolName;
    }

    /**
     * Gets the ID of the tool use.
     *
     * @return The ID of the tool use
     */
    public String getToolUseId() {
        return toolUseId;
    }

    /**
     * Sets the ID of the tool use.
     *
     * @param toolUseId The ID of the tool use
     */
    public void setToolUseId(String toolUseId) {
        this.toolUseId = toolUseId;
    }

    /**
     * Gets the input for the tool.
     *
     * @return The input for the tool
     */
    public Map<String, Object> getInput() {
        return input;
    }

    /**
     * Sets the input for the tool.
     *
     * @param input The input for the tool
     */
    public void setInput(Map<String, Object> input) {
        this.input = input;
    }

    /**
     * Gets the list of permission suggestions.
     *
     * @return The list of permission suggestions
     */
    public List<PermissionSuggestion> getPermissionSuggestions() {
        return permissionSuggestions;
    }

    /**
     * Sets the list of permission suggestions.
     *
     * @param permissionSuggestions The list of permission suggestions
     */
    public void setPermissionSuggestions(
            List<PermissionSuggestion> permissionSuggestions) {
        this.permissionSuggestions = permissionSuggestions;
    }

    /**
     * Gets the blocked path.
     *
     * @return The blocked path
     */
    public String getBlockedPath() {
        return blockedPath;
    }

    /**
     * Sets the blocked path.
     *
     * @param blockedPath The blocked path
     */
    public void setBlockedPath(String blockedPath) {
        this.blockedPath = blockedPath;
    }

    /**
     * Represents a permission suggestion.
     */
    public static class PermissionSuggestion {
        /**
         * The type of suggestion (allow, deny, modify).
         */
        private String type; // 'allow' | 'deny' | 'modify'
        /**
         * The label for the suggestion.
         */
        private String label;
        /**
         * The description of the suggestion.
         */
        private String description;
        /**
         * The modified input.
         */
        private Object modifiedInput;

        /**
         * Gets the type of suggestion.
         *
         * @return The type of suggestion
         */
        public String getType() {
            return type;
        }

        /**
         * Sets the type of suggestion.
         *
         * @param type The type of suggestion
         */
        public void setType(String type) {
            this.type = type;
        }

        /**
         * Gets the label for the suggestion.
         *
         * @return The label for the suggestion
         */
        public String getLabel() {
            return label;
        }

        /**
         * Sets the label for the suggestion.
         *
         * @param label The label for the suggestion
         */
        public void setLabel(String label) {
            this.label = label;
        }

        /**
         * Gets the description of the suggestion.
         *
         * @return The description of the suggestion
         */
        public String getDescription() {
            return description;
        }

        /**
         * Sets the description of the suggestion.
         *
         * @param description The description of the suggestion
         */
        public void setDescription(String description) {
            this.description = description;
        }

        /**
         * Gets the modified input.
         *
         * @return The modified input
         */
        public Object getModifiedInput() {
            return modifiedInput;
        }

        /**
         * Sets the modified input.
         *
         * @param modifiedInput The modified input
         */
        public void setModifiedInput(Object modifiedInput) {
            this.modifiedInput = modifiedInput;
        }
    }
}
