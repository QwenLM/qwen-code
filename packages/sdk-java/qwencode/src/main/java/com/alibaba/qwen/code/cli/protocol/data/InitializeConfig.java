package com.alibaba.qwen.code.cli.protocol.data;

/**
 * Configuration for initializing the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class InitializeConfig {
    /**
     * Hooks configuration.
     */
    String hooks;
    /**
     * SDK MCP servers configuration.
     */
    String sdkMcpServers;
    /**
     * MCP servers configuration.
     */
    String mcpServers;
    /**
     * Agents configuration.
     */
    String agents;

    /**
     * Gets the hooks configuration.
     *
     * @return The hooks configuration
     */
    public String getHooks() {
        return hooks;
    }

    /**
     * Sets the hooks configuration.
     *
     * @param hooks The hooks configuration
     */
    public void setHooks(String hooks) {
        this.hooks = hooks;
    }

    /**
     * Gets the SDK MCP servers configuration.
     *
     * @return The SDK MCP servers configuration
     */
    public String getSdkMcpServers() {
        return sdkMcpServers;
    }

    /**
     * Sets the SDK MCP servers configuration.
     *
     * @param sdkMcpServers The SDK MCP servers configuration
     */
    public void setSdkMcpServers(String sdkMcpServers) {
        this.sdkMcpServers = sdkMcpServers;
    }

    /**
     * Gets the MCP servers configuration.
     *
     * @return The MCP servers configuration
     */
    public String getMcpServers() {
        return mcpServers;
    }

    /**
     * Sets the MCP servers configuration.
     *
     * @param mcpServers The MCP servers configuration
     */
    public void setMcpServers(String mcpServers) {
        this.mcpServers = mcpServers;
    }

    /**
     * Gets the agents configuration.
     *
     * @return The agents configuration
     */
    public String getAgents() {
        return agents;
    }

    /**
     * Sets the agents configuration.
     *
     * @param agents The agents configuration
     */
    public void setAgents(String agents) {
        this.agents = agents;
    }
}
