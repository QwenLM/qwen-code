package com.alibaba.acp.sdk.protocol.domain.client;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

/**
 * Client Information Class
 *
 * Describes basic client information such as name, title, and version.
 */
public class ClientInfo extends Meta {
    private String name;
    private String title;
    private String version;

    /**
     * Gets the client name
     *
     * @return Client name
     */
    public String getName() {
        return name;
    }

    /**
     * Sets the client name
     *
     * @param name Client name
     */
    public void setName(String name) {
        this.name = name;
    }

    /**
     * Gets the client title
     *
     * @return Client title
     */
    public String getTitle() {
        return title;
    }

    /**
     * Sets the client title
     *
     * @param title Client title
     */
    public void setTitle(String title) {
        this.title = title;
    }

    /**
     * Gets the client version
     *
     * @return Client version
     */
    public String getVersion() {
        return version;
    }

    /**
     * Sets the client version
     *
     * @param version Client version
     */
    public void setVersion(String version) {
        this.version = version;
    }
}
