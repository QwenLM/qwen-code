package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRelativePath;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;

public record WorkspaceSelection(String workspaceId, String cwdRelative) {
    private static final Pattern IDENTIFIER =
            Pattern.compile("[A-Za-z0-9._:-]{1,128}");

    public WorkspaceSelection {
        if (workspaceId == null || !IDENTIFIER.matcher(workspaceId).matches()) {
            throw invalidRequest();
        }
        if (cwdRelative == null) {
            throw invalidCwd();
        }
        cwdRelative = normalizeCwd(cwdRelative);
    }

    public static WorkspaceSelection parse(JsonNode workspace,
            boolean webShell) {
        String idKey = webShell ? "workspaceId" : "workspace_id";
        String cwdKey = webShell ? "cwdRelative" : "cwd_relative";
        if (!workspace.isObject()) {
            throw invalidRequest();
        }
        var fields = workspace.fieldNames();
        while (fields.hasNext()) {
            String key = fields.next();
            if (!idKey.equals(key) && !cwdKey.equals(key)) {
                throw invalidRequest();
            }
        }
        JsonNode id = workspace.get(idKey);
        if (id == null || !id.isTextual()) {
            throw invalidRequest();
        }
        JsonNode cwd = workspace.get(cwdKey);
        if (cwd == null) {
            return new WorkspaceSelection(id.textValue(), ".");
        }
        if (!cwd.isTextual()) {
            throw invalidCwd();
        }
        return new WorkspaceSelection(id.textValue(), cwd.textValue());
    }

    private static String normalizeCwd(String value) {
        try {
            return WorkspaceRelativePath.normalize(value);
        } catch (WorkspaceException error) {
            throw invalidCwd();
        }
    }

    private static ApiException invalidRequest() {
        return new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                "Workspace selection is invalid.");
    }

    private static ApiException invalidCwd() {
        return new ApiException(HttpStatus.BAD_REQUEST, "invalid_cwd",
                "Workspace directory must be a relative path.");
    }
}
