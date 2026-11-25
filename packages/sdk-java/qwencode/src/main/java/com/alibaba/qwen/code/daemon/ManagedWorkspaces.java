package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Workspace discovery for the current tenant and actor. */
public final class ManagedWorkspaces {
    private final ManagedAgentClient client;

    ManagedWorkspaces(ManagedAgentClient client) {
        this.client = client;
    }

    public ManagedWorkspace get(String workspaceId) {
        return new ManagedWorkspace(client.getWorkspace(workspaceId));
    }

    public Page list() {
        return list(null, null);
    }

    public Page list(String cursor, Integer limit) {
        return new Page(client.listWorkspaces(cursor, limit));
    }

    public static final class Page extends ManagedPage<ManagedWorkspace> {
        private Page(Map<String, Object> json) {
            super(json, ManagedWorkspace::new);
        }

        /** The configured default visible to the caller, or null. */
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
