package com.alibaba.qwen.code.managedagent.channel;

import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ChannelPolicy;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchAdmission;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchBindingView;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchCreateRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchInjectRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchRetireRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.RegisterChannelRequest;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.PrWatchInjectionRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.PrWatchInjectionRepository.PrWatchInjection;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessTransportFailure;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelInstanceStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcPrWatchBindingStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcPrWatchInjectionRepository;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.PrWatchBindingStore.PrWatchBinding;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The PR-watch bound-session service against the real stores on H2 and a
 * recording Harness that answers submit_pr_event_input the way the hosted
 * funnel commits it: one admission per derived input id, replay answered
 * from the committed input.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-pr-watch-service;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedPrWatchServiceTest {
    private static final String TENANT = "tenant-prwatch-" + UUID.randomUUID();
    private static final String WORKSPACE = "ws-prwatch";
    private static final String OTHER_WORKSPACE = "ws-prwatch-other";
    private static final String ACTOR = "prwatch-owner";
    private static final String OWNER = "octocat";
    private static final String REPO = "hello-world";
    private static final long PR = 42;
    private static final String HEAD = "a".repeat(40);
    /** Byte-for-byte the Harness gate regex (hosted-file-history-protocol.ts
     * HOSTED_UUID): a version 1-5, RFC 4122 variant UUID. */
    private static final String HOSTED_UUID_REGEX =
            "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

    @Autowired
    private JdbcChannelInstanceStore instances;

    @Autowired
    private JdbcPrWatchBindingStore bindings;

    @Autowired
    private ManagedAgentService sessions;

    @Autowired
    private SessionQueryStore sessionQueries;

    @Autowired
    private ManagedChannelService channels;

    @Autowired
    private @Qualifier("managedAgentObjectMapper") ObjectMapper mapper;

    @Autowired
    private @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc;

    private String channel;
    private RecordingHarness harness;
    private JdbcPrWatchInjectionRepository injections;
    private ManagedPrWatchService service;

    @BeforeEach
    void setUp() {
        for (String workspace : List.of(WORKSPACE, OTHER_WORKSPACE)) {
            jdbc.update("INSERT IGNORE INTO ma_workspace (tenant_id,"
                            + " workspace_id, workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref, state)"
                            + " VALUES (?, ?, 1, 'storage', 'Workspace', ?, ?,"
                            + " 'ACTIVE')",
                    TENANT, workspace,
                    com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                    com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT IGNORE INTO ma_workspace_access (tenant_id,"
                            + " workspace_id, actor_id, role)"
                            + " VALUES (?, ?, ?, 'OPERATOR')",
                    TENANT, workspace, ACTOR.getBytes(StandardCharsets.UTF_8));
        }
        channel = "github-" + UUID.randomUUID();
        harness = new RecordingHarness(sessionQueries);
        injections = new JdbcPrWatchInjectionRepository(jdbc);
        service = new ManagedPrWatchService(instances, sessionQueries,
                bindings, injections, harness, mapper);
        channels.register(TENANT, channel, new RegisterChannelRequest(
                "github", "bot-account", 1, ACTOR, WORKSPACE, ".",
                new ChannelPolicy("github", "allowlist",
                        List.of("maintainer"), "followup")));
    }

    private String createSession(String workspace) {
        return sessions.createWorkspaceSession(TENANT, ACTOR,
                "prwatch-create-" + UUID.randomUUID(), "qwen-code", null,
                "PR watch target", null, List.of(),
                new WorkspaceSelection(workspace, ".")).sessionId();
    }

    private PrWatchBindingView bind(String sessionId) {
        return service.create(TENANT, channel, new PrWatchCreateRequest(
                sessionId, OWNER, REPO, PR,
                List.of("ci_failure", "head_change")));
    }

    private static PrWatchInjectRequest inject(String transition,
            String headSha, String text) {
        return inject(transition, headSha, 1, text);
    }

    private static PrWatchInjectRequest inject(String transition,
            String headSha, long episode, String text) {
        return new PrWatchInjectRequest(OWNER, REPO, PR, transition, headSha,
                episode, "checks: build / test", text);
    }

    private List<Map<String, Object>> ledgerRows(String sessionId) {
        return jdbc.queryForList("SELECT operation_id, session_id, state,"
                + " request_json FROM ma_operation WHERE operation_kind ="
                + " 'PR_WATCH_INJECT' AND tenant_id = ? AND session_id = ?",
                TENANT, sessionId);
    }

    @Test
    void createBindsAnActiveSessionOfTheChannelWorkspace() {
        String sessionId = createSession(WORKSPACE);
        PrWatchBindingView view = bind(sessionId);
        assertThat(view.bindingId()).isEqualTo(PrWatchOperations
                .prWatchBindingId(TENANT, channel, OWNER, REPO, PR));
        assertThat(view.sessionId()).isEqualTo(sessionId);
        assertThat(view.events()).containsExactly("ci_failure", "head_change");
        assertThat(view.createdAt()).isPositive();
        assertThat(bindings.findBinding(TENANT, channel, OWNER, REPO, PR))
                .isPresent().get()
                .extracting(b -> b.sessionId()).isEqualTo(sessionId);
    }

    @Test
    void createRefusesUnknownForeignAndInactiveSessions() {
        assertThatThrownBy(() -> bind("session-missing"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(404);
                    assertThat(error.getCode()).isEqualTo("session_not_found");
                });
        // A Session of another Workspace is invisible to this channel.
        String foreign = createSession(OTHER_WORKSPACE);
        assertThatThrownBy(() -> bind(foreign))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(404);
                    assertThat(error.getCode()).isEqualTo("session_not_found");
                });
        String closed = createSession(WORKSPACE);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, closed);
        assertThatThrownBy(() -> bind(closed))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("session_not_active");
                });
        String deleted = createSession(WORKSPACE);
        jdbc.update("UPDATE ma_session SET status = 'DELETED'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, deleted);
        assertThatThrownBy(() -> bind(deleted))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("session_not_found"));
    }

    @Test
    void createIsIdempotentAndRefusesAConflictingRebind() {
        String first = createSession(WORKSPACE);
        PrWatchBindingView view = bind(first);
        assertThat(bind(first)).isEqualTo(view);
        assertThat(ledgerRows(first)).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_pr_watch_binding WHERE tenant_id = ?"
                + " AND channel_id = ?", Long.class,
                TENANT, channel)).isEqualTo(1);
        String second = createSession(WORKSPACE);
        assertThatThrownBy(() -> service.create(TENANT, channel,
                new PrWatchCreateRequest(second, OWNER, REPO, PR,
                        List.of("ci_failure", "head_change"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("pr_watch_binding_conflict");
                });
        assertThatThrownBy(() -> service.create(TENANT, channel,
                new PrWatchCreateRequest(first, OWNER, REPO, PR,
                        List.of("merge_conflict"))))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("pr_watch_binding_conflict"));
    }

    @Test
    void createRefusesAnUnknownTransition() {
        String sessionId = createSession(WORKSPACE);
        assertThatThrownBy(() -> service.create(TENANT, channel,
                new PrWatchCreateRequest(sessionId, OWNER, REPO, PR,
                        List.of("state_change"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(400);
                    assertThat(error.getCode()).isEqualTo("invalid_request");
                });
    }

    @Test
    void listAndRetireServeTheChannelsBindings() {
        String sessionId = createSession(WORKSPACE);
        PrWatchBindingView view = bind(sessionId);
        service.create(TENANT, channel, new PrWatchCreateRequest(sessionId,
                OWNER, REPO, PR + 1, List.of("merge_conflict")));
        assertThat(service.list(TENANT, channel).bindings()).hasSize(2);
        PrWatchBindingView retired = service.retire(TENANT, channel,
                new PrWatchRetireRequest(OWNER, REPO, PR));
        assertThat(retired.bindingId()).isEqualTo(view.bindingId());
        assertThat(service.list(TENANT, channel).bindings()).hasSize(1);
        assertThatThrownBy(() -> service.retire(TENANT, channel,
                new PrWatchRetireRequest(OWNER, REPO, PR)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("pr_watch_binding_not_found"));
    }

    @Test
    void injectForcesTheBoundSessionAndPinsTheEnvelope() {
        String sessionId = createSession(WORKSPACE);
        PrWatchBindingView binding = bind(sessionId);
        PrWatchAdmission admission = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "the build went red"));
        String inputId = PrWatchOperations.prWatchInputId(TENANT, channel,
                OWNER, REPO, PR, "ci_failure", HEAD, 1);
        assertThat(admission.inputId()).isEqualTo(inputId);
        assertThat(admission.turnId()).isEqualTo(inputId);
        assertThat(admission.sessionId()).isEqualTo(sessionId);
        assertThat(admission.bindingId()).isEqualTo(binding.bindingId());
        assertThat(admission.replayed()).isFalse();
        // The Harness saw exactly the bound Session, never a caller-chosen one.
        assertThat(harness.calls).hasSize(1);
        assertThat(harness.calls.getFirst().sessionId()).isEqualTo(sessionId);
        Map<String, Object> body = harness.calls.getFirst().body();
        assertThat(body.get("kind")).isEqualTo("submit_pr_event_input");
        // The Harness channel-operation gate admits only a UUID operationId
        // (hosted-harness-session.ts HOSTED_UUID), never the prw-… input id.
        // Pin the exact regex the Harness enforces so a non-UUID transport
        // token (which the recording Harness would silently accept) fails here.
        assertThat(String.valueOf(body.get("operationId")))
                .matches(HOSTED_UUID_REGEX);
        assertThat(body.get("operationId")).isEqualTo(UUID.nameUUIDFromBytes(
                inputId.getBytes(StandardCharsets.UTF_8)).toString());
        assertThat(body.get("inputId")).isEqualTo(inputId);
        assertThat(body.get("turnId")).isEqualTo(inputId);
        assertThat(body.get("bindingId")).isEqualTo(binding.bindingId());
        assertThat(body.get("owner")).isEqualTo(OWNER);
        assertThat(body.get("repo")).isEqualTo(REPO);
        assertThat(body.get("prNumber")).isEqualTo(PR);
        assertThat(body.get("transition")).isEqualTo("ci_failure");
        assertThat(body.get("headSha")).isEqualTo(HEAD);
        assertThat(body.get("episode")).isEqualTo(1L);
        assertThat(body.get("evidence")).isEqualTo("checks: build / test");
        assertThat(body.get("text")).isEqualTo("the build went red");
        assertThat(ledgerRows(sessionId)).singleElement()
                .satisfies(row -> {
                    assertThat(row.get("state")).isEqualTo("admitted");
                    assertThat(row.get("session_id")).isEqualTo(sessionId);
                });
        // Private-only: a pr_event input plans no channel delivery.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_delivery"
                + " WHERE tenant_id = ? AND channel_id = ?", Long.class,
                TENANT, channel)).isZero();
    }

    @Test
    void injectReplaysTheSameAdmission() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        PrWatchAdmission first = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "the build went red"));
        PrWatchAdmission again = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "the build went red"));
        assertThat(again.inputId()).isEqualTo(first.inputId());
        assertThat(again.sessionId()).isEqualTo(sessionId);
        assertThat(again.replayed()).isTrue();
        assertThat(ledgerRows(sessionId)).hasSize(1);
        // The Harness deduped the redelivery onto the one committed input.
        assertThat(harness.inputs).hasSize(1);
    }

    @Test
    void crashBetweenHarnessCommitAndLedgerReplaysThePinnedEnvelope() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        harness.loseAnswerOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "the build went red")))
                .isInstanceOf(IllegalStateException.class);
        // The Harness committed; the ledger never saw the answer.
        assertThat(harness.inputs).hasSize(1);
        assertThat(ledgerRows(sessionId)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("staged");
        // The adapter retries with a different presentation text: the replay
        // must send the pinned envelope, not the new request's.
        PrWatchAdmission replay = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "another wording"));
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.inputId()).isEqualTo(PrWatchOperations
                .prWatchInputId(TENANT, channel, OWNER, REPO, PR,
                        "ci_failure", HEAD, 1));
        assertThat(harness.calls).hasSize(2);
        assertThat(harness.calls.get(1).body().get("text"))
                .isEqualTo("the build went red");
        assertThat(ledgerRows(sessionId)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("admitted");
    }

    @Test
    void injectRefusesUnknownBindingAndDisabledTransitions() {
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("pr_watch_binding_not_found"));
        String sessionId = createSession(WORKSPACE);
        service.create(TENANT, channel, new PrWatchCreateRequest(sessionId,
                OWNER, REPO, PR, List.of("ci_failure")));
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("merge_conflict", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("pr_watch_transition_not_enabled");
                });
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("state_change", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("invalid_request"));
        assertThat(harness.calls).isEmpty();
    }

    @Test
    void injectRefusesATransitionAlreadyAdmittedToAnotherSession() {
        String first = createSession(WORKSPACE);
        bind(first);
        service.inject(TENANT, channel, inject("ci_failure", HEAD, "text"));
        service.retire(TENANT, channel, new PrWatchRetireRequest(OWNER, REPO, PR));
        String second = createSession(WORKSPACE);
        bind(second);
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("pr_watch_injection_conflict");
                });
        assertThat(harness.calls).hasSize(1);
    }

    @Test
    void injectReleasesAStagedRowAndDeliversToTheReboundSession() {
        // A transient Harness failure stages the row for Session A without
        // admitting it. After retire + rebind to Session B the adapter
        // re-drives the identical occurrence: the pre-release replay against
        // the pinned Session proves it never committed (A is closed, so the
        // replay cannot answer), and the staged row is released and re-staged
        // for B — not refused as a conflict that would reserve the identity
        // for a dead binding forever.
        String first = createSession(WORKSPACE);
        bind(first);
        harness.failTransientOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(503));
        assertThat(ledgerRows(first)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("staged");
        service.retire(TENANT, channel, new PrWatchRetireRequest(OWNER, REPO, PR));
        // CLOSED is terminal: the pinned Session can never accept the input,
        // so the replay against it fails and the receipt is releasable.
        jdbc.update("UPDATE ma_session SET status = 'CLOSED'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, first);
        String second = createSession(WORKSPACE);
        bind(second);
        PrWatchAdmission admission = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text"));
        assertThat(admission.sessionId()).isEqualTo(second);
        assertThat(admission.replayed()).isFalse();
        assertThat(ledgerRows(first)).isEmpty();
        assertThat(ledgerRows(second)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("admitted");
    }

    @Test
    void aCommittedStagedRowIsNotRedeliveredToTheReboundSession() {
        // The Harness committed the input into Session A, then the answer
        // was lost before admit(): the row stays staged while A already
        // acted on the occurrence. After retire + rebind to Session B (A
        // stays alive), the re-inject must replay against the pinned
        // Session, admit its row and return the original admission — never
        // release and re-deliver the occurrence to B as a fresh turn.
        String first = createSession(WORKSPACE);
        bind(first);
        harness.loseAnswerOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOf(IllegalStateException.class);
        assertThat(ledgerRows(first)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("staged");
        service.retire(TENANT, channel,
                new PrWatchRetireRequest(OWNER, REPO, PR));
        String second = createSession(WORKSPACE);
        bind(second);
        PrWatchAdmission admission = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text"));
        // B received no input: the only commit is A's original one.
        assertThat(harness.commits).singleElement()
                .satisfies(commit -> assertThat(commit.sessionId())
                        .isEqualTo(first));
        assertThat(admission.sessionId()).isEqualTo(first);
        assertThat(admission.replayed()).isTrue();
        assertThat(ledgerRows(first)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("admitted");
        assertThat(ledgerRows(second)).isEmpty();
    }

    @Test
    void aStagedRowIsNotReplayedIntoASessionThatLeftTheWorkspace() {
        // A staged receipt for Session A survives a retire. A then leaves the
        // instance's Workspace (still ACTIVE). After rebind to Session B the
        // re-inject must revalidate the pinned Session against the current
        // Workspace and refuse to replay into A — release the row and deliver
        // to B instead, never landing PR-watch content outside the owner's
        // grant. The Harness resolves a Session by id and would answer A, so
        // only the Workspace revalidation can refuse the replay.
        String first = createSession(WORKSPACE);
        bind(first);
        harness.failTransientOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(503));
        assertThat(ledgerRows(first)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("staged");
        service.retire(TENANT, channel,
                new PrWatchRetireRequest(OWNER, REPO, PR));
        jdbc.update("UPDATE ma_session SET workspace_id = ?"
                + " WHERE tenant_id = ? AND session_id = ?",
                OTHER_WORKSPACE, TENANT, first);
        String second = createSession(WORKSPACE);
        bind(second);
        PrWatchAdmission admission = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text"));
        assertThat(admission.sessionId()).isEqualTo(second);
        assertThat(admission.replayed()).isFalse();
        assertThat(harness.commits).singleElement()
                .satisfies(commit -> assertThat(commit.sessionId())
                        .isEqualTo(second));
        assertThat(ledgerRows(first)).isEmpty();
        assertThat(ledgerRows(second)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("admitted");
    }

    @Test
    void anOutcomeUnknownReplayDoesNotReleaseThePinnedRow() {
        // The replay against the pinned Session fails with an outcome-unknown
        // transport error: it may have committed. The row must stay pinned to
        // A (retryable), never released and re-delivered to B. Once the replay
        // can answer, A's original admission is returned.
        String first = createSession(WORKSPACE);
        bind(first);
        harness.failTransientOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(503));
        service.retire(TENANT, channel,
                new PrWatchRetireRequest(OWNER, REPO, PR));
        String second = createSession(WORKSPACE);
        bind(second);
        harness.failUnknownOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(503));
        assertThat(ledgerRows(first)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("staged");
        assertThat(ledgerRows(second)).isEmpty();
        assertThat(harness.commits).isEmpty();
        PrWatchAdmission admission = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text"));
        assertThat(admission.sessionId()).isEqualTo(first);
        assertThat(admission.replayed()).isFalse();
        assertThat(harness.commits).singleElement()
                .satisfies(commit -> assertThat(commit.sessionId())
                        .isEqualTo(first));
        assertThat(ledgerRows(second)).isEmpty();
    }

    @Test
    void aDeterministicRefusalReleasesTheStagedRow() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        harness.refuseDeterministicOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(400));
        // A refusal verdict proves non-commit: the staged receipt is released,
        // not orphaned for a binding the adapter will poison and unsubscribe.
        String inputId = PrWatchOperations.prWatchInputId(TENANT, channel,
                OWNER, REPO, PR, "ci_failure", HEAD, 1);
        assertThat(injections.find(TENANT, inputId)).isEmpty();
        assertThat(ledgerRows(sessionId)).isEmpty();
    }

    @Test
    void aConcurrentAdmissionOfTheSameOccurrenceIsNotAConflict() {
        // A concurrent inject of the same occurrence already admitted the row
        // to this Session between submit and admit: admit() matches no staged
        // row, but the re-read shows the same-Session admission — return it,
        // not a false 409.
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        final boolean[] swallowOnce = {true};
        PrWatchInjectionRepository racing = new PrWatchInjectionRepository() {
            private final JdbcPrWatchInjectionRepository delegate =
                    new JdbcPrWatchInjectionRepository(jdbc);

            @Override
            public PrWatchInjection findOrCreate(PrWatchInjection candidate) {
                return delegate.findOrCreate(candidate);
            }

            @Override
            public Optional<PrWatchInjection> find(String tenantId,
                    String inputId) {
                return delegate.find(tenantId, inputId);
            }

            @Override
            public PrWatchInjection admit(String tenantId, String inputId,
                    String admitSessionId) {
                PrWatchInjection result = delegate.admit(tenantId, inputId,
                        admitSessionId);
                if (swallowOnce[0]) {
                    swallowOnce[0] = false;
                    return null;
                }
                return result;
            }

            @Override
            public boolean releaseStaged(String tenantId, String inputId) {
                return delegate.releaseStaged(tenantId, inputId);
            }
        };
        ManagedPrWatchService racingService = new ManagedPrWatchService(
                instances, sessionQueries, bindings, racing, harness, mapper);
        PrWatchAdmission admission = racingService.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text"));
        assertThat(admission.sessionId()).isEqualTo(sessionId);
        assertThat(admission.replayed()).isFalse();
        assertThat(ledgerRows(sessionId)).singleElement()
                .extracting(row -> row.get("state")).isEqualTo("admitted");
    }

    @Test
    void findOrCreateRefusesACandidateThatClaimsAdmission() {
        String sessionId = createSession(WORKSPACE);
        PrWatchBindingView binding = bind(sessionId);
        String inputId = PrWatchOperations.prWatchInputId(TENANT, channel,
                OWNER, REPO, PR, "ci_failure", HEAD, 1);
        // Ingress only ever stages: admission is recorded by admit() after
        // the Harness commits, never claimed by the candidate itself.
        PrWatchInjection candidate = new PrWatchInjection(TENANT, inputId,
                channel, binding.bindingId(), sessionId, OWNER, REPO, PR,
                "ci_failure", HEAD, 1, "checks: build / test", "text",
                "admitted", 0, 0);
        assertThatThrownBy(() -> injections.findOrCreate(candidate))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(injections.find(TENANT, inputId)).isEmpty();
    }

    @Test
    void admitOnlyFlipsTheStagedRowOfTheExpectedSession() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        harness.failTransientOnce = true;
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(503));
        String inputId = PrWatchOperations.prWatchInputId(TENANT, channel,
                OWNER, REPO, PR, "ci_failure", HEAD, 1);
        // A concurrent rebind must not let admit() flip another Session's
        // row: the identity predicate matches no staged row, so the result
        // is null and the row keeps its owner.
        assertThat(injections.admit(TENANT, inputId, "session-other")).isNull();
        assertThat(injections.find(TENANT, inputId)).get()
                .extracting(PrWatchInjection::state).isEqualTo("staged");
        assertThat(injections.admit(TENANT, inputId, sessionId)).isNotNull();
        assertThat(injections.find(TENANT, inputId)).get()
                .extracting(PrWatchInjection::state).isEqualTo("admitted");
    }

    @Test
    void distinctTransitionsAndHeadsDeriveDistinctInputs() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        PrWatchAdmission failure = service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "red"));
        PrWatchAdmission moved = service.inject(TENANT, channel,
                inject("head_change", "b".repeat(40), "moved"));
        PrWatchAdmission movedAgain = service.inject(TENANT, channel,
                inject("head_change", "c".repeat(40), "moved again"));
        assertThat(List.of(failure.inputId(), moved.inputId(),
                movedAgain.inputId())).doesNotHaveDuplicates();
        assertThat(ledgerRows(sessionId)).hasSize(3);
    }

    @Test
    void aRecurrenceWithANewEpisodeDerivesANewInput() {
        String sessionId = createSession(WORKSPACE);
        service.create(TENANT, channel, new PrWatchCreateRequest(sessionId,
                OWNER, REPO, PR, List.of("merge_conflict")));
        PrWatchAdmission first = service.inject(TENANT, channel,
                inject("merge_conflict", HEAD, 1, "dirty"));
        // dirty -> clean -> dirty on the SAME head: a legitimate recurrence
        // is a new episode and must not dedupe into the first admission.
        PrWatchAdmission recurrence = service.inject(TENANT, channel,
                inject("merge_conflict", HEAD, 2, "dirty again"));
        assertThat(recurrence.inputId()).isNotEqualTo(first.inputId());
        assertThat(recurrence.replayed()).isFalse();
        assertThat(ledgerRows(sessionId)).hasSize(2);
        // A redelivery of the SAME occurrence still replays its admission.
        assertThat(service.inject(TENANT, channel,
                inject("merge_conflict", HEAD, 2, "dirty again")).replayed())
                .isTrue();
        assertThat(ledgerRows(sessionId)).hasSize(2);
    }

    @Test
    void injectRequiresAConnectedChannelAndTheRightTenant() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        instances.setState(TENANT, channel, "disconnected");
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("channel_disconnected"));
        assertThatThrownBy(() -> service.inject("tenant-other", channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("channel_not_found"));
    }

    @Test
    void ownershipMoveRefusedWhilePrWatchBindingsRetained() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId); // a PR-watch binding, zero channel route bindings
        // Re-registering the same channel into another Workspace must be
        // refused: the retained PR-watch binding still names a Session of the
        // old Workspace. Counting only ma_channel_binding would let the move
        // through and inject into a Session the new owner's grant never covered.
        assertThatThrownBy(() -> channels.register(TENANT, channel,
                new RegisterChannelRequest("github", "bot-account", 2, ACTOR,
                        OTHER_WORKSPACE, ".",
                        new ChannelPolicy("github", "allowlist",
                                List.of("maintainer"), "followup"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("channel_ownership_conflict");
                });
    }

    @Test
    void keepsTheOwnershipGuardAtomicAgainstARacingPrWatchBind()
            throws InterruptedException {
        // The ownership-move UPDATE counts PR-watch bindings in its own
        // subquery: a bind committed between the pre-check and the write
        // must still flatten the write to zero rows. The channel starts
        // with zero bindings of either class, so the pre-check passes and
        // only the UPDATE's own count can refuse the move.
        java.util.concurrent.CountDownLatch atCount =
                new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch bound =
                new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicLong preCheck =
                new java.util.concurrent.atomic.AtomicLong(-1);
        JdbcTemplate latching = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> requiredType,
                    Object... args) {
                T value = super.queryForObject(sql, requiredType, args);
                if (sql.contains(
                        "SELECT COUNT(*) FROM ma_channel_binding")) {
                    preCheck.set(((Number) value).longValue());
                    atCount.countDown();
                    try {
                        bound.await();
                    } catch (InterruptedException error) {
                        throw new RuntimeException(error);
                    }
                }
                return value;
            }
        };
        JdbcChannelInstanceStore.ChannelInstance snapshot = instances
                .findInstance(TENANT, channel).orElseThrow();
        JdbcChannelInstanceStore racingStore =
                new JdbcChannelInstanceStore(latching);
        String sessionId = createSession(WORKSPACE);
        Thread binder = new Thread(() -> {
            try {
                atCount.await();
                bindings.bind(new PrWatchBinding(TENANT, channel,
                        PrWatchOperations.prWatchBindingId(TENANT, channel,
                                OWNER, REPO, PR),
                        OWNER, REPO, PR, sessionId, "[\"ci_failure\"]", 0));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                bound.countDown();
            }
        });
        binder.start();
        try {
            IllegalStateException error = assertThrows(
                    IllegalStateException.class,
                    () -> racingStore.register(
                            new JdbcChannelInstanceStore.ChannelInstance(TENANT,
                                    channel, "github", "bot-account", 2,
                                    "connected", "other-actor", WORKSPACE, ".",
                                    snapshot.policyJson(), 0, 0)));
            assertThat(error.getMessage())
                    .isEqualTo("channel_ownership_conflict");
        } finally {
            binder.interrupt();
            binder.join(10_000);
        }
        // The pre-check saw zero bindings: the refusal came from the
        // UPDATE's own PR-watch count, not from the earlier SELECT. The
        // stored connection keeps its owner and the raced-in binding stays.
        assertThat(preCheck.get()).isZero();
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(JdbcChannelInstanceStore.ChannelInstance::actorId)
                .isEqualTo(ACTOR);
        assertThat(bindings.findBinding(TENANT, channel, OWNER, REPO, PR))
                .isPresent();
    }

    @Test
    void injectRefusesAndRetiresWhenTheBoundSessionIsGone() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        jdbc.update("UPDATE ma_session SET status = 'DELETED'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, sessionId);
        // inject re-validates the bound Session's Workspace/liveness and fails
        // closed instead of starting a turn in a Session that is gone.
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("session_not_found"));
        // The dead binding is lazily retired so the PR can be rebound.
        assertThat(bindings.findBinding(TENANT, channel, OWNER, REPO, PR))
                .isEmpty();
        String fresh = createSession(WORKSPACE);
        assertThat(bind(fresh).sessionId()).isEqualTo(fresh);
    }

    @Test
    void injectRefusesAndRetiresWhenTheBoundSessionIsClosed() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        jdbc.update("UPDATE ma_session SET status = 'CLOSED'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, sessionId);
        // CLOSED is terminal — the Session can never accept an input again.
        // inject fails closed with the liveness refusal, and the lazy-retire
        // fires on session_not_active too, so the PR can be rebound instead
        // of being blocked by the dead binding forever.
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("session_not_active");
                });
        assertThat(bindings.findBinding(TENANT, channel, OWNER, REPO, PR))
                .isEmpty();
        String fresh = createSession(WORKSPACE);
        assertThat(bind(fresh).sessionId()).isEqualTo(fresh);
    }

    @Test
    void injectRefusesAnUnadmittableWrappedPromptBeforeStaging() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        // A raw text at the wire maximum wraps past the Harness char cap. The
        // route must refuse before staging, or the row would stay staged
        // forever and every redelivery would replay the un-admittable payload.
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, "x".repeat(32_000))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(400);
                    assertThat(error.getCode()).isEqualTo("invalid_request");
                });
        assertThat(ledgerRows(sessionId)).isEmpty();
        assertThat(harness.calls).isEmpty();
    }

    @Test
    void injectRefusesEvidenceOverTheCharacterBoundBeforeStaging() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        // Defence in depth beside the @Size wire bound: the service itself
        // refuses evidence past the contract's character cap.
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                new PrWatchInjectRequest(OWNER, REPO, PR, "ci_failure", HEAD,
                        1, "x".repeat(4_001), "text")))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(400);
                    assertThat(error.getCode()).isEqualTo("invalid_request");
                });
        assertThat(ledgerRows(sessionId)).isEmpty();
        assertThat(harness.calls).isEmpty();
    }

    @Test
    void injectRefusesAnEnvelopeOverTheByteBoundBeforeStaging() {
        String sessionId = createSession(WORKSPACE);
        bind(sessionId);
        // Each control character JSON-serializes to a 6-byte escape: 12000
        // of them stay under the wrapped char cap yet push the envelope past
        // the byte cap — the branch the plain-text char-bound test never
        // reaches.
        String text = "\u0001".repeat(12_000);
        String wrapped = PrWatchOperations.prWatchInputText(OWNER, REPO, PR,
                "ci_failure", HEAD, "checks: build / test", text);
        assertThat(wrapped.length())
                .isLessThanOrEqualTo(PrWatchOperations.MAX_TEXT_CHARS);
        assertThatThrownBy(() -> service.inject(TENANT, channel,
                inject("ci_failure", HEAD, text)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(400);
                    assertThat(error.getCode()).isEqualTo("invalid_request");
                });
        assertThat(ledgerRows(sessionId)).isEmpty();
        assertThat(harness.calls).isEmpty();
    }

    private record Call(String sessionId, Map<String, Object> body) {
    }

    static final class RecordingHarness implements HarnessConnector {
        final List<Call> calls = new ArrayList<>();
        /** Committed inputs keyed by Session + input id: each Session has
         * its own journal, so the same input id committed into two Sessions
         * is two commits, exactly as the hosted funnel records them. */
        final Map<String, Map<String, Object>> inputs = new LinkedHashMap<>();
        /** First-time commits, each naming the Session that received it. */
        final List<Call> commits = new ArrayList<>();
        boolean loseAnswerOnce;
        boolean failTransientOnce;
        boolean failUnknownOnce;
        boolean refuseDeterministicOnce;
        private final SessionQueryStore sessions;

        RecordingHarness(SessionQueryStore sessions) {
            this.sessions = sessions;
        }

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public Attachment createOrLoad(String tenantId, String sessionId,
                boolean loadExisting) {
            return new Attachment("boot");
        }

        @Override
        public Admission submit(String tenantId, String sessionId,
                String promptId, List<Map<String, Object>> input,
                String payloadDigest) {
            throw new UnsupportedOperationException();
        }

        @Override
        public SourceStream stream(String tenantId, String sessionId,
                long lastEventId, String eventEpoch) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void cancel(String tenantId, String sessionId) {
        }

        @Override
        public void rename(String tenantId, String sessionId, String title) {
        }

        @Override
        public String closeSession(String tenantId, String sessionId) {
            return "boot";
        }

        @Override
        public Map<String, Object> runChannelOperation(String tenantId,
                String sessionId, Map<String, Object> body) {
            calls.add(new Call(sessionId, new LinkedHashMap<>(body)));
            assertThat(body.get("kind")).isEqualTo("submit_pr_event_input");
            // A non-ACTIVE Session can never accept an input again, as the
            // hosted funnel refuses it: a replay against a dead binding
            // fails instead of answering.
            SessionRecord session = sessions.findSession(tenantId, sessionId)
                    .orElse(null);
            if (session == null || !"ACTIVE".equals(session.status())) {
                throw new HarnessFailure("the session is not active");
            }
            if (failTransientOnce) {
                failTransientOnce = false;
                throw new HarnessFailure("transient harness failure");
            }
            if (failUnknownOnce) {
                failUnknownOnce = false;
                throw new HarnessTransportFailure("outcome unknown", null);
            }
            if (refuseDeterministicOnce) {
                refuseDeterministicOnce = false;
                throw new HarnessHttpFailure("refused", null, 400,
                        "{\"code\":\"invalid_request\"}",
                        Map.of("code", "invalid_request"));
            }
            String inputId = String.valueOf(body.get("inputId"));
            String journalKey = sessionId + "\u0000" + inputId;
            boolean replayed = inputs.containsKey(journalKey);
            if (inputs.putIfAbsent(journalKey, body) == null) {
                commits.add(new Call(sessionId, new LinkedHashMap<>(body)));
            }
            if (loseAnswerOnce) {
                loseAnswerOnce = false;
                throw new IllegalStateException("answer lost after commit");
            }
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("operationId", body.get("operationId"));
            answer.put("state", "settled");
            answer.put("inputId", inputId);
            answer.put("turnId", inputId);
            answer.put("replayed", replayed);
            return answer;
        }
    }
}
