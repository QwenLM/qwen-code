package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore.Command;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore.Message;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore.Snapshot;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
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

    private JdbcManagedUserMessageStore messages;
    private String session;

    @BeforeEach
    void setUp() {
        session = agents.createSession(TENANT, ACTOR, "create-" + UUID.randomUUID(),
                "qwen-code", null, "queue", Map.of(), List.of()).sessionId();
        ManagedAgentService queueAgents = mock(ManagedAgentService.class);
        when(queueAgents.supportsUserMessageQueue()).thenReturn(true);
        when(queueAgents.userMessageInput(anyList()))
                .thenAnswer(call -> agents.userMessageInput(call.getArgument(0)));
        messages = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new JdbcManagedUserMessageStore(jdbc, json, digests, queueAgents));
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
                new JdbcManagedUserMessageStore(tracedJdbc, json, digests, queueAgents));
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
    void admitsClaimedSeedThroughTheRealSchemaAdapterAndKeepsTheQueueBarrier() throws Exception {
        seedConversationBoundary();
        Message first = command("first", submit("first")).messages().getFirst();
        assertThat(conversationBoundary()).isEqualTo(1);
        command("first", submit("first"));
        assertThat(conversationBoundary()).isEqualTo(1);
        assertCode("user_message_queue_pending", () -> store.insertTurnCommand(TENANT, "queue-test", "ordinary-key",
                "digest", session, first.input(), "sha256:" + "0".repeat(64), ACTOR));
        jdbc.update("UPDATE ma_user_message SET state = 'claimed' WHERE tenant_id = ? AND session_id = ?", TENANT, session);

        var admission = store.insertTurnCommand(TENANT, "queue-test", "user-queue:" + first.id(),
                "digest", session, first.input(), "sha256:" + "0".repeat(64), ACTOR);
        assertThat(admission.turnId()).isNotBlank();
        assertThat(conversationBoundary()).isEqualTo(1);
    }

    @Test
    void ordinaryInputWithAQueueLikeIdempotencyKeyStillAdvancesTheBoundary() throws Exception {
        seedConversationBoundary();
        var admission = store.insertTurnCommand(TENANT, "queue-test", "user-queue:ordinary-input", "digest", session,
                agents.userMessageInput(text("ordinary")), "sha256:" + "0".repeat(64), ACTOR);
        assertThat(admission.turnId()).isNotBlank();
        assertThat(conversationBoundary()).isEqualTo(1);
    }

    @Test
    void startsTheNextQueuedTurnWhileTheTenantPlacementGuardIsHeld() throws Exception {
        Message first = command("guarded", submit("guarded")).messages().getFirst();
        try (var holder = java.util.Objects.requireNonNull(jdbc.getDataSource()).getConnection()) {
            holder.setAutoCommit(false);
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.lockPlacementDomain(holder, TENANT);
            try {
                messages.startNext(TENANT, session, (tenantId, principal, actorId, key, target, input) -> {
                    var admission = store.insertTurnCommand(tenantId, "queue-test", key, "digest", target,
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
        messages.startNext(TENANT, legacy, (tenantId, principal, actorId, key, target, input) -> {
            var admission = store.insertTurnCommand(tenantId,
                    "queue-test", key, "digest", target, first.input(),
                    "sha256:" + "0".repeat(64), actorId);
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

    @ParameterizedTest
    @EnumSource(value = OperationKind.class, names = {"CLOSE", "DELETE"})
    void retiresAtLifecycleAdmissionAndKeepsClaimsThroughFailureAndLateReceipts(OperationKind kind) throws Exception {
        Message claimed = command("claimed", submit("claimed")).messages().getFirst();
        Message blocked = command("blocked", submit("blocked")).messages().getLast();
        Message queued = command("queued", submit("queued")).messages().getLast();
        command("edit", new Command("edit", queued.id(), 1L, text("edited")));
        Message another = command("another", submit("another")).messages().getLast();
        jdbc.update("UPDATE ma_user_message SET state = 'claimed', turn_id = 'delivered'"
                + " WHERE tenant_id = ? AND session_id = ? AND message_id = ?", TENANT, session, claimed.id());
        jdbc.update("UPDATE ma_user_message SET state = 'recovery_blocked', turn_id = 'delivered'"
                + " WHERE tenant_id = ? AND session_id = ? AND message_id = ?", TENANT, session, blocked.id());
        String otherSession = "other-" + UUID.randomUUID();
        seedQueue("other-tenant", otherSession, "ACTIVE", 1);
        long before = queueRevision(session);

        var admission = store.beginOperation(TENANT, session, kind, ACTOR, "retire", "digest");
        assertThat(store.requireSession(TENANT, session).status())
                .isEqualTo(kind == OperationKind.CLOSE ? "CLOSING" : "DELETING");
        assertThat(state(queued)).isEqualTo("withdrawn");
        assertThat(state(another)).isEqualTo("withdrawn");
        assertThat(state(claimed)).isEqualTo("claimed");
        assertThat(state(blocked)).isEqualTo("recovery_blocked");
        assertThat(jdbc.queryForList("SELECT revision FROM ma_user_message WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY sequence_number", Long.class, TENANT, session)).containsExactly(1L, 1L, 2L, 1L);
        assertThat(queueRevision(session)).isEqualTo(before + 1);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                String.class, "other-tenant", otherSession)).isEqualTo("queued");
        assertThat(store.beginOperation(TENANT, session, kind, ACTOR, "retire", "digest").replayed()).isTrue();
        var claim = store.claimOperation(TENANT, session, admission.operation().operationId(), "worker", Duration.ofMinutes(1)).orElseThrow();
        assertThat(store.failOperation(TENANT, session, claim.operationId(), "worker", claim.claimGeneration(), "failed")).isTrue();
        messages.retireClosed();
        assertThat(queueRevision(session)).isEqualTo(before + 1);
        assertThat(state(claimed)).isEqualTo("claimed");
        assertThat(state(blocked)).isEqualTo("recovery_blocked");
        capture(claimed.id() + ":1", 10);
        capture(blocked.id() + ":1", 11);
        capture(queued.id() + ":2", 12);
        assertThat(state(claimed)).isEqualTo("consumed");
        assertThat(state(blocked)).isEqualTo("consumed");
        assertThat(state(queued)).isEqualTo("withdrawn");

        var resumed = store.beginOperation(TENANT, session, kind, ACTOR, "retry", "digest");
        var resumedClaim = store.claimOperation(TENANT, session, resumed.operation().operationId(), "worker", Duration.ofMinutes(1)).orElseThrow();
        assertThat(store.completeOperation(TENANT, session, resumedClaim.operationId(), "worker", resumedClaim.claimGeneration(), true)).isTrue();
        messages.retireClosed();
        assertThat(queueRevision(session)).isEqualTo(before + 1);
    }

    @Test
    void refusesBusyCloseWithoutWithdrawingQueuedInput() {
        Message queued = command("queued", submit("queued")).messages().getFirst();
        long before = queueRevision(session);
        turn("RUNNING");
        assertCode("turn_active", () -> store.beginOperation(TENANT, session, OperationKind.CLOSE, ACTOR, "close", "digest"));
        assertThat(state(queued)).isEqualTo("queued");
        assertThat(queueRevision(session)).isEqualTo(before);
        assertThat(store.requireSession(TENANT, session).status()).isEqualTo("ACTIVE");
    }

    @Test
    void rollsBackLifecycleStatusMessagesAndQueueRevisionTogether() {
        Message queued = command("queued", submit("queued")).messages().getFirst();
        long before = queueRevision(session);
        var nested = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        nested.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
        assertThatThrownBy(() -> nested.executeWithoutResult(transaction -> {
            store.beginOperation(TENANT, session, OperationKind.CLOSE, ACTOR, "rollback", "digest");
            assertThat(state(queued)).isEqualTo("withdrawn");
            assertThat(queueRevision(session)).isEqualTo(before + 1);
            throw new IllegalStateException("after retirement");
        })).isInstanceOf(IllegalStateException.class).hasMessage("after retirement");
        assertThat(store.requireSession(TENANT, session).status()).isEqualTo("ACTIVE");
        assertThat(state(queued)).isEqualTo("queued");
        assertThat(queueRevision(session)).isEqualTo(before);
        assertThat(store.beginOperation(TENANT, session, OperationKind.CLOSE, ACTOR, "rollback", "digest").replayed()).isFalse();
        assertThat(queueRevision(session)).isEqualTo(before + 1);
    }

    @Test
    void retiresLegacyQueuedInputAtCompletionAndUnarchiveWithoutReactivation() {
        Message queued = command("queued", submit("queued")).messages().getFirst();
        var close = store.beginOperation(TENANT, session, OperationKind.CLOSE, ACTOR, "close", "digest");
        jdbc.update("UPDATE ma_user_message SET state = 'queued' WHERE tenant_id = ? AND session_id = ?", TENANT, session);
        long beforeCompletion = queueRevision(session);
        var claim = store.claimOperation(TENANT, session, close.operation().operationId(), "worker", Duration.ofMinutes(1)).orElseThrow();
        assertThat(store.completeOperation(TENANT, session, claim.operationId(), "worker", claim.claimGeneration(), true)).isTrue();
        assertThat(state(queued)).isEqualTo("withdrawn");
        assertThat(queueRevision(session)).isEqualTo(beforeCompletion + 1);
        store.beginOperation(TENANT, session, OperationKind.ARCHIVE, ACTOR, "archive", "digest");
        jdbc.update("UPDATE ma_user_message SET state = 'queued' WHERE tenant_id = ? AND session_id = ?", TENANT, session);
        long beforeUnarchive = queueRevision(session);
        store.beginSessionMutation(TENANT, "UNARCHIVE_SESSION", "unarchive", "digest", session, SessionMutationKind.UNARCHIVE);
        store.completeSessionMutation(TENANT, "UNARCHIVE_SESSION", "unarchive", session, SessionMutationKind.UNARCHIVE, null, null);
        assertThat(store.requireSession(TENANT, session).status()).isEqualTo("CLOSED");
        assertThat(state(queued)).isEqualTo("withdrawn");
        assertThat(queueRevision(session)).isEqualTo(beforeUnarchive + 1);
        store.completeSessionMutation(TENANT, "UNARCHIVE_SESSION", "unarchive", session, SessionMutationKind.UNARCHIVE, null, null);
        assertThat(queueRevision(session)).isEqualTo(beforeUnarchive + 1);
    }

    @ParameterizedTest
    @EnumSource(value = OperationKind.class, names = {"CLOSE", "DELETE"})
    void retiresWorkspaceAndChildQueuesAtPendingStatus(OperationKind kind) {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var workspaceStore = VerificationFixtures.managedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new JdbcManagedWorkspaceRegistry(jdbc), properties, new SdkHarnessRules());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state) VALUES (?, 'queue-workspace', 1, 'queue-storage', 'Queue', ?, ?, 'ACTIVE')",
                TENANT, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'queue-workspace', ?, 'OPERATOR')",
                TENANT, ACTOR.getBytes(StandardCharsets.UTF_8));
        String parent = workspaceStore.insertWorkspaceSessionCommand(SessionCreationCommand.builder()
                .tenantId(TENANT).actorId(ACTOR).idempotencyKey("workspace-create").requestDigest("digest").agentId("qwen-code")
                .selection(new WorkspaceSelection("queue-workspace", ".")).build()).sessionId();
        String child = workspaceStore.insertChildSessionCommand(TENANT, parent, "child-create", "digest", "child", List.of(), null,
                new SessionLineage(parent, parent, "queue-child-run", 1)).sessionId();
        messages.command(TENANT, ACTOR, parent, "parent-message", submit("parent"));
        messages.command(TENANT, ACTOR, child, "child-message", submit("child"));
        long parentRevision = queueRevision(parent);
        long childRevision = queueRevision(child);
        var parentOperation = kind == OperationKind.CLOSE
                ? workspaceStore.beginWorkspaceClose(TENANT, parent, ACTOR, ACTOR, "workspace-close", "digest", true)
                : workspaceStore.beginWorkspaceLifecycle(TENANT, parent, kind, ACTOR, ACTOR, "workspace-delete", "digest", true,
                        WorkspaceToolProfiles.lifecycleProtocol(WorkspaceToolProfiles.FILES));
        assertThat(workspaceStore.requireSession(TENANT, parent).status()).isEqualTo(kind == OperationKind.CLOSE ? "CLOSING" : "DELETING");
        assertThat(queueRevision(parent)).isEqualTo(parentRevision + 1);
        assertThat(queueRevision(child)).isEqualTo(childRevision);
        workspaceStore.beginChildClose(TENANT, parent, child, "queue-child-run", ACTOR, "child-close", "digest", true);
        assertThat(workspaceStore.requireSession(TENANT, child).status()).isEqualTo("CLOSING");
        assertThat(queueRevision(child)).isEqualTo(childRevision + 1);
        assertThat(jdbc.queryForList("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id IN (?, ?)",
                String.class, TENANT, parent, child)).containsOnly("withdrawn").hasSize(2);
        if (kind == OperationKind.CLOSE) {
            var claim = workspaceStore.claimOperation(TENANT, parent, parentOperation.operation().operationId(), "worker", Duration.ofMinutes(1)).orElseThrow();
            assertThat(workspaceStore.completeOperation(TENANT, parent, claim.operationId(), "worker", claim.claimGeneration(), true)).isTrue();
            workspaceStore.beginWorkspaceLifecycle(TENANT, parent, OperationKind.ARCHIVE, ACTOR, ACTOR, "archive", "digest", false);
            jdbc.update("UPDATE ma_user_message SET state = 'queued' WHERE tenant_id = ? AND session_id = ?", TENANT, parent);
            var unarchived = workspaceStore.unarchiveWorkspaceSession(TENANT, parent, ACTOR, "unarchive", "digest");
            assertThat(unarchived.session().status()).isEqualTo("CLOSED");
            assertThat(queueRevision(parent)).isEqualTo(parentRevision + 2);
            assertThat(workspaceStore.unarchiveWorkspaceSession(TENANT, parent, ACTOR, "unarchive", "digest").replayed()).isTrue();
            assertThat(queueRevision(parent)).isEqualTo(parentRevision + 2);
        }
    }

    @Test
    void readySessionsAreUniqueFairAndExcludeEveryDispatchBarrier() {
        record Ready(String tenant, String session, long dispatched) { }
        List<Ready> expected = new ArrayList<>();
        for (int index = 35; index >= 0; index--) {
            String tenant = index % 2 == 0 ? "queue-a" : "queue-b";
            String target = "ready-" + String.format("%02d", index / 2) + "-" + tenant;
            seedQueue(tenant, target, "ACTIVE", 3);
            jdbc.update("UPDATE ma_user_message_queue SET last_dispatch_at = ? WHERE tenant_id = ? AND session_id = ?",
                    index % 3, tenant, target);
            expected.add(new Ready(tenant, target, index % 3));
        }
        seedQueue(TENANT, "paused", "ACTIVE", 1);
        jdbc.update("UPDATE ma_user_message_queue SET is_paused = TRUE WHERE tenant_id = ? AND session_id = ?", TENANT, "paused");
        for (String state : List.of("claimed", "recovery_blocked")) {
            seedQueue(TENANT, state, "ACTIVE", 2);
            jdbc.update("UPDATE ma_user_message SET state = ? WHERE tenant_id = ? AND session_id = ? AND sequence_number = 1", state, TENANT, state);
        }
        for (String status : List.of("ACCEPTED", "RUNNING", "CANCELLING", "RECOVERY_BLOCKED")) {
            seedQueue(TENANT, status, "ACTIVE", 1);
            jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest, status, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, ?, '[]', 'digest', ?, 1, 1)", TENANT, status, status, status, status);
        }
        for (String status : List.of("CLOSING", "DELETING", "CLOSED", "ARCHIVED", "DELETED")) {
            seedQueue(TENANT, status, status, 1);
        }
        seedQueue(TENANT, "empty", "ACTIVE", 0);
        expected.sort(Comparator.comparingLong(Ready::dispatched).thenComparing(Ready::tenant).thenComparing(Ready::session));
        List<Map<String, String>> ordered = expected.stream().map(row -> Map.of("tenant", row.tenant(), "session", row.session())).toList();
        var observed = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> List<T> query(String sql, RowMapper<T> mapper) {
                assertThat(sql).startsWith("SELECT q.tenant_id, q.session_id, q.last_dispatch_at FROM ma_user_message_queue q JOIN ma_session s")
                        .contains("EXISTS (SELECT 1 FROM ma_user_message m", "ORDER BY q.last_dispatch_at, q.tenant_id, q.session_id LIMIT 32")
                        .doesNotContain("DISTINCT");
                return super.query(sql, mapper);
            }
        };
        var ready = new JdbcManagedUserMessageStore(observed, json, digests, mock(ManagedAgentService.class));
        assertThat(ready.readySessions()).containsExactlyElementsOf(ordered.subList(0, 32));
        ordered.subList(0, 32).forEach(row -> messages.attempted(row.get("tenant"), row.get("session")));
        var next = messages.readySessions();
        assertThat(next).hasSize(32);
        assertThat(next.subList(0, 4)).containsExactlyElementsOf(ordered.subList(32, 36));
    }

    @Test
    void compatibilitySweepBoundsSourceQueuesAdvancesAcrossEmptyAndMissingSessionsAndWraps() {
        Message active = command("active", submit("active")).messages().getFirst();
        for (int index = 0; index < 64; index++) {
            seedQueue(TENANT, "empty-" + index, index % 2 == 0 ? "ACTIVE" : "CLOSED", 0);
        }
        jdbc.update("DELETE FROM ma_session WHERE tenant_id = ? AND session_id = ?", TENANT, "empty-0");
        seedQueue(TENANT, "legacy-closed", "CLOSING", 2);
        List<Long> ids = jdbc.queryForList("SELECT id FROM ma_user_message_queue ORDER BY id", Long.class);
        assertThat(ids).hasSize(66);
        List<Long> cursors = new ArrayList<>();
        List<Long> maxima = new ArrayList<>();
        List<String> stateReads = new ArrayList<>();
        var observed = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> type) {
                assertThat(sql).isEqualTo("SELECT MAX(id) FROM ma_user_message_queue");
                T value = super.queryForObject(sql, type);
                maxima.add(((Number) value).longValue());
                return value;
            }

            @Override
            public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
                if (sql.startsWith("SELECT id, tenant_id, session_id FROM ma_user_message_queue")) {
                    assertThat(sql).contains("WHERE id > ? AND id <= ? ORDER BY id LIMIT 32").doesNotContain("JOIN", "EXISTS", "state", "status");
                    assertThat(arguments).hasSize(2);
                    assertThat(arguments[1]).isEqualTo(ids.getLast());
                    cursors.add((Long) arguments[0]);
                } else if (sql.startsWith("SELECT status FROM ma_session")) {
                    assertThat(sql).contains("tenant_id = ? AND session_id = ? FOR UPDATE SKIP LOCKED");
                    stateReads.add((String) arguments[1]);
                }
                return super.query(sql, mapper, arguments);
            }

            @Override
            public int update(String sql, Object... arguments) {
                assertThat(sql).contains("WHERE tenant_id = ? AND session_id = ?");
                assertThat(arguments).hasSize(2);
                return super.update(sql, arguments);
            }
        };
        var sweep = new JdbcManagedUserMessageStore(observed, json, digests, mock(ManagedAgentService.class));
        sweep.retireClosed();
        assertThat(stateReads).hasSize(32);
        assertThat(queueRevision("legacy-closed")).isZero();
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?", TENANT, session);
        sweep.retireClosed();
        assertThat(stateReads).hasSize(64);
        assertThat(queueRevision("legacy-closed")).isZero();
        sweep.retireClosed();
        assertThat(stateReads).hasSize(66);
        assertThat(queueRevision("legacy-closed")).isEqualTo(1);
        assertThat(jdbc.queryForList("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                String.class, TENANT, "legacy-closed")).containsExactly("withdrawn", "withdrawn");
        assertThat(state(active)).isEqualTo("queued");
        sweep.retireClosed();
        assertThat(state(active)).isEqualTo("withdrawn");
        assertThat(cursors).containsExactly(0L, ids.get(31), ids.get(63), 0L);
        assertThat(jdbc.queryForList("SELECT queue_revision FROM ma_user_message_queue WHERE tenant_id = ?"
                + " AND session_id NOT IN (?, ?)", Long.class, TENANT, session, "legacy-closed")).hasSize(64).containsOnly(0L);
        sweep.retireClosed();
        sweep.retireClosed();
        assertThat(queueRevision("legacy-closed")).isEqualTo(1);
        assertThat(queueRevision(session)).isEqualTo(2);
        assertThat(maxima).containsExactly(ids.getLast(), ids.getLast());
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"active", "deleted-tail", "rollback"})
    void compatibilitySweepFreezesRoundAndRevisitsSkippedOrRolledBackRows(String mode) {
        boolean rollback = "rollback".equals(mode);
        boolean deletedTail = "deleted-tail".equals(mode);
        for (int index = 0; index < 64; index++) {
            seedQueue(TENANT, "repair-" + index, index == 0 && !rollback ? "ACTIVE" : "CLOSED", index == 0 ? 1 : 0);
        }
        var ids = jdbc.queryForList("SELECT id FROM ma_user_message_queue ORDER BY id", Long.class);
        assertThat(ids).hasSize(64);
        var bounds = new ArrayList<List<Object>>();
        var pageSizes = new ArrayList<Integer>();
        var maxima = new ArrayList<Long>();
        var observed = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> type) {
                assertThat(sql).isEqualTo("SELECT MAX(id) FROM ma_user_message_queue");
                T value = super.queryForObject(sql, type);
                maxima.add(((Number) value).longValue());
                return value;
            }

            @Override
            public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
                var rows = super.query(sql, mapper, arguments);
                if (sql.startsWith("SELECT id, tenant_id, session_id FROM ma_user_message_queue")) {
                    assertThat(sql).contains("WHERE id > ? AND id <= ? ORDER BY id LIMIT 32")
                            .doesNotContain("JOIN", "EXISTS", "state", "status");
                    bounds.add(List.of(arguments));
                    pageSizes.add(rows.size());
                } else {
                    assertThat(sql).isEqualTo("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE SKIP LOCKED");
                }
                return rows;
            }
        };
        var sweep = new JdbcManagedUserMessageStore(observed, json, digests, mock(ManagedAgentService.class));
        var nested = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        nested.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
        nested.executeWithoutResult(status -> {
            sweep.retireClosed();
            if (rollback) {
                assertThat(queueRevision("repair-0")).isEqualTo(1);
                status.setRollbackOnly();
            }
        });
        assertThat(bounds).containsExactly(List.of(0L, ids.getLast()));
        assertThat(pageSizes).containsExactly(32);
        assertThat(queueRevision("repair-0")).isZero();
        jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?", TENANT, "repair-0");
        if (deletedTail) {
            jdbc.update("DELETE FROM ma_user_message_queue WHERE id > ?", ids.get(31));
        }
        for (int scan = 1; scan <= 2; scan++) {
            for (int index = 0; index < 32; index++) {
                seedQueue(TENANT, "new-" + scan + "-" + index, "ACTIVE", 0);
            }
            assertThat(maxima).containsExactly(ids.getLast());
            sweep.retireClosed();
            if (scan == 1) {
                assertThat(maxima).containsExactly(ids.getLast());
                assertThat(bounds.getLast()).containsExactly(ids.get(31), ids.getLast());
                assertThat(queueRevision("repair-0")).isZero();
                assertThat(jdbc.queryForObject("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                        String.class, TENANT, "repair-0")).isEqualTo("queued");
            }
        }
        long latest = jdbc.queryForObject("SELECT MAX(id) FROM ma_user_message_queue", Long.class);
        assertThat(maxima).containsExactly(ids.getLast(), latest);
        assertThat(bounds.getLast()).containsExactly(0L, latest);
        assertThat(pageSizes).containsExactly(32, deletedTail ? 0 : 32, 32);
        assertThat(queueRevision("repair-0")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                String.class, TENANT, "repair-0")).isEqualTo("withdrawn");
        assertThat(jdbc.queryForObject("SELECT revision FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                Long.class, TENANT, "repair-0")).isEqualTo(1);
    }

    private long queueRevision(String target) {
        return jdbc.queryForObject("SELECT queue_revision FROM ma_user_message_queue WHERE tenant_id = ? AND session_id = ?",
                Long.class, TENANT, target);
    }

    private void seedQueue(String tenant, String target, String status, int count) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified) VALUES (?, ?, 'agent', ?, 0, 0)",
                tenant, target, status);
        jdbc.update("INSERT INTO ma_user_message_queue (tenant_id, session_id) VALUES (?, ?)", tenant, target);
        for (int index = 0; index < count; index++) {
            jdbc.update("INSERT INTO ma_user_message (tenant_id, session_id, message_id, sequence_number, revision, actor_id, input_json, state)"
                    + " VALUES (?, ?, ?, ?, 1, ?, '[]', 'queued')", tenant, target, "umsg_" + UUID.randomUUID(), index + 1, ACTOR);
        }
    }

    private Command submit(String text) {
        return new Command("submit", null, null, text(text));
    }

    private void seedConversationBoundary() {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(TENANT, session);
        jdbc.update("INSERT INTO ma_session_record (session_scope_key,record_key,tenant_id,session_id,domain,record_id,"
                        + "revision,record_kind,options_json,gmt_create) VALUES (?,?,?,?,?,?,1,'CONVERSATION',?,1)",
                scope, com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(scope, "side_query_conversation"),
                TENANT, session, "side_query_conversation", "side_query_conversation", "{\"mainInputBoundary\":0}");
    }

    private long conversationBoundary() throws Exception {
        return json.readTree(jdbc.queryForObject("SELECT options_json FROM ma_session_record"
                        + " WHERE tenant_id=? AND session_id=? AND record_kind='CONVERSATION'", String.class, TENANT, session))
                .path("mainInputBoundary").asLong();
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
        JdbcManagedUserMessageStore.capture(jdbc, TENANT, session, List.of(record));
    }

    private void assertCode(String code, org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
