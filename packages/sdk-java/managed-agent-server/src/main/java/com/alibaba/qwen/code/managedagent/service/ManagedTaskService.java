package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTask;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTaskEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTask;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTaskEvent;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskPage;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore.TaskRow;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore.CursorPositions;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore.EventPage;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore.TaskEvent;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * The task list, detail and events of a Session (SessionTaskView), read
 * from the Stage H records its Session store holds and the per-task event
 * journal the same commits write. A task advertises {@code cancel} while
 * {@link ManagedTaskCancelService} would admit one for it (H4f).
 */
@Service
public class ManagedTaskService {
    private static final Pattern CURSOR = Pattern.compile(
            "^(0|[1-9][0-9]{0,18}):(task_[0-9a-f]{64})$");
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;
    private final ManagedTaskEventStore events;

    public ManagedTaskService(ManagedAgentService sessions,
            ManagedExtensionRecordStore records,
            ManagedTaskEventStore events) {
        this.sessions = sessions;
        this.records = records;
        this.events = events;
    }

    public PublicList<PublicTask> listPublicTasks(String tenantId,
            String actorId, String sessionId, String cursor, int limit) {
        Viewed<TaskPage> viewed = page(tenantId, actorId, sessionId, cursor,
                limit);
        TaskPage page = viewed.value();
        return new PublicList<>("list", page.tasks().stream()
                .map(task -> publicTask(tenantId, sessionId, task,
                        viewed.sessionActive())).toList(),
                page.hasMore(), nextCursor(page));
    }

    public PublicTask getPublicTask(String tenantId, String actorId,
            String sessionId, String taskId) {
        Viewed<TaskRow> viewed = task(tenantId, actorId, sessionId, taskId);
        return publicTask(tenantId, sessionId, viewed.value(),
                viewed.sessionActive());
    }

    public WebShellPage<WebShellTask> queryWebShellTasks(String tenantId,
            String actorId, String sessionId, String cursor, int limit) {
        Viewed<TaskPage> viewed = page(tenantId, actorId, sessionId, cursor,
                limit);
        TaskPage page = viewed.value();
        return new WebShellPage<>(page.tasks().stream()
                .map(task -> webShellTask(tenantId, sessionId, task,
                        viewed.sessionActive()))
                .toList(), nextCursor(page), page.hasMore());
    }

    public WebShellTask getWebShellTask(String tenantId, String actorId,
            String sessionId, String taskId) {
        Viewed<TaskRow> viewed = task(tenantId, actorId, sessionId, taskId);
        return webShellTask(tenantId, sessionId, viewed.value(),
                viewed.sessionActive());
    }

    public PublicList<PublicTaskEvent> listPublicTaskEvents(String tenantId,
            String actorId, String sessionId, String taskId, String after,
            int limit) {
        ResolvedPage page = eventPage(tenantId, actorId, sessionId, taskId,
                after, limit);
        return new PublicList<>("list", page.page().events().stream()
                .map(event -> publicEvent(sessionId, taskId, event)).toList(),
                page.page().hasMore(), page.nextCursor());
    }

    public WebShellPage<WebShellTaskEvent> queryWebShellTaskEvents(
            String tenantId, String actorId, String sessionId, String taskId,
            String after, int limit) {
        ResolvedPage page = eventPage(tenantId, actorId, sessionId, taskId,
                after, limit);
        return new WebShellPage<>(page.page().events().stream()
                .map(event -> webShellEvent(sessionId, taskId, event))
                .toList(), page.nextCursor(), page.page().hasMore());
    }

    /** A read result with whether its Session is active: a task's
     * {@code cancel} is an action only an active Session admits. */
    private record Viewed<T>(T value, boolean sessionActive) {
    }

    private Viewed<TaskPage> page(String tenantId, String actorId,
            String sessionId, String cursor, int limit) {
        boolean active = "ACTIVE".equals(sessions.requireReadableSession(
                tenantId, actorId, sessionId).status());
        return new Viewed<>(pageOf(tenantId, sessionId, cursor, limit),
                active);
    }

    private TaskPage pageOf(String tenantId, String sessionId, String cursor,
            int limit) {
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

    private Viewed<TaskRow> task(String tenantId, String actorId,
            String sessionId, String taskId) {
        boolean active = "ACTIVE".equals(sessions.requireReadableSession(
                tenantId, actorId, sessionId).status());
        return new Viewed<>(records.findTask(tenantId, sessionId, taskId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "task_not_found", "The task was not found.")),
                active);
    }

    /** A read page plus its required, never null next cursor. */
    private record ResolvedPage(EventPage page, String nextCursor) {
    }

    /**
     * The shared read of both event routes: an omitted {@code after} starts
     * at the durable retention floor; a cursor strictly below it is {@code
     * 409 cursor_expired}, even when nothing is retained. The page cursor
     * is its last event's cursor; on an empty page it is the requested
     * position, or the retention floor when {@code after} was omitted.
     */
    private ResolvedPage eventPage(String tenantId, String actorId,
            String sessionId, String taskId, String after, int limit) {
        task(tenantId, actorId, sessionId, taskId);
        if (limit < 1 || limit > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
        long position;
        if (after == null || after.isEmpty()) {
            position = events.positions(tenantId, sessionId, taskId)
                    .expiredThrough();
        } else {
            position = ManagedTaskEventStore.decodeCursor(taskId, after);
        }
        EventPage page = events.read(tenantId, sessionId, taskId, position,
                limit);
        // Events are read before the visible floor, and the floor is
        // monotonic: a floor not above the cursor after the read was not
        // above it during the read either, so an expiry that crossed the
        // cursor mid-read must surface as the contract's 409, not a page
        // that silently skips what the expiry then deleted. The omitted-
        // after branch never claims a position, so it re-reads the current
        // floor for its empty-page cursor rather than an older one.
        long floor = events.positions(tenantId, sessionId, taskId)
                .expiredThrough();
        if (after != null && !after.isEmpty() && position < floor) {
            throw new ApiException(HttpStatus.CONFLICT, "cursor_expired",
                    "The task event cursor is below the task's durable"
                            + " retention floor.");
        }
        String nextCursor;
        if (page.events().isEmpty()) {
            nextCursor = ManagedTaskEventStore.encodeCursor(taskId,
                    Math.max(position, floor));
        } else {
            TaskEvent last = page.events().get(page.events().size() - 1);
            nextCursor = ManagedTaskEventStore.encodeCursor(taskId,
                    last.sequence());
        }
        return new ResolvedPage(page, nextCursor);
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

    private PublicTask publicTask(String tenantId, String sessionId,
            TaskRow task, boolean sessionActive) {
        TaskProjection view = task.projection();
        CursorPositions positions = events.positions(tenantId, sessionId,
                task.taskId());
        return new PublicTask(task.taskId(), "agent.task", sessionId,
                task.kind(), view.state(), view.definitionRevision(),
                view.runtimeState(), view.createdAt(), view.startedAt(),
                view.settledAt(), outputCursor(task.taskId(), positions),
                positions.artifactRefs(),
                actions(task, view, sessionActive));
    }

    private WebShellTask webShellTask(String tenantId, String sessionId,
            TaskRow task, boolean sessionActive) {
        TaskProjection view = task.projection();
        CursorPositions positions = events.positions(tenantId, sessionId,
                task.taskId());
        return new WebShellTask(task.taskId(), sessionId, task.kind(),
                view.state(), view.definitionRevision(), view.runtimeState(),
                view.createdAt(), view.startedAt(), view.settledAt(),
                outputCursor(task.taskId(), positions),
                positions.artifactRefs(),
                actions(task, view, sessionActive));
    }

    /** The task's own actions, and none in a Session that is not active:
     * the cancel route would refuse a new request there. Contention with
     * another open operation is transient and stays the route's answer. */
    private static List<String> actions(TaskRow task, TaskProjection view,
            boolean sessionActive) {
        return sessionActive ? ManagedExtensionProjection.taskActions(
                task.kind(), view.state()) : List.of();
    }

    /** The committed tail at the view read; absent until the first event. */
    private static String outputCursor(String taskId,
            CursorPositions positions) {
        return positions.lastSequence() == 0 ? null
                : ManagedTaskEventStore.encodeCursor(taskId,
                        positions.lastSequence());
    }

    private static PublicTaskEvent publicEvent(String sessionId,
            String taskId, TaskEvent event) {
        return new PublicTaskEvent(event.schemaVersion(),
                event.projectionVersion(), taskId, sessionId, event.type(),
                ManagedTaskEventStore.encodeCursor(taskId, event.sequence()),
                event.occurredAt(), event.state(), event.runtimeState(),
                event.text(), event.truncated(), event.artifactId());
    }

    private static WebShellTaskEvent webShellEvent(String sessionId,
            String taskId, TaskEvent event) {
        return new WebShellTaskEvent(event.schemaVersion(),
                event.projectionVersion(), taskId, sessionId, event.type(),
                ManagedTaskEventStore.encodeCursor(taskId, event.sequence()),
                event.occurredAt(), event.state(), event.runtimeState(),
                event.text(), event.truncated(), event.artifactId());
    }
}
