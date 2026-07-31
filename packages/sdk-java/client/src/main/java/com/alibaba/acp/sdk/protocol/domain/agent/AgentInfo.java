package com.alibaba.acp.sdk.protocol.domain.agent;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

/**
 * Agent Implementation Information Class
 *
 * Describes the agent's implementation information, such as name, title, and version.
 */
public class AgentInfo extends Meta {
    private String name;
    private String title;
    private String version;

    /**
     * Gets the implementation name
     *
     * @return Implementation name
     */
    public String getName() {
        return name;
    }

    /**
     * Sets the implementation name
     *
     * @param name Implementation name
     */
    public void setName(String name) {
        this.name = name;
    }

    /**
     * Gets the implementation title
     *
     * @return Implementation title
     */
    public String getTitle() {
        return title;
    }

    /**
     * Sets the implementation title
     *
     * @param title Implementation title
     */
    public void setTitle(String title) {
        this.title = title;
    }

    /**
     * Gets the implementation version
     *
     * @return Implementation version
     */
    public String getVersion() {
        return version;
    }

    /**
     * Sets the implementation version
     *
     * @param version Implementation version
     */
    public void setVersion(String version) {
        this.version = version;
    }
}
