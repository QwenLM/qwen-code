package com.alibaba.acp.sdk.protocol.domain.content;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class Diff extends Meta {
    private String path;
    private String newText;
    private String oldText;

    // Getters and setters
    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getNewText() {
        return newText;
    }

    public void setNewText(String newText) {
        this.newText = newText;
    }

    public String getOldText() {
        return oldText;
    }

    public void setOldText(String oldText) {
        this.oldText = oldText;
    }
}
