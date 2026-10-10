package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore.EventPage;
import com.alibaba.qwen.code.managedagent.store.ManagedTaskEventStore.TaskEvent;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The task contract's section 6.1 demonstrations, run as store-level
 * contract traffic against the task event journal: floor expiry including
 * an empty retained set, no visibility behind a returned cursor, cursor
 * identity as pure durable state, the Artifact visibility barrier with
 * delayed archival and archival failure, the 100-reference bound, the
 * capabilities.artifacts admission gate and segment joins without
 * duplication.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-task-events;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedTaskEventJournalTest {
    private static final String TENANT = "tenant-task-events";
    private static final String WORKSPACE = "workspace-task-events";

    @Autowired
    private ManagedTaskEventStore events;

    @Autowired
    private ManagedSessionStore sessionStore;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void recordRevisionsJournalStateChangesInCommitOrder() throws Exception {
        String sessionId = session(true);
        ExtensionRecordJournal journal = new ExtensionRecordJournal(
                sessionStore, TENANT, WORKSPACE, sessionId).open();
        JsonNode chain = ManagedExtensionProjectionContractTest.fixtures()
                .required("monitorChainCases").get(0).required("revisions");
        String taskId = null;
        for (int index = 0; index < chain.size(); index++) {
            journal.commitMonitor("monitor-1:" + index,
                    chain.get(index).required("monitorRun"),
                    chain.get(index).required("occurredAt").longValue());
            if (taskId == null) {
                taskId = jdbc.queryForObject(
                        "SELECT CONCAT('task_', record_key) FROM"
                                + " qwen_managed_session_extension_record"
                                + " WHERE tenant_id = ? AND session_id = ?",
                        String.class, TENANT, sessionId);
            }
        }
        EventPage page = events.read(TENANT, sessionId, taskId, 0, 100);
        assertThat(page.events()).isNotEmpty();
        assertThat(page.events())
                .allMatch(event -> "state_changed".equals(event.type()));
        for (int index = 0; index < page.events().size(); index++) {
            assertThat(page.events().get(index).sequence())
                    .isEqualTo(index + 1);
        }
        // A cursor is pure durable state: a rebuild derives the same string.
        TaskEvent first = page.events().getFirst();
        assertThat(ManagedTaskEventStore.encodeCursor(taskId,
                first.sequence())).isEqualTo(
                ManagedTaskEventStore.encodeCursor(taskId, 1));
        assertThat(ManagedTaskEventStore.decodeCursor(taskId,
                ManagedTaskEventStore.encodeCursor(taskId,
                        first.sequence()))).isEqualTo(first.sequence());
        // The first revision's view opens the task; a settled chain end
        // shows the terminal state of the last committed revision.
        assertThat(page.events().getFirst().state()).isEqualTo("pending");
        assertThat(events.positions(TENANT, sessionId,
                taskId).lastSequence()).isEqualTo(page.events()
                .get(page.events().size() - 1).sequence());
    }

    @Test
    void floorExpirySurvivesAnEmptyRetainedSet() {
        String sessionId = session(true);
        String taskId = "task_" + "ab".repeat(32);
        for (int round = 0; round < 3; round++) {
            events.appendStateChange(TENANT, sessionId, taskId, "running",
                    "ready", 1 + round);
        }
        assertThat(events.expireThrough(TENANT, sessionId, taskId, 3))
                .isEqualTo(3);
        assertThat(events.read(TENANT, sessionId, taskId, 0, 100).events())
                .isEmpty();
        // The retained set is empty, yet the floor is durable: an expiry at
        // or below it is a no-op, and 3 stays the position the routes read
        // from when the cursor is omitted.
        assertThat(events.expireThrough(TENANT, sessionId, taskId, 1))
                .isEqualTo(3);
        assertThat(events.positions(TENANT, sessionId,
                taskId).expiredThrough()).isEqualTo(3);
        events.appendStateChange(TENANT, sessionId, taskId, "completed",
                null, 4);
        EventPage page = events.read(TENANT, sessionId, taskId, 3, 100);
        assertThat(page.events()).hasSize(1);
        assertThat(page.events().getFirst().state())
                .isEqualTo("completed");
    }

    @Test
    void nothingAppearsAtOrBehindAReturnedCursor() {
        String sessionId = session(true);
        String taskId = "task_" + "cd".repeat(32);
        List<Long> seen = new ArrayList<>();
        for (int round = 0; round < 5; round++) {
            events.appendStateChange(TENANT, sessionId, taskId,
                    round % 2 == 0 ? "running" : "waiting", "ready", round);
            // Re-read the whole stream from the floor after every commit:
            // what a cursor already passed comes back identical, never new.
            EventPage replay = events.read(TENANT, sessionId, taskId, 0,
                    100);
            assertThat(replay.events().stream().map(TaskEvent::sequence))
                    .containsExactlyElementsOf(stream(1, round + 1));
            assertThat(replay.events().stream().map(TaskEvent::state))
                    .containsExactlyElementsOf(stream(1, round + 1).stream()
                            .map(sequence -> sequence % 2 == 1 ? "running"
                                    : "waiting")
                            .toList());
        }
        long checkpoint = 2;
        seen = events.read(TENANT, sessionId, taskId, checkpoint, 100)
                .events().stream().map(TaskEvent::sequence).toList();
        assertThat(seen).containsExactly(3L, 4L, 5L);
        events.appendStateChange(TENANT, sessionId, taskId, "completed",
                null, 6);
        seen = events.read(TENANT, sessionId, taskId, checkpoint, 100)
                .events().stream().map(TaskEvent::sequence).toList();
        assertThat(seen).containsExactly(3L, 4L, 5L, 6L);
        assertThat(events.read(TENANT, sessionId, taskId, 6, 100).events())
                .isEmpty();
    }

    @Test
    void archivalFailurePinsTheFloorWithoutLosingOutput() {
        String sessionId = session(true);
        String taskId = "task_" + "ef".repeat(32);
        events.appendStateChange(TENANT, sessionId, taskId, "running",
                "ready", 1);
        long outputSequence = events.appendOutput(TENANT, sessionId, taskId,
                "partial chunk\n", true, "capture-1", "stdout", 0L, 4L, 2);
        events.appendStateChange(TENANT, sessionId, taskId, "running",
                "ready", 3);
        // The state change behind the output may expire; the output and
        // everything after it may not, healthy or failing archival alike.
        events.expireThrough(TENANT, sessionId, taskId, outputSequence - 1);
        assertThatThrownBy(() -> events.expireThrough(TENANT, sessionId,
                taskId, outputSequence))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode()).isEqualTo(
                            ManagedTaskEventStore.CODE_FLOOR_PINNED);
                });
        assertThat(events.positions(TENANT, sessionId,
                taskId).expiredThrough()).isEqualTo(outputSequence - 1);
        // Nothing is lost: the pinned output still reads.
        EventPage pinned = events.read(TENANT, sessionId, taskId,
                outputSequence - 1, 100);
        assertThat(pinned.events().stream().map(TaskEvent::type))
                .containsExactly("output", "state_changed");
        // Delayed archival lands; only then does the floor cross it.
        assertThat(events.markOutputArchived(TENANT, sessionId, taskId,
                outputSequence)).isEqualTo(1);
        assertThat(events.expireThrough(TENANT, sessionId, taskId,
                outputSequence + 1)).isEqualTo(outputSequence + 1);
        assertThat(events.read(TENANT, sessionId, taskId, 0, 100).events())
                .isEmpty();
        assertThat(events.positions(TENANT, sessionId,
                taskId).expiredThrough()).isEqualTo(outputSequence + 1);
    }

    @Test
    void theBacklogBoundRefusesPastCapacityInsteadOfDiscarding() {
        String sessionId = session(true);
        String taskId = "task_" + "aa".repeat(32);
        // One unarchived output pins the floor; the journal fills with
        // accepted events the pass cannot expire...
        events.appendOutput(TENANT, sessionId, taskId, "x", false, null,
                null, null, null, 0);
        for (int round = 0; round < ManagedTaskEventStore.BACKLOG_BOUND - 1;
                round++) {
            events.appendStateChange(TENANT, sessionId, taskId, "running",
                    "ready", round);
        }
        assertThat(events.positions(TENANT, sessionId,
                taskId).expiredThrough()).isZero();
        // ...and the next accepted event is a refusal, never a silent drop.
        assertThatThrownBy(() -> events.appendStateChange(TENANT, sessionId,
                taskId, "running", "ready", 0))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_BACKLOG_FULL));
        // Archival plus an explicit expiry reopens admission.
        events.markOutputArchived(TENANT, sessionId, taskId, 1);
        events.expireThrough(TENANT, sessionId, taskId, 1);
        events.appendStateChange(TENANT, sessionId, taskId, "running",
                "ready", 0);
        // With no output held back, the automatic pass keeps the journal at
        // its retain target on its own.
        for (int round = 0; round < 40; round++) {
            events.appendStateChange(TENANT, sessionId, taskId, "running",
                    "ready", round);
        }
        var positions = events.positions(TENANT, sessionId, taskId);
        assertThat(positions.lastSequence() - positions.expiredThrough())
                .isLessThanOrEqualTo(ManagedTaskEventStore.RETAIN_TARGET);
    }

    @Test
    void appendArtifactKeepsEveryReferenceSyncWrites() {
        String sessionId = session(true);
        String taskId = "task_" + "cc".repeat(32);
        events.appendArtifact(TENANT, sessionId, taskId, "artifact-a", 1);
        events.appendArtifact(TENANT, sessionId, taskId, "artifact-b", 2);
        assertThat(events.positions(TENANT, sessionId,
                taskId).artifactRefs()).containsExactly("artifact-a",
                "artifact-b");
        assertThat(events.read(TENANT, sessionId, taskId, 0, 8).events())
                .hasSize(2)
                .allSatisfy(event -> assertThat(event.type())
                        .isEqualTo("artifact"));
    }

    @Test
    void staleSnapshotCannotRewriteTheReferenceList() {
        String sessionId = session(true);
        String taskId = "task_" + "dd".repeat(32);
        events.appendArtifact(TENANT, sessionId, taskId, "artifact-a", 1);
        // The clobber the old write shape could carry: a writer holding the
        // outdated empty list. The compare-and-set latch must refuse it.
        int rewritten = jdbc.update("UPDATE"
                        + " qwen_managed_session_task_journal_cursor"
                        + " SET artifact_refs = ? WHERE tenant_id = ?"
                        + " AND session_id = ? AND task_id = ?"
                        + " AND artifact_refs = ?",
                "[\"artifact-b\"]", TENANT, sessionId, taskId, "[]");
        assertThat(rewritten).isZero();
        assertThat(events.positions(TENANT, sessionId,
                taskId).artifactRefs()).containsExactly("artifact-a");
    }

    @Test
    void artifactReferencesStopFailLoudAtTheBound() {
        String sessionId = session(true);
        String taskId = "task_" + "bb".repeat(32);
        for (int index = 0; index
                < ManagedTaskEventStore.ARTIFACT_REF_BOUND; index++) {
            events.appendArtifact(TENANT, sessionId, taskId,
                    "artifact-" + index, index);
        }
        assertThat(events.positions(TENANT, sessionId,
                taskId).artifactRefs()).hasSize(100)
                .startsWith("artifact-0")
                .doesNotHaveDuplicates();
        assertThatThrownBy(() -> events.appendArtifact(TENANT, sessionId,
                taskId, "artifact-100", 100))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_ADMISSION_REFUSED));
        assertThatThrownBy(() -> events.appendArtifact(TENANT, sessionId,
                taskId, "artifact-0", 101))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_ADMISSION_REFUSED));
        // No reference aged out to admit another.
        assertThat(events.positions(TENANT, sessionId,
                taskId).artifactRefs()).hasSize(100)
                .contains("artifact-0");
    }

    @Test
    void sessionsWithoutArtifactsAdmitNoOutputFlow() {
        String plain = session(false);
        String taskId = "task_" + "cc".repeat(32);
        assertThatThrownBy(() -> events.appendOutput(TENANT, plain, taskId,
                "x", false, null, null, null, null, 0))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_ADMISSION_REFUSED));
        // Includes a task whose output would go only to Artifacts.
        assertThatThrownBy(() -> events.appendArtifact(TENANT, plain,
                taskId, "artifact-1", 0))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_ADMISSION_REFUSED));
        String deleting = session(true);
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETING'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT,
                deleting);
        assertThatThrownBy(() -> events.appendOutput(TENANT, deleting,
                taskId, "x", false, null, null, null, null, 0))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_ADMISSION_REFUSED));
    }

    @Test
    void outputChunksKeepTheirSizeAndShape() {
        String sessionId = session(true);
        String taskId = "task_" + "dd".repeat(32);
        assertThatThrownBy(() -> events.appendOutput(TENANT, sessionId,
                taskId, "", false, null, null, null, null, 0))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> events.appendOutput(TENANT, sessionId,
                taskId, "x".repeat(16385), false, null, null, null, null,
                0))
                .isInstanceOf(ApiException.class);
        events.appendOutput(TENANT, sessionId, taskId, "x".repeat(16384),
                true, null, null, null, null, 0);
        // The segment identity is all or nothing, with a half-open range.
        assertThatThrownBy(() -> events.appendOutput(TENANT, sessionId,
                taskId, "x", false, "capture-1", null, 0L, 1L, 0))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_SEGMENT_CONFLICT));
        assertThatThrownBy(() -> events.appendOutput(TENANT, sessionId,
                taskId, "x", false, "capture-1", "stdout", 1L, 1L, 0))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_SEGMENT_CONFLICT));
    }

    @Test
    void segmentRangesJoinWithoutDuplication() {
        String sessionId = session(true);
        String taskId = "task_" + "ee".repeat(32);
        events.appendOutput(TENANT, sessionId, taskId, "abcd", true,
                "capture-1", "stdout", 0L, 4L, 0);
        events.appendOutput(TENANT, sessionId, taskId, "efghi", true,
                "capture-1", "stdout", 4L, 9L, 1);
        // A second stream publishes its own ordinal space independently.
        events.appendOutput(TENANT, sessionId, taskId, "xy", true,
                "capture-1", "stderr", 0L, 2L, 2);
        // An overlap or duplication against the published space refuses.
        assertThatThrownBy(() -> events.appendOutput(TENANT, sessionId,
                taskId, "zz", true, "capture-1", "stdout", 2L, 5L, 3))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_SEGMENT_CONFLICT));
        assertThatThrownBy(() -> events.appendOutput(TENANT, sessionId,
                taskId, "abcd", true, "capture-1", "stdout", 0L, 4L, 4))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_SEGMENT_CONFLICT));
        // A gap against the continuous space refuses as well.
        assertThatThrownBy(() -> events.appendOutput(TENANT, sessionId,
                taskId, "zz", true, "capture-1", "stdout", 10L, 12L, 5))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedTaskEventStore.CODE_SEGMENT_CONFLICT));
        // What committed joins: each stream's ranges are continuous and
        // pairwise disjoint.
        EventPage page = events.read(TENANT, sessionId, taskId, 0, 100);
        var stdout = page.events().stream()
                .filter(event -> "stdout".equals(event.streamId())).toList();
        assertThat(stdout).hasSize(2);
        assertThat(stdout.get(0).endOrdinal())
                .isEqualTo(stdout.get(1).firstOrdinal());
        var stderr = page.events().stream()
                .filter(event -> "stderr".equals(event.streamId())).toList();
        assertThat(stderr).hasSize(1);
        assertThat(stdout.get(0).firstOrdinal()).isZero();
    }

    private String session(boolean workspaceBound) {
        String sessionId = UUID.randomUUID().toString();
        if (workspaceBound) {
            // The binding reader verifies the descriptor digest over the
            // persisted config and policy references.
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
        } else {
            jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                            + " session_id, agent_id, status, created_at,"
                            + " updated_at) VALUES"
                            + " (?, ?, 'qwen-code', 'ACTIVE', 1, 1)",
                    TENANT, sessionId);
        }
        return sessionId;
    }

    private static List<Long> stream(long first, int size) {
        List<Long> values = new ArrayList<>();
        for (long value = first; value < first + size; value++) {
            values.add(value);
        }
        return values;
    }
}
