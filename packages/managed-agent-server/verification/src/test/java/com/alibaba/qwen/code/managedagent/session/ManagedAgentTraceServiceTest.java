package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionAdmissionStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskPage;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskRow;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskTarget;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ManagedAgentTraceServiceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
    private final SessionAdmissionStore lineage = mock(SessionAdmissionStore.class);
    private final ManagedAgentTraceService service = new ManagedAgentTraceService(sessions, records, lineage, JSON);

    @Test
    void returnsOnlyDirectInvocationsAndBindsTheKeysetCursorToTheReaderAndSession() {
        TaskRow first = task("b", 20);
        TaskRow second = task("a", 20);
        when(records.listChildTasks("tenant", "parent", null, null, 1)).thenReturn(new TaskPage(List.of(first), true));
        when(records.listChildTasks("tenant", "parent", 20L, first.taskId(), 1)).thenReturn(new TaskPage(List.of(second), false));
        when(records.diagnosticReadRevision("tenant", "parent")).thenReturn("9007199254740999");
        target(first, null);
        target(second, null);
        var page = service.list("tenant", "actor", "parent", null, 1);
        assertThat(page.path("scope").asText()).isEqualTo("direct-invocations");
        assertThat(page.path("readRevision").asText()).isEqualTo("9007199254740999");
        assertThat(page.path("items")).hasSize(1);
        assertThat(page.at("/items/0/taskId").asText()).isEqualTo(first.taskId());
        assertThat(page.at("/items/0/childSessionId").isNull()).isTrue();
        assertThat(page.path("hasMore").asBoolean()).isTrue();
        String cursor = page.path("nextCursor").asText();
        var last = service.list("tenant", "actor", "parent", cursor, 1);
        assertThat(last.at("/items/0/taskId").asText()).isEqualTo(second.taskId());
        assertThat(last.path("nextCursor").isNull()).isTrue();
        assertThat(last.path("hasMore").asBoolean()).isFalse();
        assertThatThrownBy(() -> service.list("tenant", "other", "parent", cursor, 1))
                .hasFieldOrPropertyWithValue("code", "invalid_cursor");
        assertThatThrownBy(() -> service.list("tenant", "actor", "other", cursor, 1))
                .hasFieldOrPropertyWithValue("code", "invalid_cursor");
        verifyNoInteractions(lineage);
    }

    @Test
    void exposesAChildOnlyAfterItsOwnAuthorizationAndPersistedRelationshipMatch() {
        TaskRow task = task("c", 10);
        when(records.listChildTasks("tenant", "parent", null, null, 20)).thenReturn(new TaskPage(List.of(task), false));
        target(task, "child");
        when(lineage.findChildLineage("tenant", "child")).thenReturn(new SessionLineage("parent", "parent", "run", 1));
        var allowed = service.list("tenant", "actor", "parent", null, 20);
        assertThat(allowed.at("/items/0/childSessionId").asText()).isEqualTo("child");
        verify(sessions).requireReadableSession("tenant", "actor", "child");
        when(lineage.findChildLineage("tenant", "child")).thenReturn(new SessionLineage("other", "other", "run", 1));
        var unrelated = service.list("tenant", "actor", "parent", null, 20);
        assertThat(unrelated.at("/items/0/childSessionId").isNull()).isTrue();
        assertThat(unrelated.path("availability").asText()).isEqualTo("partial");
        when(sessions.requireReadableSession("tenant", "actor", "child"))
                .thenThrow(new ManagedAgentException(404, "session_not_found", "Not found"));
        var denied = service.list("tenant", "actor", "parent", null, 20);
        assertThat(denied.at("/items/0/childSessionId").isNull()).isTrue();
        assertThat(denied.at("/items/0/state").asText()).isEqualTo("running");
        assertThat(denied.path("coverageReasons").toString()).contains("child_unavailable");
    }

    @Test
    void copiesOnlyTheBoundedDescriptionAndKeepsMissingChildRecordsVisible() {
        TaskRow task = task("d", 1);
        ObjectNode body = target(task, null);
        body.putObject("inputRef").put("byteLength", 50);
        when(records.readRecordResource(eq("tenant"), eq("parent"), any()))
                .thenReturn(JSON.createObjectNode().put("description", "Inspect the build").put("prompt", "secret prompt"));
        when(records.listChildTasks("tenant", "parent", null, null, 5)).thenReturn(new TaskPage(List.of(task), false));
        var result = service.list("tenant", "actor", "parent", null, 5);
        assertThat(result.at("/items/0/description").asText()).isEqualTo("Inspect the build");
        assertThat(result.toString()).doesNotContain("secret prompt", "inputRef");
        when(records.findTaskTarget("tenant", "parent", task.taskId())).thenReturn(Optional.empty());
        var missing = service.list("tenant", "actor", "parent", null, 5);
        assertThat(missing.path("items")).hasSize(1);
        assertThat(missing.at("/items/0/description").isNull()).isTrue();
        assertThat(missing.path("availability").asText()).isEqualTo("partial");
        when(records.findTaskTarget("tenant", "parent", task.taskId()))
                .thenThrow(new ManagedAgentException(409, "resource_unavailable", "Unavailable"));
        var unavailable = service.list("tenant", "actor", "parent", null, 5);
        assertThat(unavailable.path("items")).hasSize(1);
        assertThat(unavailable.path("coverageReasons").toString()).contains("invocation_unavailable");
    }

    @Test
    void authorizesTheParentBeforeAnyRepositoryReadAndRejectsInvalidBounds() {
        when(sessions.requireReadableSession("tenant", "actor", "parent"))
                .thenThrow(new ManagedAgentException(404, "session_not_found", "Not found"));
        assertThatThrownBy(() -> service.list("tenant", "actor", "parent", null, 20))
                .hasFieldOrPropertyWithValue("code", "session_not_found");
        verifyNoInteractions(records, lineage);
        for (int limit : new int[] {0, 101}) {
            assertThatThrownBy(() -> service.list("tenant", "actor", "other", null, limit))
                    .hasFieldOrPropertyWithValue("code", "invalid_limit");
        }
        assertThatThrownBy(() -> service.list("tenant", "actor", "other", "not-a-cursor", 20))
                .hasFieldOrPropertyWithValue("code", "invalid_cursor");
        verifyNoInteractions(records, lineage);
    }

    private ObjectNode target(TaskRow task, String child) {
        ObjectNode body = JSON.createObjectNode().put("childSessionId", child).put("depth", 1);
        when(records.findTaskTarget("tenant", "parent", task.taskId()))
                .thenReturn(Optional.of(new TaskTarget("child_run", "run", "child_agent", "running", 1, body)));
        return body;
    }

    private static TaskRow task(String digit, long time) {
        return new TaskRow("task_" + digit.repeat(64), "child_agent", new TaskProjection("running", "running_attached", null, time, time, null), "private-resource");
    }
}
