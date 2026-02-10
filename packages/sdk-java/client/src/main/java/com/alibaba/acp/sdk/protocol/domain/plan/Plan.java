package com.alibaba.acp.sdk.protocol.domain.plan;

import java.util.List;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class Plan extends Meta {
    private List<PlanEntry> entries;

    // Getters and setters
    public List<PlanEntry> getEntries() {
        return entries;
    }

    public void setEntries(List<PlanEntry> entries) {
        this.entries = entries;
    }
}
