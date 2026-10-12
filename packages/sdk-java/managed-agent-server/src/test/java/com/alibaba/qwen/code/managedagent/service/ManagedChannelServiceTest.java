package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicChannel;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicChannelDelivery;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ChannelPolicy;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ClaimResponse;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ClaimedDelivery;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.DeliveryView;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.InboundAdmission;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.InboundAttachment;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.InboundEventRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ReceiptRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.RegisterChannelRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ResendResponse;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.RouteScope;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore;
import com.alibaba.qwen.code.managedagent.store.JdbcChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.store.JdbcChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * H5b/H5c: the control plane's channel service against the real stores on
 * H2 and a recording Hosted Harness that answers the channel operations
 * the way the hosted funnel does.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-channel-service;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedChannelServiceTest {
    private static final String TENANT = "tenant-channel-"
            + UUID.randomUUID();
    private static final String WORKSPACE = "ws-channel";
    private static final String ACTOR = "channel-owner";
    /** Per test: the H2 database outlives the test, and generations only move forward. */
    private String channel;

    @Autowired
    private ChannelInstanceStore instances;

    @Autowired
    private ManagedAgentService sessions;

    @Autowired
    private ManagedWorkspaceRegistry workspaces;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private JdbcTemplate jdbc;

    private RecordingHarness harness;
    private AtomicLong clock;
    private ManagedChannelService service;

    @BeforeEach
    void setUp() {
        jdbc.update("INSERT IGNORE INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, 'storage', 'Workspace', ?, ?,"
                        + " 'ACTIVE')",
                TENANT, WORKSPACE,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT IGNORE INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')",
                TENANT, WORKSPACE, ACTOR.getBytes(StandardCharsets.UTF_8));
        channel = "mail-" + UUID.randomUUID();
        harness = new RecordingHarness((sessionId, deliveryId, state) -> {
            // The Session store materializes the committed revision's
            // delivery line in the same transaction — and the segment
            // receipts in the record body; the recording Harness mirrors
            // both projections.
            jdbc.update("UPDATE qwen_managed_session_extension_record"
                            + " SET delivery_state = ? WHERE tenant_id = ?"
                            + " AND session_id = ? AND record_id = ?",
                    state, TENANT, sessionId, deliveryId);
            if ("delivered".equals(state)) {
                mirrorReceiptIntoRecord(sessionId, deliveryId);
            }
        });
        clock = new AtomicLong(1_000_000L);
        service = new ManagedChannelService(instances,
                new JdbcChannelRouteRepository(jdbc),
                new JdbcChannelDeliveryRepository(jdbc), sessions, workspaces,
                harness, mapper, Duration.ofMinutes(10), clock::get);
        service.register(TENANT, channel, register(1));
    }

    private static RegisterChannelRequest register(long generation) {
        return new RegisterChannelRequest("email", "agent@example.com",
                generation, ACTOR, WORKSPACE, ".", new ChannelPolicy("email",
                        "allowlist", List.of("alice@example.com"),
                        "followup"));
    }

    private static InboundEventRequest event(long generation, String eventId,
            String text) {
        return new InboundEventRequest(generation, eventId, 1,
                new RouteScope("chat_thread", null, "alice@example.com",
                        "thread-1"),
                "alice@example.com", "alice@example.com", "thread-1",
                "Build status", text, List.of(), null);
    }

    @Test
    void admitsOneInputPerPlatformEventAndKeepsTwoEventsApart() {
        InboundAdmission first = service.submitInbound(TENANT, channel,
                event(1, "1700:42", "check the build"));
        assertThat(first.replayed()).isFalse();
        assertThat(first.inputId()).startsWith("chin-");
        assertThat(first.routeId()).startsWith("chrt-");
        assertThat(harness.operations).hasSize(1);
        assertThat(harness.operations.getFirst().get("kind"))
                .isEqualTo("submit_input");
        assertThat(harness.operations.getFirst().get("inputId"))
                .isEqualTo(first.inputId());
        // The route's Session exists, bound to the registered Workspace,
        // and the binding row names it.
        assertThat(instances.findBinding(TENANT, channel, first.routeId()))
                .isPresent()
                .get()
                .extracting(b -> b.sessionId())
                .isEqualTo(first.sessionId());
        assertThat(instances.sessionStatus(TENANT, first.sessionId()))
                .isEqualTo("ACTIVE");
        // The ingress row is admitted with the input it committed.
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = '" + channel + "'"
                        + " AND platform_event_id = '1700:42'", String.class,
                TENANT)).isEqualTo("admitted");

        // A provider redelivery: the same identity, the same input, no
        // second Session and no second ingress row.
        InboundAdmission again = service.submitInbound(TENANT, channel,
                event(1, "1700:42", "check the build"));
        assertThat(again.inputId()).isEqualTo(first.inputId());
        assertThat(again.sessionId()).isEqualTo(first.sessionId());
        assertThat(again.replayed()).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = ?",
                Integer.class, TENANT, channel)).isEqualTo(1);

        // A second real message with identical text is a second input on
        // the same Session.
        InboundAdmission second = service.submitInbound(TENANT, channel,
                event(1, "1700:43", "check the build"));
        assertThat(second.inputId()).isNotEqualTo(first.inputId());
        assertThat(second.sessionId()).isEqualTo(first.sessionId());
        assertThat(second.routeId()).isEqualTo(first.routeId());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = ?",
                Integer.class, TENANT, channel)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_channel_binding WHERE tenant_id = ?"
                        + " AND channel_id = ?",
                Integer.class, TENANT, channel)).isEqualTo(1);
    }

    @Test
    void recoversAnAdmissionWhoseAnswerWasLost() {
        // The Harness committed, the control plane died before marking the
        // row admitted: the retry re-drives the same operation and the
        // Harness answers the original admission.
        harness.loseAnswerOnce = true;
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:50", "hello")))
                .isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = '" + channel + "'"
                        + " AND platform_event_id = '1700:50'", String.class,
                TENANT)).isEqualTo("staged");
        InboundAdmission retried = service.submitInbound(TENANT, channel,
                event(1, "1700:50", "hello"));
        assertThat(retried.replayed()).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = '" + channel + "'"
                        + " AND platform_event_id = '1700:50'", String.class,
                TENANT)).isEqualTo("admitted");
        assertThat(harness.operations).hasSize(2);
    }

    @Test
    void refusesAStaleOrUnregisteredGenerationAndADisconnectedChannel() {
        service.submitInbound(TENANT, channel, event(1, "1700:60", "one"));
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(2, "1800:1", "two")))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("account generation");
        // A re-key is registered first; then the old generation is stale.
        service.register(TENANT, channel, register(2));
        InboundAdmission rolled = service.submitInbound(TENANT, channel,
                event(2, "1800:1", "two"));
        assertThat(rolled.replayed()).isFalse();
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:61", "late")))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getCode())
                .isEqualTo("channel_generation_stale");
        assertThatThrownBy(() -> service.register(TENANT, channel,
                register(1)))
                .isInstanceOf(ApiException.class);
        service.disconnect(TENANT, channel);
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(2, "1800:2", "three")))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getCode())
                .isEqualTo("channel_disconnected");
        assertThatThrownBy(() -> service.submitInbound(TENANT, "missing",
                event(1, "1", "x")))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getCode())
                .isEqualTo("channel_not_found");
    }

    @Test
    void claimsReceiptsAndSettlesDeliveriesThroughTheLedger() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:70", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId,
                admitted.routeId(), "The build is green.");

        ClaimResponse claimed = service.claimDeliveries(TENANT, channel, 16);
        assertThat(claimed.deliveries()).hasSize(1);
        ClaimedDelivery delivery = claimed.deliveries().getFirst();
        assertThat(delivery.deliveryId()).isEqualTo(deliveryId);
        assertThat(delivery.sessionId()).isEqualTo(admitted.sessionId());
        assertThat(delivery.text()).isEqualTo("The build is green.");
        assertThat(delivery.segments()).hasSize(1);
        assertThat(delivery.segments().getFirst().text())
                .isEqualTo("The build is green.");
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("sending");
        assertThat(instances.findClaim(TENANT, channel, deliveryId))
                .isPresent();
        // The record is sending now, so a second claim finds nothing.
        assertThat(service.claimDeliveries(TENANT, channel, 16).deliveries())
                .isEmpty();

        DeliveryView delivered = service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m1@example.com>",
                        1_750_000_000_000L));
        assertThat(delivered.state()).isEqualTo("delivered");
        assertThat(delivered.providerReceipt()).isEqualTo("<m1@example.com>");
        assertThat(harness.operations.getLast().get("kind"))
                .isEqualTo("segment_receipt");
        // A replayed receipt answers the same state.
        assertThat(service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m1@example.com>",
                        1_750_000_000_000L)).state()).isEqualTo("delivered");

        PublicList<PublicChannelDelivery> listed = service.listDeliveries(
                TENANT, ACTOR, channel, null, 10);
        assertThat(listed.data()).extracting(PublicChannelDelivery::id)
                .containsExactly(deliveryId);
        assertThat(listed.data().getFirst().state()).isEqualTo("delivered");
        assertThat(service.getDelivery(TENANT, ACTOR, channel, deliveryId)
                .providerReceipt()).isEqualTo("<m1@example.com>");
        assertThatThrownBy(() -> service.getDelivery(TENANT, ACTOR, channel,
                "missing"))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getCode())
                .isEqualTo("delivery_not_found");
    }

    @Test
    void settlesUnknownByLeaseNeverResendsAndResendsOnlyOnRequest() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:80", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId,
                admitted.routeId(), "Done.");
        service.claimDeliveries(TENANT, channel, 16);
        // The adapter died after the send: the lease expires, the
        // reconciler settles unknown, and nothing resends.
        int before = (int) harness.operations.stream()
                .filter(op -> deliveryId.equals(op.get("deliveryId")))
                .count();
        service.reconcile();
        assertThat(harness.operations.stream()
                        .filter(op -> deliveryId.equals(op.get("deliveryId")))
                        .count())
                .isEqualTo(before);
        clock.addAndGet(Duration.ofMinutes(11).toMillis());
        jdbc.update("UPDATE qwen_managed_channel_claim SET claimed_at = ?"
                        + " WHERE tenant_id = ? AND delivery_id = ?",
                clock.get() - Duration.ofMinutes(11).toMillis(), TENANT,
                deliveryId);
        service.reconcile();
        assertThat(harness.operations.stream()
                        .filter(op -> deliveryId.equals(op.get("deliveryId")))
                        .reduce((first, second) -> second)).get()
                .extracting(op -> op.get("kind"), op -> op.get("outcome"))
                .containsExactly("settle_delivery", "unknown");
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("unknown");
        Map<String, Object> last = harness.operations.stream()
                .filter(op -> deliveryId.equals(op.get("deliveryId")))
                .reduce((first, second) -> second).orElseThrow();
        service.reconcile();
        assertThat(harness.operations.stream()
                        .filter(op -> deliveryId.equals(op.get("deliveryId")))
                        .reduce((first, second) -> second)).get()
                .isSameAs(last);
        assertThat(service.claimDeliveries(TENANT, channel, 16).deliveries())
                .isEmpty();

        ResendResponse resent = service.resend(TENANT, channel, deliveryId);
        assertThat(resent.possibleDuplicate()).isTrue();
        assertThat(resent.deliveryId()).isEqualTo(deliveryId + ":r1");
        assertThat(resent.resentFrom()).isEqualTo(deliveryId);
        assertThat(service.ledger(TENANT, channel, resent.deliveryId())).get()
                .extracting(row -> row.state()).isEqualTo("planned");
        assertThat(instances.findClaim(TENANT, channel, resent.deliveryId()))
                .isPresent();
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("unknown");

        // A definitive refusal settles rejected through the same step.
        String other = admitted.inputId() + ":other";
        plannedDelivery(admitted.sessionId(), other, admitted.routeId(),
                "Again.");
        service.claimDeliveries(TENANT, channel, 16);
        assertThat(service.receipt(TENANT, channel, other,
                new ReceiptRequest("rejected", null, null, null)).state())
                .isEqualTo("rejected");
    }

    @Test
    void keepsADeterministicHarnessFourHundredAsFourHundred() {
        // A deterministic input refusal is not a server failure: widening
        // the hop's 400 to 503 would hide it from the adapter's
        // permanent-refusal branch, so the classification must survive.
        com.alibaba.qwen.code.daemon.DaemonHttpException refused =
                org.mockito.Mockito.mock(
                        com.alibaba.qwen.code.daemon.DaemonHttpException.class);
        org.mockito.Mockito.when(refused.getStatusCode()).thenReturn(400);
        org.mockito.Mockito.when(refused.getResponseBody())
                .thenReturn("{\"error\":{\"code\":\"invalid_channel_operation\"}}");
        harness.submitErrors.add(refused);
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:98", "hello")))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(org.springframework.http.HttpStatus
                                    .BAD_REQUEST);
                    assertThat(error.getCode())
                            .isEqualTo("invalid_channel_operation");
                });
        // The ingress row stays staged for no second drive: the adapter
        // treats this class as final.
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = '" + channel + "'"
                        + " AND platform_event_id = '1700:98'", String.class,
                TENANT)).isEqualTo("staged");
    }

    @Test
    void crossesASelfHealingHarnessConflictAsRetryable() {
        // A crashed Harness's writer lease outlives it for its duration: the
        // re-attach answers 409 until the lease lapses. The adapter drops
        // every 409, so this one must cross as the retryable 503, while a
        // deterministic channel 409 keeps its class.
        harness.submitErrors.add(harnessError(409,
                "{\"error\":\"managed_session_writer_conflict\","
                        + "\"code\":\"managed_session_writer_conflict\"}"));
        harness.submitErrors.add(harnessError(409,
                "{\"error\":\"channel_operation_conflict\","
                        + "\"code\":\"channel_operation_conflict\"}"));
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:97", "hello")))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(org.springframework.http.HttpStatus
                                    .SERVICE_UNAVAILABLE);
                    assertThat(error.getCode())
                            .isEqualTo("managed_session_writer_conflict");
                });
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:97", "hello")))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(org.springframework.http.HttpStatus
                                    .CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("channel_operation_conflict");
                });
        // Once the lease lapses the same event admits: nothing was lost.
        assertThat(service.submitInbound(TENANT, channel,
                event(1, "1700:97", "hello")).replayed()).isFalse();
    }

    @Test
    void refusesAnOwnershipMoveWhileBindingsRemain() {
        // A moved Workspace/actor must not inherit what the old owner could
        // see: every retained binding still points at a Session of the old
        // Workspace, while the new connection's read authority would answer
        // their routes and receipts (R8 P1). A binding-less re-registration
        // keeps working.
        service.submitInbound(TENANT, channel, event(1, "1700:90", "hi"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_channel_binding WHERE tenant_id = ?"
                        + " AND channel_id = ?", Integer.class, TENANT,
                channel)).isEqualTo(1);
        RegisterChannelRequest moved = new RegisterChannelRequest("email",
                "agent@example.com", 2, "other-actor", "other-workspace",
                ".", new ChannelPolicy("email", "allowlist",
                        List.of("alice@example.com"), "followup"));
        assertThatThrownBy(() -> service.register(TENANT, channel, moved))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(org.springframework.http.HttpStatus
                                    .CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("channel_ownership_conflict");
                });
        // The refusal changed nothing: the connection keeps its owner.
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(ChannelInstanceStore.ChannelInstance::workspaceId)
                .isEqualTo(WORKSPACE);
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(ChannelInstanceStore.ChannelInstance::actorId)
                .isEqualTo(ACTOR);
        // With no binding yet, the same move class is ordinary
        // re-registration.
        String fresh = "mail-" + UUID.randomUUID();
        service.register(TENANT, fresh, moved);
        assertThat(instances.findInstance(TENANT, fresh)).get()
                .extracting(ChannelInstanceStore.ChannelInstance::workspaceId)
                .isEqualTo("other-workspace");
    }

    @Test
    void keepsMonotonicGenerationInTheWriteItself() {
        // The registration race: an earlier SELECT cannot promise against a
        // row that moved forward — the monotonic check rides in the UPDATE
        // (R8 P2). Simulate the stale read with a store whose findInstance
        // answers the just-slipped snapshot.
        ChannelInstanceStore.ChannelInstance snapshot = instances
                .findInstance(TENANT, channel).orElseThrow();
        assertThat(snapshot.accountGeneration()).isEqualTo(1);
        jdbc.update("UPDATE qwen_managed_channel_instance"
                        + " SET account_generation = 3"
                        + " WHERE tenant_id = ? AND channel_id = ?",
                TENANT, channel);
        ChannelInstanceStore racing = new ChannelInstanceStore(jdbc) {
            @Override
            public java.util.Optional<ChannelInstanceStore.ChannelInstance>
                    findInstance(String tenantId, String channelId) {
                return java.util.Optional.of(
                        new ChannelInstanceStore.ChannelInstance(
                                snapshot.tenantId(), snapshot.channelId(),
                                snapshot.platform(), snapshot.accountId(), 1L,
                                snapshot.state(), snapshot.actorId(),
                                snapshot.workspaceId(), snapshot.cwdRelative(),
                                snapshot.policyJson(), snapshot.createdAt(),
                                snapshot.updatedAt()));
            }
        };
        assertThatThrownBy(() -> racing.register(
                        new ChannelInstanceStore.ChannelInstance(TENANT,
                                channel, "email", "agent@example.com", 2,
                                "connected", ACTOR, WORKSPACE, ".",
                                snapshot.policyJson(), 0, 0)))
                .isInstanceOfSatisfying(IllegalStateException.class, error ->
                        assertThat(error.getMessage()).isEqualTo(
                                "channel_generation_stale"));
        // The stored row never regressed.
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(
                        ChannelInstanceStore.ChannelInstance::accountGeneration)
                .isEqualTo(3L);
    }

    @Test
    void keepsTheOwnershipGuardAtomicAgainstARacingBind()
            throws InterruptedException {
        // R10 P2: the binding-count pre-check and the UPDATE must not be two
        // separate statements — a bind committed between them would slip
        // the move past. Hold the COUNT at a latch until the bind commits,
        // then the UPDATE's own subquery must still flatten the write to
        // zero rows.
        service.submitInbound(TENANT, channel, event(1, "1710:1", "hi"));
        java.util.concurrent.CountDownLatch atCount =
                new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch bound =
                new java.util.concurrent.CountDownLatch(1);
        JdbcTemplate latching = new JdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> requiredType,
                    Object... args) {
                T value = super.queryForObject(sql, requiredType, args);
                if (sql.contains(
                        "SELECT COUNT(*) FROM qwen_managed_channel_binding")) {
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
        ChannelInstanceStore.ChannelInstance snapshot = instances
                .findInstance(TENANT, channel).orElseThrow();
        ChannelInstanceStore racingStore = new ChannelInstanceStore(latching);
        Thread binder = new Thread(() -> {
            try {
                atCount.await();
                instances.bind(new ChannelInstanceStore.ChannelBinding(TENANT,
                        channel, "chrt-race", "sess-race", "chat_thread",
                        null, "alice@example.com", "thread-1",
                        instances.databaseNow()));
            } catch (InterruptedException error) {
                throw new RuntimeException(error);
            } finally {
                bound.countDown();
            }
        });
        binder.start();
        assertThatThrownBy(() -> racingStore.register(
                        new ChannelInstanceStore.ChannelInstance(TENANT,
                                channel, "email", "agent@example.com", 1,
                                "connected", "other-actor", WORKSPACE, ".",
                                snapshot.policyJson(), 0, 0)))
                .isInstanceOfSatisfying(IllegalStateException.class, error ->
                        assertThat(error.getMessage()).isEqualTo(
                                "channel_ownership_conflict"));
        binder.join(10_000);
        // The bind raced in mid-check, and the stored connection still
        // names its original owner.
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(ChannelInstanceStore.ChannelInstance::actorId)
                .isEqualTo(ACTOR);
    }

    @Test
    void sweepsPastUnprogressedClaimsInsteadOfStarvingNewerOnes() {
        // Fifty claims that never committed their claimed delivery (the
        // record stays planned) crowd the sweep page; a live claim on a
        // sibling channel must not starve behind them (R8 P2).
        List<String> stalled = new ArrayList<>();
        ChannelDeliveryRepository repo = new JdbcChannelDeliveryRepository(
                jdbc);
        for (int i = 0; i < 50; i++) {
            InboundAdmission admitted = service.submitInbound(TENANT, channel,
                    event(1, "1800:" + (100 + i), "q" + i));
            String deliveryId = admitted.inputId() + ":reply";
            plannedDelivery(admitted.sessionId(), deliveryId,
                    admitted.routeId(), "Done.");
            repo.findOrCreate(new ChannelDeliveryRepository.ChannelDelivery(
                    TENANT, channel, deliveryId, deliveryId + ":0", 0,
                    "planned", null, 0, 0));
            instances.claim(TENANT, channel, deliveryId, admitted.sessionId());
            stalled.add(deliveryId);
        }
        for (int i = 0; i < stalled.size(); i++) {
            // Strictly ordered past-marks, each older than the next: the
            // sweep's first page is exactly this 50, ties impossible.
            jdbc.update("UPDATE qwen_managed_channel_claim"
                            + " SET claimed_at = ? WHERE tenant_id = ?"
                            + " AND delivery_id = ?",
                    clock.get() - Duration.ofDays(1).toMillis() - i * 1000L,
                    TENANT, stalled.get(i));
        }
        String channel2 = "mail-" + UUID.randomUUID();
        service.register(TENANT, channel2, register(1));
        InboundAdmission late = service.submitInbound(TENANT, channel2,
                event(1, "1801:1", "newer"));
        String lateDelivery = late.inputId() + ":reply";
        plannedDelivery(late.sessionId(), lateDelivery, late.routeId(),
                "Done.");
        assertThat(service.claimDeliveries(TENANT, channel2, 16).deliveries())
                .hasSize(1);
        assertThat(service.ledger(TENANT, channel2, lateDelivery)).get()
                .extracting(row -> row.state()).isEqualTo("sending");
        jdbc.update("UPDATE qwen_managed_channel_claim SET claimed_at = ?"
                        + " WHERE tenant_id = ? AND delivery_id = ?",
                clock.get() - Duration.ofMinutes(10).toMillis() - 30_000,
                TENANT, lateDelivery);
        // One sweep settles every unprogressed row unknown; the live claim
        // takes its turn on the next one instead of never.
        service.reconcile();
        List<String> unknowns = jdbc.queryForList(
                "SELECT delivery_id FROM qwen_managed_channel_delivery"
                        + " WHERE tenant_id = ? AND channel_instance_id = ?"
                        + " AND state = 'unknown'",
                String.class, TENANT, channel);
        // Every stalled row advanced; the sweep may also carry an expired
        // planned claim an earlier test of this suite left behind — the
        // page bound is proven by the live claim remaining next.
        assertThat(unknowns).containsAll(stalled);
        assertThat(service.ledger(TENANT, channel2, lateDelivery)).get()
                .extracting(row -> row.state()).isEqualTo("sending");
        service.reconcile();
        assertThat(service.ledger(TENANT, channel2, lateDelivery)).get()
                .extracting(row -> row.state()).isEqualTo("unknown");
    }

    private static com.alibaba.qwen.code.daemon.DaemonHttpException harnessError(
            int status, String body) {
        com.alibaba.qwen.code.daemon.DaemonHttpException error =
                org.mockito.Mockito.mock(
                        com.alibaba.qwen.code.daemon.DaemonHttpException.class);
        org.mockito.Mockito.when(error.getStatusCode()).thenReturn(status);
        org.mockito.Mockito.when(error.getResponseBody()).thenReturn(body);
        return error;
    }

    @Test
    void translatesADaemonGenerationFailureIntoTheRetryableEnvelope() {
        // A generation clash at the Hosted Harness is a transient daemon
        // failure, not an HTTP answer: the adapter still takes the same
        // retryable envelope an HTTP refusal produces.
        harness.throwDaemonOnceOnSubmit = true;
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:99", "hello")))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(org.springframework.http.HttpStatus
                                    .SERVICE_UNAVAILABLE);
                    assertThat(error.getCode())
                            .isEqualTo("channel_operation_failed");
                });
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = '" + channel + "'"
                        + " AND platform_event_id = '1700:99'", String.class,
                TENANT)).isEqualTo("staged");
        // The retry lands clean: the staged row admits on the second drive.
        InboundAdmission retried = service.submitInbound(TENANT, channel,
                event(1, "1700:99", "hello"));
        assertThat(retried.replayed()).isFalse();
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND channel_instance_id = '" + channel + "'"
                        + " AND platform_event_id = '1700:99'", String.class,
                TENANT)).isEqualTo("admitted");
    }

    @Test
    void reconcilesAClaimCommittedBeforeItsAnswerWasLost() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:81", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId,
                admitted.routeId(), "Done.");
        // The claim_delivery commit landed; its answer died on the wire, so
        // the ledger never stepped past planned.
        harness.loseClaimAnswerOnce = true;
        assertThat(service.claimDeliveries(TENANT, channel, 16).deliveries())
                .isEmpty();
        assertThat(instances.findClaim(TENANT, channel, deliveryId))
                .isPresent();
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("planned");
        assertThat(jdbc.queryForObject("SELECT delivery_state FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND record_id = ?", String.class, TENANT,
                admitted.sessionId(), deliveryId)).isEqualTo("sending");
        // Neither recovery entry point saw the committed claim: the record
        // is sending, so no pending poll owes it, and the planned ledger
        // hid the claim from an unreconciled scan. The lease expiry routes
        // it through the ledger — converged to sending, then settled
        // unknown, never offered to another adapter.
        assertThat(service.claimDeliveries(TENANT, channel, 16).deliveries())
                .isEmpty();
        expire(deliveryId);
        service.reconcile();
        assertThat(harness.operations.getLast().get("kind"))
                .isEqualTo("settle_delivery");
        assertThat(harness.operations.getLast().get("outcome"))
                .isEqualTo("unknown");
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("unknown");
    }

    @Test
    void convergesAReceiptCommittedBeforeItsAnswerWasLost() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:82", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId,
                admitted.routeId(), "Done.");
        service.claimDeliveries(TENANT, channel, 16);
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("sending");
        // The accepted receipt committed, with the provider id, but its
        // answer died before the ledger stepped.
        harness.loseReceiptAnswerOnce = true;
        assertThatThrownBy(() -> service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m1@example.com>",
                        1_750_000_000_000L)))
                .isInstanceOf(RuntimeException.class);
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("sending");
        assertThat(jdbc.queryForObject("SELECT delivery_state FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND record_id = ?", String.class, TENANT,
                admitted.sessionId(), deliveryId)).isEqualTo("delivered");
        // The reconciler converges from the committed record — delivered
        // with its provider receipt — and never asks the authority to
        // settle the delivered delivery unknown.
        expire(deliveryId);
        int before = harness.operations.size();
        service.reconcile();
        assertThat(harness.operations).hasSize(before);
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("delivered");
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.providerReceipt())
                .isEqualTo("<m1@example.com>");
    }

    @Test
    void claimsDeliveriesOwedByAnyBindingNotOnlyTheNewest() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:83", "please reply"));
        // Sixty-four newer threads crowd the route's binding out of any
        // newest-first window, and none of them owes a delivery.
        for (int i = 0; i < 64; i++) {
            String crowdSession = "crowd-" + i + '-' + channel;
            jdbc.update("INSERT IGNORE INTO managed_agent_session"
                            + " (tenant_id, session_id, agent_id, title,"
                            + " status, created_at, updated_at)"
                            + " VALUES (?, ?, 'qwen-code', 'mail thread',"
                            + " 'ACTIVE', 1, 1)",
                    TENANT, crowdSession);
            instances.bind(new ChannelInstanceStore.ChannelBinding(TENANT,
                    channel, "chrt-crowd-" + i, crowdSession, "chat_thread",
                    "alice@example.com", "chat-" + i, "thread-" + i, 0));
        }
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId,
                admitted.routeId(), "The oldest thread's reply.");
        ClaimResponse claimed = service.claimDeliveries(TENANT, channel, 16);
        assertThat(claimed.deliveries())
                .extracting(entry -> entry.deliveryId())
                .containsExactly(deliveryId);
        assertThat(claimed.deliveries().getFirst().text())
                .isEqualTo("The oldest thread's reply.");
    }

    @Test
    void servesChannelsWithTheirRoutesToReadersOnly() {
        service.submitInbound(TENANT, channel, event(1, "1700:90", "a"));
        service.submitInbound(TENANT, channel, event(1, "1700:91", "b"));
        PublicList<PublicChannel> listed = service.listChannels(TENANT, ACTOR,
                null, 100);
        PublicChannel listedChannel = listed.data().stream()
                .filter(entry -> entry.id().equals(channel)).findFirst()
                .orElseThrow();
        assertThat(listedChannel.id()).isEqualTo(channel);
        assertThat(listedChannel.object()).isEqualTo("agent.channel");
        assertThat(listedChannel.platform()).isEqualTo("email");
        assertThat(listedChannel.state()).isEqualTo("connected");
        // Two bindings created inside one database millisecond tie on
        // created_at and order by route key, so only the set is pinned.
        assertThat(listedChannel.routes())
                .extracting(r -> r.platformEventId())
                .containsExactlyInAnyOrder("1700:90", "1700:91");
        assertThat(listedChannel.routes().getFirst().state())
                .isEqualTo("admitted");
        assertThat(listedChannel.routes().getFirst().inputId())
                .startsWith("chin-");
        assertThat(service.listChannels(TENANT, "stranger", null, 20).data())
                .isEmpty();
        assertThatThrownBy(() -> service.listDeliveries(TENANT, "stranger",
                channel, null, 20))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getCode())
                .isEqualTo("channel_not_found");
        assertThatThrownBy(() -> service.listChannels(TENANT, ACTOR, "!!",
                20))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getCode())
                .isEqualTo("invalid_cursor");
        assertThatThrownBy(() -> service.listChannels(TENANT, ACTOR, null,
                0))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getCode())
                .isEqualTo("invalid_limit");
    }

    @Test
    void stagesAttachmentDigestsOnTheIngressRow() throws Exception {
        byte[] bytes = "hello".getBytes(StandardCharsets.UTF_8);
        InboundEventRequest event = new InboundEventRequest(1, "1700:95", 1,
                new RouteScope("chat_thread", null, "alice@example.com",
                        "thread-1"),
                "alice@example.com", "alice@example.com", "thread-1", null,
                "see attachment", List.of(new InboundAttachment("notes.txt",
                        "text/plain",
                        Base64.getEncoder().encodeToString(bytes))), null);
        service.submitInbound(TENANT, channel, event);
        String refs = jdbc.queryForObject("SELECT staged_attachment_refs_json"
                        + " FROM qwen_managed_channel_route WHERE tenant_id = ?"
                        + " AND platform_event_id = '1700:95'", String.class,
                TENANT);
        assertThat(refs).contains("sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(bytes)));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> sent = (List<Map<String, Object>>) harness
                .operations.getLast().get("attachments");
        assertThat(sent).hasSize(1);
        assertThat(sent.getFirst().get("fileName")).isEqualTo("notes.txt");
    }

    /** A planned channel_delivery row as the Session store projects it. */
    private void plannedDelivery(String sessionId, String deliveryId,
            String routeId, String text) {
        String resourceId = UUID.randomUUID().toString();
        String body = """
                {"deliveryId":"%s","routeId":"%s","routeRevision":1,
                 "sourceTurnId":"turn","contentRef":{"resourceId":"r","kind":"managed-channel-reply","schemaVersion":1,"byteLength":1,"digest":"%s"},
                 "segments":[{"segmentId":"%s:0","ordinal":0,
                   "contentRef":{"resourceId":"s","kind":"managed-channel-segment","schemaVersion":1,"byteLength":1,"digest":"%s"},
                   "receipt":null}],
                 "cancelRequested":false,
                 "run":{"state":"admitted","reason":null,"definition":null,"executionCallId":null,"effectId":"%s","dispatchId":null,"deliveryId":"%s","execution":null,"runtime":null,"delivery":{"target":"channel","state":"planned"}}}
                """.formatted(deliveryId, routeId, "a".repeat(64), deliveryId,
                "b".repeat(64), deliveryId, deliveryId);
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, created_at)"
                        + " VALUES (?, ?, ?, ?, ?, 'managed-channel_delivery',"
                        + " 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'REFERENCED',"
                        + " CURRENT_TIMESTAMP(6))",
                scopeKey(sessionId), TENANT, WORKSPACE, sessionId, resourceId,
                body.length(), "c".repeat(64),
                body.getBytes(StandardCharsets.UTF_8), "publish-" + resourceId);
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, created_at)"
                        + " VALUES (?, ?, ?, ?, ?, 'channel_delivery', ?, ?,"
                        + " 1, ?, NULL, NULL, 'channel', 'planned', ?)",
                scopeKey(sessionId),
                com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection
                        .recordKey(sessionId, "channel_delivery", deliveryId),
                TENANT, WORKSPACE, sessionId, deliveryId, "d".repeat(64),
                resourceId, clock.get());
        harness.replies.put(deliveryId, text);
    }

    /** The record body gains the committed segment receipt, as the Session
     * store writes it with the delivered revision. */
    private void mirrorReceiptIntoRecord(String sessionId,
            String deliveryId) {
        for (Map<String, Object> row : jdbc.queryForList(
                "SELECT resource_id, inline_bytes"
                        + " FROM qwen_managed_session_resource"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND kind = 'managed-channel_delivery'"
                        + " AND state = 'REFERENCED'",
                TENANT, sessionId)) {
            JsonNode tree;
            try {
                tree = mapper.readTree(
                        new String((byte[]) row.get("inline_bytes"),
                                StandardCharsets.UTF_8));
            } catch (JsonProcessingException error) {
                throw new IllegalStateException(error);
            }
            if (!deliveryId.equals(tree.path("deliveryId").asText())) {
                continue;
            }
            ObjectNode receipt = mapper.createObjectNode();
            receipt.put("providerMessageId", "<m1@example.com>");
            receipt.put("acceptedAt", 1_750_000_000_000L);
            for (JsonNode segment : tree.path("segments")) {
                ((ObjectNode) segment).set("receipt", receipt.deepCopy());
            }
            try {
                jdbc.update("UPDATE qwen_managed_session_resource"
                                + " SET inline_bytes = ?"
                                + " WHERE tenant_id = ? AND resource_id = ?",
                        mapper.writeValueAsString(tree)
                                .getBytes(StandardCharsets.UTF_8),
                        TENANT, row.get("resource_id"));
            } catch (JsonProcessingException error) {
                throw new IllegalStateException(error);
            }
        }
    }

    /** Back-dates the claim so the reconciler sees it as expired. */
    private void expire(String deliveryId) {
        jdbc.update("UPDATE qwen_managed_channel_claim SET claimed_at = ?"
                        + " WHERE tenant_id = ? AND delivery_id = ?",
                clock.get() - Duration.ofMinutes(11).toMillis(), TENANT,
                deliveryId);
    }

    private static String scopeKey(String sessionId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest((TENANT + "\u0000" + sessionId)
                            .getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    /** Answers the channel operations the way the hosted funnel does. */
    interface Projection {
        void deliveryState(String sessionId, String deliveryId, String state);
    }

    static final class RecordingHarness implements HarnessConnector {
        private static final java.util.Set<String> TERMINAL = java.util.Set.of(
                "delivered", "unknown", "rejected", "cancelled");
        final List<Map<String, Object>> operations = new ArrayList<>();
        final Map<String, String> replies = new LinkedHashMap<>();
        private final Map<String, Map<String, Object>> inputs =
                new LinkedHashMap<>();
        private final Map<String, String> deliveryStates =
                new LinkedHashMap<>();
        private final Projection projection;
        boolean loseAnswerOnce;
        boolean loseClaimAnswerOnce;
        boolean loseReceiptAnswerOnce;
        boolean throwDaemonOnceOnSubmit;
        java.util.Queue<com.alibaba.qwen.code.daemon.DaemonException>
                submitErrors = new java.util.ArrayDeque<>();

        RecordingHarness(Projection projection) {
            this.projection = projection;
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
            operations.add(new LinkedHashMap<>(body));
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("operationId", body.get("operationId"));
            answer.put("state", "settled");
            String kind = String.valueOf(body.get("kind"));
            String deliveryId = String.valueOf(body.get("deliveryId"));
            switch (kind) {
                case "submit_input" -> {
                    if (!submitErrors.isEmpty()) {
                        throw submitErrors.poll();
                    }
                    if (throwDaemonOnceOnSubmit) {
                        throwDaemonOnceOnSubmit = false;
                        throw new com.alibaba.qwen.code.daemon.DaemonException(
                                "generation changed");
                    }
                    String inputId = String.valueOf(body.get("inputId"));
                    boolean replayed = inputs.containsKey(inputId);
                    inputs.putIfAbsent(inputId, body);
                    if (loseAnswerOnce) {
                        loseAnswerOnce = false;
                        throw new IllegalStateException(
                                "answer lost after commit");
                    }
                    answer.put("inputId", inputId);
                    answer.put("turnId", inputId);
                    answer.put("routeId", "chrt-" + "e".repeat(64));
                    answer.put("routeRevision", 1L);
                    answer.put("replayed", replayed);
                }
                case "claim_delivery" -> {
                    deliveryStates.put(deliveryId, "sending");
                    projection.deliveryState(sessionId, deliveryId, "sending");
                    if (loseClaimAnswerOnce) {
                        loseClaimAnswerOnce = false;
                        throw new IllegalStateException(
                                "answer lost after commit");
                    }
                    answer.put("delivery", delivery(deliveryId, "sending"));
                    Map<String, Object> reply = new LinkedHashMap<>();
                    reply.put("text", replies.get(deliveryId));
                    reply.put("replyContext", Map.of("parent", "<a@b>"));
                    answer.put("reply", reply);
                    Map<String, Object> segment = new LinkedHashMap<>();
                    segment.put("ordinal", 0);
                    segment.put("segmentId", deliveryId + ":0");
                    segment.put("text", replies.get(deliveryId));
                    answer.put("segments", List.of(segment));
                }
                case "segment_receipt" -> {
                    deliveryStates.put(deliveryId, "delivered");
                    projection.deliveryState(sessionId, deliveryId,
                            "delivered");
                    if (loseReceiptAnswerOnce) {
                        loseReceiptAnswerOnce = false;
                        throw new IllegalStateException(
                                "answer lost after commit");
                    }
                    answer.put("delivery", delivery(deliveryId, "delivered"));
                }
                case "settle_delivery" -> {
                    String outcome = String.valueOf(body.get("outcome"));
                    String current = deliveryStates.get(deliveryId);
                    // The H5a successor rules freeze a terminal line: the
                    // real authority refuses an outcome that disagrees.
                    if (current != null && TERMINAL.contains(current)
                            && !current.equals(outcome)) {
                        throw new IllegalStateException("Channel delivery"
                                + " line " + outcome + " does not match its"
                                + " run and segment receipts");
                    }
                    deliveryStates.put(deliveryId, outcome);
                    projection.deliveryState(sessionId, deliveryId, outcome);
                    answer.put("delivery", delivery(deliveryId, outcome));
                }
                case "resend_delivery" -> {
                    String resent = deliveryId + ":r1";
                    deliveryStates.put(resent, "planned");
                    replies.put(resent, replies.get(deliveryId));
                    answer.put("delivery", delivery(resent, "planned"));
                    answer.put("possibleDuplicate", true);
                }
                default -> throw new IllegalArgumentException(kind);
            }
            return answer;
        }

        private static Map<String, Object> delivery(String deliveryId,
                String state) {
            Map<String, Object> delivery = new LinkedHashMap<>();
            delivery.put("deliveryId", deliveryId);
            delivery.put("routeId", "chrt-" + "e".repeat(64));
            delivery.put("routeRevision", 1L);
            delivery.put("sourceTurnId", "turn");
            delivery.put("state", state);
            delivery.put("cancelRequested", false);
            Map<String, Object> segment = new LinkedHashMap<>();
            segment.put("ordinal", 0);
            segment.put("segmentId", deliveryId + ":0");
            segment.put("providerMessageId",
                    "delivered".equals(state) ? "<m1@example.com>" : null);
            delivery.put("segments", List.of(segment));
            return delivery;
        }
    }
}
