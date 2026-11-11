package com.alibaba.qwen.code.managedagent.channel;

import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ChannelPolicy;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ClaimResponse;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ClaimedDelivery;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ClaimedSegment;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.DeliveryView;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.InboundAdmission;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.InboundAttachment;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.InboundEventRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ReceiptRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.RegisterChannelRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.ResendResponse;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.RouteScope;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelSegmentRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelSegmentRepository.SegmentLedger;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicChannel;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicChannelDelivery;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicChannelDeliverySegment;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelInstanceStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChannelSegmentRepository;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

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
    private JdbcChannelInstanceStore instances;

    @Autowired
    private ManagedAgentService sessions;

    @Autowired
    private JdbcManagedWorkspaceRegistry workspaces;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc;

    private RecordingHarness harness;
    private AtomicLong clock;
    private ManagedChannelService service;
    private JdbcChannelSegmentRepository segmentLedger;

    @BeforeEach
    void setUp() {
        jdbc.update("INSERT IGNORE INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, 'storage', 'Workspace', ?, ?,"
                        + " 'ACTIVE')",
                TENANT, WORKSPACE,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT IGNORE INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')",
                TENANT, WORKSPACE, ACTOR.getBytes(StandardCharsets.UTF_8));
        channel = "mail-" + UUID.randomUUID();
        harness = new RecordingHarness(new Projection() {
            @Override
            public void deliveryState(String sessionId, String deliveryId,
                    String state) {
                // The Session store materializes the committed revision's
                // delivery line in the same transaction — and the segment
                // receipts in the record body; the recording Harness mirrors
                // both projections. The partial revision carries the receipts
                // committed so far, not only the delivered one.
                jdbc.update("UPDATE ma_session_record"
                                + " SET delivery_state = ? WHERE tenant_id = ?"
                                + " AND session_id = ? AND record_id = ?",
                        state, TENANT, sessionId, deliveryId);
                if ("delivered".equals(state) || "partial".equals(state)) {
                    mirrorReceiptIntoRecord(sessionId, deliveryId);
                }
            }

            @Override
            public void commitDelivery(String sessionId, String deliveryId,
                    List<Map<String, Object>> segments) {
                commitDeliveryRecord(sessionId, deliveryId, segments);
            }
        });
        clock = new AtomicLong(1_000_000L);
        segmentLedger = new JdbcChannelSegmentRepository(jdbc);
        service = new ManagedChannelService(instances,
                new JdbcChannelRouteRepository(jdbc),
                new JdbcChannelDeliveryRepository(jdbc), segmentLedger,
                sessions, workspaces,
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
        assertThat(route("1700:42").state()).isEqualTo("admitted");

        // A provider redelivery: the same identity, the same input, no
        // second Session and no second ingress row.
        InboundAdmission again = service.submitInbound(TENANT, channel,
                event(1, "1700:42", "check the build"));
        assertThat(again.inputId()).isEqualTo(first.inputId());
        assertThat(again.sessionId()).isEqualTo(first.sessionId());
        assertThat(again.replayed()).isTrue();
        assertThat(routes().size()).isEqualTo(1);

        // A second real message with identical text is a second input on
        // the same Session.
        InboundAdmission second = service.submitInbound(TENANT, channel,
                event(1, "1700:43", "check the build"));
        assertThat(second.inputId()).isNotEqualTo(first.inputId());
        assertThat(second.sessionId()).isEqualTo(first.sessionId());
        assertThat(second.routeId()).isEqualTo(first.routeId());
        assertThat(routes().size()).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_channel_binding WHERE tenant_id = ?"
                        + " AND channel_id = ?",
                Integer.class, TENANT, channel)).isEqualTo(1);
    }

    // A TAB in an inbound subject survives the producer chain's
    // [\r\n\0] sanitization, and the create route refuses control
    // characters in a title — folding them to spaces at the derivation
    // keeps the route's Session creatable instead of dropping the event as
    // a deterministic refusal the adapter never re-drives.
    @Test
    void bindsARouteWhoseSubjectCarriesAControlCharacter() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                new InboundEventRequest(1, "1700:99", 1,
                        new RouteScope("chat_thread", null,
                                "alice@example.com", "thread-9"),
                        "alice@example.com", "alice@example.com", "thread-9",
                        "Build\tstatus", "check the build", List.of(), null));
        assertThat(admitted.replayed()).isFalse();
        assertThat(instances.findBinding(TENANT, channel, admitted.routeId()))
                .isPresent();
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, TENANT,
                admitted.sessionId())).isEqualTo("email: Build status");
    }

    @Test
    void bindsARouteWhoseSenderIdCarriesAControlCharacter() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                new InboundEventRequest(1, "1700:98", 1,
                        new RouteScope("chat_thread", null,
                                "alice@example.com", "thread-8"),
                        "alice\t@example.com", "alice@example.com",
                        "thread-8", null, "check the build", List.of(),
                        null));
        assertThat(admitted.replayed()).isFalse();
        assertThat(instances.findBinding(TENANT, channel, admitted.routeId()))
                .isPresent();
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, TENANT,
                admitted.sessionId())).isEqualTo("email: alice @example.com");
    }

    // The platform name composes the same title and is validated only as
    // @NotBlank @Size(max = 64) at registration — no character class — so
    // a TAB in it refuses the route's Session exactly like an unfolded
    // subject, and with no binding row written every later event of the
    // route re-drives the same refusal: the platform folds too.
    @Test
    void bindsARouteWhosePlatformCarriesAControlCharacter() {
        String tabbed = "tab-" + UUID.randomUUID();
        service.register(TENANT, tabbed, new RegisterChannelRequest(
                "emai\til", "agent@example.com", 1, ACTOR, WORKSPACE, ".",
                new ChannelPolicy("emai\til", "allowlist",
                        List.of("alice@example.com"), "followup")));
        InboundAdmission admitted = service.submitInbound(TENANT, tabbed,
                new InboundEventRequest(1, "1700:97", 1,
                        new RouteScope("chat_thread", null,
                                "alice@example.com", "thread-7"),
                        "alice@example.com", "alice@example.com", "thread-7",
                        "Build status", "check the build", List.of(), null));
        assertThat(admitted.replayed()).isFalse();
        assertThat(instances.findBinding(TENANT, tabbed, admitted.routeId()))
                .isPresent();
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, TENANT,
                admitted.sessionId())).isEqualTo("emai il: Build status");
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
        assertThat(route("1700:50").state()).isEqualTo("staged");
        InboundAdmission retried = service.submitInbound(TENANT, channel,
                event(1, "1700:50", "hello"));
        assertThat(retried.replayed()).isTrue();
        assertThat(route("1700:50").state()).isEqualTo("admitted");
        assertThat(harness.operations).hasSize(2);
    }

    @Test
    void refusesAStaleOrUnregisteredGenerationAndADisconnectedChannel() {
        service.submitInbound(TENANT, channel, event(1, "1700:60", "one"));
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(2, "1800:1", "two")))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessageContaining("account generation");
        // A re-key is registered first; then the old generation is stale.
        service.register(TENANT, channel, register(2));
        InboundAdmission rolled = service.submitInbound(TENANT, channel,
                event(2, "1800:1", "two"));
        assertThat(rolled.replayed()).isFalse();
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:61", "late")))
                .isInstanceOf(ManagedAgentException.class)
                .extracting(e -> ((ManagedAgentException) e).getCode())
                .isEqualTo("channel_generation_stale");
        assertThatThrownBy(() -> service.register(TENANT, channel,
                register(1)))
                .isInstanceOf(ManagedAgentException.class);
        service.disconnect(TENANT, channel);
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(2, "1800:2", "three")))
                .isInstanceOf(ManagedAgentException.class)
                .extracting(e -> ((ManagedAgentException) e).getCode())
                .isEqualTo("channel_disconnected");
        assertThatThrownBy(() -> service.submitInbound(TENANT, "missing",
                event(1, "1", "x")))
                .isInstanceOf(ManagedAgentException.class)
                .extracting(e -> ((ManagedAgentException) e).getCode())
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
                .isInstanceOf(ManagedAgentException.class)
                .extracting(e -> ((ManagedAgentException) e).getCode())
                .isEqualTo("delivery_not_found");
    }

    @Test
    void claimsAndReceiptsEverySegmentOfAMultiSegmentDelivery() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:90", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);

        ClaimResponse claimed = service.claimDeliveries(TENANT, channel, 16);
        assertThat(claimed.deliveries()).hasSize(1);
        assertThat(claimed.deliveries().getFirst().segments()).hasSize(3);
        // The claim plans every segment, not just the first unsent one.
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::segmentId)
                .containsExactly(deliveryId + ":0", deliveryId + ":1",
                        deliveryId + ":2");
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::ordinal)
                .containsExactly(0, 1, 2);

        // Each receipt lands on its own segment; the line stays partial
        // until the last segment is receipted.
        assertThat(service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null))
                .state()).isEqualTo("partial");
        assertThat(service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 1, "<m1@example.com>", null))
                .state()).isEqualTo("partial");
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>", null);
        assertThat(service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 2, "<m2@example.com>", null))
                .state()).isEqualTo("delivered");
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>",
                        "<m2@example.com>");
        // The public read model exposes every segment with its own receipt.
        PublicChannelDelivery viewed = service.getDelivery(TENANT, ACTOR,
                channel, deliveryId);
        assertThat(viewed.segments())
                .extracting(PublicChannelDeliverySegment::segmentId)
                .containsExactly(deliveryId + ":0", deliveryId + ":1",
                        deliveryId + ":2");
        assertThat(viewed.segments())
                .extracting(PublicChannelDeliverySegment::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>",
                        "<m2@example.com>");
        assertThat(viewed.segments())
                .extracting(PublicChannelDeliverySegment::ordinal)
                .containsExactly(0, 1, 2);
        // The singular fields name the first segment of the array.
        assertThat(viewed.segmentId())
                .isEqualTo(viewed.segments().getFirst().segmentId());
        assertThat(viewed.ordinal())
                .isEqualTo(viewed.segments().getFirst().ordinal());
        assertThat(service.listDeliveries(TENANT, ACTOR, channel, null, 10)
                .data().getFirst().segments()).hasSize(3);
        // The mirrored record body carries one provider id per ordinal, as
        // the adapter sent them, not a single constant on every segment.
        assertThat(recordSegmentReceipts(admitted.sessionId(), deliveryId))
                .containsExactly("<m0@example.com>", "<m1@example.com>",
                        "<m2@example.com>");
    }

    @Test
    void listDeliveriesScopesSegmentsToEachDelivery() {
        InboundAdmission first = service.submitInbound(TENANT, channel,
                event(1, "1700:95", "first"));
        InboundAdmission second = service.submitInbound(TENANT, channel,
                event(1, "1700:96", "second"));
        String firstId = first.inputId() + ":reply";
        String secondId = second.inputId() + ":reply";
        plannedDelivery(first.sessionId(), firstId, first.routeId(), "one", 2);
        plannedDelivery(second.sessionId(), secondId, second.routeId(), "two", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, firstId,
                new ReceiptRequest("accepted", 0, "<f0@example.com>", null));
        service.receipt(TENANT, channel, secondId,
                new ReceiptRequest("accepted", 0, "<s0@example.com>", null));

        List<PublicChannelDelivery> page = service.listDeliveries(TENANT,
                ACTOR, channel, null, 10).data();
        assertThat(page).hasSize(2);
        PublicChannelDelivery firstView = page.stream()
                .filter(d -> d.id().equals(firstId)).findFirst().orElseThrow();
        PublicChannelDelivery secondView = page.stream()
                .filter(d -> d.id().equals(secondId)).findFirst().orElseThrow();
        assertThat(firstView.segments())
                .extracting(PublicChannelDeliverySegment::segmentId)
                .containsExactly(firstId + ":0", firstId + ":1");
        assertThat(firstView.segments())
                .extracting(PublicChannelDeliverySegment::providerReceipt)
                .containsExactly("<f0@example.com>", null);
        assertThat(secondView.segments())
                .extracting(PublicChannelDeliverySegment::segmentId)
                .containsExactly(secondId + ":0", secondId + ":1",
                        secondId + ":2");
        assertThat(secondView.segments())
                .extracting(PublicChannelDeliverySegment::providerReceipt)
                .containsExactly("<s0@example.com>", null, null);
    }

    @Test
    void listDeliveriesReadsThePageSegmentsInOneCall() {
        InboundAdmission first = service.submitInbound(TENANT, channel,
                event(1, "1700:110", "first"));
        InboundAdmission second = service.submitInbound(TENANT, channel,
                event(1, "1700:111", "second"));
        String firstId = first.inputId() + ":reply";
        String secondId = second.inputId() + ":reply";
        plannedDelivery(first.sessionId(), firstId, first.routeId(), "one", 2);
        plannedDelivery(second.sessionId(), secondId, second.routeId(), "two", 3);
        service.claimDeliveries(TENANT, channel, 16);
        // A counting wrapper over the real ledger: the page read must batch the
        // segments in one listByDelivery call, never fall back to a per-row
        // list. Reverting listDeliveries to per-row reads reds this case.
        java.util.concurrent.atomic.AtomicInteger listCalls =
                new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.atomic.AtomicInteger batchCalls =
                new java.util.concurrent.atomic.AtomicInteger();
        ChannelSegmentRepository counting = new ChannelSegmentRepository() {
            @Override
            public void plan(String tenantId, String channelInstanceId,
                    String deliveryId, List<SegmentLedger> segments) {
                segmentLedger.plan(tenantId, channelInstanceId, deliveryId, segments);
            }

            @Override
            public boolean receipt(String tenantId, String channelInstanceId,
                    String deliveryId, int ordinal, String providerReceipt) {
                return segmentLedger.receipt(tenantId, channelInstanceId,
                        deliveryId, ordinal, providerReceipt);
            }

            @Override
            public List<SegmentLedger> list(String tenantId,
                    String channelInstanceId, String deliveryId) {
                listCalls.incrementAndGet();
                return segmentLedger.list(tenantId, channelInstanceId, deliveryId);
            }

            @Override
            public Map<String, List<SegmentLedger>> listByDelivery(String tenantId,
                    String channelInstanceId, List<String> deliveryIds) {
                batchCalls.incrementAndGet();
                return segmentLedger.listByDelivery(tenantId, channelInstanceId,
                        deliveryIds);
            }
        };
        ManagedChannelService countingService = new ManagedChannelService(
                instances, new JdbcChannelRouteRepository(jdbc),
                new JdbcChannelDeliveryRepository(jdbc), counting, sessions,
                workspaces, harness, mapper, Duration.ofMinutes(10), clock::get);
        assertThat(countingService.listDeliveries(TENANT, ACTOR, channel, null, 10)
                .data()).hasSize(2);
        assertThat(batchCalls.get()).isEqualTo(1);
        assertThat(listCalls.get()).isZero();
    }

    @Test
    void reconcileConvergesEverySegmentReceiptAfterALostAnswer() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:91", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        // The Harness committed every segment receipt and the delivered
        // line, but the control plane died before mirroring them into the
        // segment ledger.
        mirrorSegmentReceipts(admitted.sessionId(), deliveryId, 3);
        jdbc.update("UPDATE ma_session_record SET delivery_state='delivered'"
                        + " WHERE tenant_id=? AND session_id=? AND record_id=?",
                TENANT, admitted.sessionId(), deliveryId);
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly(null, null, null);
        expire(deliveryId);
        service.reconcile();
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>",
                        "<m2@example.com>");
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("delivered");
        // The delivery-level representative receipt is the last segment's,
        // not the first: a first-wins fold would persist m0 here.
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.providerReceipt())
                .isEqualTo("<m2@example.com>");
    }

    @Test
    void aResumedPartialDeliveryIsReclaimedNotRejected() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:99", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        // The committed record now holds segment 0's receipt, as the Session
        // store writes it with the partial revision.
        mirrorSegmentReceipts(admitted.sessionId(), deliveryId, 1);
        // A reconnecting adapter polls again: the partial delivery must be
        // handed back, not rejected because its first unsent segment moved
        // past ordinal 0 while the delivery row still names ordinal 0.
        ClaimResponse resumed = service.claimDeliveries(TENANT, channel, 16);
        assertThat(resumed.deliveries()).hasSize(1);
        assertThat(resumed.deliveries().getFirst().deliveryId())
                .isEqualTo(deliveryId);
        // The re-claim hands back only the segments still unsent; the
        // receipted ordinal 0 is never re-handled to the adapter.
        assertThat(resumed.deliveries().getFirst().segments())
                .extracting(ClaimedSegment::ordinal)
                .containsExactly(1, 2);
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.segmentId()).isEqualTo(deliveryId + ":0");
    }

    @Test
    void reconcileRebuildsSegmentRowsThatWereNeverPlanned() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:94", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        // The record carries receipts on the first two segments; the segment
        // rows the claim created are gone, as for a delivery claimed before
        // the segment ledger existed.
        mirrorSegmentReceipts(admitted.sessionId(), deliveryId, 2);
        jdbc.update("DELETE FROM ma_channel_segment WHERE tenant_id=?"
                        + " AND channel_id=?",
                TENANT, channel);
        assertThat(segmentLedger.list(TENANT, channel, deliveryId)).isEmpty();
        expire(deliveryId);
        service.reconcile();
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::segmentId)
                .containsExactly(deliveryId + ":0", deliveryId + ":1",
                        deliveryId + ":2");
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>", null);
    }

    @Test
    void reconcileSkipsTheRecordReadForAFullyReceiptedLedger() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:107", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 1, "<m1@example.com>", null));
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 2, "<m2@example.com>", null));
        // The crash window: every segment receipt landed but the line's last
        // step to delivered failed, so the ledger lags at partial while every
        // segment holds a receipt. The sweep still selects a partial line.
        // Clear the delivery receipt too: transition writes it via
        // COALESCE(?, provider_receipt_json), so a preset value would survive
        // whatever the gate forwards and the assertion below would not pin the
        // gate's one durable write.
        jdbc.update("UPDATE ma_delivery SET transport_state = 'partial',"
                        + " provider_receipt_json = NULL"
                        + " WHERE tenant_id = ? AND delivery_id = ?",
                TENANT, deliveryId);
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>",
                        "<m2@example.com>");
        expire(deliveryId);
        // A plain store, not the autowired CGLIB proxy, so Mockito can spy it.
        JdbcChannelInstanceStore observing = org.mockito.Mockito.spy(
                new JdbcChannelInstanceStore(jdbc));
        ManagedChannelService observingService = new ManagedChannelService(
                observing, new JdbcChannelRouteRepository(jdbc),
                new JdbcChannelDeliveryRepository(jdbc), segmentLedger,
                sessions, workspaces, harness, mapper, Duration.ofMinutes(10),
                clock::get);
        observingService.reconcile();
        // The ledger already lists every segment with a receipt, so the
        // reconciler converges the lagging line from the ledger's own receipts
        // and never reads this delivery's record body. Removing the gate reds
        // here: the LONGTEXT read would run on every sweep. Scoped to this
        // session — the sweep also converges other tests' expired claims.
        org.mockito.Mockito.verify(observing, org.mockito.Mockito.never())
                .readResource(org.mockito.ArgumentMatchers.eq(TENANT),
                        org.mockito.ArgumentMatchers.eq(admitted.sessionId()),
                        org.mockito.ArgumentMatchers.anyString());
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("delivered");
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.providerReceipt())
                .isEqualTo("<m2@example.com>");
    }

    @Test
    void reconcileKeepsTheRecordReadWhenASegmentLacksAReceipt() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:108", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        // A null receipt on segment 1 means the record still has something to
        // converge, so the gate keeps the read.
        mirrorSegmentReceipts(admitted.sessionId(), deliveryId, 1);
        expire(deliveryId);
        JdbcChannelInstanceStore observing = org.mockito.Mockito.spy(
                new JdbcChannelInstanceStore(jdbc));
        ManagedChannelService observingService = new ManagedChannelService(
                observing, new JdbcChannelRouteRepository(jdbc),
                new JdbcChannelDeliveryRepository(jdbc), segmentLedger,
                sessions, workspaces, harness, mapper, Duration.ofMinutes(10),
                clock::get);
        observingService.reconcile();
        org.mockito.Mockito.verify(observing, org.mockito.Mockito.atLeastOnce())
                .readResource(org.mockito.ArgumentMatchers.eq(TENANT),
                        org.mockito.ArgumentMatchers.eq(admitted.sessionId()),
                        org.mockito.ArgumentMatchers.anyString());
    }

    @Test
    void aTerminalReceiptOnAPreLedgerClaimReplansTheSegmentRows() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:101", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        // A delivery claimed before the segment ledger existed: its segment
        // rows are absent when the receipts arrive.
        jdbc.update("DELETE FROM ma_channel_segment WHERE tenant_id=?"
                        + " AND channel_id=?",
                TENANT, channel);
        assertThat(segmentLedger.list(TENANT, channel, deliveryId)).isEmpty();
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 1, "<m1@example.com>", null));
        assertThat(service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 2, "<m2@example.com>", null))
                .state()).isEqualTo("delivered");
        // The receipts are durable on the re-planned rows even though the
        // delivery reached a terminal state the reconciler will not revisit.
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>",
                        "<m2@example.com>");
    }

    @Test
    void aConflictingPendingRecordIsNotPlannedByTheClaimSweep() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:102", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        // A pending record whose first segment is deliveryId:0, but a stored
        // delivery row already names a different first segment.
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 2);
        new JdbcChannelDeliveryRepository(jdbc).findOrCreate(
                new ChannelDeliveryRepository.ChannelDelivery(TENANT, channel,
                        deliveryId, "other:0", 0, "planned", null, 0, 0));
        segmentLedger.plan(TENANT, channel, deliveryId,
                List.of(new SegmentLedger("other:0", 0, null)));
        // The claim sweep must refuse the conflicting record before planning,
        // so no orphan segment rows persist under the key.
        ClaimResponse claimed = service.claimDeliveries(TENANT, channel, 16);
        assertThat(claimed.deliveries()).isEmpty();
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::segmentId)
                .containsExactly("other:0");
    }

    @Test
    void aFailedLastSegmentReceiptKeepsTheDeliveryRecoverable() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:93", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        FailingSegments failing = new FailingSegments(segmentLedger);
        ManagedChannelService failingService = new ManagedChannelService(
                instances, new JdbcChannelRouteRepository(jdbc),
                new JdbcChannelDeliveryRepository(jdbc), failing, sessions,
                workspaces, harness, mapper, Duration.ofMinutes(10), clock::get);
        failingService.claimDeliveries(TENANT, channel, 16);
        failingService.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        failingService.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 1, "<m1@example.com>", null));
        // The last receipt's record commit lands, but its ledger write fails
        // before the delivery line can move.
        failing.failNextReceipt = true;
        assertThatThrownBy(() -> failingService.receipt(TENANT, channel,
                deliveryId, new ReceiptRequest("accepted", 2,
                        "<m2@example.com>", null)))
                .isInstanceOf(IllegalStateException.class);
        // The delivery must not reach a terminal state: the reconciler skips
        // terminal deliveries, so closing the line here would strand the
        // missing receipt beyond every recovery entry.
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("partial");
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>", null);
        // The reconciler still reaches the open delivery and converges the
        // missing receipt from the committed record.
        mirrorSegmentReceipts(admitted.sessionId(), deliveryId, 3);
        expire(deliveryId);
        failingService.reconcile();
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("delivered");
        assertThat(segmentLedger.list(TENANT, channel, deliveryId))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("<m0@example.com>", "<m1@example.com>",
                        "<m2@example.com>");
    }

    @Test
    void resendPlansEveryCarriedSegmentOfAMultiSegmentDelivery() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:92", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        // The adapter died after sending: the lease settles the delivery
        // unknown without a single segment receipt.
        expire(deliveryId);
        service.reconcile();
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("unknown");

        ResendResponse resent = service.resend(TENANT, channel, deliveryId);
        assertThat(resent.possibleDuplicate()).isTrue();
        // The new chain carries every proven-unsent segment, none receipted,
        // keeping each carried segmentId (not a resentId-derived one).
        assertThat(segmentLedger.list(TENANT, channel, resent.deliveryId()))
                .extracting(SegmentLedger::segmentId)
                .containsExactly(deliveryId + ":0", deliveryId + ":1",
                        deliveryId + ":2");
        assertThat(segmentLedger.list(TENANT, channel, resent.deliveryId()))
                .extracting(SegmentLedger::ordinal)
                .containsExactly(0, 1, 2);
        assertThat(segmentLedger.list(TENANT, channel, resent.deliveryId()))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly(null, null, null);
        // A replayed resend under the same id matches the stored row and
        // converges rather than conflicting or appending.
        ResendResponse replayed = service.resend(TENANT, channel, deliveryId);
        assertThat(replayed.deliveryId()).isEqualTo(resent.deliveryId());
        assertThat(segmentLedger.list(TENANT, channel, resent.deliveryId()))
                .extracting(SegmentLedger::ordinal)
                .containsExactly(0, 1, 2);
    }

    @Test
    void aResendAfterAPartialReceiptCarriesOnlyTheUnsentSegments() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:103", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        // The partial revision mirrors the committed receipt into the record
        // body — the data the reconciler rebuilds ledger receipts from. The
        // record body is the only evidence here: deleting the projection's
        // partial arm reds this assertion.
        assertThat(recordSegmentReceipts(admitted.sessionId(), deliveryId))
                .containsExactly("<m0@example.com>", null, null);
        // The adapter died mid-send and reports the rest unknown; the partial
        // delivery settles unknown.
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("unknown", null, null, null));
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("unknown");

        ResendResponse resent = service.resend(TENANT, channel, deliveryId);
        // Only the proven-unsent segments 1 and 2 are carried, keeping their
        // original ids and renumbered densely from 0.
        assertThat(segmentLedger.list(TENANT, channel, resent.deliveryId()))
                .extracting(SegmentLedger::segmentId)
                .containsExactly(deliveryId + ":1", deliveryId + ":2");
        assertThat(segmentLedger.list(TENANT, channel, resent.deliveryId()))
                .extracting(SegmentLedger::ordinal)
                .containsExactly(0, 1);
        assertThat(segmentLedger.list(TENANT, channel, resent.deliveryId()))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly(null, null);
        // The resent chain's settle threshold is the carried count, not the
        // original chain's length: receipting both carried segments steps
        // partial then delivered. A threshold reading the original chain's
        // length would leave the last answer partial and strand the chain.
        assertThat(service.receipt(TENANT, channel, resent.deliveryId(),
                new ReceiptRequest("accepted", 0, "<m1@example.com>", null))
                .state()).isEqualTo("partial");
        assertThat(service.receipt(TENANT, channel, resent.deliveryId(),
                new ReceiptRequest("accepted", 1, "<m2@example.com>", null))
                .state()).isEqualTo("delivered");
    }

    @Test
    void aReclaimFiltersOnTheCommittedRecordNotTheReceiptLog() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:104", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        // Segment 1's receipt commits to the record while its answer is lost:
        // only the mirror sees it, never the double's receipt-call log.
        mirrorSegmentReceipts(admitted.sessionId(), deliveryId, 2);
        ClaimResponse resumed = service.claimDeliveries(TENANT, channel, 16);
        assertThat(resumed.deliveries()).hasSize(1);
        // The re-claim filters on the committed record, so both receipted
        // ordinals (0 and 1) are withheld — not just the one the double logged.
        assertThat(resumed.deliveries().getFirst().segments())
                .extracting(ClaimedSegment::ordinal)
                .containsExactly(2);
    }

    @Test
    void theSettleThresholdCountsMirrorCommittedReceipts() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:109", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        // Two receipts commit to the record while their answers are lost: only
        // the mirror sees them, never a segment_receipt call.
        mirrorSegmentReceipts(admitted.sessionId(), deliveryId, 2);
        // The third receipt arrives through the service. The threshold counts
        // the two mirror-committed receipts plus this one and answers
        // delivered; a threshold reading the receipt-call log would only see
        // ordinal 2 and answer partial, stranding a fully-receipted line.
        assertThat(service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 2, "<m2@example.com>", null))
                .state()).isEqualTo("delivered");
    }

    @Test
    void aResentChainIsClaimableWithItsCarriedSegmentIds() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:105", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("unknown", null, null, null));
        ResendResponse resent = service.resend(TENANT, channel, deliveryId);
        // The resent chain's record is committed, so the sweep hands it back,
        // and the claim reports the carried segmentIds — not resentId-derived.
        ClaimResponse claimed = service.claimDeliveries(TENANT, channel, 16);
        assertThat(claimed.deliveries()).hasSize(1);
        assertThat(claimed.deliveries().getFirst().deliveryId())
                .isEqualTo(resent.deliveryId());
        assertThat(claimed.deliveries().getFirst().segments())
                .extracting(ClaimedSegment::segmentId)
                .containsExactly(deliveryId + ":1", deliveryId + ":2");
    }

    @Test
    void aResendOfAFullyReceiptedChainIsRefused() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:106", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 3);
        service.claimDeliveries(TENANT, channel, 16);
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 0, "<m0@example.com>", null));
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 1, "<m1@example.com>", null));
        service.receipt(TENANT, channel, deliveryId,
                new ReceiptRequest("accepted", 2, "<m2@example.com>", null));
        assertThat(service.ledger(TENANT, channel, deliveryId)).get()
                .extracting(row -> row.state()).isEqualTo("delivered");
        // Nothing is unsent, so the funnel refuses the resend as a
        // deterministic 409 conflict — not a retryable 5xx an adapter would
        // retry forever — and the service translates it instead of
        // dereferencing an empty list.
        assertThatThrownBy(() -> service.resend(TENANT, channel, deliveryId))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("channel_operation_conflict");
                });
        assertThat(segmentLedger.list(TENANT, channel, deliveryId + ":r1"))
                .isEmpty();
    }

    @Test
    void aResendAgainstAMatchingIdButDifferentOrdinalIsRejected() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:100", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 2);
        service.claimDeliveries(TENANT, channel, 16);
        // The stored row keeps the first segment's id but a different ordinal:
        // the ordinal clause of the identity guard must reject it.
        String resentId = deliveryId + ":r1";
        new JdbcChannelDeliveryRepository(jdbc).findOrCreate(
                new ChannelDeliveryRepository.ChannelDelivery(TENANT, channel,
                        resentId, resentId + ":0", 5, "planned", null, 0, 0));
        assertThatThrownBy(() -> service.resend(TENANT, channel, deliveryId))
                .isInstanceOf(IllegalStateException.class);
        // The guard must reject on the ordinal before planning: findOrCreate
        // would also reject, but only after orphan segment rows were written.
        assertThat(segmentLedger.list(TENANT, channel, resentId)).isEmpty();
    }

    @Test
    void aResendAgainstAConflictingStoredChainLeavesNoOrphanSegments() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:97", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 2);
        service.claimDeliveries(TENANT, channel, 16);
        // The Harness mints deliveryId + ":r1"; pre-create that id naming a
        // different first segment, as an already-issued conflicting chain.
        String resentId = deliveryId + ":r1";
        new JdbcChannelDeliveryRepository(jdbc).findOrCreate(
                new ChannelDeliveryRepository.ChannelDelivery(TENANT, channel,
                        resentId, "other:0", 0, "planned", null, 0, 0));
        segmentLedger.plan(TENANT, channel, resentId,
                List.of(new SegmentLedger("other:0", 0, null)));
        assertThatThrownBy(() -> service.resend(TENANT, channel, deliveryId))
                .isInstanceOf(IllegalStateException.class);
        // The refused chain planned nothing: only the original row remains.
        assertThat(segmentLedger.list(TENANT, channel, resentId))
                .extracting(SegmentLedger::segmentId)
                .containsExactly("other:0");
    }

    @Test
    void deliveryRowsAreCreatedOnlyAfterTheirSegmentsArePlanned() {
        InboundAdmission admitted = service.submitInbound(TENANT, channel,
                event(1, "1700:98", "please reply"));
        String deliveryId = admitted.inputId() + ":reply";
        plannedDelivery(admitted.sessionId(), deliveryId, admitted.routeId(),
                "The build is green.", 2);
        ChannelDeliveryRepository delegate = new JdbcChannelDeliveryRepository(jdbc);
        ChannelDeliveryRepository observing = new ChannelDeliveryRepository() {
            @Override
            public ChannelDelivery findOrCreate(ChannelDelivery candidate) {
                assertThat(segmentLedger.list(TENANT, channel,
                        candidate.deliveryId()))
                        .as("segments planned before the delivery row is visible")
                        .isNotEmpty();
                return delegate.findOrCreate(candidate);
            }

            @Override
            public java.util.Optional<ChannelDelivery> find(String tenantId,
                    String channelId, String deliveryId) {
                return delegate.find(tenantId, channelId, deliveryId);
            }

            @Override
            public ChannelDelivery transition(String tenantId, String channelId,
                    String deliveryId, String expectedState, String state,
                    String providerReceipt) {
                return delegate.transition(tenantId, channelId, deliveryId,
                        expectedState, state, providerReceipt);
            }

            @Override
            public ChannelDelivery transition(String tenantId, String channelId,
                    String deliveryId, String expectedState, String state,
                    String providerReceipt, long claimGeneration) {
                return delegate.transition(tenantId, channelId, deliveryId,
                        expectedState, state, providerReceipt, claimGeneration);
            }

            @Override
            public DeliveryPage listByChannel(String tenantId, String channelId,
                    DeliveryCursor before, int limit) {
                return delegate.listByChannel(tenantId, channelId, before, limit);
            }
        };
        ManagedChannelService observingService = new ManagedChannelService(
                instances, new JdbcChannelRouteRepository(jdbc), observing,
                segmentLedger, sessions, workspaces, harness, mapper,
                Duration.ofMinutes(10), clock::get);
        observingService.claimDeliveries(TENANT, channel, 16);
        expire(deliveryId);
        observingService.reconcile();
        ResendResponse resent = observingService.resend(TENANT, channel, deliveryId);
        assertThat(resent.deliveryId()).isEqualTo(deliveryId + ":r1");
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
        jdbc.update("UPDATE ma_delivery SET claimed_at = ?"
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
        com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure refused =
                org.mockito.Mockito.mock(
                        com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure.class);
        org.mockito.Mockito.when(refused.getStatusCode()).thenReturn(400);
        org.mockito.Mockito.when(refused.getResponseBody())
                .thenReturn("{\"error\":{\"code\":\"invalid_channel_operation\"}}");
        harness.submitErrors.add(refused);
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:98", "hello")))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(400);
                    assertThat(error.getCode())
                            .isEqualTo("invalid_channel_operation");
                });
        // The ingress row stays staged for no second drive: the adapter
        // treats this class as final.
        assertThat(route("1700:98").state()).isEqualTo("staged");
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(503);
                    assertThat(error.getCode())
                            .isEqualTo("managed_session_writer_conflict");
                });
        assertThatThrownBy(() -> service.submitInbound(TENANT, channel,
                event(1, "1700:97", "hello")))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(409);
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
                        + " ma_channel_binding WHERE tenant_id = ?"
                        + " AND channel_id = ?", Integer.class, TENANT,
                channel)).isEqualTo(1);
        RegisterChannelRequest moved = new RegisterChannelRequest("email",
                "agent@example.com", 2, "other-actor", "other-workspace",
                ".", new ChannelPolicy("email", "allowlist",
                        List.of("alice@example.com"), "followup"));
        assertThatThrownBy(() -> service.register(TENANT, channel, moved))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("channel_ownership_conflict");
                });
        // The refusal changed nothing: the connection keeps its owner.
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(JdbcChannelInstanceStore.ChannelInstance::workspaceId)
                .isEqualTo(WORKSPACE);
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(JdbcChannelInstanceStore.ChannelInstance::actorId)
                .isEqualTo(ACTOR);
        // With no binding yet, the same move class is ordinary
        // re-registration.
        String fresh = "mail-" + UUID.randomUUID();
        service.register(TENANT, fresh, moved);
        assertThat(instances.findInstance(TENANT, fresh)).get()
                .extracting(JdbcChannelInstanceStore.ChannelInstance::workspaceId)
                .isEqualTo("other-workspace");
    }

    @Test
    void keepsMonotonicGenerationInTheWriteItself() {
        // The registration race: an earlier SELECT cannot promise against a
        // row that moved forward — the monotonic check rides in the UPDATE
        // (R8 P2). Simulate the stale read with a store whose findInstance
        // answers the just-slipped snapshot.
        JdbcChannelInstanceStore.ChannelInstance snapshot = instances
                .findInstance(TENANT, channel).orElseThrow();
        assertThat(snapshot.accountGeneration()).isEqualTo(1);
        jdbc.update("UPDATE ma_channel_instance"
                        + " SET account_generation = 3"
                        + " WHERE tenant_id = ? AND channel_id = ?",
                TENANT, channel);
        JdbcChannelInstanceStore racing = new JdbcChannelInstanceStore(jdbc) {
            @Override
            public java.util.Optional<JdbcChannelInstanceStore.ChannelInstance>
                    findInstance(String tenantId, String channelId) {
                return java.util.Optional.of(
                        new JdbcChannelInstanceStore.ChannelInstance(
                                snapshot.tenantId(), snapshot.channelId(),
                                snapshot.platform(), snapshot.accountId(), 1L,
                                snapshot.state(), snapshot.actorId(),
                                snapshot.workspaceId(), snapshot.cwdRelative(),
                                snapshot.policyJson(), snapshot.createdAt(),
                                snapshot.updatedAt()));
            }
        };
        assertThatThrownBy(() -> racing.register(
                        new JdbcChannelInstanceStore.ChannelInstance(TENANT,
                                channel, "email", "agent@example.com", 2,
                                "connected", ACTOR, WORKSPACE, ".",
                                snapshot.policyJson(), 0, 0)))
                .isInstanceOfSatisfying(IllegalStateException.class, error ->
                        assertThat(error.getMessage()).isEqualTo(
                                "channel_generation_stale"));
        // The stored row never regressed.
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(
                        JdbcChannelInstanceStore.ChannelInstance::accountGeneration)
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
        JdbcTemplate latching = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> requiredType,
                    Object... args) {
                T value = super.queryForObject(sql, requiredType, args);
                if (sql.contains(
                        "SELECT COUNT(*) FROM ma_channel_binding")) {
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
        JdbcChannelInstanceStore racingStore = new JdbcChannelInstanceStore(latching);
        Thread binder = new Thread(() -> {
            try {
                atCount.await();
                instances.bind(new JdbcChannelInstanceStore.ChannelBinding(TENANT,
                        channel, "chrt-race", "sess-race", "chat_thread",
                        null, "alice@example.com", "thread-1",
                        instances.databaseNow()));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                bound.countDown();
            }
        });
        binder.start();
        try {
            IllegalStateException error = assertThrows(IllegalStateException.class,
                    () -> racingStore.register(
                            new JdbcChannelInstanceStore.ChannelInstance(TENANT,
                                    channel, "email", "agent@example.com", 1,
                                    "connected", "other-actor", WORKSPACE, ".",
                                    snapshot.policyJson(), 0, 0)));
            assertThat(error.getMessage()).isEqualTo("channel_ownership_conflict");
        } finally {
            binder.interrupt();
            binder.join(10_000);
        }
        // The bind raced in mid-check, and the stored connection still
        // names its original owner.
        assertThat(instances.findInstance(TENANT, channel)).get()
                .extracting(JdbcChannelInstanceStore.ChannelInstance::actorId)
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
            jdbc.update("UPDATE ma_delivery"
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
        jdbc.update("UPDATE ma_delivery SET claimed_at = ?"
                        + " WHERE tenant_id = ? AND delivery_id = ?",
                clock.get() - Duration.ofMinutes(10).toMillis() - 30_000,
                TENANT, lateDelivery);
        // One sweep settles every unprogressed row unknown; the live claim
        // takes its turn on the next one instead of never.
        service.reconcile();
        List<String> unknowns = jdbc.queryForList(
                "SELECT delivery_id FROM ma_delivery"
                        + " WHERE delivery_kind = 'CHANNEL' AND tenant_id = ? AND channel_id = ?"
                        + " AND transport_state = 'unknown'",
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

    private static com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure harnessError(
            int status, String body) {
        com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure error =
                org.mockito.Mockito.mock(
                        com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure.class);
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(503);
                    assertThat(error.getCode())
                            .isEqualTo("channel_operation_failed");
                });
        assertThat(route("1700:99").state()).isEqualTo("staged");
        // The retry lands clean: the staged row admits on the second drive.
        InboundAdmission retried = service.submitInbound(TENANT, channel,
                event(1, "1700:99", "hello"));
        assertThat(retried.replayed()).isFalse();
        assertThat(route("1700:99").state()).isEqualTo("admitted");
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
                        + " ma_session_record"
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
                        + " ma_session_record"
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
        // The ledger copies the committed record's reported id (<m1>), not
        // one synthesized from the ordinal (<m0>): a record-to-ledger path
        // that derives the id from the ordinal reds here.
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
            jdbc.update("INSERT IGNORE INTO ma_session"
                            + " (tenant_id, session_id, agent_id, title,"
                            + " status, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, 'qwen-code', 'mail thread',"
                            + " 'ACTIVE', 1, 1)",
                    TENANT, crowdSession);
            instances.bind(new JdbcChannelInstanceStore.ChannelBinding(TENANT,
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
        // gmt_create and order by route key, so only the set is pinned.
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
                .isInstanceOf(ManagedAgentException.class)
                .extracting(e -> ((ManagedAgentException) e).getCode())
                .isEqualTo("channel_not_found");
        assertThatThrownBy(() -> service.listChannels(TENANT, ACTOR, "!!",
                20))
                .isInstanceOf(ManagedAgentException.class)
                .extracting(e -> ((ManagedAgentException) e).getCode())
                .isEqualTo("invalid_cursor");
        assertThatThrownBy(() -> service.listChannels(TENANT, ACTOR, null,
                0))
                .isInstanceOf(ManagedAgentException.class)
                .extracting(e -> ((ManagedAgentException) e).getCode())
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
        String refs = route("1700:95").stagedAttachmentRefs().toString();
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
        plannedDelivery(sessionId, deliveryId, routeId, text, 1);
    }

    private void plannedDelivery(String sessionId, String deliveryId,
            String routeId, String text, int segmentCount) {
        StringBuilder segments = new StringBuilder();
        List<Map<String, Object>> chain = new ArrayList<>();
        for (int i = 0; i < segmentCount; i++) {
            if (i > 0) {
                segments.append(',');
            }
            segments.append("""
                    {"segmentId":"%s:%d","ordinal":%d,
                     "contentRef":{"resourceId":"s%d","kind":"managed-channel-segment","schemaVersion":1,"byteLength":1,"digest":"%s"},
                     "receipt":null}"""
                    .formatted(deliveryId, i, i, i, "b".repeat(64)));
            Map<String, Object> segment = new LinkedHashMap<>();
            segment.put("ordinal", i);
            segment.put("segmentId", deliveryId + ":" + i);
            segment.put("providerMessageId", null);
            chain.add(segment);
        }
        writeDeliveryRecord(sessionId, deliveryId, routeId, segments.toString());
        harness.replies.put(deliveryId, text);
        harness.chainSegments.put(deliveryId, chain);
    }

    /** Inserts the delivery record — the ma_resource body plus its
     * ma_session_record line — that the claim sweep selects, as the funnel's
     * plan commit does. */
    private void writeDeliveryRecord(String sessionId, String deliveryId,
            String routeId, String segmentsJson) {
        String resourceId = UUID.randomUUID().toString();
        String body = """
                {"deliveryId":"%s","routeId":"%s","routeRevision":1,
                 "sourceTurnId":"turn","contentRef":{"resourceId":"r","kind":"managed-channel-reply","schemaVersion":1,"byteLength":1,"digest":"%s"},
                 "segments":[%s],
                 "cancelRequested":false,
                 "run":{"state":"admitted","reason":null,"definition":null,"executionCallId":null,"effectId":"%s","dispatchId":null,"deliveryId":"%s","execution":null,"runtime":null,"delivery":{"target":"channel","state":"planned"}}}
                """.formatted(deliveryId, routeId, "a".repeat(64), segmentsJson,
                deliveryId, deliveryId);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, ?, ?, ?, ?, 'managed-channel_delivery', 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(scopeKey(sessionId), resourceId), scopeKey(sessionId), TENANT, WORKSPACE, sessionId, resourceId,
                body.length(), "c".repeat(64),
                body.getBytes(StandardCharsets.UTF_8), "publish-" + resourceId);
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, delivery_target,"
                        + " delivery_state, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, 'channel_delivery', ?, ?,"
                        + " 1, ?, NULL, NULL, 'channel', 'planned', ?)",
                scopeKey(sessionId),
                com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection
                        .recordKey(sessionId, "channel_delivery", deliveryId),
                TENANT, WORKSPACE, sessionId, deliveryId, "d".repeat(64),
                resourceId, clock.get());
    }

    /** Commits a resent chain's record carrying the given segments, so the
     * claim sweep can hand the chain back like any planned delivery. */
    private void commitDeliveryRecord(String sessionId, String deliveryId,
            List<Map<String, Object>> segments) {
        StringBuilder segmentsJson = new StringBuilder();
        for (Map<String, Object> segment : segments) {
            if (segmentsJson.length() > 0) {
                segmentsJson.append(',');
            }
            int ordinal = ((Number) segment.get("ordinal")).intValue();
            segmentsJson.append("""
                    {"segmentId":"%s","ordinal":%d,
                     "contentRef":{"resourceId":"s%d","kind":"managed-channel-segment","schemaVersion":1,"byteLength":1,"digest":"%s"},
                     "receipt":null}"""
                    .formatted(segment.get("segmentId"), ordinal, ordinal,
                            "b".repeat(64)));
        }
        writeDeliveryRecord(sessionId, deliveryId, "chrt-" + "e".repeat(64),
                segmentsJson.toString());
    }

    /** The record body gains one committed receipt per segment, as the
     * Session store writes them while the control plane's answers are lost. */
    private void mirrorSegmentReceipts(String sessionId, String deliveryId,
            int segmentCount) {
        mirrorReceipts(sessionId, deliveryId, segmentCount,
                ordinal -> "<m" + ordinal + "@example.com>");
    }

    /** The record body gains the committed segment receipts, as the Session
     * store writes them with the partial or delivered revision: each receipt
     * echoes the provider id the adapter reported for that ordinal, and an
     * unsent segment keeps no receipt. */
    private void mirrorReceiptIntoRecord(String sessionId,
            String deliveryId) {
        mirrorReceipts(sessionId, deliveryId, Integer.MAX_VALUE,
                ordinal -> harness.segmentReceiptId(deliveryId, ordinal));
    }

    /** Stamps the record's segments below {@code segmentCount} with the
     * receipt id the policy supplies (null leaves the segment unsent),
     * rewriting the resource body exactly as the Session store does and
     * keeping the chain's segment state current with it. */
    private void mirrorReceipts(String sessionId, String deliveryId,
            int segmentCount, java.util.function.IntFunction<String> receiptId) {
        RecordBody body = recordBody(sessionId, deliveryId);
        if (body == null) {
            return;
        }
        for (JsonNode segment : body.tree().path("segments")) {
            int ordinal = segment.path("ordinal").asInt();
            if (ordinal >= segmentCount) {
                continue;
            }
            String id = receiptId.apply(ordinal);
            if (id == null) {
                continue;
            }
            ObjectNode receipt = mapper.createObjectNode();
            receipt.put("providerMessageId", id);
            receipt.put("acceptedAt", 1_750_000_000_000L);
            ((ObjectNode) segment).set("receipt", receipt);
            harness.setSegmentReceipt(deliveryId, ordinal, id);
        }
        try {
            jdbc.update("UPDATE ma_resource"
                            + " SET inline_bytes = ?"
                            + " WHERE tenant_id = ? AND resource_id = ?",
                    mapper.writeValueAsString(body.tree())
                            .getBytes(StandardCharsets.UTF_8),
                    TENANT, body.resourceId());
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    /** The provider message ids the committed record body holds, in ordinal
     * order (null for a segment without a receipt). */
    private List<String> recordSegmentReceipts(String sessionId, String deliveryId) {
        RecordBody body = recordBody(sessionId, deliveryId);
        if (body == null) {
            throw new IllegalStateException("no record for " + deliveryId);
        }
        List<String> receipts = new ArrayList<>();
        for (JsonNode segment : body.tree().path("segments")) {
            JsonNode receipt = segment.path("receipt");
            receipts.add(receipt.isObject()
                    && receipt.path("providerMessageId").isTextual()
                    ? receipt.path("providerMessageId").asText() : null);
        }
        return receipts;
    }

    /** The committed delivery record body and its resource id, located by the
     * deliveryId the body carries — one session can hold several delivery
     * resources. Null when no row matches. */
    private RecordBody recordBody(String sessionId, String deliveryId) {
        for (Map<String, Object> row : jdbc.query(
                "SELECT resource_id, inline_bytes"
                        + " FROM ma_resource"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND kind = ?"
                        + " AND state = 'REFERENCED'",
                (row, index) -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.read(row), TENANT, sessionId, "managed-channel_delivery")) {
            JsonNode tree;
            try {
                tree = mapper.readTree(
                        new String((byte[]) row.get("inline_bytes"),
                                StandardCharsets.UTF_8));
            } catch (JsonProcessingException error) {
                throw new IllegalStateException(error);
            }
            if (deliveryId.equals(tree.path("deliveryId").asText())) {
                return new RecordBody(tree, String.valueOf(row.get("resource_id")));
            }
        }
        return null;
    }

    private record RecordBody(JsonNode tree, String resourceId) {
    }

    private List<com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelRouteRepository.ChannelRoute> routes() {
        return new JdbcChannelRouteRepository(jdbc).listByChannel(TENANT, channel, null, 100).routes();
    }

    private com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelRouteRepository.ChannelRoute route(String eventId) {
        return routes().stream().filter(route -> eventId.equals(route.platformEventId())).findFirst().orElseThrow();
    }

    /** Back-dates the claim so the reconciler sees it as expired. */
    private void expire(String deliveryId) {
        jdbc.update("UPDATE ma_delivery SET claimed_at = ?"
                        + " WHERE tenant_id = ? AND delivery_id = ?",
                clock.get() - Duration.ofMinutes(11).toMillis(), TENANT,
                deliveryId);
    }

    private static String scopeKey(String sessionId) {
        return ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
    }

    /** Answers the channel operations the way the hosted funnel does. */
    interface Projection {
        void deliveryState(String sessionId, String deliveryId, String state);

        void commitDelivery(String sessionId, String deliveryId,
                List<Map<String, Object>> segments);
    }

    static final class RecordingHarness implements HarnessConnector {
        private static final java.util.Set<String> TERMINAL = java.util.Set.of(
                "delivered", "unknown", "rejected", "cancelled");
        final List<Map<String, Object>> operations = new ArrayList<>();
        final Map<String, String> replies = new LinkedHashMap<>();
        // Each chain's segments as the committed record holds them: ordinal,
        // segmentId and the provider id once receipted (null while unsent).
        // Both the receipt path and the record mirror keep this current, so
        // the claim filter and the delivery view read one source of truth.
        final Map<String, List<Map<String, Object>>> chainSegments =
                new LinkedHashMap<>();
        private final Map<String, Map<String, Object>> inputs =
                new LinkedHashMap<>();
        private final Map<String, String> deliveryStates =
                new LinkedHashMap<>();
        private final Projection projection;
        boolean loseAnswerOnce;
        boolean loseClaimAnswerOnce;
        boolean loseReceiptAnswerOnce;
        boolean throwDaemonOnceOnSubmit;
        java.util.Queue<com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure>
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
                        throw new com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure(
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
                    // The funnel hands out only the segments still unsent,
                    // filtering on the committed record's receipt field and
                    // returning each segment's stored segmentId. The chain's
                    // segment state is that record here, kept current by both
                    // the receipt path and the mirror, so a receipted segment
                    // is never re-handled to the adapter.
                    List<Map<String, Object>> claimedSegments = new ArrayList<>();
                    for (Map<String, Object> segment : chainSegments.getOrDefault(
                            deliveryId, List.of())) {
                        if (segment.get("providerMessageId") != null) {
                            continue;
                        }
                        Map<String, Object> claimed = new LinkedHashMap<>();
                        claimed.put("ordinal", segment.get("ordinal"));
                        claimed.put("segmentId", segment.get("segmentId"));
                        claimed.put("text", replies.get(deliveryId));
                        claimedSegments.add(claimed);
                    }
                    answer.put("segments", claimedSegments);
                }
                case "segment_receipt" -> {
                    int ordinal = ((Number) body.get("ordinal")).intValue();
                    // Keep the id the adapter reported, not one derived from
                    // the ordinal: the committed record carries this value.
                    Object reportedId = body.get("providerMessageId");
                    if (reportedId != null) {
                        setSegmentReceipt(deliveryId, ordinal,
                                String.valueOf(reportedId));
                    }
                    // The threshold reads the same committed segment state the
                    // claim filter and the delivery view read, not a log of
                    // receipt calls, so a mirror-committed receipt counts too.
                    // An absent chain is not "every segment receipted".
                    List<Map<String, Object>> chain = chainSegments.getOrDefault(
                            deliveryId, List.of());
                    boolean complete = !chain.isEmpty() && chain.stream()
                            .allMatch(segment ->
                                    segment.get("providerMessageId") != null);
                    String state = complete ? "delivered" : "partial";
                    deliveryStates.put(deliveryId, state);
                    projection.deliveryState(sessionId, deliveryId, state);
                    if (loseReceiptAnswerOnce) {
                        loseReceiptAnswerOnce = false;
                        throw new IllegalStateException(
                                "answer lost after commit");
                    }
                    answer.put("delivery", delivery(deliveryId, state));
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
                    List<Map<String, Object>> carried;
                    if (chainSegments.containsKey(resent)) {
                        // A replayed resend converges on the chain already
                        // opened, rather than committing its record twice.
                        carried = chainSegments.get(resent);
                    } else {
                        // The funnel carries only the unreceipted segments,
                        // keeps each carried segmentId, and renumbers densely
                        // from 0.
                        carried = new ArrayList<>();
                        int dense = 0;
                        for (Map<String, Object> segment : chainSegments.getOrDefault(
                                deliveryId, List.of())) {
                            if (segment.get("providerMessageId") != null) {
                                continue;
                            }
                            Map<String, Object> carry = new LinkedHashMap<>();
                            carry.put("ordinal", dense++);
                            carry.put("segmentId", segment.get("segmentId"));
                            carry.put("providerMessageId", null);
                            carried.add(carry);
                        }
                        // The funnel refuses to resend a chain with nothing
                        // unsent (channelDeliveryResendable) as a deterministic
                        // 409 channel_operation_conflict, not a retryable
                        // failure: an adapter must not retry a chain that can
                        // never be resent. Answer the same shape so the service
                        // translates it, instead of dereferencing an empty list.
                        if (carried.isEmpty()) {
                            throw harnessError(409,
                                    "{\"code\":\"channel_operation_conflict\"}");
                        }
                        deliveryStates.put(resent, "planned");
                        replies.put(resent, replies.get(deliveryId));
                        chainSegments.put(resent, carried);
                        // Commit the resent chain's record so the claim sweep
                        // can hand it back, as the funnel's plan commit does.
                        projection.commitDelivery(sessionId, resent, carried);
                    }
                    answer.put("delivery",
                            delivery(resent, deliveryStates.get(resent), carried));
                    answer.put("possibleDuplicate", true);
                }
                default -> throw new IllegalArgumentException(kind);
            }
            return answer;
        }

        private Map<String, Object> delivery(String deliveryId, String state) {
            return delivery(deliveryId, state,
                    chainSegments.getOrDefault(deliveryId, List.of()));
        }

        private Map<String, Object> delivery(String deliveryId, String state,
                List<Map<String, Object>> segments) {
            Map<String, Object> delivery = new LinkedHashMap<>();
            delivery.put("deliveryId", deliveryId);
            delivery.put("routeId", "chrt-" + "e".repeat(64));
            delivery.put("routeRevision", 1L);
            delivery.put("sourceTurnId", "turn");
            delivery.put("state", state);
            delivery.put("cancelRequested", false);
            List<Map<String, Object>> rendered = new ArrayList<>();
            for (Map<String, Object> segment : segments) {
                Map<String, Object> copy = new LinkedHashMap<>();
                copy.put("ordinal", segment.get("ordinal"));
                copy.put("segmentId", segment.get("segmentId"));
                copy.put("providerMessageId", segment.get("providerMessageId"));
                rendered.add(copy);
            }
            delivery.put("segments", rendered);
            return delivery;
        }

        void setSegmentReceipt(String deliveryId, int ordinal,
                String providerMessageId) {
            for (Map<String, Object> segment : chainSegments.getOrDefault(
                    deliveryId, List.of())) {
                if (((Number) segment.get("ordinal")).intValue() == ordinal) {
                    segment.put("providerMessageId", providerMessageId);
                    return;
                }
            }
        }

        String segmentReceiptId(String deliveryId, int ordinal) {
            for (Map<String, Object> segment : chainSegments.getOrDefault(
                    deliveryId, List.of())) {
                if (((Number) segment.get("ordinal")).intValue() == ordinal) {
                    return (String) segment.get("providerMessageId");
                }
            }
            return null;
        }
    }

    /** A segment ledger that fails one receipt write, to inject the crash
     * window between the record commit and the ledger write. */
    private static final class FailingSegments implements ChannelSegmentRepository {
        private final ChannelSegmentRepository delegate;
        boolean failNextReceipt;

        FailingSegments(ChannelSegmentRepository delegate) {
            this.delegate = delegate;
        }

        @Override
        public void plan(String tenantId, String channelInstanceId,
                String deliveryId, List<SegmentLedger> segments) {
            delegate.plan(tenantId, channelInstanceId, deliveryId, segments);
        }

        @Override
        public boolean receipt(String tenantId, String channelInstanceId,
                String deliveryId, int ordinal, String providerReceipt) {
            if (failNextReceipt) {
                failNextReceipt = false;
                throw new IllegalStateException("segment receipt write failed");
            }
            return delegate.receipt(tenantId, channelInstanceId, deliveryId,
                    ordinal, providerReceipt);
        }

        @Override
        public List<SegmentLedger> list(String tenantId, String channelInstanceId,
                String deliveryId) {
            return delegate.list(tenantId, channelInstanceId, deliveryId);
        }

        @Override
        public Map<String, List<SegmentLedger>> listByDelivery(String tenantId,
                String channelInstanceId, List<String> deliveryIds) {
            return delegate.listByDelivery(tenantId, channelInstanceId, deliveryIds);
        }
    }
}
