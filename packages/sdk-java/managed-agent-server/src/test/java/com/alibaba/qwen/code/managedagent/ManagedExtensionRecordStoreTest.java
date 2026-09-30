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
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
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
import org.springframework.http.HttpStatus;
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
            // A command that opened a record opens no other, whatever the
            // operation that carries it.
            JsonNode reuse = reject.get("reuseCommandOf");
            String operation = reuse == null
                    ? ExtensionRecordJournal.OPERATION : "reopenMonitorRun";
            String commandId = reuse == null ? "rejected"
                    : "accepted-" + reuse.intValue();
            assertRefused(reject.required("id").textValue(), sessionId,
                    ManagedExtensionRecordStore.ERROR_REJECTED, null,
                    () -> journal.commit(journal.request(operation,
                            commandId, ExtensionRecordJournal.bytes(
                                    reject.required("next")), occurredAt,
                            event -> {
                            }, records -> records)));
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
        Map<String, Refusal> events = Map.ofEntries(
                Map.entry("another workspace", new Refusal(
                        "names another Session", event -> ((ObjectNode) event
                                .get("sessionKey")).put("workspaceId",
                                        "other"))),
                Map.entry("an extra Session key field", new Refusal(
                        "event.sessionKey must be an object with exactly",
                        event -> ((ObjectNode) event.get("sessionKey"))
                                .put("extra", true))),
                Map.entry("a schema version as text", new Refusal(
                        "recordRef.schemaVersion is out of range",
                        event -> ((ObjectNode) event.at(
                                "/payload/recordRef")).put("schemaVersion",
                                        "1"))),
                Map.entry("a record version 2", new Refusal(
                        "event.payload.version is out of range",
                        event -> ((ObjectNode) event.get("payload"))
                                .put("version", 2))),
                Map.entry("an event version 2", new Refusal(
                        "event.v is out of range", event -> event.put("v",
                                2))),
                Map.entry("an extra payload field", new Refusal(
                        "event.payload must be an object with exactly",
                        event -> ((ObjectNode) event.get("payload"))
                                .put("extra", true))),
                Map.entry("an event subject", new Refusal(
                        "event must be an object with exactly",
                        event -> event.putObject("subject")
                                .put("type", "turn").put("id", "turn-1"))),
                Map.entry("a sequence past its place", new Refusal(
                        "event.sequence is out of range",
                        event -> event.put("sequence", event.get("sequence")
                                .longValue() + 1))),
                Map.entry("a digest of another body", new Refusal(
                        "does not match its resource",
                        event -> ((ObjectNode) event.at(
                                "/payload/recordRef")).put("digest",
                                        ExtensionRecordJournal.sha256(
                                                "another body")))),
                Map.entry("a length of another body", new Refusal(
                        "does not match its resource",
                        event -> ((ObjectNode) event.at(
                                "/payload/recordRef")).put("byteLength",
                                        start.length + 1))),
                Map.entry("a time between two milliseconds", new Refusal(
                        "event.occurredAt is out of range",
                        event -> event.put("occurredAt", 1_000.5))),
                Map.entry("a time past the contract's range", new Refusal(
                        "event.occurredAt is out of range",
                        event -> event.put("occurredAt",
                                8_640_000_000_000_001L))),
                Map.entry("a reference of another domain", new Refusal(
                        "must reference managed-monitor_run version 1",
                        event -> ((ObjectNode) event.at(
                                "/payload/recordRef")).put("kind",
                                        "managed-hook_execution"))));
        for (Map.Entry<String, Refusal> edit : events.entrySet()) {
            refuse(edit.getKey(), edit.getValue().message(), start,
                    edit.getValue().editEvent(), records -> records);
        }
        refuse("a body with trailing content", "The Stage H record is not a"
                + " JSON object the Session authority can read", trailing,
                event -> {
                }, records -> records);
        refuse("no commit marker", "holds only its events, then its commit"
                + " marker", start, event -> {
                }, records -> records.substring(0, records.indexOf('\n')
                        + 1) + "{\"subtype\":\"managed_session_note\"}\n");
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        assertRefused("a line among the events that is not one", sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED,
                "holds only its events, then its commit marker",
                () -> journal.commit(journal.request(
                        ExtensionRecordJournal.OPERATION, "refused", start,
                        1_000, event -> {
                        }, records -> records.replaceFirst("\n",
                                "\n{\"subtype\":\"managed_session_note\"}\n"),
                        1)));
    }

    @Test
    void refusesRecordLinesTheAuthorityCouldNotParse() throws Exception {
        byte[] start = ExtensionRecordJournal.bytes(
                chain().get(0).required("monitorRun"));
        Map<String, UnaryOperator<String>> lines = Map.of(
                "trailing content", records -> records.replaceFirst("\n",
                        " xyz\n"),
                "a duplicate key", records -> records.replaceFirst("\\{",
                        "{\"type\":\"system\","),
                "nesting deeper than the authority reads", records -> records
                        .replaceFirst("\\{", "{\"deep\":" + nested(64) + ","),
                "a number past the double range", records -> records
                        .replaceFirst("\\{", "{\"huge\":1e400,"));
        for (Map.Entry<String, UnaryOperator<String>> edit
                : lines.entrySet()) {
            String sessionId = UUID.randomUUID().toString();
            ExtensionRecordJournal journal = journal(sessionId);
            assertRefused(edit.getKey(), sessionId,
                    ManagedSessionStoreModels.ERROR_INVALID_REQUEST,
                    "Record line 1 is not a JSON object the Session authority"
                            + " can read",
                    () -> journal.commit(journal.request(
                            ExtensionRecordJournal.OPERATION, "refused",
                            start, 1_000, event -> {
                            }, edit.getValue())));
        }
        // The deepest line the authority reads is still accepted, on a line
        // the Stage H rules do not otherwise look at.
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        journal.commit(journal.request(ExtensionRecordJournal.OPERATION,
                "deepest", start, 1_000, event -> {
                }, records -> records.replaceFirst(
                        "\\{\"uuid\"(?=[^\n]*managed_session_commit_v1)",
                        "{\"deep\":" + nested(63) + ",\"uuid\"")));
        assertThat(revisions(sessionId)).isEqualTo(1);
    }

    /** A value holding {@code depth} nested arrays. */
    private static String nested(int depth) {
        return "[".repeat(depth) + "]".repeat(depth);
    }

    @Test
    void refusesAStageHRecordInTheGenesis() throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = new ExtensionRecordJournal(
                sessionStore, TENANT, WORKSPACE, sessionId).acquire();
        CommitTransactionRequest revision = journal.request("genesis",
                chain().get(0).required("monitorRun"), 1_000);
        String event = new String(Base64.getDecoder().decode(
                revision.recordBytesBase64()), StandardCharsets.UTF_8)
                .split("\n")[0];
        assertRefused("a genesis with a Stage H record", sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED,
                "is not one of the transaction's events",
                () -> journal.commit(journal.genesis(event
                        + "\n{\"subtype\":\"managed_session_header_v1\"}\n",
                        revision.resources())));
    }

    private record Refusal(String message, Consumer<ObjectNode> editEvent) {
    }

    private void refuse(String label, String message, byte[] body,
            Consumer<ObjectNode> editEvent,
            UnaryOperator<String> editRecords) {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        assertRefused(label, sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED, message,
                () -> journal.commit(journal.request(
                        ExtensionRecordJournal.OPERATION, "refused", body,
                        1_000, editEvent, editRecords)));
    }

    /**
     * A refused commit leaves no journal row, no resource reference and no
     * revision behind, which it would if the store did not roll back. A
     * {@code message} names the rule that refused it.
     */
    private void assertRefused(String label, String sessionId, String code,
            String message, ThrowingCallable commit) {
        long transactions = rows("qwen_managed_session_journal_tx", sessionId);
        long references = rows("qwen_managed_session_resource_ref",
                sessionId);
        long revisions = revisions(sessionId);
        assertThatThrownBy(commit).as(label)
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode()).as(label).isEqualTo(code);
                    // A line the authority cannot read is a bad request; a
                    // Stage H rule that refuses a revision is a conflict.
                    assertThat(error.getStatus()).as(label).isEqualTo(
                            ManagedSessionStoreModels.ERROR_INVALID_REQUEST
                                    .equals(code) ? HttpStatus.BAD_REQUEST
                                    : HttpStatus.CONFLICT);
                    if (message != null) {
                        assertThat(error.getMessage()).as(label)
                                .contains(message);
                    }
                });
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
    void announcesNothingOnceThePublicSessionIsBeingDeleted()
            throws Exception {
        String sessionId = agents.createSession(TENANT, "deleted-"
                + UUID.randomUUID(), "qwen-code", null, "tasks", Map.of(),
                List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        List<JsonNode> chain = chain();
        journal.commitMonitor("deleted-0", chain.get(0).required(
                "monitorRun"), chain.get(0).required("occurredAt")
                        .longValue());
        // The delete stays pending while this journal's writer holds the
        // Session, so the Session is being deleted when the revision lands.
        state.beginOperation(TENANT, sessionId, OperationKind.DELETE,
                "sha256:" + "d".repeat(64), "delete", "digest-delete");
        // The next revision changes the view, which a live Session would
        // hear about.
        assertThat(ManagedExtensionProjectionContractTest.view(chain.get(1)
                .required("view"))).isNotEqualTo(
                        ManagedExtensionProjectionContractTest.view(chain
                                .get(0).required("view")));
        journal.commitMonitor("deleted-1", chain.get(1).required(
                "monitorRun"), chain.get(1).required("occurredAt")
                        .longValue());
        List<EventRecord> events = state.findEvents(TENANT, sessionId, 0,
                100);
        assertThat(events).extracting(EventRecord::type)
                .containsOnlyOnce("task.updated")
                .endsWith("session.delete.requested");
        assertThat(revisions(sessionId)).isEqualTo(2);
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
        // A page of two ends inside the tie, so its cursor must name the
        // last row it returned.
        List<String> first = null;
        for (int limit : new int[] {1, 2, 3}) {
            List<String> seen = new ArrayList<>();
            String cursor = null;
            do {
                PublicList<PublicTask> page = tasks.listPublicTasks(TENANT,
                        null, sessionId, cursor, limit);
                page.data().forEach(task -> seen.add(task.createdAt() + " "
                        + task.id()));
                assertThat(page.hasMore()).as("limit %d", limit)
                        .isEqualTo(seen.size() < 3);
                cursor = page.nextCursor();
            } while (cursor != null);
            assertThat(seen).as("limit %d", limit).hasSize(3)
                    .doesNotHaveDuplicates()
                    .isSortedAccordingTo((left, right) -> right.compareTo(
                            left));
            if (first == null) {
                first = seen;
            } else {
                assertThat(seen).as("limit %d", limit).isEqualTo(first);
            }
        }
        assertThat(tasks.getPublicTask(TENANT, null, sessionId,
                first.get(0).substring(5)).kind()).isEqualTo("monitor");
        assertThatThrownBy(() -> tasks.listPublicTasks(TENANT, null,
                sessionId, "not-a-cursor", 1))
                .hasFieldOrPropertyWithValue("code", "invalid_cursor");
        for (int limit : new int[] {0, 101}) {
            assertThatThrownBy(() -> tasks.listPublicTasks(TENANT, null,
                    sessionId, null, limit))
                    .hasFieldOrPropertyWithValue("code", "invalid_limit");
        }
        assertThatThrownBy(() -> tasks.getPublicTask(TENANT, null, sessionId,
                "task_" + "0".repeat(64)))
                .hasFieldOrPropertyWithValue("code", "task_not_found");
    }

    @Test
    void materializesMcpWithoutTasksAndRequiresItsResourceClosure() throws Exception {
        String sessionId = agents.createSession(TENANT, "mcp-" + UUID.randomUUID(),
                "qwen-code", null, "mcp", Map.of(), List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode fixtures = ManagedMcpRecordContractTest.fixtures();
        JsonNode configuration = fixtures.get("templates").get("mcp_configuration");
        commitMcp(journal, "configure-1", "mcp_configuration", configuration, List.of());
        JsonNode dispatched = ManagedMcpRecordContractTest.merge(configuration,
                fixtures.get("successors").get(0).get("after"));
        commitMcp(journal, "configure-dispatch", "mcp_configuration", dispatched, List.of());
        ObjectNode configured = (ObjectNode) ManagedMcpRecordContractTest.merge(configuration,
                fixtures.get("cases").get(3).get("patch"));
        CommitResource data = new CommitResource("mcp-data", "mcp-data", 1,
                2, ExtensionRecordJournal.sha256("{}"), "e30=");
        ObjectNode ref = configured.withObject("/catalogRef");
        ref.put("resourceId", data.resourceId()).put("kind", data.kind())
                .put("digest", data.digest());
        CommitTransactionRequest missing = journal.requestDomain("configure-result",
                "mcp_configuration", configured, List.of(), 1000);
        assertThatThrownBy(() -> journal.commit(missing)).isInstanceOf(ApiException.class);
        assertThat(revisions(sessionId)).isEqualTo(2);
        commitMcp(journal, "configure-result", "mcp_configuration", configured, List.of(data));
        assertThat(records.listRecords(TENANT, sessionId, "mcp_configuration"))
                .containsExactly(configured);
        assertThat(records.readRecordResource(TENANT, sessionId, ref).isEmpty()).isTrue();
        assertThat(records.listRecords("other-tenant", sessionId, "mcp_configuration")).isEmpty();
        assertThatThrownBy(() -> records.readRecordResource("other-tenant", sessionId, ref))
                .isInstanceOf(ApiException.class);
        ObjectNode conflictingPin = configuration.deepCopy();
        conflictingPin.put("configurationId", "configure-2");
        conflictingPin.withObject("/run").put("effectId", "configure-2");
        conflictingPin.withObject("/run/definition").put("definitionDigest", "c".repeat(64));
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("configure-2",
                "mcp_configuration", conflictingPin, List.of(), 1000)))
                .hasMessageContaining("two definition digests");
        ObjectNode operation = fixtures.get("templates").get("mcp_operation").deepCopy();
        operation.set("argsRef", ref);
        ObjectNode wrong = operation.deepCopy();
        wrong.put("catalogRevision", 2);
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("wrong-binding",
                "mcp_operation", wrong, List.of(), 1000))).hasMessageContaining("active committed configuration");
        commitMcp(journal, "operation-1", "mcp_operation", operation, List.of());
        assertThat(records.listTasks(TENANT, sessionId, null, null, 10).tasks()).isEmpty();
        String fakeTask = ManagedExtensionProjection.taskId(ManagedExtensionProjection.recordKey(
                sessionId, "mcp_operation", "operation-1"));
        assertThat(records.findTask(TENANT, sessionId, fakeTask)).isEmpty();
        assertThat(state.findEvents(TENANT, sessionId, 0, 100)).extracting(EventRecord::type)
                .doesNotContain("task.updated");
        assertThat(new ManagedExtensionRecordStore(jdbc, state)
                .listRecords(TENANT, sessionId, "mcp_operation")).containsExactly(operation);
    }

    private static void commitMcp(ExtensionRecordJournal journal, String commandId,
            String domain, JsonNode record, List<CommitResource> resources) {
        CommitTransactionRequest request = journal.requestDomain(commandId, domain, record, resources, 1000);
        journal.commit(request);
        journal.committed(request);
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
