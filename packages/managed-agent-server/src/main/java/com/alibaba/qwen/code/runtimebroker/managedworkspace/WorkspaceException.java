package com.alibaba.qwen.code.runtimebroker.managedworkspace;

/**
 * Typed Workspace admission failure that an API adapter maps to its error
 * envelope. None of these succeeds on an unchanged retry.
 */
public final class WorkspaceException extends RuntimeException {
    private final int statusCode;
    private final String code;

    private WorkspaceException(int statusCode, String code, String message) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }

    static WorkspaceException workspaceRequired() {
        return new WorkspaceException(400, "workspace_required",
                "Select a Workspace; the tenant has no usable default");
    }

    static WorkspaceException invalidCwd() {
        return new WorkspaceException(400, "invalid_cwd",
                "cwdRelative is not a valid Workspace-relative directory");
    }

    static WorkspaceException workspaceNotFound() {
        return new WorkspaceException(404, "workspace_not_found",
                "Workspace not found");
    }

    static WorkspaceException workspaceForbidden() {
        return new WorkspaceException(403, "workspace_forbidden",
                "Creating a Session in this Workspace is not allowed");
    }

    static WorkspaceException workspaceUnavailable() {
        return new WorkspaceException(409, "workspace_unavailable",
                "Workspace does not accept new Sessions");
    }

    public int getStatusCode() {
        return statusCode;
    }

    public String getCode() {
        return code;
    }
}
