package com.alibaba.acp.sdk.protocol.domain.permission;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class PermissionOption extends Meta {
    private String optionId;
    private String name;
    private PermissionOptionKind kind;

    // Getters and setters
    public String getOptionId() {
        return optionId;
    }

    public void setOptionId(String optionId) {
        this.optionId = optionId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public PermissionOptionKind getKind() {
        return kind;
    }

    public void setKind(PermissionOptionKind kind) {
        this.kind = kind;
    }
}
