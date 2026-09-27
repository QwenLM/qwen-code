package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTask;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.ManagedTaskService;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.UnaryOperator;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-extension-records;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedExtensionRecordStoreTest {
    private static final String TENANT = "tenant-extension";
    private static final String WORKSPACE = "workspace-extension";

    @Autowired
    private ManagedSessionStore sessionStore;

    @Autowired
    private ManagedExtensionRecordStore records;

    @Autowired
    private ManagedAgentService agents;

    @Autowired
    private ManagedTaskService tasks;

    @Autowired
    private AgentStateStore state;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void commitsAndProjectsTheSharedMonitorChains() throws Exception {
        for (JsonNode chain : fixtures().required("monitorChainCases")) {
            String sessionId = UUID.randomUUID().toString();
            ExtensionRecordJournal journal = journal(sessionId);
            int index = 0;
            String taskId = null;
            for (JsonNode revision : chain.required("revisions")) {
                JsonNode monitor = revision.required("monitorRun");
                journal.commitMonitor("chain-" + index++, monitor,
                        revision.required("occurredAt").longValue());
                taskId = ManagedExtensionProjection.taskId(
                        ManagedExtensionProjection.recordKey(sessionId,
                                "monitor_run", monitor.required("monitorId")
                                        .textValue()));
                assertThat(records.findTask(TENANT, sessionId, taskId)
                        .orElseThrow().projection())
                        .as("%s revision %d", chain.required("id")
                                .textValue(), index)
                        .isEqualTo(ManagedExtensionProjectionContractTest
                                .view(revision.required("view")));
            }
            // The list lives in SQL: another store instance reads it alike.
            assertThat(new ManagedExtensionRecordStore(jdbc, state)
                    .listTasks(TENANT, sessionId, null, null, 10).tasks())
                    .extracting(ManagedExtensionRecordStore.TaskRow::taskId)
                    .containsExactly(taskId);
        }
    }

    @Test
    void refusesTheSharedRejectedChains() throws Exception {
        for (JsonNode reject : fixtures().required("monitorChainRejectCases")) {
            String sessionId = UUID.randomUUID().toString();
            ExtensionRecordJournal journal = journal(sessionId);
            int index = 0;
            for (JsonNode monitor : reject.required("accepted")) {
                journal.commitMonitor("accepted-" + index, monitor,
                        1_000L * ++index);
            }
            long occurredAt = 1_000L * (index + 1);
            assertRefused(reject.required("id").textValue(), sessionId,
                    () -> journal.commitMonitor("rejected",
                            reject.required("next"), occurredAt));
        }
    }

    @Test
    void appliesAReplayedCommitOnce() throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode start = chain().get(0).required("monitorRun");
        CommitTransactionRequest request = journal.request("start", start,
                1_000);
        assertThat(journal.commit(request).replayed()).isFalse();
        journal.committed(request);
        assertThat(journal.commit(request).replayed()).isTrue();
        assertThat(revisions(sessionId)).isEqualTo(1);
    }

    @Test
    void refusesWhatTheAuthorityCouldNotReadBack() throws Exception {
        byte[] start = ExtensionRecordJournal.bytes(
                chain().get(0).required("monitorRun"));
        byte[] trailing = (new String(start, StandardCharsets.UTF_8)
                + " {}").getBytes(StandardCharsets.UTF_8);
        Map<String, Consumer<ObjectNode>> events = Map.of(
                "another workspace", event -> ((ObjectNode) event
                        .get("sessionKey")).put("workspaceId", "other"),
                "an extra Session key field", event -> ((ObjectNode) event
                        .get("sessionKey")).put("extra", true),
                "a schema version as text", event -> ((ObjectNode) event
                        .at("/payload/recordRef")).put("schemaVersion", "1"),
                "a record version 2", event -> ((ObjectNode) event
                        .get("payload")).put("version", 2),
                "an event version 2", event -> event.put("v", 2),
                "an extra payload field", event -> ((ObjectNode) event
                        .get("payload")).put("extra", true));
        for (Map.Entry<String, Consumer<ObjectNode>> edit
                : events.entrySet()) {
            refuse(edit.getKey(), start, edit.getValue(), records -> records);
        }
        refuse("a body with trailing content", trailing, event -> {
        }, records -> records);
        refuse("an event line with trailing content", start, event -> {
        }, records -> records.replaceFirst("\n", " xyz\n"));
    }

    private void refuse(String label, byte[] body,
            Consumer<ObjectNode> editEvent,
            UnaryOperator<String> editRecords) {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        assertRefused(label, sessionId, () -> journal.commit(journal.request(
                "refused", body, 1_000, editEvent, editRecords)));
    }

    /**
     * A refused commit leaves no journal row, no resource reference and no
     * revision behind, which it would if the store did not roll back.
     */
    private void assertRefused(String label, String sessionId,
            ThrowingCallable commit) {
        long transactions = rows("qwen_managed_session_journal_tx", sessionId);
        long references = rows("qwen_managed_session_resource_ref",
                sessionId);
        long revisions = revisions(sessionId);
        assertThatThrownBy(commit).as(label)
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).as(label).isEqualTo(
                                ManagedExtensionRecordStore.ERROR_REJECTED));
        assertThat(rows("qwen_managed_session_journal_tx", sessionId))
                .as(label).isEqualTo(transactions);
        assertThat(rows("qwen_managed_session_resource_ref", sessionId))
                .as(label).isEqualTo(references);
        assertThat(revisions(sessionId)).as(label).isEqualTo(revisions);
    }

    @Test
    void announcesEachChangedViewOnThePublicSession() throws Exception {
        String sessionId = agents.createSession(TENANT, "announce-"
                + UUID.randomUUID(), "qwen-code", null, "tasks", Map.of(),
                List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        List<String> expected = new ArrayList<>();
        TaskProjection previous = null;
        int index = 0;
        for (JsonNode revision : chain()) {
            journal.commitMonitor("announce-" + index++,
                    revision.required("monitorRun"),
                    revision.required("occurredAt").longValue());
            TaskProjection view = ManagedExtensionProjectionContractTest.view(
                    revision.required("view"));
            if (!Objects.equals(previous, view)) {
                expected.add(view.state());
            }
            previous = view;
        }
        List<EventRecord> announced = state.findEvents(TENANT, sessionId, 0,
                100).stream()
                .filter(event -> "task.updated".equals(event.type()))
                .toList();
        String taskId = ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(sessionId,
                        "monitor_run", "monitor-1"));
        assertThat(announced).extracting(event -> event.data().get("state"))
                .containsExactlyElementsOf(expected);
        assertThat(announced).allSatisfy(event ->
                assertThat(event.data().get("taskId")).isEqualTo(taskId));
        assertThat(expected.size()).isLessThan(chain().size());
    }

    @Test
    void pagesTasksNewestFirstThenByTaskId() throws Exception {
        String sessionId = agents.createSession(TENANT, "pages-"
                + UUID.randomUUID(), "qwen-code", null, "tasks", Map.of(),
                List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode start = chain().get(0).required("monitorRun");
        long[] createdAt = {1_000, 2_000, 2_000};
        for (int index = 0; index < createdAt.length; index++) {
            journal.commitMonitor("monitor-" + index, ((ObjectNode) start
                    .deepCopy()).put("monitorId", "monitor-" + index),
                    createdAt[index]);
        }
        List<String> seen = new ArrayList<>();
        String cursor = null;
        do {
            PublicList<PublicTask> page = tasks.listPublicTasks(TENANT, null,
                    sessionId, cursor, 1);
            page.data().forEach(task -> seen.add(task.createdAt() + " "
                    + task.id()));
            assertThat(page.hasMore()).isEqualTo(seen.size() < 3);
            cursor = page.nextCursor();
        } while (cursor != null);
        assertThat(seen).hasSize(3)
                .isSortedAccordingTo((left, right) -> right.compareTo(left));
        assertThat(tasks.getPublicTask(TENANT, null, sessionId,
                seen.get(0).substring(5)).kind()).isEqualTo("monitor");
        assertThatThrownBy(() -> tasks.listPublicTasks(TENANT, null,
                sessionId, "not-a-cursor", 1))
                .hasFieldOrPropertyWithValue("code", "invalid_cursor");
        assertThatThrownBy(() -> tasks.getPublicTask(TENANT, null, sessionId,
                "task_" + "0".repeat(64)))
                .hasFieldOrPropertyWithValue("code", "task_not_found");
    }

    private ExtensionRecordJournal journal(String sessionId) {
        return new ExtensionRecordJournal(sessionStore, TENANT, WORKSPACE,
                sessionId).open();
    }

    private long revisions(String sessionId) {
        Long total = jdbc.queryForObject("SELECT COALESCE(SUM(revision), 0)"
                        + " FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Long.class, TENANT, sessionId);
        return total == null ? 0 : total;
    }

    private long rows(String table, String sessionId) {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM " + table
                        + " WHERE tenant_id = ? AND session_id = ?",
                Long.class, TENANT, sessionId);
        return count == null ? 0 : count;
    }

    private static List<JsonNode> chain() throws Exception {
        List<JsonNode> revisions = new ArrayList<>();
        fixtures().required("monitorChainCases").get(0).required("revisions")
                .forEach(revisions::add);
        return revisions;
    }

    private static JsonNode fixtures() throws Exception {
        return ManagedExtensionProjectionContractTest.fixtures();
    }
}
