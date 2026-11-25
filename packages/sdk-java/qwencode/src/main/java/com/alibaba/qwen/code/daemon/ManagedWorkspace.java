package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Workspace visible to the current actor. */
public final class ManagedWorkspace extends ManagedJson {
    ManagedWorkspace(Map<String, Object> json) {
        super(json);
    }

    public String getId() {
        return string("id");
    }

    public String getDisplayName() {
        return optionalString("display_name");
    }

    public String getState() {
        return string("state");
    }

    public boolean canCreateSession() {
        return flag("can_create_session");
    }
}
