package com.alibaba.qwen.code.managedagent;

import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.childAgent;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.childRun;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.commitDomain;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.hookRef;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.hookResource;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.settleChildAgentChain;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.settleChildSessionChain;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The store-side rules of H4d (docs/design/2026-10-09-managed-session-messages.md):
 * a session_message binds to the child run or the lineage its Session
 * holds, a receipt opens with exactly its input, and a continuation follows
 * a completed predecessor that no other run continues. The authority suite
 * managed-session-authority.session-message.test.ts pins the same rules.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-extension-records;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedSessionMessageStoreTest {
    private static final String TENANT = "tenant-extension";
    private static final String WORKSPACE = "workspace-extension";
    private static final String REJECTED =
            ManagedExtensionRecordStore.ERROR_REJECTED;
    // Spelled out, not read from the store: the TypeScript HTTP store
    // matches this literal to treat the refusal as a rollbackable
    // non-commit, so renaming the constant must fail here.
    private static final String LINEAGE = "session_message_lineage_refused";
    private static final String BINDING =
            "An inbound session message opens together with its input, and"
                    + " no other revision carries one";

    @Autowired
    private ManagedSessionStore sessionStore;

    @Autowired
    private ManagedExtensionRecordStore records;

    @Autowired
    private ManagedAgentService agents;

    @Autowired
    private JdbcTemplate jdbc;

    private final CommitResource input = hookResource("child-input",
            "managed-input", "{\"prompt\":\"audit\"}".getBytes(
                    StandardCharsets.UTF_8));
    private final CommitResource result = hookResource("child-result",
            "managed-child-result", "{\"summary\":\"clean\"}".getBytes(
                    StandardCharsets.UTF_8));
    private final CommitResource receipt = hookResource("child-receipt",
            "managed-runtime-receipt", "{}".getBytes(StandardCharsets.UTF_8));
    private final CommitResource content = hookResource("message-content",
            "managed-message-content", "also check the tests".getBytes(
                    StandardCharsets.UTF_8));
    private final CommitResource otherContent = hookResource(
            "message-other", "managed-message-content",
            "a different message".getBytes(StandardCharsets.UTF_8));
    private final CommitResource notification = hookResource(
            "message-notification", "managed-input",
            "{\"text\":\"also check the tests\"}".getBytes(
                    StandardCharsets.UTF_8));

    @Test
    void chainsAParentMessageToItsAttachedChild() {
        String parent = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(parent);
        attachChild(parent, journal);
        for (String state : List.of("planned", "accepting", "accepted",
                "consumed")) {
            commitDomain(journal, "message-1:" + state, "session_message",
                    toChild(parent, state), List.of(content));
        }
        List<JsonNode> committed = records.listRecords(TENANT, parent,
                "session_message");
        assertThat(committed).hasSize(1);
        assertThat(committed.get(0).at("/run/delivery/state").textValue())
                .isEqualTo("consumed");
        assertThat(committed.get(0).get("inputId").textValue())
                .isEqualTo("message-1:input");
        // A message is not a task: the child run's task alone shows.
        assertThat(records.listTasks(TENANT, parent, null, null, 10).tasks())
                .hasSize(1);
    }

    @Test
    void bindsAParentMessageToALiveAttachedChildRun() {
        String missing = UUID.randomUUID().toString();
        ExtensionRecordJournal missingJournal = journal(missing);
        assertRefused("a message to a missing child", missing,
                "Session message must name a child Session run of this"
                        + " Session",
                () -> commit(missingJournal, "message-1:1",
                        toChild(missing, "planned"), null));
        String shell = UUID.randomUUID().toString();
        ExtensionRecordJournal shellJournal = journal(shell);
        commitDomain(shellJournal, "shell-1", "child_run",
                childRun("admitted", "intent", null, input), List.of(input));
        ObjectNode toShell = toChild(shell, "planned");
        toShell.put("childRunId", "shell-x");
        assertRefused("a message to a background Shell", shell,
                "Session message must name a child Session run of this"
                        + " Session",
                () -> commit(shellJournal, "message-1:1", toShell, null));
        String parent = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(parent);
        attachChild(parent, journal);
        ObjectNode unheld = toChild(parent, "planned");
        unheld.withObject("/contentRef").put("resourceId", "never-committed");
        assertRefused("a message citing content the Session does not hold",
                parent, ManagedSessionStoreModels.ERROR_RESOURCE_MISSING, null,
                () -> journal.commit(journal.requestDomain("message-1:1",
                        "session_message", unheld, List.of(), 1_000)));
        ObjectNode foreign = toChild(parent, "planned");
        foreign.put("targetSessionId", "session-other");
        assertRefused("a message to another Session", parent,
                "Session message to a child must target the Session its run"
                        + " attached",
                () -> commit(journal, "message-1:1", foreign, null));
        ObjectNode forged = toChild(parent, "planned");
        forged.put("senderSessionId", "session-other");
        assertRefused("an outbox entry another Session sent", parent,
                "Outbound session message must be sent by this Session",
                () -> commit(journal, "message-1:1", forged, null));
        commitDomain(journal, "message-1:1", "session_message",
                toChild(parent, "planned"), List.of(content));
        assertRefused("an outbox entry carrying an input", parent, BINDING,
                () -> commit(journal, "message-1:2",
                        toChild(parent, "accepting"), "message-1:input"));
        // The target is fixed only at handover, so nothing claims a message
        // to a child before its Session exists.
        String early = UUID.randomUUID().toString();
        ExtensionRecordJournal earlyJournal = journal(early);
        dispatchChild(early, earlyJournal);
        commitDomain(earlyJournal, "message-1:1", "session_message",
                toChild(early, "planned"), List.of(content));
        assertRefused("a claim before the child attached", early,
                "Session message to a child must target the Session its run"
                        + " attached",
                () -> commit(earlyJournal, "message-1:2",
                        toChild(early, "accepting"), null));
        String ended = UUID.randomUUID().toString();
        ExtensionRecordJournal endedJournal = journal(ended);
        settleChildAgentChain(ended, "sent", endedJournal, input, result,
                receipt);
        assertRefused("a message to an ended child", ended,
                "Session message to a child must name a run that has not"
                        + " ended",
                () -> commit(endedJournal, "message-1:1",
                        toChild(ended, "planned"), null));
    }

    @Test
    void keepsDeliveringAMessageSentBeforeItsChildEnded() {
        String parent = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(parent);
        attachChild(parent, journal);
        commitDomain(journal, "message-1:1", "session_message",
                toChild(parent, "planned"), List.of(content));
        ObjectNode settled = childAgent(parent, "sent", "settled", "settled",
                "binding-1", input);
        settled.withObject("/run").put("dispatchId", "dispatch-1");
        settled.put("childSessionId", "session-child");
        settled.put("stopReason", "completed");
        settled.set("resultRef", hookRef(result));
        settled.set("terminalReceiptRef", hookRef(receipt));
        commitDomain(journal, "agent-4", "child_run", settled,
                List.of(result, receipt));
        commitDomain(journal, "message-1:2", "session_message",
                toChild(parent, "accepting"), List.of(content));
        assertThat(records.listRecords(TENANT, parent, "session_message")
                .get(0).at("/run/delivery/state").textValue())
                .isEqualTo("accepting");
    }

    @Test
    void receivesAChildMessageWithExactlyItsInput() {
        String early = UUID.randomUUID().toString();
        ExtensionRecordJournal earlyJournal = journal(early);
        dispatchChild(early, earlyJournal);
        assertRefused("a message before its child attached", early,
                "Session message from a child arrives only once its run"
                        + " attached",
                () -> commit(earlyJournal, "message-9:accept",
                        fromChild(early, "accepted"), "message-9:input"));
        String parent = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(parent);
        attachChild(parent, journal);
        assertRefused("a receipt bundling a second input", parent, BINDING,
                () -> journal.commit(journal.requestDomainWithInputs(
                        "message-9:accept", "session_message",
                        fromChild(parent, "accepted"), List.of(content),
                        List.of("message-9:input", "message-9:extra"),
                        notification)));
        // Two inputs, two turns, one id: each would still be consumed.
        assertRefused("a receipt bundling its input twice", parent, BINDING,
                () -> journal.commit(journal.requestDomainWithInputs(
                        "message-9:accept", "session_message",
                        fromChild(parent, "accepted"), List.of(content),
                        List.of("message-9:input", "message-9:input"),
                        notification)));
        assertRefused("a receipt without its input", parent, BINDING,
                () -> commit(journal, "message-9:accept",
                        fromChild(parent, "accepted"), null));
        assertRefused("a receipt with another input", parent, BINDING,
                () -> commit(journal, "message-9:accept",
                        fromChild(parent, "accepted"), "message-8:input"));
        ObjectNode stranger = fromChild(parent, "accepted");
        stranger.put("senderSessionId", "session-other");
        assertRefused("a message from another Session", parent,
                "Session message from a child must come from the Session its"
                        + " run attached",
                () -> commit(journal, "message-9:accept", stranger,
                        "message-9:input"));
        ObjectNode misaddressed = fromChild(parent, "accepted");
        misaddressed.put("targetSessionId", "session-other");
        assertRefused("a receipt addressed to another Session", parent,
                "Inbound session message must be addressed to this Session",
                () -> commit(journal, "message-9:accept", misaddressed,
                        "message-9:input"));
        CommitTransactionRequest accepted = journal.requestDomainWithInput(
                "message-9:accept", "session_message",
                fromChild(parent, "accepted"), List.of(content),
                "message-9:input", notification);
        journal.commit(accepted);
        journal.committed(accepted);
        assertRefused("a redelivery that brings the input again", parent,
                BINDING, () -> commit(journal, "message-9:redelivered",
                        fromChild(parent, "accepted"), "message-9:input"));
        ObjectNode changed = fromChild(parent, "accepted");
        changed.set("contentRef", hookRef(otherContent));
        changed.put("contentDigest", otherContent.digest());
        assertRefused("another message under the taken id", parent,
                "session_message record message-9 cannot follow its revision",
                () -> journal.commit(journal.requestDomainWithInput(
                        "message-9:changed", "session_message", changed,
                        List.of(otherContent), "message-9:input-2",
                        notification)));
        commitDomain(journal, "message-9:consume", "session_message",
                fromChild(parent, "consumed"), List.of(content));
        assertThat(records.listRecords(TENANT, parent, "session_message")
                .get(0).at("/run/delivery/state").textValue())
                .isEqualTo("consumed");
    }

    @Test
    void bindsAChildsOwnRoutesToItsLineage() {
        String parent = UUID.randomUUID().toString();
        String child = session();
        ExtensionRecordJournal journal = journal(child);
        String toParent = "Session message to a parent must follow this"
                + " Session's lineage";
        String fromParent = "Session message from a parent must follow this"
                + " Session's lineage";
        assertRefused("a root Session writing to a parent", child, LINEAGE,
                toParent, () -> commit(journal, "message-2:1",
                        toParent(child, parent, "planned"), null));
        jdbc.update("UPDATE managed_agent_session SET parent_session_id = ?,"
                        + " root_session_id = ?, parent_child_run_id = ?,"
                        + " child_depth = 1 WHERE tenant_id = ?"
                        + " AND session_id = ?",
                parent, parent, "run-x", TENANT, child);
        ObjectNode elsewhere = toParent(child, "session-other", "planned");
        assertRefused("a message to another parent", child, LINEAGE,
                toParent, () -> commit(journal, "message-2:1", elsewhere,
                        null));
        ObjectNode sibling = toParent(child, parent, "planned");
        sibling.put("childRunId", "run-other");
        assertRefused("a message along another edge", child, LINEAGE,
                toParent, () -> commit(journal, "message-2:1", sibling, null));
        // The parent may be left for the handover to fix.
        commitDomain(journal, "message-2:1", "session_message",
                toParent(child, null, "planned"), List.of(content));
        commitDomain(journal, "message-2:2", "session_message",
                toParent(child, parent, "accepting"), List.of(content));
        ObjectNode impostor = toChildFrom("session-other", child);
        assertRefused("a message from another parent", child, LINEAGE,
                fromParent, () -> commit(journal, "message-3:accept",
                        impostor, "message-3:input"));
        ObjectNode astray = toChildFrom(parent, child);
        astray.put("childRunId", "run-other");
        assertRefused("a parent's message along another edge", child,
                LINEAGE, fromParent, () -> commit(journal, "message-3:accept",
                        astray, "message-3:input"));
        CommitTransactionRequest accepted = journal.requestDomainWithInput(
                "message-3:accept", "session_message",
                toChildFrom(parent, child), List.of(content),
                "message-3:input", notification);
        journal.commit(accepted);
        journal.committed(accepted);
        assertThat(records.listRecords(TENANT, child, "session_message"))
                .hasSize(2);
    }

    @Test
    void followsACompletedPredecessorThatNoOtherRunContinues() {
        String parent = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(parent);
        assertRefused("a continuation of a missing run", parent,
                "Child continuation must name a child run of this Session of"
                        + " its own kind",
                () -> commit(journal, "run-y:1",
                        continuation(parent, "run-y"), null, "child_run"));
        commitDomain(journal, "agent-1", "child_run", childAgent(parent,
                "sent", "admitted", "intent", null, input), List.of(input));
        assertRefused("a continuation of an unfinished run", parent,
                "Child continuation must follow a run that completed with its"
                        + " result",
                () -> commit(journal, "run-y:1",
                        continuation(parent, "run-y"), null, "child_run"));
        String settled = UUID.randomUUID().toString();
        ExtensionRecordJournal settledJournal = journal(settled);
        settleChildAgentChain(settled, "sent", settledJournal, input, result,
                receipt);
        ObjectNode workflow = continuation(settled, "run-y");
        workflow.put("kind", "workflow");
        assertRefused("a continuation of another kind", settled,
                "Child continuation must name a child run of this Session of"
                        + " its own kind",
                () -> commit(settledJournal, "run-y:1", workflow, null,
                        "child_run"));
        Map<String, Consumer<ObjectNode>> changes = Map.of(
                "scope", body -> body.put("ownerScopeId", "scope-other"),
                "depth", body -> body.put("depth", 2),
                "workspace mode", body -> body.put("workspaceMode",
                        "snapshot"),
                "working directory", body -> body.put("workingDirectory",
                        "packages"));
        changes.forEach((label, change) -> {
            ObjectNode changed = continuation(settled, "run-y");
            change.accept(changed);
            assertRefused("a continuation that changes its " + label,
                    settled, "Child continuation must keep its predecessor's"
                            + " scope, tree, workspace and definition",
                    () -> commit(settledJournal, "run-y:1", changed, null,
                            "child_run"));
        });
        ObjectNode redefined = continuation(settled, "run-y");
        redefined.withObject("/run/definition").put("definitionDigest",
                "e".repeat(64));
        assertRefused("a continuation that changes its definition", settled,
                "Child continuation must keep its predecessor's scope, tree,"
                        + " workspace and definition",
                () -> commit(settledJournal, "run-y:1", redefined, null,
                        "child_run"));
        String taken = "Child continuation must name a predecessor no other"
                + " run continues";
        commitDomain(settledJournal, "run-y:1", "child_run",
                continuation(settled, "run-y"), List.of(input));
        assertRefused("a second continuation of the same run", settled,
                taken, () -> commit(settledJournal, "run-z:1",
                        continuation(settled, "run-z"), null, "child_run"));
        // A continuation proven never to have started releases it.
        ObjectNode unstarted = continuation(settled, "run-y");
        unstarted.put("stopReason", "creation_failed");
        unstarted.withObject("/run").put("state", "failed")
                .put("execution", "not_started_proven")
                .putObject("delivery").put("target", "session")
                .put("state", "cancelled");
        commitDomain(settledJournal, "run-y:2", "child_run", unstarted,
                List.of());
        commitDomain(settledJournal, "run-z:1", "child_run",
                continuation(settled, "run-z"), List.of(input));
        assertRefused("a continuation beside a live one", settled, taken,
                () -> commit(settledJournal, "run-w:1",
                        continuation(settled, "run-w"), null, "child_run"));
    }

    @Test
    void refusesToContinueAFailedOrStoppedRunOrToLeaveItsTree() {
        String failed = UUID.randomUUID().toString();
        ExtensionRecordJournal failedJournal = journal(failed);
        attachChild(failed, failedJournal);
        ObjectNode ended = childAgent(failed, "sent", "failed", "settled",
                "binding-1", input);
        ended.withObject("/run").put("dispatchId", "dispatch-1");
        ended.put("childSessionId", "session-child");
        ended.put("stopReason", "child_failed");
        commitDomain(failedJournal, "agent-4", "child_run", ended, List.of());
        assertRefused("a continuation of a failed run", failed,
                "Child continuation must follow a run that completed with its"
                        + " result",
                () -> commit(failedJournal, "run-y:1",
                        continuation(failed, "run-y"), null, "child_run"));
        String stopped = UUID.randomUUID().toString();
        ExtensionRecordJournal stoppedJournal = journal(stopped);
        settleChildSessionChain(stopped, "sent", stoppedJournal, input,
                result, receipt, body -> {
                    body.put("stopRequested", "settled".equals(
                            body.at("/run/state").textValue()));
                    return body;
                });
        assertRefused("a continuation of a run whose stop was requested",
                stopped, "Child continuation cannot revive a run whose stop"
                        + " was requested",
                () -> commit(stoppedJournal, "run-y:1",
                        continuation(stopped, "run-y"), null, "child_run"));
        // Past the first level the tree root is not this Session, so only
        // the continuation rule binds a continuation to it.
        String nested = UUID.randomUUID().toString();
        ExtensionRecordJournal nestedJournal = journal(nested);
        settleChildSessionChain(nested, "sent", nestedJournal, input, result,
                receipt, body -> nested(body, "session-root"));
        assertRefused("a continuation in another tree", nested,
                "Child continuation must keep its predecessor's scope, tree,"
                        + " workspace and definition",
                () -> commit(nestedJournal, "run-y:1", nested(
                        continuation(nested, "run-y"), "session-other"),
                        null, "child_run"));
        commitDomain(nestedJournal, "run-y:1", "child_run", nested(
                continuation(nested, "run-y"), "session-root"),
                List.of(input));
    }

    private static ObjectNode nested(ObjectNode body, String root) {
        body.put("depth", 2);
        body.put("rootSessionId", root);
        return body;
    }

    /** Commits the child run run-x through its dispatch. */
    private static void dispatchChild(String parent,
            ExtensionRecordJournal journal) {
        CommitResource launch = hookResource("child-input", "managed-input",
                "{\"prompt\":\"audit\"}".getBytes(StandardCharsets.UTF_8));
        commitDomain(journal, "agent-1", "child_run", childAgent(parent,
                "sent", "admitted", "intent", null, launch), List.of(launch));
        ObjectNode dispatching = childAgent(parent, "sent", "running",
                "dispatch_started", "binding-1", launch);
        dispatching.withObject("/run").put("dispatchId", "dispatch-1");
        commitDomain(journal, "agent-2", "child_run", dispatching, List.of());
    }

    /** Commits the child run run-x through its attach to session-child. */
    private static void attachChild(String parent,
            ExtensionRecordJournal journal) {
        dispatchChild(parent, journal);
        CommitResource launch = hookResource("child-input", "managed-input",
                "{\"prompt\":\"audit\"}".getBytes(StandardCharsets.UTF_8));
        ObjectNode attached = childAgent(parent, "sent", "running",
                "running_attached", "binding-1", launch);
        attached.withObject("/run").put("dispatchId", "dispatch-1");
        attached.put("childSessionId", "session-child");
        commitDomain(journal, "agent-3", "child_run", attached, List.of());
    }

    private ObjectNode continuation(String parent, String childRunId) {
        ObjectNode body = childAgent(parent, "sent", "admitted", "intent",
                null, input);
        body.put("childRunId", childRunId);
        body.put("predecessorChildRunId", "run-x");
        body.withObject("/run").put("executionCallId", "call-" + childRunId);
        return body;
    }

    private ObjectNode message(String direction, String route,
            String sender, String target, String inputId,
            String executionCallId, String state) {
        ObjectNode body = JsonNodeFactory.instance.objectNode();
        body.put("direction", direction);
        body.put("messageId", "outbound".equals(direction)
                ? ("to_child".equals(route) ? "message-1" : "message-2")
                : ("to_parent".equals(route) ? "message-9" : "message-3"));
        body.put("route", route);
        body.put("childRunId", "run-x");
        body.put("senderSessionId", sender);
        if (target == null) {
            body.putNull("targetSessionId");
        } else {
            body.put("targetSessionId", target);
        }
        body.set("contentRef", hookRef(content));
        body.put("contentDigest", content.digest());
        if (inputId == null) {
            body.putNull("inputId");
        } else {
            body.put("inputId", inputId);
        }
        ObjectNode run = body.putObject("run");
        run.put("state", "settled");
        run.putNull("reason");
        run.putNull("definition");
        if (executionCallId == null) {
            run.putNull("executionCallId");
        } else {
            run.put("executionCallId", executionCallId);
        }
        run.putNull("effectId");
        run.putNull("dispatchId");
        run.putNull("deliveryId");
        run.putNull("execution");
        run.putNull("runtime");
        run.putObject("delivery").put("target", "session").put("state",
                state);
        return body;
    }

    /** The parent's outbox entry for a message to run-x's Session. */
    private ObjectNode toChild(String parent, String state) {
        return message("outbound", "to_child", parent,
                "planned".equals(state) ? null : "session-child",
                "accepted".equals(state) || "consumed".equals(state)
                        ? "message-1:input" : null,
                "call-send-1", state);
    }

    /** The parent's receipt of a message run-x's Session sent. */
    private ObjectNode fromChild(String parent, String state) {
        return message("inbound", "to_parent", "session-child", parent,
                "message-9:input", null, state);
    }

    /** A child's outbox entry for a message to its parent. */
    private ObjectNode toParent(String child, String parent, String state) {
        return message("outbound", "to_parent", child, parent, null,
                "call-send-2", state);
    }

    /** A child's receipt of a message its parent sent. */
    private ObjectNode toChildFrom(String parent, String child) {
        return message("inbound", "to_child", parent, child,
                "message-3:input", null, "accepted");
    }

    /** Commits {@code body} as a session_message revision, with an input
     * named {@code inputId} when it is not null. */
    private void commit(ExtensionRecordJournal journal, String commandId,
            JsonNode body, String inputId) {
        commit(journal, commandId, body, inputId, "session_message");
    }

    private void commit(ExtensionRecordJournal journal, String commandId,
            JsonNode body, String inputId, String domain) {
        List<CommitResource> closure = "child_run".equals(domain)
                ? List.of(input) : List.of(content);
        CommitTransactionRequest request = inputId == null
                ? journal.requestDomain(commandId, domain, body, closure,
                        1_000)
                : journal.requestDomainWithInput(commandId, domain, body,
                        closure, inputId, notification);
        journal.commit(request);
        journal.committed(request);
    }

    private String session() {
        return agents.createSession(TENANT, "message-" + UUID.randomUUID(),
                "qwen-code", null, "messages", Map.of(), List.of())
                .sessionId();
    }

    private ExtensionRecordJournal journal(String sessionId) {
        return new ExtensionRecordJournal(sessionStore, TENANT, WORKSPACE,
                sessionId).open();
    }

    /** A refused commit is a 409 naming its rule, and leaves no revision
     * behind. */
    private void assertRefused(String label, String sessionId,
            String message, ThrowingCallable commit) {
        assertRefused(label, sessionId, REJECTED, message, commit);
    }

    private void assertRefused(String label, String sessionId, String code,
            String message, ThrowingCallable commit) {
        long revisions = revisions(sessionId);
        assertThatThrownBy(commit).as(label)
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode()).as(label).isEqualTo(code);
                    if (message != null) {
                        assertThat(error.getStatus()).as(label)
                                .isEqualTo(HttpStatus.CONFLICT);
                        assertThat(error.getMessage()).as(label)
                                .contains(message);
                    }
                });
        assertThat(revisions(sessionId)).as(label).isEqualTo(revisions);
    }

    private long revisions(String sessionId) {
        Long total = jdbc.queryForObject("SELECT COALESCE(SUM(revision), 0)"
                        + " FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Long.class, TENANT, sessionId);
        return total == null ? 0 : total;
    }
}
