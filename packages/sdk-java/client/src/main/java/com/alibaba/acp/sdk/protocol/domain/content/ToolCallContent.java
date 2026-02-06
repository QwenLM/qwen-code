package com.alibaba.acp.sdk.protocol.domain.content;

import com.alibaba.acp.sdk.protocol.domain.content.block.ContentBlock;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class ToolCallContent extends Meta {
    private String type;
    private ContentBlock content;
    private Diff diff;
    private String terminalId;

    // Getters and setters
    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public ContentBlock getContent() {
        return content;
    }

    public void setContent(ContentBlock content) {
        this.content = content;
    }

    public Diff getDiff() {
        return diff;
    }

    public void setDiff(Diff diff) {
        this.diff = diff;
    }

    public String getTerminalId() {
        return terminalId;
    }

    public void setTerminalId(String terminalId) {
        this.terminalId = terminalId;
    }
}
