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
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.function.Function;
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
    private static final ObjectMapper JSON = new ObjectMapper();
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
    void commitsTwoMonitorRecordsIntoOneSessionThroughTheDomainChain()
            throws Exception {
        // Two records of one domain, interleaved: the chain IDs follow the
        // per-domain total of revisions, never one record's latest — a
        // MAX(revision) in place of SUM would assign 3 to the fourth.
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        JsonNode start = chain().get(0).required("monitorRun");
        JsonNode next = chain().get(1).required("monitorRun");
        ObjectNode otherStart = ((ObjectNode) start).deepCopy()
                .put("monitorId", "monitor-other");
        ObjectNode otherNext = ((ObjectNode) next).deepCopy()
                .put("monitorId", "monitor-other");
        journal.commitMonitor("interleaved-a1", start,
                chain().get(0).required("occurredAt").longValue());
        journal.commitMonitor("interleaved-a2", next,
                chain().get(1).required("occurredAt").longValue());
        journal.commitMonitor("interleaved-b1", otherStart,
                chain().get(0).required("occurredAt").longValue());
        journal.commitMonitor("interleaved-b2", otherNext,
                chain().get(1).required("occurredAt").longValue());
        assertThat(revisions(sessionId)).isEqualTo(4);
        assertThat(records.listTasks(TENANT, sessionId, null, null, 10)
                .tasks()).hasSize(2);
        TaskProjection view = ManagedExtensionProjectionContractTest.view(
                chain().get(1).required("view"));
        for (String monitorId : List.of(
                start.required("monitorId").textValue(), "monitor-other")) {
            assertThat(records.findTask(TENANT, sessionId,
                    ManagedExtensionProjection.taskId(
                            ManagedExtensionProjection.recordKey(sessionId,
                                    "monitor_run", monitorId)))
                    .orElseThrow().projection()).isEqualTo(view);
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
                        "Journal event scope conflicts", event -> ((ObjectNode) event
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
                        "payload has the unexpected field extra for"
                                + " domain.committed",
                        event -> ((ObjectNode) event.get("payload"))
                                .put("extra", true))),
                Map.entry("an event subject", new Refusal(
                        "event.subject has the unexpected field id",
                        event -> event.putObject("subject")
                                .put("type", "turn").put("id", "turn-1"))),
                Map.entry("a Stage H event with a well-formed subject",
                        new Refusal(
                        "event must be an object with exactly",
                        event -> event.putObject("subject")
                                .put("type", "turn").put("turnId", "turn-1"))),
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
        refuse("a foreign line where the commit marker belongs",
                "has the unknown subtype"
                + " managed_session_note after the Managed header", start,
                event -> {
                }, records -> records.substring(0, records.indexOf('\n')
                        + 1) + "{\"subtype\":\"managed_session_note\","
                        + "\"sessionId\":\"" + sessionIdOf(records)
                        + "\"}\n");
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        assertRefused("a line among the events that is not one", sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED,
                "holds only its events, then its commit marker",
                () -> journal.commit(journal.request(
                        ExtensionRecordJournal.OPERATION, "refused", start,
                        1_000, event -> {
                        }, records -> {
                            String marker = records.substring(
                                    records.indexOf('\n') + 1);
                            return records.replaceFirst("\n", "\n" + marker);
                        }, 1)));
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

    /** The Session the composed record line names at its top level. */
    private static String sessionIdOf(String records) {
        int at = records.indexOf("\"sessionId\":\"") + "\"sessionId\":\""
                .length();
        return records.substring(at, records.indexOf('"', at));
    }

    /**
     * Every event line carries the shared envelope and its kind's payload
     * and subject, every domain.committed line a body the authority could
     * read back, every line this Session's name at the top level, the
     * header and the commit marker bodies the reader parses, and both
     * content digests recomputed from the lines — the rules the authority's
     * reopen scanner and commit gate check, refused at commit time so the
     * journal never holds a line it could not reopen. The payload, subject,
     * header- and marker-body and digest cases answer 200 before the
     * mirror and 409 after it; the sequence, shape, byte-cap, domain and
     * event-ID cases the store's own gate already refused.
     */
    @Test
    void refusesJournalLinesTheAuthorityRefusesOnReopen() throws Exception {
        refuseLine("an event line with no envelope",
                "event must be an object", 1,
                sessionId -> records -> records.replaceFirst("\n",
                        "\n{\"subtype\":\"managed_session_event_v1\","
                                + "\"sessionId\":\"" + sessionId + "\"}\n"));
        refuseLine("an event line with no payload",
                "payload must be a JSON object", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "lifecycle.changed", null, null)
                        + "\n"));
        refuseLine("a lifecycle.changed with an empty payload",
                "payload.operationId is required for lifecycle.changed", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "lifecycle.changed", "{}", null)
                        + "\n"));
        refuseLine("an event out of its sequence place",
                "event.sequence is out of range", 1,
                sessionId -> records -> records.replaceFirst("\n",
                        "\n" + ordinaryEvent(sessionId, 5, "turn:1",
                                "lifecycle.changed", lifecyclePayload(),
                                null)
                                + "\n"));
        refuseLine("an event of an unknown kind",
                "event.kind must be one of", 1,
                sessionId -> records -> records.replaceFirst("\n",
                        "\n" + ordinaryEvent(sessionId, 2, "turn:1",
                                "not_a_kind", "{}", null) + "\n"));
        refuseLine("a record of an unknown subtype", "has the unknown"
                + " subtype not_a_subtype after the Managed header", 1,
                sessionId -> records -> records.replaceFirst("\n",
                        "\n{\"subtype\":\"not_a_subtype\",\"sessionId\":\""
                                + sessionId + "\"}\n"));
        refuseLine("an event line without its Session at the top level",
                "does not name this Session at the top level", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "lifecycle.changed", lifecyclePayload(),
                                null)
                                .replaceFirst("\"sessionId\":\"" + sessionId
                                        + "\",", "")
                        + "\n"));
        refuseLine("an event line naming another Session",
                "does not name this Session at the top level", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "lifecycle.changed", lifecyclePayload(),
                                null)
                                .replaceFirst("\"sessionId\":\"" + sessionId
                                                + "\",",
                                        "\"sessionId\":\"another-session\",")
                        + "\n"));
        String unknownDomain = "\"domain\":\"not_a_domain\",\"version\":1,"
                + "\"operationId\":\"op-other\",\"recordRef\":{"
                + "\"resourceId\":\"other-body\",\"kind\":\"managed-other\","
                + "\"schemaVersion\":1,\"byteLength\":2,\"digest\":\""
                + ExtensionRecordJournal.sha256("{}") + "\"}";
        refuseLine("a record of an unknown domain",
                "commits a record of an unknown domain", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "other:1",
                                "domain.committed", "{" + unknownDomain
                                        + "}",
                                null)
                        + "\n"));
        String goalState = "\"domain\":\"goal_state\",\"version\":1,"
                + "\"operationId\":\"op-goal\",\"recordRef\":{"
                + "\"resourceId\":\"goal-body\",\"kind\":\"managed-goal_state\","
                + "\"schemaVersion\":1,\"byteLength\":2,\"digest\":\""
                + ExtensionRecordJournal.sha256("{}") + "\"}";
        refuseLine("a body-less record with an extra payload field",
                "payload has the unexpected field extra for"
                        + " domain.committed", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "goal_state:1",
                                "domain.committed",
                                "{" + goalState + ",\"extra\":true}", null)
                        + "\n"));
        refuseLine("a body-less record at version 2",
                "event.payload.version is out of range", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "goal_state:1",
                                "domain.committed",
                                "{" + goalState
                                        .replace("\"version\":1",
                                                "\"version\":2")
                                        + "}", null)
                        + "\n"));
        refuseLine("an event ID reserved for Stage H records",
                "takes an event ID reserved for Stage H records", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "monitor_run:99",
                                "lifecycle.changed", lifecyclePayload(),
                                null)
                        + "\n"));
        refuseLine("a Stage H event ID the chain did not assign",
                "the monitor_run chain assigns monitor_run:1 to its next"
                        + " revision", 0,
                sessionId -> records -> records.replace("monitor_run:1",
                        "monitor_run:42"));
        refuseLine("two events sharing an event ID",
                "repeats the event ID of another event in the transaction",
                1,
                sessionId -> records -> {
                    String first = records.substring(0,
                            records.indexOf('\n') + 1);
                    return first + first.replace("\"sequence\":1",
                            "\"sequence\":2")
                            + records.substring(first.length());
                });
        refuseLine("a tool.intent without a subject",
                "tool.intent requires an activation subject", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "tool.intent",
                                "{\"executionCallId\":\"call-1\","
                                        + "\"batchId\":\"batch-1\","
                                        + "\"ordinal\":1,"
                                        + "\"toolDefinitionRef\":"
                                        + toolIntentRef() + ",\"argsRef\":"
                                        + toolIntentRef()
                                        + ",\"outcomeSource\":\"runtime\"}",
                                null)
                        + "\n"));
        refuseLine("a checkpoint.committed without a subject",
                "checkpoint.committed requires an activation subject", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "checkpoint.committed", checkpointPayload(1),
                                null)
                        + "\n"));
        refuseLine("a checkpoint covering its own transaction",
                "covers events not committed before its transaction", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "checkpoint.committed", checkpointPayload(1),
                                activationSubject())
                        + "\n"));
        refuseLine("an activation.changed released without its boundary",
                "payload.boundaryRef must be present when phase is released",
                1, sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "activation.changed", activationPayload(
                                        "released", false), null)
                        + "\n"));
        refuseLine("an activation.changed active with no lease",
                "payload.leaseDurationMs must be present when phase is active",
                1, sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "activation.changed", activationPayload(
                                        "active", true), null)
                        + "\n"));
        refuseLine("a lifecycle.changed leaping to deleted",
                "payload cannot transition from idle to deleted", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "lifecycle.changed",
                                "{\"operationId\":\"op-1\",\"from\":\"idle\","
                                        + "\"to\":\"deleted\",\"reason\":"
                                        + "\"gone\",\"pendingOwnersRef\":null}",
                                null)
                        + "\n"));
        refuseLine("a wake.requested before the first sequence",
                "payload.requiredSequence must start at 1", 1,
                sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "wake.requested",
                                "{\"wakeId\":\"wake-1\",\"reason\":\"prompt\","
                                        + "\"subject\":" + activationSubject()
                                        + ",\"sourceEventId\":\"event-1\","
                                        + "\"requiredSequence\":0}", null)
                        + "\n"));
        refuseLine("a cancel.requested carrying a control character",
                "payload.reason must not contain control characters", 1,
                sessionId -> {
                    String line = ordinaryEvent(sessionId, 2, "turn:1",
                            "cancel.requested",
                            "{\"requestId\":\"cancel-1\",\"target\":null,"
                                    + "\"reason\":\"no\\u0001\",\"requestedBy\":\"user\"}",
                            null);
                    return records -> records.substring(0,
                            records.indexOf('\n') + 1) + line + "\n"
                            + records.substring(records.indexOf('\n') + 1);
                });
        refuseLine("a model.attempt started with a usage ref",
                "payload.usageRef must be null while the attempt is started",
                1, sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "model.attempt",
                                "{\"attemptId\":\"attempt-1\",\"routeRef\":"
                                        + toolIntentRef()
                                        + ",\"inputCheckpointRef\":null,"
                                        + "\"state\":\"started\",\"usageRef\":"
                                        + toolIntentRef() + "}",
                                activationSubject())
                        + "\n"));
        refuseLine("a context.compacted folding back its own span",
                "payload.toSequence must not precede payload.fromSequence",
                1, sessionId -> records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "turn:1",
                                "context.compacted",
                                "{\"compactionId\":\"compact-1\","
                                        + "\"fromSequence\":2,"
                                        + "\"toSequence\":1,\"summaryRef\":"
                                        + toolIntentRef()
                                        + ",\"replacedMessageIds\":[],"
                                        + "\"tokenCountsRef\":null}",
                                activationSubject())
                        + "\n"));
        refuseLine("a commit marker without a body",
                "commit must be an object", 0,
                sessionId -> records -> records.substring(0,
                        records.indexOf('\n') + 1)
                        + "{\"subtype\":\"managed_session_commit_v1\","
                        + "\"sessionId\":\"" + sessionId + "\"}\n");
        refuseLine("a commit marker past the shared cap",
                "exceeds 65536 UTF-8 bytes", 0,
                sessionId -> records -> records.substring(0,
                        records.indexOf('\n') + 1)
                        + "{\"subtype\":\"managed_session_commit_v1\","
                        + "\"sessionId\":\"" + sessionId + "\",\"pad\":\""
                        + "x".repeat(70_000) + "\"}\n");
        refuseLine("a commit marker out of agreement with its request",
                "commit marker does not agree with the transaction its"
                        + " request declares", 0,
                sessionId -> records -> records.replace(
                        "\"lastSequence\":1,\"eventCount\":1",
                        "\"lastSequence\":2,\"eventCount\":2"));
        refuseLine("a commit marker without its previous digest",
                "commit.previousCommitDigest is required", 0,
                sessionId -> records -> records.replace(
                        ",\"previousCommitDigest\":null", ""));
        refuseLine("a commit marker declaring another command",
                "commit marker does not agree with the transaction its"
                        + " request declares", 0,
                sessionId -> records -> records.replace(
                        "\"commandId\":\"refused-line\"",
                        "\"commandId\":\"another-command\""));
        refuseLine("a commit marker digesting other events",
                "commit marker does not agree with the transaction its"
                        + " request declares", 0,
                sessionId -> records -> records.replace(
                        "\"eventsDigest\":\"__EVENTS_DIGEST__\"",
                        "\"eventsDigest\":\"" + "f".repeat(64) + "\""));
        refuseLine("a commit marker naming a previous chain",
                "commit marker does not agree with the transaction its"
                        + " request declares", 0,
                sessionId -> records -> records.replace(
                        "\"previousCommitDigest\":null",
                        "\"previousCommitDigest\":\"" + "c".repeat(64)
                                + "\""));
        refuseLine("a commit marker shifted one sequence over",
                "commit marker does not agree with the transaction its"
                        + " request declares", 0,
                sessionId -> records -> records.replace(
                        "\"firstSequence\":1,\"lastSequence\":1",
                        "\"firstSequence\":2,\"lastSequence\":2"));
        refuseLine("no event at all between its commit markers",
                "holds only its events, then its commit marker", 0,
                sessionId -> records -> {
                    String marker = records.substring(
                            records.indexOf('\n') + 1);
                    return marker + marker;
                });
        refuseLine("an event after its commit marker",
                "holds only its events, then its commit marker", 1,
                sessionId -> records -> {
                    String marker = records.substring(
                            records.indexOf('\n') + 1);
                    return marker + records.substring(0,
                            records.indexOf('\n') + 1)
                            .replace("\"sequence\":1", "\"sequence\":2")
                            + marker;
                });
        refuseLine("a second Stage H revision in one transaction",
                "commits a second Stage H record revision", 1,
                sessionId -> records -> {
                    String first = records.substring(0,
                            records.indexOf('\n') + 1);
                    String second = first.replace("\"sequence\":1",
                            "\"sequence\":2").replace("monitor_run:1",
                                    "monitor_run:2");
                    return first + second + records.substring(first.length());
                });

        // A faithful read-only domain record commits through the same
        // loop, its reference backed by a resource the same transaction
        // carries, its envelope checked but nothing materialized.
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        CommitResource goalBody = new CommitResource("goal-body",
                "managed-goal_state", 1, 2, ExtensionRecordJournal.sha256(
                        "{}"), "e30=");
        journal.commit(journal.request(ExtensionRecordJournal.OPERATION,
                "body-less", startBody(), 1_000, event -> {
                }, records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "goal_state:1",
                                "domain.committed", "{" + goalState + "}",
                                null)
                        + "\n"), 1, List.of(goalBody)));
        assertThat(revisions(sessionId)).isEqualTo(1);
        assertThat(rows("qwen_managed_session_resource_ref", sessionId))
                .isEqualTo(2);

        // The two content digests are recomputed from the transaction, so
        // a request and its marker agreeing on a wrong value still refuse.
        refuseDeclaredDigest("an eventsDigest that is not its event"
                + " content", "eventsDigest", "e".repeat(64),
                "eventsDigest does not match its event content");
        refuseDeclaredDigest("a commitDigest that is not its commit's"
                + " marker", "commitDigest", "d".repeat(64),
                "commitDigest does not match its commit marker");
    }

    private void refuseDeclaredDigest(String label, String field, String lie,
            String message) throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        CommitTransactionRequest base = journal.request(
                ExtensionRecordJournal.OPERATION, "digest-lie", startBody(),
                1_000, event -> {
                }, records -> records);
        ObjectNode tree = JSON.valueToTree(base);
        tree.put(field, lie);
        if ("eventsDigest".equals(field)) {
            // Only the canonical recompute can spot this one: the marker
            // and the request agree on the wrong value.
            String records = new String(Base64.getDecoder().decode(
                    base.recordBytesBase64()), StandardCharsets.UTF_8);
            records = records.replaceAll("\"eventsDigest\":\"[0-9a-f]{64}\"",
                    "\"eventsDigest\":\"" + lie + "\"");
            tree.put("recordBytesBase64", Base64.getEncoder().encodeToString(
                    records.getBytes(StandardCharsets.UTF_8)));
            tree.put("recordDigest", ExtensionRecordJournal.sha256(records));
        }
        assertRefused(label, sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED, message,
                () -> journal.commit(JSON.treeToValue(tree,
                        CommitTransactionRequest.class)));
    }

    /** The shared ref shape the durable-ref fields carry in these tests. */
    private static String toolIntentRef() {
        return new StringBuilder("{\"resourceId\":\"ref-1\",\"kind\":")
                .append("\"managed-tool-definition\",\"schemaVersion\":1,")
                .append("\"byteLength\":2,\"digest\":\"")
                .append(ExtensionRecordJournal.sha256("{}"))
                .append("\"}").toString();
    }

    /** A faithful checkpoint.committed payload covering `covered`. */
    private static String checkpointPayload(int covered) {
        return "{\"checkpointId\":\"checkpoint-1\",\"coveredSequence\":"
                + covered
                + ",\"previousCheckpointId\":null,\"stateRef\":"
                + toolIntentRef() + ",\"boundary\":null}";
    }

    private void refuseLine(String label, String message,
            int extraEvents,
            Function<String, UnaryOperator<String>> editRecords)
            throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        assertRefused(label, sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED, message,
                () -> journal.commit(journal.request(
                        ExtensionRecordJournal.OPERATION, "refused-line",
                        startBody(), 1_000, event -> {
                        }, editRecords.apply(sessionId), extraEvents)));
    }

    /** The shared chain's first revision, as the commit body. */
    private static byte[] startBody() throws Exception {
        return ExtensionRecordJournal.bytes(chain().get(0)
                .required("monitorRun"));
    }

    /**
     * An ordinary event line the way the authority composes one: the
     * Session at the top level, the shared envelope inside, and a payload
     * and subject of the caller's shape.
     */
    private String ordinaryEvent(String sessionId, int sequence,
            String eventId, String kind, String payloadJson,
            String subjectJson) {
        return "{\"subtype\":\"managed_session_event_v1\",\"sessionId\":\""
                + sessionId + "\",\"managedSession\":"
                + "{\"v\":1,\"sequence\":" + sequence + ",\"eventId\":\""
                + eventId + "\",\"sessionKey\":{\"tenantId\":\"" + TENANT
                + "\",\"workspaceId\":\"" + WORKSPACE + "\",\"sessionId\":\""
                + sessionId + "\"},\"kind\":\"" + kind
                + "\",\"occurredAt\":1000"
                + (payloadJson == null ? "" : ",\"payload\":" + payloadJson)
                + (subjectJson == null ? "" : ",\"subject\":" + subjectJson)
                + "}}";
    }

    /** A faithful lifecycle.changed payload, from nothing to idle. */
    private static String lifecyclePayload() {
        return "{\"operationId\":\"op-lifecycle\",\"from\":null,"
                + "\"to\":\"idle\",\"reason\":\"opened\",\"pendingOwnersRef\":null}";
    }

    /** A faithful activation subject. */
    private static String activationSubject() {
        return "{\"type\":\"activation\",\"scopeId\":\"scope-1\","
                + "\"activationId\":\"activation-1\",\"epoch\":1}";
    }

    /** The activation.changed payload, breaking the rule {@code phase} pairs. */
    private static String activationPayload(String phase,
            boolean missingLease) {
        return "{\"activationId\":\"activation-1\",\"epoch\":1,"
                + "\"workerId\":\"worker-1\",\"subject\":" + activationSubject()
                + ",\"phase\":\"" + phase + "\",\"leaseDurationMs\":"
                + ("released".equals(phase) || missingLease ? "null"
                        : "300000")
                + ",\"expiresAt\":1000,\"installRef\":"
                + ("released".equals(phase) ? "null" : toolIntentRef())
                + ",\"boundaryRef\":"
                + ("released".equals(phase) ? "null" : "null") + "}";
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
                        + "\n" + journal.headerLine(),
                        revision.resources())));
    }

    /**
     * The genesis transaction's own shape rules: its Managed header is one
     * line, capped and parsed as the reader parses it, everything after it
     * is a known subtype, and no marker or second header appears. Each case
     * is a transaction the store accepted and the authority's reopen
     * reader throws on.
     */
    @Test
    void refusesGenesisLinesTheAuthorityRefusesOnReopen() throws Exception {
        refuseGenesis("a header past the shared cap",
                "exceeds 65536 UTF-8 bytes",
                journal -> {
                    String header = journal.headerLine();
                    return journal.engineLine()
                            + header.substring(0, header.length() - 2)
                            + ",\"pad\":\"" + "x".repeat(70_000) + "\"}\n";
                });
        refuseGenesis("a repeated Managed header",
                "repeats the Managed header",
                journal -> journal.headerLine() + journal.headerLine());
        refuseGenesis("a commit marker before the Managed header",
                "precedes the Managed header",
                journal -> "{\"subtype\":\"managed_session_commit_v1\","
                        + "\"sessionId\":\"" + journal.sessionId + "\"}\n"
                        + journal.headerLine());
        refuseGenesis("a foreign record after the Managed header",
                "has the unknown subtype not_a_subtype after the Managed"
                        + " header",
                journal -> journal.headerLine()
                        + "{\"subtype\":\"not_a_subtype\",\"sessionId\":\""
                        + journal.sessionId + "\"}\n");
        refuseGenesis("a header naming another Session",
                "the genesis transaction belongs to a different session",
                journal -> journal.engineLine()
                        + journal.headerLine().replace(TENANT,
                                "another-tenant"));
        refuseGenesis("a header naming another workspace",
                "the genesis transaction belongs to a different session",
                journal -> journal.engineLine()
                        + journal.headerLine().replace(WORKSPACE,
                                "workspace-elsewhere"));
        refuseGenesis("a header naming another session in its key",
                "the genesis transaction belongs to a different session",
                journal -> journal.engineLine()
                        + journal.headerLine().replace(
                                "{\"tenantId\":\"" + TENANT
                                        + "\",\"workspaceId\":\"" + WORKSPACE
                                        + "\",\"sessionId\":\""
                                        + journal.sessionId + "\"}",
                                "{\"tenantId\":\"" + TENANT
                                        + "\",\"workspaceId\":\"" + WORKSPACE
                                        + "\",\"sessionId\":\"session-elsewhere\"}"));
        refuseGenesis("a header at format version 2",
                "header.formatVersion is not supported by this reader",
                journal -> journal.engineLine() + journal.headerLine()
                        .replace("\"formatVersion\":1",
                                "\"formatVersion\":2"));
        refuseGenesis("a header naming a newer reader",
                "header.minimumReader is not supported by this reader",
                journal -> journal.engineLine() + journal.headerLine()
                        .replace("managed-session/1", "managed-session/2"));

        // A Managed header line is refused in every later transaction too.
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(sessionId);
        assertRefused("a Managed header in an ordinary transaction",
                sessionId, ManagedExtensionRecordStore.ERROR_REJECTED,
                "holds the Managed header outside the genesis transaction",
                () -> journal.commit(journal.request(
                        ExtensionRecordJournal.OPERATION, "header", startBody(),
                        1_000, event -> {
                        }, records -> records.replaceFirst("\n",
                                "\n" + journal.headerLine()), 1)));
    }

    private void refuseGenesis(String label, String message,
            Function<ExtensionRecordJournal, String> records)
            throws Exception {
        String sessionId = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = new ExtensionRecordJournal(
                sessionStore, TENANT, WORKSPACE, sessionId).acquire();
        assertRefused(label, sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED, message,
                () -> journal.commit(journal.genesis(
                        records.apply(journal), List.of())));
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
    void announcesEachChangedViewOnTheTaskEventOutbox() throws Exception {
        String sessionId = agents.createSession(TENANT, "announce-"
                + UUID.randomUUID(), "qwen-code", null, "tasks", Map.of(),
                List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        // The first revision commits beside one opening event, so journal
        // sequence and revision disagree from then on and the exact
        // ordering key is what the assertion pins.
        JsonNode first = chain().get(0);
        CommitTransactionRequest opening = journal.request(
                ExtensionRecordJournal.OPERATION, "announce-0",
                ExtensionRecordJournal.bytes(first.required("monitorRun")),
                first.required("occurredAt").longValue(), event -> {
                }, records -> records.replaceFirst("\n", "\n"
                        + ordinaryEvent(sessionId, 2, "opening:1",
                                "lifecycle.changed", lifecyclePayload(),
                                null)
                        + "\n"), 1);
        journal.commit(opening);
        journal.committed(opening);
        List<String> expected = new ArrayList<>();
        List<Long> expectedSequences = new ArrayList<>();
        TaskProjection previous = null;
        int index = 0;
        for (JsonNode revision : chain()) {
            if (index > 0) {
                journal.commitMonitor("announce-" + index,
                        revision.required("monitorRun"),
                        revision.required("occurredAt").longValue());
            }
            TaskProjection view = ManagedExtensionProjectionContractTest.view(
                    revision.required("view"));
            if (!Objects.equals(previous, view)) {
                expected.add(view.state());
                expectedSequences.add(index == 0 ? 1L : index + 2L);
            }
            previous = view;
            index++;
        }
        List<Map<String, Object>> announced = taskEvents(sessionId);
        String taskId = ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(sessionId,
                        "monitor_run", "monitor-1"));
        assertThat(announced).extracting(row -> row.get("task_state"))
                .containsExactlyElementsOf(expected);
        assertThat(announced).allSatisfy(row ->
                assertThat(row.get("task_id")).isEqualTo(taskId));
        assertThat(announced).extracting(row -> ((Number) row
                .get("journal_sequence")).longValue())
                .containsExactlyElementsOf(expectedSequences);
        assertThat(state.findEvents(TENANT, sessionId, 0, 100))
                .extracting(EventRecord::type)
                .doesNotContain("task.updated");
        assertThat(expected.size()).isLessThan(chain().size());
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
        // Only the revision ahead of the delete window announced: the
        // outbox carries one row, and the Session event stream neither.
        assertThat(taskEvents(sessionId)).hasSize(1);
        assertThat(state.findEvents(TENANT, sessionId, 0, 100))
                .extracting(EventRecord::type)
                .doesNotContain("task.updated");
        assertThat(revisions(sessionId)).isEqualTo(2);
    }

    @Test
    void keepsTaskAnnouncementsOutOfTheMessageProjectionSequence()
            throws Exception {
        String sessionId = agents.createSession(TENANT, "split-"
                + UUID.randomUUID(), "qwen-code", null, "tasks", Map.of(),
                List.of()).sessionId();
        ExtensionRecordJournal journal = journal(sessionId);
        state.appendPublicEventIfAbsent(TENANT, sessionId, "turn-split",
                "item.output_text.delta", Map.of("text", "one"), false,
                "split-delta-1");
        journal.commitMonitor("split-0", chain().get(0)
                .required("monitorRun"),
                chain().get(0).required("occurredAt").longValue());
        state.appendPublicEventIfAbsent(TENANT, sessionId, "turn-split",
                "item.output_text.delta", Map.of("text", "two"), false,
                "split-delta-2");
        // The revision committed between the two deltas announced nothing
        // onto the Session event stream, whose interleaved events split a
        // streamed message part, so both deltas keep one output_text Part.
        // The announcement itself exists, on the outbox only.
        state.materializeNextBatch(TENANT, sessionId, 100);
        assertThat(state.findEvents(TENANT, sessionId, 0, 100))
                .extracting(EventRecord::type)
                .doesNotContain("task.updated");
        assertThat(taskEvents(sessionId)).hasSize(1);
        List<Map<String, Object>> parts = jdbc.queryForList(
                "SELECT part_id, part_text FROM managed_agent_item_part"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND part_type = 'output_text'",
                TENANT, sessionId);
        assertThat(parts).hasSize(1);
        assertThat(parts.get(0).get("part_text")).isEqualTo("onetwo");
    }

    private List<Map<String, Object>> taskEvents(String sessionId) {
        return jdbc.queryForList("SELECT task_id, task_state, revision,"
                        + " journal_sequence FROM"
                        + " qwen_managed_session_task_event"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY journal_sequence, task_id",
                TENANT, sessionId);
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
        // The revision committed before the delete announced once; the one
        // committed while the Session is being deleted announced nothing.
        // The surviving row is the first revision's view, not the second's.
        TaskProjection beforeDelete = ManagedExtensionProjectionContractTest
                .view(chain.get(0).required("view"));
        assertThat(taskEvents(sessionId)).singleElement().satisfies(row -> {
            assertThat(((Number) row.get("revision")).longValue())
                    .isEqualTo(1L);
            assertThat(row.get("task_state"))
                    .isEqualTo(beforeDelete.state());
        });
        assertThat(state.findEvents(TENANT, sessionId, 0, 100))
                .extracting(EventRecord::type)
                .doesNotContain("task.updated")
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
