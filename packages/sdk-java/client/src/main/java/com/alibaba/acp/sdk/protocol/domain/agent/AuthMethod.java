package com.alibaba.acp.sdk.protocol.domain.agent;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

/**
 * Authentication Method Class
 *
 * Describes an available authentication method, including ID, name, and description.
 */
public class AuthMethod extends Meta {
    private String id;
    private String name;
    private String description;

    /**
     * Gets the authentication method ID
     *
     * @return Authentication method ID
     */
    public String getId() {
        return id;
    }

    /**
     * Sets the authentication method ID
     *
     * @param id Authentication method ID
     */
    public void setId(String id) {
        this.id = id;
    }

    /**
     * Gets the authentication method name
     *
     * @return Authentication method name
     */
    public String getName() {
        return name;
    }

    /**
     * Sets the authentication method name
     *
     * @param name Authentication method name
     */
    public void setName(String name) {
        this.name = name;
    }

    /**
     * Gets the authentication method description
     *
     * @return Authentication method description
     */
    public String getDescription() {
        return description;
    }

    /**
     * Sets the authentication method description
     *
     * @param description Authentication method description
     */
    public void setDescription(String description) {
        this.description = description;
    }
}
