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
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
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
    void keepsCommittingRecordsWhenTheTaskJournalRefusesPastItsBound()
            throws Exception {
        JsonNode chain = fixtures().required("monitorChainCases").get(0);
        JsonNode first = chain.required("revisions").get(0);
        JsonNode second = chain.required("revisions").get(1);
        // The witness only bites if the second revision actually changes the
        // task view, because only a view change appends a journal event.
        assertThat(ManagedExtensionProjectionContractTest
                .view(second.required("view")))
                .isNotEqualTo(ManagedExtensionProjectionContractTest
                        .view(first.required("view")));
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode monitor = first.required("monitorRun");
        journal.commitMonitor("wedge-0", monitor,
                first.required("occurredAt").longValue());
        String taskId = ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(sessionId, "monitor_run",
                        monitor.required("monitorId").textValue()));

        // One unarchived output pins the retention floor, so the automatic
        // pass cannot expire anything and the bound starts refusing. The
        // output admission gate reads the durable Session row, so bind this
        // Session to its workspace first.
        if (jdbc.update("UPDATE managed_agent_session SET workspace_id = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                WORKSPACE, TENANT, sessionId) == 0) {
            jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                            + " session_id, agent_id, status, created_at,"
                            + " updated_at, workspace_id,"
                            + " workspace_generation, workspace_storage_id,"
                            + " cwd_relative, context_config_ref,"
                            + " context_revision, workspace_config_ref,"
                            + " workspace_policy_ref) VALUES"
                            + " (?, ?, 'qwen-code', 'ACTIVE', 1, 1,"
                            + " ?, 1, 'storage-1', '.', ?, 1,"
                            + " 'config', 'policy')",
                    TENANT, sessionId, WORKSPACE,
                    "sha256:" + ExtensionRecordJournal.sha256(
                            "config\u0000policy"));
        }
        ManagedTaskEventStore events = new ManagedTaskEventStore(jdbc);
        events.appendOutput(TENANT, sessionId, taskId, "x", false, null,
                null, null, null, 0);
        for (int round = 0; round < ManagedTaskEventStore.BACKLOG_BOUND - 1;
                round++) {
            events.appendStateChange(TENANT, sessionId, taskId, "running",
                    "ready", round);
        }
        assertThatThrownBy(() -> events.appendStateChange(TENANT, sessionId,
                taskId, "running", "ready", 0))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_BACKLOG_FULL));

        // The record row is the authoritative state; a full derived feed
        // degrades the feed and never wedges the commit that feeds it.
        journal.commitMonitor("wedge-1", second.required("monitorRun"),
                second.required("occurredAt").longValue());
        assertThat(records.findTask(TENANT, sessionId, taskId).orElseThrow()
                .projection())
                .isEqualTo(ManagedExtensionProjectionContractTest
                        .view(second.required("view")));
    }

    @Test
    void answersCursorExpiredRatherThanAGappedPageWhenTheFloorMoved()
            throws Exception {
        JsonNode chain = fixtures().required("monitorChainCases").get(0);
        JsonNode first = chain.required("revisions").get(0);
        String sessionId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                TENANT, sessionId);
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode monitor = first.required("monitorRun");
        journal.commitMonitor("race-0", monitor,
                first.required("occurredAt").longValue());
        String taskId = ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(sessionId, "monitor_run",
                        monitor.required("monitorId").textValue()));
        // The floor stands at 2 when the read begins and at 7 once the
        // events have loaded: an expiry that deleted everything through 7
        // happened mid-read, so the contract's 409 must stand where a
        // gapped page previously was — the marker flips at the read itself
        // because that is what concurrent expiry means here.
        final java.util.concurrent.atomic.AtomicBoolean readHappened =
                new java.util.concurrent.atomic.AtomicBoolean();
        ManagedTaskEventStore racing = new ManagedTaskEventStore(jdbc) {
            @Override
            public CursorPositions positions(String tenantId,
                    String session, String task) {
                return new CursorPositions(9, readHappened.get() ? 7 : 2,
                        List.of());
            }

            @Override
            public EventPage read(String tenantId, String session,
                    String task, long afterSequence, int limit) {
                readHappened.set(true);
                return new EventPage(List.of(), false);
            }
        };
        ManagedTaskService service = new ManagedTaskService(agents, records,
                racing);
        String cursor = ManagedTaskEventStore.encodeCursor(taskId, 2);
        assertThatThrownBy(() -> service.queryWebShellTaskEvents(TENANT,
                TENANT, sessionId, taskId, cursor, 10))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("cursor_expired");
                });
    }

    @Test
    void pagesFreshEventsAgainstTheRealJournal() throws Exception {
        JsonNode chain = fixtures().required("monitorChainCases").get(0);
        JsonNode first = chain.required("revisions").get(0);
        String sessionId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                TENANT, sessionId);
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode monitor = first.required("monitorRun");
        journal.commitMonitor("fresh-0", monitor,
                first.required("occurredAt").longValue());
        String taskId = ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(sessionId, "monitor_run",
                        monitor.required("monitorId").textValue()));
        var page = tasks.queryWebShellTaskEvents(TENANT, TENANT, sessionId,
                taskId, null, 10);
        assertThat(page.data()).hasSize(1);
        assertThat(page.nextCursor()).isEqualTo(
                ManagedTaskEventStore.encodeCursor(taskId, 1));
        // An as-of-now explicit cursor still admits: the floor did not move
        // past it while the read was happening.
        assertThat(tasks.queryWebShellTaskEvents(TENANT, TENANT, sessionId,
                taskId, page.nextCursor(), 10).data()).isEmpty();
    }

    @Test
    void commitsAndProjectsAChildRunChain() throws Exception {
        byte[] args = "{\"command\":\"yes\"}"
                .getBytes(StandardCharsets.UTF_8);
        CommitResource argsResource = new CommitResource(
                ExtensionRecordJournal.resourceId(args), "managed-tool-args",
                1, args.length, ExtensionRecordJournal.sha256(args),
                Base64.getEncoder().encodeToString(args));
        byte[] receipt = "{}".getBytes(StandardCharsets.UTF_8);
        CommitResource receiptResource = new CommitResource(
                ExtensionRecordJournal.resourceId(receipt),
                "managed-runtime-receipt", 1, receipt.length,
                ExtensionRecordJournal.sha256(receipt),
                Base64.getEncoder().encodeToString(receipt));
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        ObjectNode rev1 = childRun("admitted", "intent", null, argsResource);
        var tx1 = journal.requestDomain("child-1", "child_run", rev1,
                List.of(argsResource), 1_000);
        journal.commit(tx1);
        journal.committed(tx1);
        ObjectNode rev2 = childRun("running", "dispatch_started", "binding-1", argsResource);
        var tx2 = journal.requestDomain("child-2", "child_run", rev2,
                List.of(), 2_000);
        journal.commit(tx2);
        journal.committed(tx2);
        ObjectNode rev3 = childRun("waiting", "running_attached", "binding-1", argsResource);
        rev3.set("startReceiptRef", hookRef(receiptResource));
        var tx3 = journal.requestDomain("child-3", "child_run", rev3,
                List.of(receiptResource), 3_000);
        journal.commit(tx3);
        journal.committed(tx3);
        String taskId = ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(sessionId, "child_run",
                        "shell-x"));
        ManagedExtensionRecordStore.TaskRow row = records
                .findTask(TENANT, sessionId, taskId).orElseThrow();
        assertThat(row.kind()).isEqualTo("background_shell");
        assertThat(row.projection().state()).isEqualTo("waiting");
        assertThat(row.projection().runtimeState()).isEqualTo("ready");
        assertThat(row.projection().startedAt()).isEqualTo(2_000L);
        assertThat(row.projection().settledAt()).isNull();
        // A revision naming a resource outside the transaction's closure is
        // refused, and nothing of it persists.
        String other = UUID.randomUUID().toString();
        ExtensionRecordJournal broken = journal(other);
        var bx1 = broken.requestDomain("broken-1", "child_run",
                childRun("admitted", "intent", null, argsResource),
                List.of(argsResource), 1_000);
        broken.commit(bx1);
        broken.committed(bx1);
        var bx2 = broken.requestDomain("broken-2", "child_run",
                childRun("running", "dispatch_started", "binding-1", argsResource),
                List.of(), 2_000);
        broken.commit(bx2);
        broken.committed(bx2);
        ObjectNode badAttach = childRun("waiting", "running_attached",
                "binding-1", argsResource);
        badAttach.set("startReceiptRef", hookRef(receiptResource));
        assertRefused("child_run names a resource the closure lacks", other,
                ManagedSessionStoreModels.ERROR_RESOURCE_MISSING, null,
                () -> broken.commit(broken.requestDomain("broken-3",
                        "child_run", badAttach, List.of(), 3_000)));
        assertThat(records.listTasks(TENANT, other, null, null, 10).tasks())
                .extracting(ManagedExtensionRecordStore.TaskRow::taskId)
                .containsExactly(ManagedExtensionProjection.taskId(
                        ManagedExtensionProjection.recordKey(other,
                                "child_run", "shell-x")));
    }

    private static ObjectNode childRun(String state, String execution,
            String runtimeBinding, CommitResource argsResource) {
        ObjectNode body = JsonNodeFactory.instance.objectNode();
        body.put("kind", "shell");
        body.put("shellId", "shell-x");
        body.put("ownerScopeId", "scope-x");
        body.set("commandRef", hookRef(argsResource));
        body.putNull("startReceiptRef");
        body.putNull("outputRef");
        body.putNull("stopReason");
        body.put("stopRequested", false);
        body.putNull("exitCode");
        body.putNull("exitSignal");
        ObjectNode run = JsonNodeFactory.instance.objectNode();
        run.put("state", state);
        run.putNull("reason");
        run.putNull("definition");
        run.put("executionCallId", "call-x");
        run.putNull("effectId");
        run.putNull("dispatchId");
        run.putNull("deliveryId");
        run.put("execution", execution);
        if (runtimeBinding != null) {
            ObjectNode runtime = JsonNodeFactory.instance.objectNode();
            runtime.put("runtimeBindingId", runtimeBinding);
            runtime.put("generation", "1");
            run.set("runtime", runtime);
        } else {
            run.putNull("runtime");
        }
        run.putNull("delivery");
        body.set("run", run);
        return body;
    }

    @Test
    void refusesTheSharedRejectedChains() throws Exception {
        for (JsonNode reject : fixtures().required("monitorChainRejectCases")) {
            // Public, so the Session event count in assertRefused is not
            // vacuous: appendLiveSessionEventIfAbsent needs the row.
            String sessionId = agents.createSession(TENANT, "reject-"
                    + UUID.randomUUID(), "qwen-code", null, "tasks", Map.of(),
                    List.of()).sessionId();
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
            CommitTransactionRequest refusedRequest = journal.request(
                    operation, commandId, ExtensionRecordJournal.bytes(
                            reject.required("next")), occurredAt, event -> {
                            }, records -> records);
            assertRefused(reject.required("id").textValue(), sessionId,
                    ManagedExtensionRecordStore.ERROR_REJECTED, null,
                    () -> journal.commit(refusedRequest));
            if (reuse == null) {
                // No command row survives a refusal: the identical bytes
                // are refused again, not replayed, and the resource rows a
                // lost rollback would keep collide the resend on the
                // resource reference primary key.
                assertRefused(reject.required("id").textValue() + " resent",
                        sessionId, ManagedExtensionRecordStore.ERROR_REJECTED,
                        null, () -> journal.commit(refusedRequest));
                // A new body under the same command id commits as new.
                JsonNode retry = ((ObjectNode) chain().get(0)
                        .required("monitorRun").deepCopy()).put("monitorId",
                        "monitor-retry-" + index);
                CommitReceipt resent = journal.commit(journal.request(
                        commandId, retry, occurredAt + 1_000));
                assertThat(resent.replayed()).isFalse();
                assertThat(revisions(sessionId)).isEqualTo(index + 1L);
            }
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
    void refusesAMonitorRunCitingAResourceOutsideItsCommit() throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        byte[] decoyBytes = { 0 };
        CommitResource decoy = new CommitResource(UUID.randomUUID()
                .toString(), "managed-note", 1, decoyBytes.length,
                ExtensionRecordJournal.sha256(decoyBytes),
                Base64.getEncoder().encodeToString(decoyBytes));
        assertRefused("a monitor run that cites a resource outside its"
                        + " commit", sessionId,
                ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                "A referenced Managed Session resource is missing.",
                () -> journal.commit(journal.requestDomain("open",
                        "monitor_run", chain().get(0).required("monitorRun"),
                        List.of(decoy), 1_000)));
    }

    @Test
    void refusesWhatTheAuthorityCouldNotReadBack() throws Exception {
        byte[] start = ExtensionRecordJournal.bytes(
                chain().get(0).required("monitorRun"));
        byte[] trailing = (new String(start, StandardCharsets.UTF_8)
                + " {}").getBytes(StandardCharsets.UTF_8);
        Map<String, Refusal> events = Map.ofEntries(
                Map.entry("another tenant", new Refusal(
                        "names another Session", event -> ((ObjectNode) event
                                .get("sessionKey")).put("tenantId",
                                        "other"))),
                Map.entry("another workspace", new Refusal(
                        "names another Session", event -> ((ObjectNode) event
                                .get("sessionKey")).put("workspaceId",
                                        "other"))),
                Map.entry("another Session", new Refusal(
                        "names another Session", event -> ((ObjectNode) event
                                .get("sessionKey")).put("sessionId",
                                        "other"))),
                Map.entry("an extra Session key field", new Refusal(
                        "event.sessionKey must be an object with exactly",
                        event -> ((ObjectNode) event.get("sessionKey"))
                                .put("extra", true))),
                Map.entry("a schema version as text", new Refusal(
                        "recordRef.schemaVersion must be an integer from 0 to 9007199254740990",
                        event -> ((ObjectNode) event.at(
                                "/payload/recordRef")).put("schemaVersion",
                                        "1"))),
                Map.entry("a record version 2", new Refusal(
                        "event.payload.version must be an integer from 1 to 1",
                        event -> ((ObjectNode) event.get("payload"))
                                .put("version", 2))),
                Map.entry("an event version 2", new Refusal(
                        "event.v must be an integer from 1 to 1", event -> event.put("v",
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
                        "event.sequence must be an integer from",
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
                        "event.occurredAt must be an integer from 0 to 8640000000000000",
                        event -> event.put("occurredAt", 1_000.5))),
                Map.entry("a time past the contract's range", new Refusal(
                        "event.occurredAt must be an integer from 0 to 8640000000000000",
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
        // The fifth field of the reference takes the missing-resource
        // answer, not the mismatch one.
        String missingId = UUID.randomUUID().toString();
        ExtensionRecordJournal missingJournal = journal(missingId);
        assertRefused("a reference of another resource", missingId,
                ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                "A referenced Managed Session resource is missing.",
                () -> missingJournal.commit(missingJournal.request(
                        ExtensionRecordJournal.OPERATION, "refused", start,
                        1_000,
                        event -> ((ObjectNode) event.at(
                                "/payload/recordRef")).put("resourceId",
                                        "other-resource"),
                        records -> records)));
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
        // And the refusal names the right line when only the second is bad.
        String second = UUID.randomUUID().toString();
        ExtensionRecordJournal secondJournal = journal(second);
        assertRefused("a duplicate key on the second line", second,
                ManagedSessionStoreModels.ERROR_INVALID_REQUEST,
                "Record line 2 is not a JSON object the Session authority"
                        + " can read",
                () -> secondJournal.commit(secondJournal.request(
                        ExtensionRecordJournal.OPERATION, "refused-second",
                        start, 1_000, event -> {
                        }, records -> records.replaceFirst(
                                "\\{\"uuid\"(?=[^\n]*managed_session_commit_v1)",
                                "{\"dup\":1,\"dup\":2,\"uuid\""))));
        // The deepest line the authority reads is still accepted, on a line
        // the Stage H rules do not otherwise look at.
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        journal.commit(journal.request(ExtensionRecordJournal.OPERATION,
                "deepest", start, 1_000, event -> {
                }, records -> {
                    String edited = records.replaceFirst(
                            "\\{\"uuid\"(?=[^\n]*managed_session_commit_v1)",
                            "{\"deep\":" + nested(63) + ",\"uuid\"");
                    assertThat(edited).as("the injection landed")
                            .isNotEqualTo(records);
                    return edited;
                }));
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

    @Test
    void answersTheThreeResourceRefusals() throws Exception {
        byte[] start = ExtensionRecordJournal.bytes(chain().get(0)
                .required("monitorRun"));
        // A body the reference names was never committed.
        String missing = UUID.randomUUID().toString();
        ExtensionRecordJournal missingJournal = journal(missing);
        assertThatThrownBy(() -> missingJournal.commit(
                missingJournal.request(ExtensionRecordJournal.OPERATION,
                        "missing", start, 1_000,
                        event -> ((ObjectNode) event.at(
                                "/payload/recordRef")).put("resourceId",
                                        "missing-body-1"),
                        records -> records))).isInstanceOfSatisfying(
                ApiException.class, error -> {
                    assertThat(error.getCode()).isEqualTo(
                            ManagedSessionStoreModels.ERROR_RESOURCE_MISSING);
                    assertThat(error.getStatus()).isEqualTo(
                            HttpStatus.CONFLICT);
                });
        // A row that no longer reads back, two ways the store knows it.
        String corruptSession = UUID.randomUUID().toString();
        ExtensionRecordJournal corruptJournal = journal(corruptSession);
        JsonNode first = chain().get(0).required("monitorRun");
        corruptJournal.commitMonitor("corrupt-1", first, 1_000);
        String corruptId = jdbc.queryForObject(
                "SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ? LIMIT 1",
                String.class, TENANT, corruptSession);
        // Its bytes no longer hold its recorded digest.
        byte[] shifted = ExtensionRecordJournal.bytes(((ObjectNode) first
                .deepCopy()).put("maxEvents", 1));
        jdbc.update("UPDATE qwen_managed_session_resource SET"
                        + " inline_bytes = ?, byte_length = ? WHERE"
                        + " tenant_id = ? AND resource_id = ?",
                shifted, shifted.length, TENANT, corruptId);
        assertThatThrownBy(() -> corruptJournal.commitMonitor("corrupt-2",
                chain().get(1).required("monitorRun"), 2_000))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode()).isEqualTo(
                            "managed_session_resource_corrupt");
                    assertThat(error.getStatus()).isEqualTo(
                            HttpStatus.INTERNAL_SERVER_ERROR);
                });
        // Its Session is not the request's, though the row says otherwise.
        String foreignSession = UUID.randomUUID().toString();
        ExtensionRecordJournal foreignJournal = journal(foreignSession);
        foreignJournal.commitMonitor("foreign-1", first, 1_000);
        String foreignId = jdbc.queryForObject(
                "SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ? LIMIT 1",
                String.class, TENANT, foreignSession);
        jdbc.update("UPDATE qwen_managed_session_resource SET"
                        + " tenant_id = 'other-tenant' WHERE tenant_id = ?"
                        + " AND resource_id = ?",
                TENANT, foreignId);
        assertThatThrownBy(() -> foreignJournal.commitMonitor("foreign-2",
                chain().get(1).required("monitorRun"), 2_000))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode()).isEqualTo(
                            "managed_session_not_found");
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.NOT_FOUND);
                });
    }

    @Test
    void announcesNothingInTheDeletingWindow() throws Exception {
        String sessionId = agents.createSession(TENANT, "deleting-"
                + UUID.randomUUID(), "qwen-code", null, "tasks", Map.of(),
                List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode first = chain().get(0).required("monitorRun");
        journal.commitMonitor("deleting-1", first, 1_000);
        // The delete stays pending while this journal's writer holds the
        // Session, so the Session is DELETING when the revision lands.
        state.beginOperation(TENANT, sessionId, OperationKind.DELETE,
                "sha256:" + "d".repeat(64), "delete", "digest-delete");
        assertThat(jdbc.queryForObject("SELECT status FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class,
                TENANT, sessionId)).isEqualTo("DELETING");
        journal.commitMonitor("deleting-2",
                chain().get(1).required("monitorRun"), 2_000);
        assertThat(state.findEvents(TENANT, sessionId, 0, 100))
                .extracting(EventRecord::type)
                .containsOnlyOnce("task.updated");
        assertThat(revisions(sessionId)).isEqualTo(2);
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
     * A refused commit leaves no resource reference, no revision and no
     * Session event behind, the rows only a rollback removes. The event
     * count is vacuous without a public Session, so the chain refusals
     * create one, and the refused command row itself is proven where the
     * pair is fresh by committing the identical bytes again: a refusal,
     * not a replay. A {@code message} names the rule that refused it.
     */
    private void assertRefused(String label, String sessionId, String code,
            String message, ThrowingCallable commit) {
        long references = rows("qwen_managed_session_resource_ref",
                sessionId);
        long events = rows("managed_agent_event", sessionId);
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
        assertThat(rows("qwen_managed_session_resource_ref", sessionId))
                .as(label).isEqualTo(references);
        assertThat(rows("managed_agent_event", sessionId)).as(label)
                .isEqualTo(events);
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
        commitDomain(journal, "configure-1", "mcp_configuration", configuration, List.of());
        JsonNode dispatched = ManagedMcpRecordContractTest.merge(configuration,
                fixtures.get("successors").get(0).get("after"));
        commitDomain(journal, "configure-dispatch", "mcp_configuration", dispatched, List.of());
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
        commitDomain(journal, "configure-result", "mcp_configuration", configured, List.of(data));
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
        commitDomain(journal, "operation-1", "mcp_operation", operation, List.of());
        assertThat(records.listTasks(TENANT, sessionId, null, null, 10).tasks()).isEmpty();
        String fakeTask = ManagedExtensionProjection.taskId(ManagedExtensionProjection.recordKey(
                sessionId, "mcp_operation", "operation-1"));
        assertThat(records.findTask(TENANT, sessionId, fakeTask)).isEmpty();
        assertThat(state.findEvents(TENANT, sessionId, 0, 100)).extracting(EventRecord::type)
                .doesNotContain("task.updated");
        assertThat(new ManagedExtensionRecordStore(jdbc, state)
                .listRecords(TENANT, sessionId, "mcp_operation")).containsExactly(operation);
    }

    @Test
    void materializesHookChainsAndAtomicallyConsumesOnceIntentsWithoutTasks() throws Exception {
        String sessionId = agents.createSession(TENANT, "hook-" + UUID.randomUUID(),
                "qwen-code", null, "hook", Map.of(), List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode fixtures = ManagedHookRecordContractTest.fixtures();
        ObjectNode registration = fixtures.get("templates").get("hook_registration").deepCopy();
        CommitResource data = new CommitResource("hook-data", "hook-data", 1,
                2, ExtensionRecordJournal.sha256("{}"), "e30=");
        ObjectNode ref = registration.withObject("/catalogRef");
        ref.put("digest", data.digest());
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("missing-catalog",
                "hook_registration", registration, List.of(), 1000))).isInstanceOf(ApiException.class);
        commitDomain(journal, "register-admitted", "hook_registration", registration, List.of(data));
        ObjectNode execution = fixtures.get("templates").get("hook_execution").deepCopy();
        execution.set("planRef", ref.deepCopy());
        execution.set("inputRef", ref.deepCopy());
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("unsettled-registration",
                "hook_execution", execution, List.of(), 1000))).hasMessageContaining("settled committed registration");
        for (String status : List.of("running", "settled")) {
            registration.withObject("/run").put("state", status);
            commitDomain(journal, "register-" + status, "hook_registration", registration, List.of());
        }
        ObjectNode otherRegistration = registration.deepCopy();
        otherRegistration.put("registrationId", "registration-other");
        otherRegistration.withObject("/run").put("effectId", "registration-other").put("state", "admitted");
        otherRegistration.withObject("/run/definition").put("definitionDigest", "c".repeat(64));
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("conflicting-pin",
                "hook_registration", otherRegistration, List.of(), 1000))).hasMessageContaining("two definition digests");
        for (String field : List.of("planRef", "inputRef")) {
            ObjectNode missing = execution.deepCopy();
            missing.withObject("/" + field).put("resourceId", "missing");
            assertThatThrownBy(() -> journal.commit(journal.requestDomain("missing-" + field,
                    "hook_execution", missing, List.of(), 1000))).isInstanceOf(ApiException.class);
        }
        commitDomain(journal, "execute-intent", "hook_execution", execution, List.of());
        ObjectNode another = execution.deepCopy();
        another.put("hookExecutionId", "execution-2").put("occurrenceId", "occurrence-2");
        another.withObject("/run").put("effectId", "execution-2");
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("consumed-once",
                "hook_execution", another, List.of(), 1000))).hasMessageContaining("onceKey");
        assertThat(revisions(sessionId)).isEqualTo(4);
        another.putNull("onceKey").put("occurrenceId", "occurrence-1");
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("duplicate-ordinal",
                "hook_execution", another, List.of(), 1000))).hasMessageContaining("unique ordinals");
        another.put("ordinal", 1).put("eventName", "AfterTool");
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("changed-event",
                "hook_execution", another, List.of(), 1000))).hasMessageContaining("unique ordinals");
        execution.withObject("/run").put("state", "running").put("execution", "dispatch_started");
        commitDomain(journal, "execute-dispatch", "hook_execution", execution, List.of());
        execution.withObject("/run").put("state", "recovery_blocked").put("execution", "outcome_unknown")
                .put("reason", "outcome_unknown");
        commitDomain(journal, "execute-unknown", "hook_execution", execution, List.of());
        assertThat(new ManagedExtensionRecordStore(jdbc, state).listRecords(TENANT, sessionId, "hook_execution"))
                .containsExactly(execution);
        execution.withObject("/run").put("state", "settled").put("execution", "settled").putNull("reason");
        execution.set("resultRef", ref.deepCopy());
        commitDomain(journal, "execute-late-result", "hook_execution", execution, List.of());
        execution.put("cancelRequested", true);
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("rewrite-terminal",
                "hook_execution", execution, List.of(), 1000))).hasMessageContaining("cannot follow");
        assertThat(records.latestHookRegistration(TENANT, sessionId)).contains(registration);
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("repeat-terminal-registration",
                "hook_registration", registration, List.of(), 1000))).hasMessageContaining("cannot follow");
        ObjectNode replacement = registration.deepCopy();
        replacement.put("registrationId", "replacement").put("catalogId", "catalog-2");
        replacement.withObject("/run").put("effectId", "replacement");
        replacement.withObject("/run/definition").put("definitionId", "catalog-2");
        for (String status : List.of("admitted", "running", "settled")) {
            replacement.withObject("/run").put("state", status);
            CommitTransactionRequest request = journal.requestDomain("replacement-" + status,
                    "hook_registration", replacement, List.of(), 500);
            journal.commit(request);
            journal.committed(request);
            assertThat(records.latestHookRegistration(TENANT, sessionId))
                    .contains("settled".equals(status) ? replacement : registration);
        }
        assertThat(records.listTasks(TENANT, sessionId, null, null, 10).tasks()).isEmpty();
        assertThat(state.findEvents(TENANT, sessionId, 0, 100)).extracting(EventRecord::type)
                .doesNotContain("task.updated");
    }

    @Test
    void keepsLatestCatalogWhenAnOlderRegistrationSettlesLater() throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        CommitResource data = hookResource("hook-data", "hook-data", "{}".getBytes(StandardCharsets.UTF_8));
        ObjectNode older = ManagedHookRecordContractTest.fixtures()
                .get("templates").get("hook_registration").deepCopy();
        older.withObject("/catalogRef").put("digest", data.digest());
        commitDomain(journal, "older-admitted", "hook_registration", older, List.of(data));
        assertThat(records.latestHookRegistration(TENANT, sessionId)).isEmpty();

        ObjectNode newer = older.deepCopy();
        newer.put("registrationId", "registration-2").put("catalogRevision", 2);
        newer.withObject("/run").put("effectId", "registration-2");
        newer.withObject("/run/definition").put("definitionRevision", 2)
                .put("definitionDigest", "c".repeat(64));
        for (String status : List.of("admitted", "running", "settled")) {
            newer.withObject("/run").put("state", status);
            commitDomain(journal, "newer-" + status, "hook_registration", newer, List.of());
            if ("settled".equals(status)) {
                assertThat(records.latestHookRegistration(TENANT, sessionId)).contains(newer);
            } else {
                assertThat(records.latestHookRegistration(TENANT, sessionId)).isEmpty();
            }
        }
        for (String status : List.of("running", "settled")) {
            older.withObject("/run").put("state", status);
            commitDomain(journal, "older-" + status, "hook_registration", older, List.of());
            assertThat(new ManagedExtensionRecordStore(jdbc, state)
                    .latestHookRegistration(TENANT, sessionId)).contains(newer);
        }
    }

    private static void commitDomain(ExtensionRecordJournal journal, String commandId,
            String domain, JsonNode record, List<CommitResource> resources) {
        CommitTransactionRequest request = journal.requestDomain(commandId, domain, record, resources, 1000);
        journal.commit(request);
        journal.committed(request);
    }

    @Test
    void commitsHookMessageSnapshotsAndRejectsIncompleteOrMismatchedClosures() throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode templates = ManagedHookRecordContractTest.fixtures().get("templates");
        CommitResource data = hookResource("hook-data", "hook-data", "{}".getBytes(StandardCharsets.UTF_8));
        ObjectNode registration = templates.get("hook_registration").deepCopy();
        registration.set("catalogRef", hookRef(data));
        for (String status : List.of("admitted", "running", "settled")) {
            registration.withObject("/run").put("state", status);
            commitDomain(journal, "register-" + status, "hook_registration", registration, List.of(data));
        }
        long resourcesBefore = rows("qwen_managed_session_resource", sessionId);
        byte[] messages = ("[{\"role\":\"user\",\"content\":\"" + "😀".repeat(20_000) + "\"}]")
                .getBytes(StandardCharsets.UTF_8);
        CommitResource first = hookResource("messages-part-1", "managed-hook-message-part",
                Arrays.copyOfRange(messages, 0, 60 * 1024));
        CommitResource second = hookResource("messages-part-2", "managed-hook-message-part",
                Arrays.copyOfRange(messages, 60 * 1024, messages.length));
        ObjectNode manifestBody = JsonNodeFactory.instance.objectNode();
        manifestBody.putArray("parts").add(hookRef(first)).add(hookRef(second));
        CommitResource manifest = hookResource("messages", "managed-hook-message-chunks",
                ExtensionRecordJournal.bytes(manifestBody));
        ObjectNode planBody = JsonNodeFactory.instance.objectNode();
        planBody.set("messagesRef", hookRef(manifest));
        planBody.putObject("input").set("userObject", hookRef(hookResource("not-a-dependency", "user-data", messages)));
        CommitResource plan = hookResource("plan", "managed-hook-plan", ExtensionRecordJournal.bytes(planBody));
        ObjectNode execution = templates.get("hook_execution").deepCopy();
        execution.set("planRef", hookRef(plan));
        execution.set("inputRef", hookRef(data));
        execution.putNull("onceKey");
        for (List<CommitResource> incomplete : List.of(List.of(plan, first, second), List.of(plan, manifest, first))) {
            assertThatThrownBy(() -> journal.commit(journal.requestDomain("missing-messages", "hook_execution",
                    execution, incomplete, 1000))).isInstanceOf(ApiException.class);
            assertThat(revisions(sessionId)).isEqualTo(3);
            assertThat(rows("qwen_managed_session_resource", sessionId)).isEqualTo(resourcesBefore);
        }
        for (boolean mismatchPart : List.of(false, true)) {
            ObjectNode badPlanBody = planBody.deepCopy();
            ObjectNode badManifestBody = manifestBody.deepCopy();
            if (mismatchPart)
                ((ObjectNode) badManifestBody.get("parts").get(1)).put("digest", "c".repeat(64));
            CommitResource badManifest = hookResource("messages", "managed-hook-message-chunks",
                    ExtensionRecordJournal.bytes(badManifestBody));
            badPlanBody.set("messagesRef", hookRef(badManifest));
            if (!mismatchPart) badPlanBody.withObject("/messagesRef").put("digest", "c".repeat(64));
            CommitResource badPlan = hookResource("plan", "managed-hook-plan", ExtensionRecordJournal.bytes(badPlanBody));
            ObjectNode invalid = execution.deepCopy();
            invalid.set("planRef", hookRef(badPlan));
            assertThatThrownBy(() -> journal.commit(journal.requestDomain("mismatched-messages", "hook_execution",
                    invalid, List.of(badPlan, badManifest, first, second), 1000)))
                    .isInstanceOf(ApiException.class).hasMessageContaining("does not match");
            assertThat(revisions(sessionId)).isEqualTo(3);
            assertThat(rows("qwen_managed_session_resource", sessionId)).isEqualTo(resourcesBefore);
        }
        commitDomain(journal, "messages-valid", "hook_execution", execution, List.of(plan, manifest, first, second));
        assertThat(new ManagedExtensionRecordStore(jdbc, state).listRecords(TENANT, sessionId, "hook_execution"))
                .extracting(JsonNode::toString).containsExactly(execution.toString());
        assertThat(sessionStore.readResource(TENANT, WORKSPACE, sessionId, manifest.resourceId(),
                "extension-writer-token-0123456789").bytes()).isEqualTo(ExtensionRecordJournal.bytes(manifestBody));
        ByteArrayOutputStream restored = new ByteArrayOutputStream();
        for (CommitResource part : List.of(first, second))
            restored.write(sessionStore.readResource(TENANT, WORKSPACE, sessionId, part.resourceId(),
                    "extension-writer-token-0123456789").bytes());
        assertThat(restored.toByteArray()).isEqualTo(messages);

        CommitResource small = hookResource("small-messages", "managed-hook-messages", "[]".getBytes(StandardCharsets.UTF_8));
        planBody.set("messagesRef", hookRef(small));
        CommitResource smallPlan = hookResource("small-plan", "managed-hook-plan", ExtensionRecordJournal.bytes(planBody));
        ObjectNode smallExecution = execution.deepCopy();
        smallExecution.put("hookExecutionId", "small").put("occurrenceId", "small");
        smallExecution.withObject("/run").put("effectId", "small");
        smallExecution.set("planRef", hookRef(smallPlan));
        assertThatThrownBy(() -> journal.commit(journal.requestDomain("small-missing", "hook_execution",
                smallExecution, List.of(smallPlan), 1000))).isInstanceOf(ApiException.class);
        commitDomain(journal, "small-valid", "hook_execution", smallExecution, List.of(smallPlan, small));
        assertThat(sessionStore.readResource(TENANT, WORKSPACE, sessionId, small.resourceId(),
                "extension-writer-token-0123456789").bytes()).isEqualTo("[]".getBytes(StandardCharsets.UTF_8));
    }

    private static CommitResource hookResource(String id, String kind, byte[] bytes) {
        return new CommitResource(id, kind, 1, bytes.length, ExtensionRecordJournal.sha256(bytes),
                Base64.getEncoder().encodeToString(bytes));
    }

    private static ObjectNode hookRef(CommitResource resource) {
        return JsonNodeFactory.instance.objectNode().put("resourceId", resource.resourceId()).put("kind", resource.kind())
                .put("schemaVersion", resource.schemaVersion()).put("byteLength", resource.byteLength()).put("digest", resource.digest());
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
