package com.alibaba.acp.sdk.protocol.domain.session;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class SessionMode extends Meta {
    private String id;
    private String name;
    private String description;

    // Getters and setters
    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }
}
