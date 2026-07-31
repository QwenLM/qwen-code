package com.alibaba.acp.sdk.protocol.domain.plan;

import com.alibaba.fastjson2.annotation.JSONField;

public enum PlanEntryStatus {
    @JSONField(name = "pending", label = "The task has not started yet.")
    PENDING,

    @JSONField(name = "in_progress", label = "The task is currently being worked on.")
    IN_PROGRESS,

    @JSONField(name = "completed", label = "The task has been successfully completed.")
    COMPLETED;
}
