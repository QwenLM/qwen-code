package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTask;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTask;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskPage;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskRow;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * The task list and detail of a Session (SessionTaskView), read from the
 * Stage H records its Session store holds. Task events and cancel arrive
 * with the slices whose tasks produce output and accept a cancel.
 */
@Service
public class ManagedTaskService {
    private static final Pattern CURSOR = Pattern.compile(
            "^(0|[1-9][0-9]{0,18}):(task_[0-9a-f]{64})$");
    // No H0c task advertises an action: cancel and events stay planned.
    private static final List<String> NO_ACTIONS = List.of();
    // Task output reaches Artifacts with Stage H3.
    private static final List<String> NO_ARTIFACTS = List.of();
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;

    public ManagedTaskService(ManagedAgentService sessions,
            ManagedExtensionRecordStore records) {
        this.sessions = sessions;
        this.records = records;
    }

    public PublicList<PublicTask> listPublicTasks(String tenantId,
            String actorId, String sessionId, String cursor, int limit) {
        TaskPage page = page(tenantId, actorId, sessionId, cursor, limit);
        return new PublicList<>("list", page.tasks().stream()
                .map(task -> publicTask(sessionId, task)).toList(),
                page.hasMore(), nextCursor(page));
    }

    public PublicTask getPublicTask(String tenantId, String actorId,
            String sessionId, String taskId) {
        return publicTask(sessionId, task(tenantId, actorId, sessionId,
                taskId));
    }

    public WebShellPage<WebShellTask> queryWebShellTasks(String tenantId,
            String actorId, String sessionId, String cursor, int limit) {
        TaskPage page = page(tenantId, actorId, sessionId, cursor, limit);
        return new WebShellPage<>(page.tasks().stream()
                .map(task -> webShellTask(sessionId, task)).toList(),
                nextCursor(page), page.hasMore());
    }

    public WebShellTask getWebShellTask(String tenantId, String actorId,
            String sessionId, String taskId) {
        return webShellTask(sessionId, task(tenantId, actorId, sessionId,
                taskId));
    }

    private TaskPage page(String tenantId, String actorId, String sessionId,
            String cursor, int limit) {
        sessions.requireReadableSession(tenantId, actorId, sessionId);
        if (limit < 1 || limit > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
        if (cursor == null || cursor.isEmpty()) {
            return records.listTasks(tenantId, sessionId, null, null, limit);
        }
        String decoded;
        try {
            decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            decoded = "";
        }
        var matcher = CURSOR.matcher(decoded);
        if (!matcher.matches()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor",
                    "Task cursor is invalid.");
        }
        try {
            return records.listTasks(tenantId, sessionId,
                    Long.parseLong(matcher.group(1)), matcher.group(2), limit);
        } catch (NumberFormatException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor",
                    "Task cursor is invalid.");
        }
    }

    private TaskRow task(String tenantId, String actorId, String sessionId,
            String taskId) {
        sessions.requireReadableSession(tenantId, actorId, sessionId);
        return records.findTask(tenantId, sessionId, taskId).orElseThrow(() ->
                new ApiException(HttpStatus.NOT_FOUND, "task_not_found",
                        "The task was not found."));
    }

    private static String nextCursor(TaskPage page) {
        if (!page.hasMore()) {
            return null;
        }
        TaskRow last = page.tasks().get(page.tasks().size() - 1);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                (last.projection().createdAt() + ":" + last.taskId())
                        .getBytes(StandardCharsets.UTF_8));
    }

    private static PublicTask publicTask(String sessionId, TaskRow task) {
        TaskProjection view = task.projection();
        return new PublicTask(task.taskId(), "agent.task", sessionId,
                task.kind(), view.state(), view.definitionRevision(),
                view.runtimeState(), view.createdAt(), view.startedAt(),
                view.settledAt(), NO_ARTIFACTS, NO_ACTIONS);
    }

    private static WebShellTask webShellTask(String sessionId,
            TaskRow task) {
        TaskProjection view = task.projection();
        return new WebShellTask(task.taskId(), sessionId, task.kind(),
                view.state(), view.definitionRevision(), view.runtimeState(),
                view.createdAt(), view.startedAt(), view.settledAt(),
                NO_ARTIFACTS, NO_ACTIONS);
    }
}
