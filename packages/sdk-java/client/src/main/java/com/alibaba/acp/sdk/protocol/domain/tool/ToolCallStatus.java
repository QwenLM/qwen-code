package com.alibaba.acp.sdk.protocol.domain.tool;

import com.alibaba.fastjson2.annotation.JSONField;

public enum ToolCallStatus {
    @JSONField(name = "pending", label = "The tool call hasn't started running yet because the input is either\nstreaming or we're awaiting approval.")
    PENDING,

    @JSONField(name = "in_progress", label = "The tool call is currently running.")
    IN_PROGRESS,

    @JSONField(name = "completed", label = "The tool call completed successfully.")
    COMPLETED,

    @JSONField(name = "failed", label = "The tool call failed with an error.")
    FAILED;
}
