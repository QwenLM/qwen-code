package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore.Command;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore.Message;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore.Snapshot;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
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
    private JdbcTemplate jdbc;
    @Autowired
    private ObjectMapper json;
    @Autowired
    private RequestDigests digests;

    private ManagedUserMessageStore messages;
    private String session;

    @BeforeEach
    void setUp() {
        session = agents.createSession(TENANT, "create-" + UUID.randomUUID(),
                "qwen-code", null, "queue", Map.of(), List.of()).sessionId();
        ManagedAgentService queueAgents = mock(ManagedAgentService.class);
        when(queueAgents.supportsUserMessageQueue()).thenReturn(true);
        when(queueAgents.userMessageInput(anyList()))
                .thenAnswer(call -> agents.userMessageInput(call.getArgument(0)));
        messages = new ManagedUserMessageStore(jdbc, json, digests, queueAgents);
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
        return messages.query(TENANT, ACTOR, session);
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
        byte[] record = (json.writeValueAsString(Map.of("managedSession", Map.of(
                "kind", "message.committed", "sequence", sequence,
                "payload", Map.of("role", "user", "messageId", identity)))) + "\n")
                .getBytes(StandardCharsets.UTF_8);
        ManagedUserMessageStore.capture(jdbc, json, TENANT, session, record);
    }

    private void assertCode(String code, org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
