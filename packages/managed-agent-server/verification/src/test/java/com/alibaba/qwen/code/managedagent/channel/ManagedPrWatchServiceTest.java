package com.alibaba.qwen.code.managedagent.channel;

import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ChannelPolicy;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchAdmission;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchBindingView;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchCreateRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchInjectRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchRetireRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.RegisterChannelRequest;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelInstanceStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcPrWatchBindingStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcPrWatchInjectionRepository;
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
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
        harness = new RecordingHarness();
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

    private record Call(String sessionId, Map<String, Object> body) {
    }

    static final class RecordingHarness implements HarnessConnector {
        final List<Call> calls = new ArrayList<>();
        final Map<String, Map<String, Object>> inputs = new LinkedHashMap<>();
        boolean loseAnswerOnce;

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
            String inputId = String.valueOf(body.get("inputId"));
            boolean replayed = inputs.containsKey(inputId);
            inputs.putIfAbsent(inputId, body);
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
