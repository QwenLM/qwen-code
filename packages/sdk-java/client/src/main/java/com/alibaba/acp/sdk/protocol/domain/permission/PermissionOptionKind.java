package com.alibaba.acp.sdk.protocol.domain.permission;

import com.alibaba.fastjson2.annotation.JSONField;

public enum PermissionOptionKind {
    @JSONField(name = "allow_once", label = "Allow this operation only this time.")
    ALLOW_ONCE,

    @JSONField(name = "allow_always", label = "Allow this operation and remember the choice.")
    ALLOW_ALWAYS,

    @JSONField(name = "reject_once", label = "Reject this operation only this time.")
    REJECT_ONCE,

    @JSONField(name = "reject_always", label = "Reject this operation and remember the choice.")
    REJECT_ALWAYS;
}
