package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore.Command;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore.Message;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore.Snapshot;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SpringBootTest(properties = {
        "spring.datasource.url=${qwen.queue-test.jdbc-url:jdbc:h2:mem:managed-user-message-queue;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE}",
        "spring.datasource.driver-class-name=${qwen.queue-test.jdbc-driver:org.h2.Driver}",
        "spring.datasource.username=${qwen.queue-test.jdbc-user:sa}",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
@Transactional
class ManagedUserMessageStoreTest {
    private static final String TENANT = "tenant-user-message";
    private static final String ACTOR = "actor-user-message";

    @Autowired
    private ManagedAgentService agents;
    @Autowired
    @Qualifier("managedJdbcTemplate")
    private JdbcTemplate jdbc;
    @Autowired
    private ObjectMapper json;
    @Autowired
    private RequestDigests digests;
    @Autowired
    private ManagedAgentStore store;

    private ManagedUserMessageStore messages;
    private String session;

    @BeforeEach
    void setUp() {
        session = agents.createSession(TENANT, ACTOR, "create-" + UUID.randomUUID(),
                "qwen-code", null, "queue", Map.of(), List.of()).sessionId();
        ManagedAgentService queueAgents = mock(ManagedAgentService.class);
        when(queueAgents.supportsUserMessageQueue()).thenReturn(true);
        when(queueAgents.userMessageInput(anyList()))
                .thenAnswer(call -> agents.userMessageInput(call.getArgument(0)));
        messages = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedUserMessageStore(jdbc, json, digests, queueAgents));
    }

    @Test
    void refusesExternalAttachmentsBeforeSubmitOrEditCanPoisonTheQueue() {
        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id = ? AND session_id = ?",
                WorkspaceToolProfiles.EXTERNAL_FILES, TENANT, session);
        List<InputBlock> attachment = List.of(new InputBlock("input_file", "contents", "text/plain", null, "notes.txt"));

        assertCode("workspace_unavailable", () -> command("first", new Command("submit", null, null, attachment)));
        assertThat(query().messages()).isEmpty();
        Message first = command("first", submit("first")).messages().getFirst();
        Snapshot beforeEdit = query();
        assertCode("workspace_unavailable", () -> command("edit",
                new Command("edit", first.id(), first.revision(), attachment)));
        assertThat(query()).isEqualTo(beforeEdit);
        command("edit", new Command("edit", first.id(), first.revision(), text("edited")));
        Message second = command("second", submit("second")).messages().getLast();

        List<Message> delivered = messages.claim(TENANT, session, turn("RUNNING"), false);
        assertThat(delivered).extracting(Message::id).containsExactly(first.id(), second.id());
        assertThat(delivered).extracting(message -> message.input().getFirst().get("text"))
                .containsExactly("edited", "second");
    }

    @Test
    void preservesAttachmentSubmitAndEditForOtherProfiles() {
        List<InputBlock> attachment = List.of(new InputBlock("input_file", "contents", "text/plain", null, "notes.txt"));
        Message first = command("first", new Command("submit", null, null, attachment)).messages().getFirst();
        assertThat(first.input().getFirst().get("type")).isEqualTo("resource");
        Message second = command("second", submit("text")).messages().getLast();
        Snapshot edited = command("edit", new Command("edit", second.id(), second.revision(), attachment));
        assertThat(edited.messages().getLast().input()).isEqualTo(first.input());
        assertThat(messages.claim(TENANT, session, turn("RUNNING"), false))
                .extracting(Message::id).containsExactly(first.id(), second.id());
    }

    @Test
    void queueCommandsLockTheirSessionBeforeReconcilingTurns() {
        var source = new org.springframework.jdbc.datasource.DriverManagerDataSource(
                "jdbc:h2:mem:queue-lock-" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        var trace = new com.alibaba.qwen.code.managedagent.persistence.StoreLockTrace(source);
        var tracedJdbc = new com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate(trace);
        tracedJdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'agent', 'ACTIVE', 0, 0)", TENANT, session);
        var queueAgents = mock(ManagedAgentService.class);
        when(queueAgents.supportsUserMessageQueue()).thenReturn(true);
        when(queueAgents.userMessageInput(anyList())).thenAnswer(call -> agents.userMessageInput(call.getArgument(0)));
        var traced = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(
                new ManagedUserMessageStore(tracedJdbc, json, digests, queueAgents));
        var transaction = new org.springframework.transaction.support.TransactionTemplate(
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(trace));
        trace.clear();
        transaction.executeWithoutResult(status -> traced.command(TENANT, ACTOR, session, "trace", submit("trace")));
        trace.assertSessionBeforeTurn(TENANT, session);
    }

    @Test
    void persistsFifoAndReplaysOriginalCommandSnapshotWithoutDuplicateAdmission() {
        Command first = submit("first");
        Snapshot admitted = command("first-key", first);
        Snapshot second = command("second-key", submit("second"));

        assertThat(second.messages()).extracting(Message::sequence)
                .containsExactly(1L, 2L);
        assertThat(second.messages()).extracting(message -> message.input().getFirst().get("text"))
                .containsExactly("first", "second");
        assertThat(command("first-key", first)).isEqualTo(admitted);
        assertThat(query().messages()).hasSize(2);
        assertCode("idempotency_conflict", () -> command("first-key", submit("changed")));
    }

    @Test
    void replaysCommittedReceiptAfterSessionClosesButRefusesFreshCommands() {
        Command first = submit("first");
        Snapshot admitted = command("first-key", first);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?", TENANT, session);

        assertThat(command("first-key", first)).isEqualTo(admitted);
        assertCode("idempotency_conflict", () -> command("first-key", submit("changed")));
        assertCode("session_not_active", () -> command("new-key", first));
    }

    @Test
    void admitsClaimedSeedThroughTheRealSchemaAdapterAndKeepsTheQueueBarrier() {
        Message first = command("first", submit("first")).messages().getFirst();
        assertCode("user_message_queue_pending", () -> store.insertTurnCommand(TENANT, "queue-test", "ordinary-key",
                "digest", session, first.input(), "sha256:" + "0".repeat(64), ACTOR));
        jdbc.update("UPDATE ma_user_message SET state = 'claimed' WHERE tenant_id = ? AND session_id = ?", TENANT, session);

        var admission = store.insertTurnCommand(TENANT, "queue-test", "user-queue:" + first.id(),
                "digest", session, first.input(), "sha256:" + "0".repeat(64), ACTOR);
        assertThat(admission.turnId()).isNotBlank();
    }

    @Test
    void startsTheNextQueuedTurnWhileTheTenantPlacementGuardIsHeld() throws Exception {
        Message first = command("guarded", submit("guarded")).messages().getFirst();
        try (var holder = java.util.Objects.requireNonNull(jdbc.getDataSource()).getConnection()) {
            holder.setAutoCommit(false);
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.lockPlacementDomain(holder, TENANT);
            try {
                messages.startNext(TENANT, session, (principal, key, target, input) -> {
                    var admission = store.insertTurnCommand(principal.tenantId(), "queue-test", key, "digest", target,
                            first.input(), "sha256:" + "0".repeat(64), principal);
                    return new com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission(
                            target, admission.turnId(), "ACCEPTED", false);
                });
            } finally {
                holder.rollback();
            }
        }
        assertThat(query().messages()).singleElement().satisfies(message -> {
            assertThat(message.state()).isEqualTo("claimed");
            assertThat(message.turnId()).isNotBlank();
        });
    }

    @Test
    void dispatchesQueuedMessagesOfALegacySessionWithoutAnOwnershipRow() {
        String legacy = agents.createSession(TENANT, null,
                "legacy-" + UUID.randomUUID(), "qwen-code", null, "legacy",
                Map.of(), List.of()).sessionId();
        Message first = messages.command(TENANT, ACTOR, legacy, "legacy-first",
                submit("legacy")).messages().getFirst();
        messages.startNext(TENANT, legacy, (principal, key, target, input) -> {
            var admission = store.insertTurnCommand(principal.tenantId(),
                    "queue-test", key, "digest", target, first.input(),
                    "sha256:" + "0".repeat(64), principal);
            return new com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission(
                    target, admission.turnId(), "ACCEPTED", false);
        });
        assertThat(messages.queryMessages(TENANT, ACTOR, legacy).messages())
                .singleElement().satisfies(message -> {
                    assertThat(message.state()).isEqualTo("claimed");
                    assertThat(message.turnId()).isNotBlank();
                });
    }

    @Test
    void dispatchesALongActorsLegacyQueueWithoutConstructingAPrincipal() {
        // R11-4: the stored actor is verbatim; startNext must not rebuild a
        // byte-bounded principal from it, or the tick rolls back and the
        // queue wedges. 512 CJK code points = 1536 UTF-8 bytes, within the
        // widened actor column but past the principal's 512-byte bound.
        String longActor = "界".repeat(512);
        String legacy = agents.createSession(TENANT, null,
                "long-legacy-" + UUID.randomUUID(), "qwen-code", null, "legacy",
                Map.of(), List.of()).sessionId();
        Message first = messages.command(TENANT, longActor, legacy,
                "long-first", submit("legacy")).messages().getFirst();
        messages.startNext(TENANT, legacy,
                (actorTenant, principal, actorId, key, target, input) -> {
                    assertThat(principal).isNull();
                    assertThat(actorId).isEqualTo(longActor);
                    var admission = store.insertTurnCommand(actorTenant,
                            "queue-test", key, "digest", target, first.input(),
                            "sha256:" + "0".repeat(64), actorId);
                    return new com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission(
                            target, admission.turnId(), "ACCEPTED", false);
                });
        assertThat(messages.queryMessages(TENANT, longActor, legacy).messages())
                .singleElement().satisfies(message -> {
                    assertThat(message.state()).isEqualTo("claimed");
                    assertThat(message.turnId()).isNotBlank();
                });
    }

    @Test
    void editsInPlaceAndRejectsStaleRevisionBeforeWithdrawing() {
        Message first = command("first", submit("first")).messages().getFirst();
        command("second", submit("second"));
        Snapshot edited = command("edit", new Command("edit", first.id(), 1L, text("edited")));

        assertThat(edited.messages()).extracting(Message::id)
                .startsWith(first.id());
        assertThat(edited.messages().getFirst().sequence()).isEqualTo(1);
        assertThat(edited.messages().getFirst().revision()).isEqualTo(2);
        assertThat(edited.messages().getFirst().input().getFirst().get("text")).isEqualTo("edited");
        assertCode("user_message_conflict", () -> command("stale-edit",
                new Command("edit", first.id(), 1L, text("stale"))));
        assertCode("user_message_conflict", () -> command("stale-withdraw",
                new Command("withdraw", first.id(), 1L, null)));
        assertThat(command("withdraw", new Command("withdraw", first.id(), 2L, null)).messages())
                .hasSize(1).noneMatch(message -> message.id().equals(first.id()));
        assertThat(state(first)).isEqualTo("withdrawn");
    }

    @Test
    void limitsOutstandingMessagesTo32AndReusesWithdrawnCapacity() {
        Message first = null;
        for (int index = 0; index < 32; index++) {
            Snapshot snapshot = command("entry-" + index, submit("entry " + index));
            if (first == null) {
                first = snapshot.messages().getFirst();
            }
        }
        assertCode("user_message_queue_full", () -> command("overflow", submit("overflow")));
        command("withdraw", new Command("withdraw", first.id(), first.revision(), null));
        Snapshot accepted = command("replacement", submit("replacement"));
        assertThat(accepted.messages()).hasSize(32);
        assertThat(accepted.messages().getLast().sequence()).isEqualTo(33);
    }

    @Test
    void claimsOnlyLiveTurnAndCapturesMatchingVersionOnce() throws Exception {
        Message first = command("first", submit("first")).messages().getFirst();
        Message second = command("second", submit("second")).messages().getLast();
        String prompt = turn("RUNNING");
        List<Message> claimed = messages.claim(TENANT, session, prompt, false);

        assertThat(claimed).extracting(Message::id).containsExactly(first.id(), second.id());
        assertThat(messages.claim(TENANT, session, prompt, false)).isEqualTo(claimed);
        assertThat(messages.claim(TENANT, session, prompt, true)).isEqualTo(claimed);
        assertCode("user_message_conflict", () -> command("withdraw-claimed",
                new Command("withdraw", first.id(), 1L, null)));
        capture(first.id() + ":2", 7);
        assertThat(state(first)).isEqualTo("claimed");
        capture(first.id() + ":1", 8);
        capture(first.id() + ":1", 9);
        assertThat(query().messages()).extracting(Message::id).containsExactly(second.id());
        assertThat(state(first)).isEqualTo("consumed");
        assertThat(jdbc.queryForObject("SELECT consumed_sequence FROM ma_user_message"
                + " WHERE tenant_id = ? AND session_id = ? AND message_id = ?", Long.class,
                TENANT, session, first.id())).isEqualTo(8);
    }

    @Test
    void pausesAfterFailureAndRequiresExplicitResumeBeforeNewClaims() {
        command("first", submit("first"));
        turn("FAILED");
        assertThat(query().paused()).isTrue();
        command("second", submit("second"));
        assertThat(query().messages()).hasSize(2);
        assertThat(command("resume", new Command("resume", null, null, null)).paused()).isFalse();
        assertThat(query().paused()).isFalse();
        String prompt = turn("RUNNING");
        assertThat(messages.claim(TENANT, session, prompt, false)).hasSize(2);
    }

    @Test
    void neverClaimsOnTerminalTurnAndBlocksUnprovenClaimRecovery() {
        Message first = command("first", submit("first")).messages().getFirst();
        String prompt = turn("RUNNING");
        assertThat(messages.claim(TENANT, session, prompt, false)).hasSize(1);
        jdbc.update("UPDATE ma_turn SET status = 'COMPLETED' WHERE tenant_id = ? AND session_id = ?",
                TENANT, session);

        assertThat(messages.claim(TENANT, session, prompt, false)).isEmpty();
        assertThat(query().paused()).isTrue();
        assertThat(state(first)).isEqualTo("recovery_blocked");
        assertCode("user_message_recovery_blocked", () -> command("resume",
                new Command("resume", null, null, null)));
    }

    @Test
    void discardsUnknownDeliveryWithoutReplayingAndStillAcceptsItsLateReceipt() throws Exception {
        Message first = command("first", submit("first")).messages().getFirst();
        String prompt = turn("RUNNING");
        messages.claim(TENANT, session, prompt, false);
        jdbc.update("UPDATE ma_turn SET status = 'FAILED' WHERE tenant_id = ? AND session_id = ?", TENANT, session);
        assertThat(query().messages().getFirst().state()).isEqualTo("recovery_blocked");

        Snapshot discarded = command("discard", new Command("withdraw", first.id(), 1L, null));
        assertThat(discarded.messages()).isEmpty();
        assertThat(discarded.paused()).isTrue();
        assertThat(state(first)).isEqualTo("withdrawn");
        assertThat(command("resume", new Command("resume", null, null, null)).paused()).isFalse();
        assertThat(messages.readySessions()).noneMatch(row -> session.equals(row.get("session")));
        capture(first.id() + ":1", 9);
        assertThat(state(first)).isEqualTo("consumed");
    }

    @Test
    void ignoresMalformedQueueIdentitiesWithoutBreakingOtherJournalCommits() throws Exception {
        Message first = command("first", submit("first")).messages().getFirst();
        messages.claim(TENANT, session, turn("RUNNING"), false);
        for (String identity : List.of(first.id(), first.id() + ":", first.id() + ":abc",
                first.id() + ":9999999999999999999", first.id() + ":0", "ordinary-message:1")) {
            capture(identity, 8);
            assertThat(state(first)).isEqualTo("claimed");
        }
        capture(first.id() + ":1", 9);
        assertThat(state(first)).isEqualTo("consumed");
    }

    @Test
    void leavesUnclaimedInputQueuedWhenOnlyACompletedTurnExists() {
        Message first = command("first", submit("first")).messages().getFirst();
        String prompt = turn("COMPLETED");

        assertThat(messages.claim(TENANT, session, prompt, false)).isEmpty();
        assertThat(state(first)).isEqualTo("queued");
        assertThat(query().paused()).isFalse();
    }

    @Test
    void blocksQueuedInputWhenWorkspaceContextChanges() {
        Message first = command("first", submit("first")).messages().getFirst();
        String prompt = turn("RUNNING");
        jdbc.update("UPDATE ma_user_message SET context_revision = 2 WHERE tenant_id = ? AND session_id = ?",
                TENANT, session);

        assertThat(messages.claim(TENANT, session, prompt, false)).isEmpty();
        assertThat(state(first)).isEqualTo("recovery_blocked");
        assertThat(query().paused()).isTrue();
    }

    @Test
    void withdrawsKnownUndeliveredContextMismatchWithoutReplayingIt() {
        Message first = command("first", submit("first")).messages().getFirst();
        String prompt = turn("RUNNING");
        jdbc.update("UPDATE ma_user_message SET context_revision = 2 WHERE tenant_id = ? AND session_id = ?", TENANT, session);
        assertThat(messages.claim(TENANT, session, prompt, false)).isEmpty();
        assertThat(command("withdraw", new Command("withdraw", first.id(), 1L, null)).messages()).isEmpty();
        assertThat(state(first)).isEqualTo("withdrawn");
    }

    private Command submit(String text) {
        return new Command("submit", null, null, text(text));
    }

    private List<InputBlock> text(String text) {
        return List.of(new InputBlock("input_text", text));
    }

    private Snapshot command(String key, Command command) {
        return messages.command(TENANT, ACTOR, session, key, command);
    }

    private Snapshot query() {
        return messages.queryMessages(TENANT, ACTOR, session);
    }

    private String turn(String status) {
        String id = "turn-" + UUID.randomUUID();
        String prompt = "prompt-" + UUID.randomUUID();
        long created = jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                Long.class, TENANT, session) + 1;
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                        + " status, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)",
                TENANT, session, id, prompt, "sha256:" + "0".repeat(64), status, created, created);
        return prompt;
    }

    private String state(Message message) {
        return jdbc.queryForObject("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ? AND message_id = ?",
                String.class, TENANT, session, message.id());
    }

    private void capture(String identity, long sequence) throws Exception {
        var record = json.valueToTree(Map.of("managedSession", Map.of(
                "kind", "message.committed", "sequence", sequence,
                "payload", Map.of("role", "user", "messageId", identity))));
        ManagedUserMessageStore.capture(jdbc, TENANT, session, List.of(record));
    }

    private void assertCode(String code, org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
