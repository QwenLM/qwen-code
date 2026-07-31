package com.alibaba.acp.sdk.protocol.domain.tool;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class ToolCallLocation extends Meta {
    private String path;
    private Integer line;

    // Getters and setters
    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public Integer getLine() {
        return line;
    }

    public void setLine(Integer line) {
        this.line = line;
    }
}
