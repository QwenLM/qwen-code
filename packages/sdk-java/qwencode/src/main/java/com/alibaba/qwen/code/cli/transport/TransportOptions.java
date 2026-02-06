package com.alibaba.qwen.code.cli.transport;

import java.util.List;
import java.util.Map;

import com.alibaba.qwen.code.cli.protocol.data.PermissionMode;
import com.alibaba.qwen.code.cli.utils.Timeout;

/**
 * Configuration options for the transport layer.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class TransportOptions implements Cloneable {
    /**
     * Path to the Qwen executable.
     */
    private String pathToQwenExecutable;
    /**
     * Current working directory for the CLI process.
     */
    private String cwd;
    /**
     * Model to use for the session.
     */
    private String model;
    /**
     * Permission mode for the session.
     */
    private PermissionMode permissionMode;
    /**
     * Environment variables to pass to the CLI process.
     */
    private Map<String, String> env;
    /**
     * Maximum number of turns in a session.
     */
    private Integer maxSessionTurns;
    /**
     * List of core tools to enable.
     */
    private List<String> coreTools;
    /**
     * List of tools to exclude.
     */
    private List<String> excludeTools;
    /**
     * List of tools that are allowed.
     */
    private List<String> allowedTools;
    /**
     * Authentication type to use.
     */
    private String authType;
    /**
     * Whether to include partial messages in responses.
     */
    private Boolean includePartialMessages;
    /**
     * Whether to enable skills.
     */
    private Boolean skillsEnable;
    /**
     * Timeout for individual turns.
     */
    private Timeout turnTimeout;
    /**
     * Timeout for messages.
     */
    private Timeout messageTimeout;
    /**
     * Session ID to resume.
     */
    private String resumeSessionId;
    /**
     * Additional options to pass to the CLI.
     */
    private List<String> otherOptions;

    /**
     * Gets the path to the Qwen executable.
     *
     * @return The path to the Qwen executable
     */
    public String getPathToQwenExecutable() {
        return pathToQwenExecutable;
    }

    /**
     * Sets the path to the Qwen executable.
     *
     * @param pathToQwenExecutable The path to the Qwen executable
     * @return This instance for method chaining
     */
    public TransportOptions setPathToQwenExecutable(String pathToQwenExecutable) {
        this.pathToQwenExecutable = pathToQwenExecutable;
        return this;
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
     * @return This instance for method chaining
     */
    public TransportOptions setCwd(String cwd) {
        this.cwd = cwd;
        return this;
    }

    /**
     * Gets the model to use.
     *
     * @return The model name
     */
    public String getModel() {
        return model;
    }

    /**
     * Sets the model to use.
     *
     * @param model The model name
     * @return This instance for method chaining
     */
    public TransportOptions setModel(String model) {
        this.model = model;
        return this;
    }

    /**
     * Gets the permission mode.
     *
     * @return The permission mode
     */
    public PermissionMode getPermissionMode() {
        return permissionMode;
    }

    /**
     * Sets the permission mode.
     *
     * @param permissionMode The permission mode
     * @return This instance for method chaining
     */
    public TransportOptions setPermissionMode(PermissionMode permissionMode) {
        this.permissionMode = permissionMode;
        return this;
    }

    /**
     * Gets the environment variables.
     *
     * @return A map of environment variables
     */
    public Map<String, String> getEnv() {
        return env;
    }

    /**
     * Sets the environment variables.
     *
     * @param env A map of environment variables
     * @return This instance for method chaining
     */
    public TransportOptions setEnv(Map<String, String> env) {
        this.env = env;
        return this;
    }

    /**
     * Gets the maximum number of session turns.
     *
     * @return The maximum number of session turns
     */
    public Integer getMaxSessionTurns() {
        return maxSessionTurns;
    }

    /**
     * Sets the maximum number of session turns.
     *
     * @param maxSessionTurns The maximum number of session turns
     * @return This instance for method chaining
     */
    public TransportOptions setMaxSessionTurns(Integer maxSessionTurns) {
        this.maxSessionTurns = maxSessionTurns;
        return this;
    }

    /**
     * Gets the list of core tools.
     *
     * @return The list of core tools
     */
    public List<String> getCoreTools() {
        return coreTools;
    }

    /**
     * Sets the list of core tools.
     *
     * @param coreTools The list of core tools
     * @return This instance for method chaining
     */
    public TransportOptions setCoreTools(List<String> coreTools) {
        this.coreTools = coreTools;
        return this;
    }

    /**
     * Gets the list of excluded tools.
     *
     * @return The list of excluded tools
     */
    public List<String> getExcludeTools() {
        return excludeTools;
    }

    /**
     * Sets the list of excluded tools.
     *
     * @param excludeTools The list of excluded tools
     * @return This instance for method chaining
     */
    public TransportOptions setExcludeTools(List<String> excludeTools) {
        this.excludeTools = excludeTools;
        return this;
    }

    /**
     * Gets the list of allowed tools.
     *
     * @return The list of allowed tools
     */
    public List<String> getAllowedTools() {
        return allowedTools;
    }

    /**
     * Sets the list of allowed tools.
     *
     * @param allowedTools The list of allowed tools
     * @return This instance for method chaining
     */
    public TransportOptions setAllowedTools(List<String> allowedTools) {
        this.allowedTools = allowedTools;
        return this;
    }

    /**
     * Gets the authentication type.
     *
     * @return The authentication type
     */
    public String getAuthType() {
        return authType;
    }

    /**
     * Sets the authentication type.
     *
     * @param authType The authentication type
     * @return This instance for method chaining
     */
    public TransportOptions setAuthType(String authType) {
        this.authType = authType;
        return this;
    }

    /**
     * Gets whether to include partial messages.
     *
     * @return Whether to include partial messages
     */
    public Boolean getIncludePartialMessages() {
        return includePartialMessages;
    }

    /**
     * Sets whether to include partial messages.
     *
     * @param includePartialMessages Whether to include partial messages
     * @return This instance for method chaining
     */
    public TransportOptions setIncludePartialMessages(Boolean includePartialMessages) {
        this.includePartialMessages = includePartialMessages;
        return this;
    }

    /**
     * Gets whether skills are enabled.
     *
     * @return Whether skills are enabled
     */
    public Boolean getSkillsEnable() {
        return skillsEnable;
    }

    /**
     * Sets whether skills are enabled.
     *
     * @param skillsEnable Whether skills are enabled
     * @return This instance for method chaining
     */
    public TransportOptions setSkillsEnable(Boolean skillsEnable) {
        this.skillsEnable = skillsEnable;
        return this;
    }

    /**
     * Gets the turn timeout.
     *
     * @return The turn timeout
     */
    public Timeout getTurnTimeout() {
        return turnTimeout;
    }

    /**
     * Sets the turn timeout.
     *
     * @param turnTimeout The turn timeout
     * @return This instance for method chaining
     */
    public TransportOptions setTurnTimeout(Timeout turnTimeout) {
        this.turnTimeout = turnTimeout;
        return this;
    }

    /**
     * Gets the message timeout.
     *
     * @return The message timeout
     */
    public Timeout getMessageTimeout() {
        return messageTimeout;
    }

    /**
     * Sets the message timeout.
     *
     * @param messageTimeout The message timeout
     * @return This instance for method chaining
     */
    public TransportOptions setMessageTimeout(Timeout messageTimeout) {
        this.messageTimeout = messageTimeout;
        return this;
    }

    /**
     * Gets the session ID to resume.
     *
     * @return The session ID to resume
     */
    public String getResumeSessionId() {
        return resumeSessionId;
    }

    /**
     * Sets the session ID to resume.
     *
     * @param resumeSessionId The session ID to resume
     * @return This instance for method chaining
     */
    public TransportOptions setResumeSessionId(String resumeSessionId) {
        this.resumeSessionId = resumeSessionId;
        return this;
    }

    /**
     * Gets additional options.
     *
     * @return Additional options
     */
    public List<String> getOtherOptions() {
        return otherOptions;
    }

    /**
     * Sets additional options.
     *
     * @param otherOptions Additional options
     * @return This instance for method chaining
     */
    public TransportOptions setOtherOptions(List<String> otherOptions) {
        this.otherOptions = otherOptions;
        return this;
    }

    /** {@inheritDoc} */
    @Override
    public TransportOptions clone() {
        try {
            return (TransportOptions) super.clone();
        } catch (CloneNotSupportedException e) {
            throw new AssertionError();
        }
    }
}
