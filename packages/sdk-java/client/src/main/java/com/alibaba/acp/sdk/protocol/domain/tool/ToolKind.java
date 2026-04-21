package com.alibaba.acp.sdk.protocol.domain.tool;

import com.alibaba.fastjson2.annotation.JSONField;

public enum ToolKind {
    @JSONField(name = "read", label = "Reading files or data.")
    READ,

    @JSONField(name = "edit", label = "Modifying files or content.")
    EDIT,

    @JSONField(name = "delete", label = "Removing files or data.")
    DELETE,

    @JSONField(name = "move", label = "Moving or renaming files.")
    MOVE,

    @JSONField(name = "search", label = "Searching for information.")
    SEARCH,

    @JSONField(name = "execute", label = "Running commands or code.")
    EXECUTE,

    @JSONField(name = "think", label = "Internal reasoning or planning.")
    THINK,

    @JSONField(name = "fetch", label = "Retrieving external data.")
    FETCH,

    @JSONField(name = "switch_mode", label = "Switching the current session mode.")
    SWITCH_MODE,

    @JSONField(name = "other", label = "Other tool types (default).")
    OTHER;
}
