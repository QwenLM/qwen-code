package com.alibaba.qwen.code.cli.protocol.message;

import java.util.List;
import java.util.Map;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a system message from the SDK.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "system")
public class SDKSystemMessage extends MessageBase {
    /**
     * The subtype of the system message.
     */
    private String subtype;
    /**
     * The UUID of the message.
     */
    private String uuid;
    /**
     * The session ID.
     */
    @JSONField(name = "session_id")
    private String sessionId;
    /**
     * Additional data.
     */
    private Object data;
    /**
     * Current working directory.
     */
    private String cwd;
    /**
     * List of available tools.
     */
    private List<String> tools;
    /**
     * List of MCP servers.
     */
    @JSONField(name = "mcp_servers")
    private List<McpServer> mcpServers;
    /**
     * Model information.
     */
    private String model;
    /**
     * Permission mode.
     */
    @JSONField(name = "permission_mode")
    private String permissionMode;
    /**
     * Available slash commands.
     */
    @JSONField(name = "slash_commands")
    private List<String> slashCommands;
    /**
     * Qwen Code version.
     */
    @JSONField(name = "qwen_code_version")
    private String qwenCodeVersion;
    /**
     * Output style.
     */
    @JSONField(name = "output_style")
    private String outputStyle;
    /**
     * Available agents.
     */
    private List<String> agents;
    /**
     * Available skills.
     */
    private List<String> skills;
    /**
     * Capabilities information.
     */
    private Map<String, Object> capabilities;
    /**
     * Compact metadata.
     */
    @JSONField(name = "compact_metadata")
    private CompactMetadata compactMetadata;

    /**
     * Creates a new SDKSystemMessage instance and sets the type to "system".
     */
    public SDKSystemMessage() {
        super();
        this.type = "system";
    }

    /**
     * Gets the subtype of the system message.
     *
     * @return The subtype of the system message
     */
    public String getSubtype() {
        return subtype;
    }

    /**
     * Sets the subtype of the system message.
     *
     * @param subtype The subtype of the system message
     */
    public void setSubtype(String subtype) {
        this.subtype = subtype;
    }

    /**
     * Gets the UUID of the message.
     *
     * @return The UUID of the message
     */
    public String getUuid() {
        return uuid;
    }

    /**
     * Sets the UUID of the message.
     *
     * @param uuid The UUID of the message
     */
    public void setUuid(String uuid) {
        this.uuid = uuid;
    }

    /**
     * Gets the session ID.
     *
     * @return The session ID
     */
    public String getSessionId() {
        return sessionId;
    }

    /**
     * Sets the session ID.
     *
     * @param sessionId The session ID
     */
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    /**
     * Gets the additional data.
     *
     * @return The additional data
     */
    public Object getData() {
        return data;
    }

    /**
     * Sets the additional data.
     *
     * @param data The additional data
     */
    public void setData(Object data) {
        this.data = data;
    }

    /**
     * Gets the current working directory.
     *
     * @return The current working directory
     */
    public String getCwd() {
        return cwd;
    }

    /**
     * Sets the current working directory.
     *
     * @param cwd The current working directory
     */
    public void setCwd(String cwd) {
        this.cwd = cwd;
    }

    /**
     * Gets the list of available tools.
     *
     * @return The list of available tools
     */
    public List<String> getTools() {
        return tools;
    }

    /**
     * Sets the list of available tools.
     *
     * @param tools The list of available tools
     */
    public void setTools(List<String> tools) {
        this.tools = tools;
    }

    /**
     * Gets the list of MCP servers.
     *
     * @return The list of MCP servers
     */
    public List<McpServer> getMcpServers() {
        return mcpServers;
    }

    /**
     * Sets the list of MCP servers.
     *
     * @param mcpServers The list of MCP servers
     */
    public void setMcpServers(List<McpServer> mcpServers) {
        this.mcpServers = mcpServers;
    }

    /**
     * Gets the model information.
     *
     * @return The model information
     */
    public String getModel() {
        return model;
    }

    /**
     * Sets the model information.
     *
     * @param model The model information
     */
    public void setModel(String model) {
        this.model = model;
    }

    /**
     * Gets the permission mode.
     *
     * @return The permission mode
     */
    public String getPermissionMode() {
        return permissionMode;
    }

    /**
     * Sets the permission mode.
     *
     * @param permissionMode The permission mode
     */
    public void setPermissionMode(String permissionMode) {
        this.permissionMode = permissionMode;
    }

    /**
     * Gets the available slash commands.
     *
     * @return The available slash commands
     */
    public List<String> getSlashCommands() {
        return slashCommands;
    }

    /**
     * Sets the available slash commands.
     *
     * @param slashCommands The available slash commands
     */
    public void setSlashCommands(List<String> slashCommands) {
        this.slashCommands = slashCommands;
    }

    /**
     * Gets the Qwen Code version.
     *
     * @return The Qwen Code version
     */
    public String getQwenCodeVersion() {
        return qwenCodeVersion;
    }

    /**
     * Sets the Qwen Code version.
     *
     * @param qwenCodeVersion The Qwen Code version
     */
    public void setQwenCodeVersion(String qwenCodeVersion) {
        this.qwenCodeVersion = qwenCodeVersion;
    }

    /**
     * Gets the output style.
     *
     * @return The output style
     */
    public String getOutputStyle() {
        return outputStyle;
    }

    /**
     * Sets the output style.
     *
     * @param outputStyle The output style
     */
    public void setOutputStyle(String outputStyle) {
        this.outputStyle = outputStyle;
    }

    /**
     * Gets the available agents.
     *
     * @return The available agents
     */
    public List<String> getAgents() {
        return agents;
    }

    /**
     * Sets the available agents.
     *
     * @param agents The available agents
     */
    public void setAgents(List<String> agents) {
        this.agents = agents;
    }

    /**
     * Gets the available skills.
     *
     * @return The available skills
     */
    public List<String> getSkills() {
        return skills;
    }

    /**
     * Sets the available skills.
     *
     * @param skills The available skills
     */
    public void setSkills(List<String> skills) {
        this.skills = skills;
    }

    /**
     * Gets the capabilities information.
     *
     * @return The capabilities information
     */
    public Map<String, Object> getCapabilities() {
        return capabilities;
    }

    /**
     * Sets the capabilities information.
     *
     * @param capabilities The capabilities information
     */
    public void setCapabilities(Map<String, Object> capabilities) {
        this.capabilities = capabilities;
    }

    /**
     * Gets the compact metadata.
     *
     * @return The compact metadata
     */
    public CompactMetadata getCompactMetadata() {
        return compactMetadata;
    }

    /**
     * Sets the compact metadata.
     *
     * @param compactMetadata The compact metadata
     */
    public void setCompactMetadata(CompactMetadata compactMetadata) {
        this.compactMetadata = compactMetadata;
    }

    /**
     * Represents MCP server information.
     */
    public static class McpServer {
        /**
         * Server name.
         */
        private String name;
        /**
         * Server status.
         */
        private String status;

        /**
         * Gets the server name.
         *
         * @return The server name
         */
        public String getName() {
            return name;
        }

        /**
         * Sets the server name.
         *
         * @param name The server name
         */
        public void setName(String name) {
            this.name = name;
        }

        /**
         * Gets the server status.
         *
         * @return The server status
         */
        public String getStatus() {
            return status;
        }

        /**
         * Sets the server status.
         *
         * @param status The server status
         */
        public void setStatus(String status) {
            this.status = status;
        }
    }

    /**
     * Represents compact metadata.
     */
    public static class CompactMetadata {
        /**
         * Trigger information.
         */
        private String trigger;

        /**
         * Pre-tokens information.
         */
        @JSONField(name = "pre_tokens")
        private Integer preTokens;

        /**
         * Gets the trigger information.
         *
         * @return The trigger information
         */
        public String getTrigger() {
            return trigger;
        }

        /**
         * Sets the trigger information.
         *
         * @param trigger The trigger information
         */
        public void setTrigger(String trigger) {
            this.trigger = trigger;
        }

        /**
         * Gets the pre-tokens information.
         *
         * @return The pre-tokens information
         */
        public Integer getPreTokens() {
            return preTokens;
        }

        /**
         * Sets the pre-tokens information.
         *
         * @param preTokens The pre-tokens information
         */
        public void setPreTokens(Integer preTokens) {
            this.preTokens = preTokens;
        }
    }
}
