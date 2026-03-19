package com.alibaba.acp.sdk.protocol.domain.tool;

import java.util.List;

import com.alibaba.acp.sdk.protocol.domain.content.ToolCallContent;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class ToolCallUpdate extends Meta {
    private String toolCallId;
    private String title;
    private ToolKind kind;
    private ToolCallStatus status;
    private Object rawInput;
    private Object rawOutput;
    private List<ToolCallLocation> locations;
    private List<ToolCallContent> content;

    // Getters and setters
    public String getToolCallId() {
        return toolCallId;
    }

    public void setToolCallId(String toolCallId) {
        this.toolCallId = toolCallId;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public ToolKind getKind() {
        return kind;
    }

    public void setKind(ToolKind kind) {
        this.kind = kind;
    }

    public ToolCallStatus getStatus() {
        return status;
    }

    public void setStatus(ToolCallStatus status) {
        this.status = status;
    }

    public Object getRawInput() {
        return rawInput;
    }

    public void setRawInput(Object rawInput) {
        this.rawInput = rawInput;
    }

    public Object getRawOutput() {
        return rawOutput;
    }

    public void setRawOutput(Object rawOutput) {
        this.rawOutput = rawOutput;
    }

    public List<ToolCallLocation> getLocations() {
        return locations;
    }

    public void setLocations(List<ToolCallLocation> locations) {
        this.locations = locations;
    }

    public List<ToolCallContent> getContent() {
        return content;
    }

    public void setContent(List<ToolCallContent> content) {
        this.content = content;
    }
}
