package com.alibaba.acp.sdk.protocol.domain.plan;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class PlanEntry extends Meta {
    private String content;
    private PlanEntryPriority priority;
    private PlanEntryStatus status;

    // Getters and setters
    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public PlanEntryPriority getPriority() {
        return priority;
    }

    public void setPriority(PlanEntryPriority priority) {
        this.priority = priority;
    }

    public PlanEntryStatus getStatus() {
        return status;
    }

    public void setStatus(PlanEntryStatus status) {
        this.status = status;
    }
}
