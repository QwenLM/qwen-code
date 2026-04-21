package com.alibaba.acp.sdk.protocol.domain.permission;

import com.alibaba.fastjson2.annotation.JSONField;

public enum PermissionOutcomeKind {
    @JSONField(name = "selected", label = "The user selected an option.")
    SELECTED,
    @JSONField(name = "cancelled", label = "The user cancelled the prompt.")
    CANCELLED
}
