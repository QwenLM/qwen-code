package com.alibaba.qwen.code.managedagent;

import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.childAgent;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.childRun;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.commitDomain;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.hookRef;
import static com.alibaba.qwen.code.managedagent.ManagedExtensionRecordStoreTest.hookResource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The store-side rules of H4e-a (docs/design/2026-10-10-managed-agent-teams.md):
 * every team record binds to its lead Session's journal, a member joins as
 * a live child Session run in one team, new team records open only in an
 * active team, and a task's owner and dependencies, a message's parties and
 * target and a plan's member come from that team. The authority suite
 * managed-session-authority.team.test.ts pins the same rules.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-extension-records;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedTeamStoreTest {
    private static final String TENANT = "tenant-extension";
    private static final String WORKSPACE = "workspace-extension";
    private static final String OPEN =
            "Team record must open in an active team of this Session";
    private static final String ROUTE = "Team message must travel between the"
            + " leader and members of its team";
    private static final String TARGET =
            "Team message must target the Session of its recipient";
    private static final String JOIN = "Team member must join as a child"
            + " Session run of this Session that has not ended";
    private static final JsonNode TEMPLATES = templates();

    @Autowired
    private ManagedSessionStore sessionStore;

    @Autowired
    private ManagedExtensionRecordStore records;

    @Autowired
    private JdbcTemplate jdbc;

    private final CommitResource input = hookResource("child-input",
            "managed-input", "{\"prompt\":\"review\"}".getBytes(
                    StandardCharsets.UTF_8));
    private final CommitResource result = hookResource("child-result",
            "managed-child-result", "{\"summary\":\"clean\"}".getBytes(
                    StandardCharsets.UTF_8));
    private final CommitResource receipt = hookResource("child-receipt",
            "managed-runtime-receipt", "{}".getBytes(StandardCharsets.UTF_8));
    private final CommitResource content = hookResource("team-content",
            "managed-team-content", "check the tests too".getBytes(
                    StandardCharsets.UTF_8));
    private int commands;

    @Test
    void chainsATeamItsBoardItsMailboxAndAPlan() {
        String lead = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = staffed(lead);
        commit(journal, "team_task", task("task-1", 1));
        ObjectNode claimed = task("task-2", 2, "task-1");
        commit(journal, "team_task", claimed);
        claimed.put("owner", "alice");
        claimed.put("status", "in_progress");
        commit(journal, "team_task", claimed);
        for (String state : List.of("planned", "accepting", "accepted",
                "consumed")) {
            commit(journal, "team_message", message("message-1", "leader",
                    "alice", state, "session-run-1"));
        }
        commit(journal, "team_message", message("message-2", "alice",
                "leader", "planned", null));
        commit(journal, "team_message", message("message-2", "alice",
                "leader", "accepting", lead));
        commit(journal, "team_plan", plan("bob"));
        ObjectNode approved = plan("bob");
        approved.put("decision", "approved");
        approved.withObject("/run").put("state", "settled");
        commit(journal, "team_plan", approved);
        commit(journal, "team_state", team(lead, "closing", ALICE, BOB));
        commit(journal, "team_state", team(lead, "deleted", ALICE, BOB));
        assertThat(records.listRecords(TENANT, lead, "team_state"))
                .singleElement().satisfies(team -> assertThat(
                        team.get("lifecycle").textValue())
                        .isEqualTo("deleted"));
        assertThat(records.listRecords(TENANT, lead, "team_task"))
                .hasSize(2);
        assertThat(records.listRecords(TENANT, lead, "team_message"))
                .extracting(each -> each.at("/run/delivery/state")
                        .textValue())
                .containsExactlyInAnyOrder("consumed", "accepting");
        assertThat(records.listRecords(TENANT, lead, "team_plan"))
                .singleElement().satisfies(each -> assertThat(
                        each.get("decision").textValue())
                        .isEqualTo("approved"));
        // No team record is a task: the two members' child runs alone show.
        assertThat(records.listTasks(TENANT, lead, null, null, 10).tasks())
                .hasSize(2);
    }

    @Test
    void bindsATeamToItsLeadAndItsMembersToLiveChildRuns() {
        String lead = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(lead);
        assertRefused("a team another Session leads", lead,
                "Team must be led by this Session",
                () -> commit(journal, "team_state",
                        team("session-other", "active")));
        commit(journal, "team_state", team(lead, "active"));
        assertRefused("a member with no child run", lead, JOIN,
                () -> commit(journal, "team_state",
                        team(lead, "active", ALICE)));
        commitDomain(journal, "shell-1", "child_run",
                childRun("admitted", "intent", null, input), List.of(input));
        assertRefused("a member that is a background Shell", lead, JOIN,
                () -> commit(journal, "team_state", team(lead, "active",
                        member("alice", "shell-x", false))));
        child(journal, lead, "run-1", 4);
        assertRefused("a member whose run ended", lead, JOIN,
                () -> commit(journal, "team_state",
                        team(lead, "active", ALICE)));
        // A run that only launched is live: it may join before it attaches.
        child(journal, lead, "run-2", 1);
        commit(journal, "team_state", team(lead, "active", BOB));
        ObjectNode other = team(lead, "active");
        other.put("teamId", "team-2");
        other.put("name", "other-team");
        commit(journal, "team_state", other);
        ObjectNode poached = team(lead, "active", member("robert", "run-2",
                true));
        poached.put("teamId", "team-2");
        poached.put("name", "other-team");
        assertRefused("a member another team lists", lead,
                "Team member's child run must belong to no other team",
                () -> commit(journal, "team_state", poached));
    }

    @Test
    void opensTeamRecordsOnlyInAnActiveTeamAndLetsOpenOnesDrain() {
        String lead = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = journal(lead);
        assertRefused("a task in a missing team", lead, OPEN,
                () -> commit(journal, "team_task", task("task-1", 1)));
        ExtensionRecordJournal staffed = staffed(lead, journal);
        commit(staffed, "team_message", message("message-1", "leader",
                "alice", "planned", null));
        commit(staffed, "team_plan", plan("bob"));
        commit(staffed, "team_state", team(lead, "closing", ALICE, BOB));
        assertRefused("a task in a closing team", lead, OPEN,
                () -> commit(staffed, "team_task", task("task-1", 1)));
        assertRefused("a message in a closing team", lead, OPEN,
                () -> commit(staffed, "team_message", message("message-2",
                        "leader", "alice", "planned", null)));
        ObjectNode later = plan("bob");
        later.put("requestId", "request-2");
        assertRefused("a plan request in a closing team", lead, OPEN,
                () -> commit(staffed, "team_plan", later));
        commit(staffed, "team_message", message("message-1", "leader",
                "alice", "accepting", "session-run-1"));
        ObjectNode withdrawn = plan("bob");
        withdrawn.withObject("/run").put("state", "cancelled");
        commit(staffed, "team_plan", withdrawn);
    }

    @Test
    void keepsTheBoardInsideItsTeam() {
        String lead = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = staffed(lead);
        ObjectNode other = team(lead, "active");
        other.put("teamId", "team-2");
        other.put("name", "other-team");
        commit(journal, "team_state", other);
        ObjectNode elsewhere = task("elsewhere", 1);
        elsewhere.put("teamId", "team-2");
        commit(journal, "team_task", elsewhere);
        commit(journal, "team_task", task("task-1", 1));
        assertRefused("a second task #1", lead,
                "Team task number must be unique in its team",
                () -> commit(journal, "team_task", task("task-9", 1)));
        ObjectNode stranger = task("task-1", 1);
        stranger.put("owner", "carol");
        assertRefused("a task given to a stranger", lead,
                "Team task owner must be the leader or a member of its team",
                () -> commit(journal, "team_task", stranger));
        ObjectNode led = task("task-1", 1);
        led.put("owner", "leader");
        commit(journal, "team_task", led);
        assertRefused("a blocker outside the team", lead,
                "Team task must be blocked only by tasks of its team",
                () -> commit(journal, "team_task", task("task-2", 2,
                        "elsewhere")));
        assertRefused("a missing blocker", lead,
                "Team task must be blocked only by tasks of its team",
                () -> commit(journal, "team_task", task("task-2", 2,
                        "missing")));
        commit(journal, "team_task", task("task-2", 2, "task-1"));
        commit(journal, "team_task", task("task-3", 3, "task-2"));
        ObjectNode cycle = task("task-1", 1, "task-3");
        cycle.put("owner", "leader");
        assertRefused("a dependency that closes a cycle", lead,
                "Team task dependencies must not form a cycle",
                () -> commit(journal, "team_task", cycle));
        // A second path to the same blocker is no cycle.
        commit(journal, "team_task", task("task-3", 3, "task-2", "task-1"));
    }

    @Test
    void routesMessagesAndPlansWithinTheTeam() {
        String lead = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = staffed(lead);
        child(journal, lead, "run-3", 1);
        commit(journal, "team_state", team(lead, "active", ALICE, BOB,
                member("dave", "run-3", false)));
        assertRefused("a message from a stranger", lead, ROUTE,
                () -> commit(journal, "team_message", message("message-1",
                        "carol", "alice", "planned", null)));
        assertRefused("a message to a stranger", lead, ROUTE,
                () -> commit(journal, "team_message", message("message-1",
                        "leader", "carol", "planned", null)));
        commit(journal, "team_message", message("message-1", "leader",
                "alice", "planned", null));
        // A successor that readdresses the message to a stranger is refused
        // as the conflict it is, before anything looks its recipient up.
        assertRefused("a successor readdressed to a stranger", lead, ROUTE,
                () -> commit(journal, "team_message", message("message-1",
                        "leader", "carol", "accepting", "session-run-1")));
        assertRefused("a message to another member's Session", lead, TARGET,
                () -> commit(journal, "team_message", message("message-1",
                        "leader", "alice", "accepting", "session-run-2")));
        commit(journal, "team_message", message("message-2", "alice", "dave",
                "planned", null));
        assertRefused("a claim before the member attached", lead, TARGET,
                () -> commit(journal, "team_message", message("message-2",
                        "alice", "dave", "accepting", "session-run-3")));
        commit(journal, "team_message", message("message-3", "bob",
                "leader", "planned", null));
        assertRefused("a message to the leader in another Session", lead,
                TARGET, () -> commit(journal, "team_message",
                        message("message-3", "bob", "leader", "accepting",
                                "session-run-2")));
        commit(journal, "team_message", message("message-3", "bob", "leader",
                "accepting", lead));
        String planning = "Team plan must come from a member of its team"
                + " that requires plan mode";
        assertRefused("a plan from a member that need not plan", lead,
                planning, () -> commit(journal, "team_plan", plan("alice")));
        assertRefused("a plan from a stranger", lead, planning,
                () -> commit(journal, "team_plan", plan("carol")));
        commit(journal, "team_plan", plan("bob"));
    }

    @Test
    void refusesTeamContentTheSessionDoesNotHold() {
        String lead = UUID.randomUUID().toString();
        ExtensionRecordJournal journal = staffed(lead);
        ObjectNode unheld = task("task-1", 1);
        unheld.withObject("/descriptionRef").put("resourceId",
                "never-committed");
        assertRefused("a task citing a description the Session does not"
                + " hold", lead, ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                null, () -> journal.commit(journal.requestDomain("task-1",
                        "team_task", unheld, List.of(), 1_000)));
    }

    private static final ObjectNode ALICE = member("alice", "run-1", false);
    private static final ObjectNode BOB = member("bob", "run-2", true);

    private static ObjectNode member(String name, String run,
            boolean planModeRequired) {
        return JsonNodeFactory.instance.objectNode().put("name", name)
                .put("childRunId", run)
                .put("planModeRequired", planModeRequired);
    }

    private static ObjectNode team(String lead, String lifecycle,
            ObjectNode... members) {
        ObjectNode body = TEMPLATES.get("team_state").deepCopy();
        body.put("leadSessionId", lead);
        body.put("lifecycle", lifecycle);
        ArrayNode roster = body.putArray("members");
        for (ObjectNode member : members) {
            roster.add(member.deepCopy());
        }
        body.put("membershipRevision", members.length + 1);
        body.withObject("/run").put("state", "deleted".equals(lifecycle)
                ? "cancelled" : "admitted");
        return body;
    }

    private ObjectNode task(String taskId, int number, String... blockedBy) {
        ObjectNode body = TEMPLATES.get("team_task").deepCopy();
        body.put("taskId", taskId);
        body.put("number", number);
        body.set("descriptionRef", hookRef(content));
        ArrayNode blockers = body.putArray("blockedBy");
        for (String blocker : blockedBy) {
            blockers.add(blocker);
        }
        return body;
    }

    private ObjectNode message(String messageId, String from, String to,
            String state, String target) {
        ObjectNode body = TEMPLATES.get("team_message").deepCopy();
        body.put("messageId", messageId);
        body.put("from", from);
        body.put("to", to);
        body.set("contentRef", hookRef(content));
        body.put("contentDigest", content.digest());
        if ("planned".equals(state)) {
            body.putNull("targetSessionId");
        } else {
            body.put("targetSessionId", target);
        }
        if ("accepted".equals(state) || "consumed".equals(state)) {
            body.put("inputId", messageId + ":input");
        }
        body.withObject("/run/delivery").put("state", state);
        return body;
    }

    private ObjectNode plan(String member) {
        ObjectNode body = TEMPLATES.get("team_plan").deepCopy();
        body.put("member", member);
        body.set("planRef", hookRef(content));
        return body;
    }

    /** Commits the first {@code count} revisions of child run {@code run},
     * which attaches to {@code session-<run>}. */
    private void child(ExtensionRecordJournal journal, String lead,
            String run, int count) {
        List<String[]> steps = List.of(
                new String[] {"admitted", "intent", null},
                new String[] {"running", "dispatch_started", "binding-1"},
                new String[] {"running", "running_attached", "binding-1"},
                new String[] {"settled", "settled", "binding-1"});
        for (int index = 0; index < count; index++) {
            String[] step = steps.get(index);
            ObjectNode body = childAgent(lead, "sent", step[0], step[1],
                    step[2], input);
            body.put("childRunId", run);
            body.withObject("/run").put("executionCallId", "call-" + run);
            if (index > 0) {
                body.withObject("/run").put("dispatchId", "dispatch-" + run);
            }
            if (index > 1) {
                body.put("childSessionId", "session-" + run);
            }
            List<CommitResource> closure = List.of(input);
            if (index == 3) {
                body.put("stopReason", "completed");
                body.set("resultRef", hookRef(result));
                body.set("terminalReceiptRef", hookRef(receipt));
                closure = List.of(result, receipt);
            }
            commitDomain(journal, run + ":" + (index + 1), "child_run", body,
                    closure);
        }
    }

    /** A team with alice (run-1) and bob (run-2), both attached. */
    private ExtensionRecordJournal staffed(String lead) {
        return staffed(lead, journal(lead));
    }

    private ExtensionRecordJournal staffed(String lead,
            ExtensionRecordJournal journal) {
        child(journal, lead, "run-1", 3);
        child(journal, lead, "run-2", 3);
        commit(journal, "team_state", team(lead, "active"));
        commit(journal, "team_state", team(lead, "active", ALICE));
        commit(journal, "team_state", team(lead, "active", ALICE, BOB));
        return journal;
    }

    private void commit(ExtensionRecordJournal journal, String domain,
            JsonNode body) {
        commands++;
        commitDomain(journal, "team-command-" + commands, domain, body,
                "team_state".equals(domain) ? List.of() : List.of(content));
    }

    private ExtensionRecordJournal journal(String sessionId) {
        return new ExtensionRecordJournal(sessionStore, TENANT, WORKSPACE,
                sessionId).open();
    }

    /** A refused commit is a 409 naming its rule, and leaves no revision
     * behind. */
    private void assertRefused(String label, String sessionId,
            String message, ThrowingCallable commit) {
        assertRefused(label, sessionId,
                ManagedExtensionRecordStore.ERROR_REJECTED, message, commit);
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

    private static JsonNode templates() {
        try {
            return ManagedTeamRecordContractTest.fixtures().get("templates");
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}
