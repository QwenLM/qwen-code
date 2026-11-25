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

    public String getObject() {
        return string("object");
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

    /** A Workspace list, including discovery capabilities and the default visible to the caller. */
    public static final class Page extends ManagedPage<ManagedWorkspace> {
        Page(Map<String, Object> json) {
            super(json, ManagedWorkspace::new);
        }

        public ManagedWorkspace getDefaultWorkspace() {
            return optionalObject("default_workspace", ManagedWorkspace::new);
        }

        public boolean supportsWorkspaceContext() {
            return JsonSupport.requiredBoolean(object("capabilities"), "workspace_context", "Workspace capabilities");
        }

        public boolean supportsWorkspaceBinding() {
            return JsonSupport.requiredBoolean(object("capabilities"), "workspace_binding", "Workspace capabilities");
        }
    }
}
