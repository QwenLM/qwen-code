package com.alibaba.acp.sdk.protocol.domain.plan;

import com.alibaba.fastjson2.annotation.JSONField;

public enum PlanEntryPriority {
    @JSONField(name = "high", label = "High priority task - critical to the overall goal.")
    HIGH,

    @JSONField(name = "medium", label = "Medium priority task - important but not critical.")
    MEDIUM,

    @JSONField(name = "low", label = "Low priority task - nice to have but not essential.")
    LOW;
}
