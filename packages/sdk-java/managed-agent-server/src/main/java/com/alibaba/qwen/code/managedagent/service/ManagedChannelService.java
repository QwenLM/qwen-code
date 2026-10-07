package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicChannel;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicChannelDelivery;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicChannelRoute;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ChannelInstanceView;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ClaimResponse;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ClaimedDelivery;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ClaimedSegment;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.DeliveryView;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.InboundAdmission;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.InboundEventRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ReceiptRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.RegisterChannelRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ResendResponse;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository.ChannelDelivery;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository.DeliveryCursor;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository.DeliveryPage;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore.ChannelBinding;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore.ChannelClaim;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore.ChannelInstance;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore.InstanceCursor;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore.InstancePage;
import com.alibaba.qwen.code.managedagent.store.ChannelInstanceStore.PendingDelivery;
import com.alibaba.qwen.code.managedagent.store.ChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.store.ChannelRouteRepository.ChannelRoute;
import com.alibaba.qwen.code.managedagent.store.JdbcChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.store.JdbcChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * H5b/H5c: the control plane's channel service. Inbound: dedupes a
 * platform event on its four-part identity (the V47 route row), resolves
 * or creates the route's Session, and asks the Harness to admit the input
 * (route revision + input + wake in one journal transaction); the V47 row
 * turns admitted only after the Harness answered, so every crash window
 * replays to the committed admission. Outbound: the adapter pulls claims,
 * each step is a record revision the Harness commits first and the V47
 * ledger follows; a claim that outlives its lease settles unknown and is
 * never resent; an explicit resend opens a new chain. Public reads serve
 * the three channel resources over the committed rows.
 */
@Service
public class ManagedChannelService {
    private static final Logger LOG = LoggerFactory.getLogger(
            ManagedChannelService.class);
    static final String INPUT_PREFIX = "chin-";
    static final String ROUTE_PREFIX = "chrt-";
    static final String CREATION_PREFIX = "chcr-";
    private static final int MAX_BINDINGS_PER_CLAIM = 64;
    private static final int RECONCILE_LIMIT = 50;
    private static final String SEPARATOR = "\u0000";

    private final ChannelInstanceStore instances;
    private final ChannelRouteRepository routes;
    private final ChannelDeliveryRepository deliveries;
    private final ManagedAgentService sessions;
    private final ManagedWorkspaceRegistry workspaces;
    private final HarnessConnector harness;
    private final ObjectMapper mapper;
    private final Duration claimLease;
    private final Supplier<Long> clock;

    @org.springframework.beans.factory.annotation.Autowired
    public ManagedChannelService(ChannelInstanceStore instances,
            JdbcTemplate jdbc, ManagedAgentService sessions,
            ManagedWorkspaceRegistry workspaces, HarnessConnector harness,
            ObjectMapper mapper, ManagedAgentProperties properties) {
        this(instances, new JdbcChannelRouteRepository(jdbc),
                new JdbcChannelDeliveryRepository(jdbc), sessions, workspaces,
                harness, mapper, properties.getChannels().getClaimLease(),
                System::currentTimeMillis);
    }

    ManagedChannelService(ChannelInstanceStore instances,
            ChannelRouteRepository routes,
            ChannelDeliveryRepository deliveries, ManagedAgentService sessions,
            ManagedWorkspaceRegistry workspaces, HarnessConnector harness,
            ObjectMapper mapper, Duration claimLease, Supplier<Long> clock) {
        this.instances = instances;
        this.routes = routes;
        this.deliveries = deliveries;
        this.sessions = sessions;
        this.workspaces = workspaces;
        this.harness = harness;
        this.mapper = mapper;
        this.claimLease = claimLease;
        this.clock = clock;
    }

    // --- trusted adapter surface ---

    public ChannelInstanceView register(String tenantId, String channelId,
            RegisterChannelRequest request) {
        requireChannelId(channelId);
        String policyJson;
        try {
            policyJson = mapper.writeValueAsString(request.policy());
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "The channel policy is not serializable.");
        }
        String cwd = request.cwdRelative() == null
                || request.cwdRelative().isBlank() ? "."
                : request.cwdRelative();
        // The selection validates the identifiers the way creation will.
        try {
            new WorkspaceSelection(request.workspaceId(), cwd);
        } catch (IllegalArgumentException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "The Workspace selection is invalid.");
        }
        ChannelInstance stored;
        try {
            stored = instances.register(new ChannelInstance(tenantId,
                    channelId, request.platform(), request.accountId(),
                    request.accountGeneration(), "connected",
                    request.actorId(), request.workspaceId(), cwd,
                    policyJson, 0, 0));
        } catch (IllegalStateException error) {
            throw new ApiException(HttpStatus.CONFLICT, error.getMessage(),
                    "The channel registration conflicts with the stored"
                            + " connection.");
        }
        return view(stored);
    }

    public ChannelInstanceView disconnect(String tenantId,
            String channelId) {
        requireInstance(tenantId, channelId);
        return view(instances.setState(tenantId, channelId, "disconnected")
                .orElseThrow());
    }

    public InboundAdmission submitInbound(String tenantId, String channelId,
            InboundEventRequest event) {
        ChannelInstance instance = requireInstance(tenantId, channelId);
        if (!"connected".equals(instance.state())) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "channel_disconnected",
                    "The channel is not connected.");
        }
        if (event.accountGeneration() != instance.accountGeneration()) {
            throw new ApiException(HttpStatus.CONFLICT,
                    event.accountGeneration() < instance.accountGeneration()
                            ? "channel_generation_stale"
                            : "channel_generation_unregistered",
                    "The event's account generation is not the registered"
                            + " one.");
        }
        forbidSeparator(event.platformEventId(), "platformEventId");
        String kind = event.scope().kind();
        String senderId = event.scope().senderId();
        String chatId = event.scope().chatId();
        String threadId = event.scope().threadId();
        String routeId = routeId(channelId, instance.accountId(), kind,
                senderId, chatId, threadId);
        String routeKey = ChannelRouteRepository.routeKey(tenantId, channelId,
                event.accountGeneration(), event.platformEventId(),
                event.semanticRevision());
        String inputId = INPUT_PREFIX + routeKey;
        ChannelBinding binding = instances.findBinding(tenantId, channelId,
                routeId).orElseGet(() -> bindRoute(tenantId, instance,
                        routeId, event, kind, senderId, chatId, threadId));
        ChannelRoute row = routes.findOrCreate(new ChannelRoute(tenantId,
                routeKey, channelId, event.accountGeneration(),
                event.platformEventId(), event.semanticRevision(),
                binding.sessionId(), event.senderId(), event.chatId(),
                event.threadId(), "staged", null,
                attachmentDigests(event), 0, 0));
        if ("admitted".equals(row.state())) {
            // Redelivery of an admitted event: the original admission,
            // nothing new in the journal. The Harness answers the committed
            // revision when it can; the row alone answers when it cannot.
            try {
                Map<String, Object> replay = harness.runChannelOperation(
                        tenantId, binding.sessionId(), submitBody(instance,
                                event, inputId, kind, senderId, chatId,
                                threadId));
                return admission(replay, inputId, binding.sessionId(),
                        routeId);
            } catch (RuntimeException error) {
                return new InboundAdmission(row.inputId(), row.inputId(),
                        binding.sessionId(), routeId, 0, true);
            }
        }
        Map<String, Object> result;
        try {
            result = harness.runChannelOperation(tenantId,
                    binding.sessionId(), submitBody(instance, event, inputId,
                            kind, senderId, chatId, threadId));
        } catch (DaemonHttpException error) {
            throw translate(error);
        }
        if (routes.admit(tenantId, routeKey, inputId) == null) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "channel_route_conflict",
                    "The ingress row was admitted with another input.");
        }
        return admission(result, inputId, binding.sessionId(), routeId);
    }

    public ClaimResponse claimDeliveries(String tenantId, String channelId,
            int limit) {
        ChannelInstance instance = requireInstance(tenantId, channelId);
        if (!"connected".equals(instance.state())) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "channel_disconnected",
                    "The channel is not connected.");
        }
        List<ClaimedDelivery> claimed = new ArrayList<>();
        for (ChannelBinding binding : instances.listBindings(tenantId,
                channelId, MAX_BINDINGS_PER_CLAIM)) {
            if (claimed.size() >= limit) {
                break;
            }
            if (!"ACTIVE".equals(instances.sessionStatus(tenantId,
                    binding.sessionId()))) {
                continue;
            }
            for (PendingDelivery pending : instances.findPendingDeliveries(
                    tenantId, binding.sessionId(), limit - claimed.size())) {
                try {
                    claimed.add(claimOne(tenantId, channelId, pending));
                } catch (RuntimeException error) {
                    LOG.warn("channel claim failed tenant={} channel={}"
                            + " delivery={} failure={}", tenantId,
                            channelId, pending.deliveryId(),
                            error.getMessage());
                }
            }
        }
        return new ClaimResponse(claimed);
    }

    public DeliveryView receipt(String tenantId, String channelId,
            String deliveryId, ReceiptRequest request) {
        requireInstance(tenantId, channelId);
        ChannelClaim claim = requireClaim(tenantId, channelId, deliveryId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", UUID.randomUUID().toString());
        body.put("deliveryId", deliveryId);
        String providerReceipt = null;
        if ("accepted".equals(request.outcome())) {
            if (request.ordinal() == null
                    || request.providerMessageId() == null
                    || request.providerMessageId().isBlank()) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "invalid_request",
                        "An accepted receipt names its segment ordinal and"
                                + " provider message id.");
            }
            body.put("kind", "segment_receipt");
            body.put("ordinal", request.ordinal());
            body.put("providerMessageId", request.providerMessageId());
            body.put("acceptedAt", request.acceptedAt() == null ? clock.get()
                    : request.acceptedAt());
            providerReceipt = request.providerMessageId();
        } else {
            body.put("kind", "settle_delivery");
            body.put("outcome", request.outcome());
        }
        Map<String, Object> result;
        try {
            result = harness.runChannelOperation(tenantId, claim.sessionId(),
                    body);
        } catch (DaemonHttpException error) {
            throw translate(error);
        }
        String state = deliveryState(result);
        ChannelDelivery row = stepLedger(tenantId, channelId, deliveryId,
                state, providerReceipt);
        return view(row, claim.sessionId());
    }

    public ResendResponse resend(String tenantId, String channelId,
            String deliveryId) {
        requireInstance(tenantId, channelId);
        ChannelClaim claim = requireClaim(tenantId, channelId, deliveryId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", UUID.randomUUID().toString());
        body.put("kind", "resend_delivery");
        body.put("deliveryId", deliveryId);
        Map<String, Object> result;
        try {
            result = harness.runChannelOperation(tenantId, claim.sessionId(),
                    body);
        } catch (DaemonHttpException error) {
            throw translate(error);
        }
        Map<?, ?> delivery = (Map<?, ?>) result.get("delivery");
        String resentId = String.valueOf(delivery.get("deliveryId"));
        List<?> segments = (List<?>) delivery.get("segments");
        Map<?, ?> first = (Map<?, ?>) segments.getFirst();
        ChannelDelivery row = deliveries.findOrCreate(new ChannelDelivery(
                tenantId, channelId, resentId,
                String.valueOf(first.get("segmentId")),
                ((Number) first.get("ordinal")).intValue(), "planned", null,
                0, 0));
        instances.claim(tenantId, channelId, resentId, claim.sessionId());
        return new ResendResponse(resentId, deliveryId, true,
                view(row, claim.sessionId()));
    }

    /**
     * A claim that outlived its lease without a receipt: the adapter may
     * have died after sending, so the outcome is unknown — recorded, never
     * resent (reference design section 14, item 5).
     */
    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.channels.scan-delay:30s}")
    public void reconcile() {
        long before = clock.get() - claimLease.toMillis();
        for (ChannelClaim claim : instances.findExpiredSendingClaims(before,
                RECONCILE_LIMIT)) {
            try {
                if (!"ACTIVE".equals(instances.sessionStatus(claim.tenantId(),
                        claim.sessionId()))) {
                    // No writer is left to revise the record: the ledger,
                    // the public read model, records the unknown outcome.
                    stepLedger(claim.tenantId(), claim.channelId(),
                            claim.deliveryId(), "unknown", null);
                    continue;
                }
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("operationId", UUID.randomUUID().toString());
                body.put("kind", "settle_delivery");
                body.put("deliveryId", claim.deliveryId());
                body.put("outcome", "unknown");
                Map<String, Object> result = harness.runChannelOperation(
                        claim.tenantId(), claim.sessionId(), body);
                stepLedger(claim.tenantId(), claim.channelId(),
                        claim.deliveryId(), deliveryState(result), null);
            } catch (RuntimeException error) {
                LOG.warn("channel claim reconcile failed tenant={} channel={}"
                        + " delivery={} failure={}", claim.tenantId(),
                        claim.channelId(), claim.deliveryId(),
                        error.getMessage());
            }
        }
    }

    // --- public reads ---

    public PublicList<PublicChannel> listChannels(String tenantId,
            String actorId, String cursor, int limit) {
        requireLimit(limit);
        InstanceCursor decoded = null;
        if (cursor != null && !cursor.isEmpty()) {
            String[] parts = decodeCursor(cursor, "Channel cursor is invalid.");
            decoded = new InstanceCursor(Long.parseLong(parts[0]), parts[1]);
        }
        InstancePage page = instances.listInstances(tenantId, decoded, limit);
        List<PublicChannel> data = new ArrayList<>();
        for (ChannelInstance instance : page.instances()) {
            if (!workspaces.canRead(tenantId, actorId,
                    instance.workspaceId())) {
                continue;
            }
            List<ChannelRoute> newest = routes.listByChannel(tenantId,
                    instance.channelId(), null, 100).routes();
            List<PublicChannelRoute> oldestFirst = new ArrayList<>();
            for (int index = newest.size() - 1; index >= 0; index--) {
                oldestFirst.add(publicRoute(newest.get(index)));
            }
            data.add(new PublicChannel(instance.channelId(), "agent.channel",
                    instance.platform(), instance.accountGeneration(),
                    instance.state(), oldestFirst, instance.createdAt()));
        }
        String next = null;
        if (page.hasMore() && !page.instances().isEmpty()) {
            ChannelInstance last = page.instances().getLast();
            next = encodeCursor(last.createdAt(), last.channelId());
        }
        return new PublicList<>("list", data, page.hasMore(), next);
    }

    public PublicList<PublicChannelDelivery> listDeliveries(String tenantId,
            String actorId, String channelId, String cursor, int limit) {
        requireLimit(limit);
        requireReadableInstance(tenantId, actorId, channelId);
        DeliveryCursor decoded = null;
        if (cursor != null && !cursor.isEmpty()) {
            String[] parts = decodeCursor(cursor,
                    "Delivery cursor is invalid.");
            decoded = new DeliveryCursor(Long.parseLong(parts[0]), parts[1]);
        }
        DeliveryPage page = deliveries.listByChannel(tenantId, channelId,
                decoded, limit);
        List<PublicChannelDelivery> data = page.deliveries().stream()
                .map(ManagedChannelService::publicDelivery).toList();
        String next = null;
        if (page.hasMore() && !page.deliveries().isEmpty()) {
            ChannelDelivery last = page.deliveries().getLast();
            next = encodeCursor(last.createdAt(), last.deliveryId());
        }
        return new PublicList<>("list", data, page.hasMore(), next);
    }

    public PublicChannelDelivery getDelivery(String tenantId, String actorId,
            String channelId, String deliveryId) {
        requireReadableInstance(tenantId, actorId, channelId);
        return deliveries.find(tenantId, channelId, deliveryId)
                .map(ManagedChannelService::publicDelivery)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "delivery_not_found", "The delivery was not found."));
    }

    // --- helpers ---

    private ChannelBinding bindRoute(String tenantId,
            ChannelInstance instance, String routeId,
            InboundEventRequest event, String kind, String senderId,
            String chatId, String threadId) {
        // The route's Session: created as the connection's owning actor
        // under its registered Workspace selection, idempotent by the
        // route's own key, so a lost answer replays — never a second
        // Session (decision 4).
        String title = instance.platform() + ": "
                + (event.subject() == null || event.subject().isBlank()
                        ? event.senderId() : event.subject());
        if (title.length() > 256) {
            title = title.substring(0, 256);
        }
        CommandAdmission created = sessions.createWorkspaceSession(tenantId,
                instance.actorId(), creationKey(tenantId,
                        instance.channelId(), routeId), "qwen-code", null,
                title, null, List.of(), new WorkspaceSelection(
                        instance.workspaceId(), instance.cwdRelative()));
        return instances.bind(new ChannelBinding(tenantId,
                instance.channelId(), routeId, created.sessionId(), kind,
                senderId, chatId, threadId, 0));
    }

    private ClaimedDelivery claimOne(String tenantId, String channelId,
            PendingDelivery pending) {
        JsonNode record = readJson(instances.readResource(tenantId,
                pending.recordResourceId()), "channel delivery record");
        JsonNode firstUnsent = null;
        for (JsonNode segment : record.required("segments")) {
            if (segment.get("receipt").isNull()) {
                firstUnsent = segment;
                break;
            }
        }
        if (firstUnsent == null) {
            throw new IllegalStateException("delivery has no unsent segment");
        }
        ChannelDelivery ledger = deliveries.findOrCreate(new ChannelDelivery(
                tenantId, channelId, pending.deliveryId(),
                firstUnsent.required("segmentId").asText(),
                firstUnsent.required("ordinal").asInt(), "planned", null,
                0, 0));
        Optional<ChannelClaim> existing = instances.findClaim(tenantId,
                channelId, pending.deliveryId());
        if (existing.isEmpty()) {
            instances.claim(tenantId, channelId, pending.deliveryId(),
                    pending.sessionId());
        } else {
            instances.touchClaim(tenantId, channelId, pending.deliveryId());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", UUID.randomUUID().toString());
        body.put("kind", "claim_delivery");
        body.put("deliveryId", pending.deliveryId());
        Map<String, Object> result = harness.runChannelOperation(tenantId,
                pending.sessionId(), body);
        stepLedger(tenantId, channelId, pending.deliveryId(), "sending",
                null);
        Map<?, ?> delivery = (Map<?, ?>) result.get("delivery");
        Map<?, ?> reply = (Map<?, ?>) result.get("reply");
        List<ClaimedSegment> segments = new ArrayList<>();
        for (Object entry : (List<?>) result.get("segments")) {
            Map<?, ?> segment = (Map<?, ?>) entry;
            segments.add(new ClaimedSegment(
                    ((Number) segment.get("ordinal")).intValue(),
                    String.valueOf(segment.get("segmentId")),
                    String.valueOf(segment.get("text"))));
        }
        return new ClaimedDelivery(pending.deliveryId(), pending.sessionId(),
                String.valueOf(delivery.get("routeId")),
                ((Number) delivery.get("routeRevision")).longValue(),
                String.valueOf(delivery.get("state")),
                String.valueOf(reply.get("text")),
                mapper.valueToTree(reply.get("replyContext")), segments);
    }

    /**
     * Moves the ledger to the state the record reached, one legal step at a
     * time; a row already there is this step's replay.
     */
    private ChannelDelivery stepLedger(String tenantId, String channelId,
            String deliveryId, String state, String providerReceipt) {
        ChannelDelivery current = deliveries.find(tenantId, channelId,
                deliveryId).orElseThrow(() -> new ApiException(
                        HttpStatus.NOT_FOUND, "delivery_not_found",
                        "The delivery was not found."));
        if (state.equals(current.state())) {
            return current;
        }
        if (!ChannelDeliveryRepository.isLegalStep(current.state(), state)) {
            // The record moved through a step the ledger never saw (a
            // partial resumed to sending before its receipt): take it.
            if (ChannelDeliveryRepository.isLegalStep(current.state(),
                    "sending") && ChannelDeliveryRepository.isLegalStep(
                            "sending", state)) {
                deliveries.transition(tenantId, channelId, deliveryId,
                        current.state(), "sending", null);
                current = deliveries.find(tenantId, channelId, deliveryId)
                        .orElseThrow();
            } else {
                return current;
            }
        }
        ChannelDelivery moved = deliveries.transition(tenantId, channelId,
                deliveryId, current.state(), state, providerReceipt);
        return moved != null ? moved
                : deliveries.find(tenantId, channelId, deliveryId)
                        .orElseThrow();
    }

    private Map<String, Object> submitBody(ChannelInstance instance,
            InboundEventRequest event, String inputId, String kind,
            String senderId, String chatId, String threadId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationId", UUID.randomUUID().toString());
        body.put("kind", "submit_input");
        body.put("inputId", inputId);
        body.put("channelInstanceId", instance.channelId());
        body.put("accountId", instance.accountId());
        body.put("accountGeneration", event.accountGeneration());
        body.put("platformEventId", event.platformEventId());
        body.put("semanticRevision", event.semanticRevision());
        Map<String, Object> scope = new LinkedHashMap<>();
        scope.put("kind", kind);
        scope.put("senderId", senderId);
        scope.put("chatId", chatId);
        scope.put("threadId", threadId);
        body.put("scope", scope);
        body.put("policy", readJson(instance.policyJson(), "channel policy"));
        body.put("senderId", event.senderId());
        body.put("chatId", event.chatId());
        body.put("threadId", event.threadId());
        body.put("subject", event.subject());
        body.put("text", event.text());
        List<Map<String, Object>> attachments = new ArrayList<>();
        if (event.attachments() != null) {
            for (var attachment : event.attachments()) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("fileName", attachment.fileName());
                entry.put("mimeType", attachment.mimeType());
                entry.put("bytesBase64", attachment.bytesBase64());
                attachments.add(entry);
            }
        }
        body.put("attachments", attachments);
        body.put("replyContext", event.replyContext() == null ? null
                : mapper.convertValue(event.replyContext(), Object.class));
        return body;
    }

    private static InboundAdmission admission(Map<String, Object> result,
            String inputId, String sessionId, String routeId) {
        return new InboundAdmission(inputId,
                String.valueOf(result.getOrDefault("turnId", inputId)),
                sessionId, routeId,
                ((Number) result.getOrDefault("routeRevision", 0L))
                        .longValue(),
                Boolean.TRUE.equals(result.get("replayed")));
    }

    private static String deliveryState(Map<String, Object> result) {
        Map<?, ?> delivery = (Map<?, ?>) result.get("delivery");
        return String.valueOf(delivery.get("state"));
    }

    private List<String> attachmentDigests(InboundEventRequest event) {
        List<String> digests = new ArrayList<>();
        if (event.attachments() == null) {
            return digests;
        }
        for (var attachment : event.attachments()) {
            byte[] bytes;
            try {
                bytes = Base64.getDecoder().decode(attachment.bytesBase64());
            } catch (IllegalArgumentException error) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "invalid_request",
                        "An attachment is not base64.");
            }
            digests.add("sha256:" + HexFormat.of().formatHex(sha256(bytes)));
        }
        return digests;
    }

    private ChannelInstance requireInstance(String tenantId,
            String channelId) {
        requireChannelId(channelId);
        return instances.findInstance(tenantId, channelId).orElseThrow(() ->
                new ApiException(HttpStatus.NOT_FOUND, "channel_not_found",
                        "The channel was not found."));
    }

    private ChannelInstance requireReadableInstance(String tenantId,
            String actorId, String channelId) {
        ChannelInstance instance = requireInstance(tenantId, channelId);
        if (!workspaces.canRead(tenantId, actorId, instance.workspaceId())) {
            throw new ApiException(HttpStatus.NOT_FOUND, "channel_not_found",
                    "The channel was not found.");
        }
        return instance;
    }

    private ChannelClaim requireClaim(String tenantId, String channelId,
            String deliveryId) {
        return instances.findClaim(tenantId, channelId, deliveryId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "delivery_not_found", "The delivery was not found."));
    }

    private static void requireChannelId(String channelId) {
        if (channelId == null
                || !channelId.matches("[A-Za-z0-9._:@+-]{1,128}")) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "The channel id is invalid.");
        }
    }

    private static void requireLimit(int limit) {
        if (limit < 1 || limit > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
    }

    private static void forbidSeparator(String value, String name) {
        if (value.contains(SEPARATOR)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    name + " must not contain NUL.");
        }
    }

    private static ApiException translate(DaemonHttpException error) {
        String code = "channel_operation_failed";
        String body = error.getResponseBody();
        if (body != null) {
            int at = body.indexOf("\"code\":\"");
            if (at >= 0) {
                int end = body.indexOf('"', at + 8);
                if (end > at) {
                    code = body.substring(at + 8, end);
                }
            }
        }
        return new ApiException(error.getStatusCode() == 409
                ? HttpStatus.CONFLICT : HttpStatus.SERVICE_UNAVAILABLE, code,
                "The Hosted Harness refused the channel operation.");
    }

    private JsonNode readJson(String text, String context) {
        if (text == null) {
            throw new IllegalStateException(context + " is not readable");
        }
        try {
            return mapper.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(context + " is not JSON", error);
        }
    }

    private static ChannelInstanceView view(ChannelInstance instance) {
        return new ChannelInstanceView(instance.channelId(),
                instance.platform(), instance.accountId(),
                instance.accountGeneration(), instance.state(),
                instance.workspaceId(), instance.cwdRelative(),
                instance.createdAt(), instance.updatedAt());
    }

    private static DeliveryView view(ChannelDelivery row, String sessionId) {
        return new DeliveryView(row.deliveryId(), sessionId, row.state(),
                row.providerReceipt(), row.createdAt(), row.updatedAt());
    }

    private static PublicChannelRoute publicRoute(ChannelRoute route) {
        return new PublicChannelRoute(route.platformEventId(),
                route.accountGeneration(), route.semanticRevision(),
                route.senderId(), route.chatId(), route.threadId(),
                route.sessionId(), route.state(), route.inputId(),
                route.stagedAttachmentRefs(), route.createdAt());
    }

    private static PublicChannelDelivery publicDelivery(
            ChannelDelivery row) {
        return new PublicChannelDelivery(row.deliveryId(),
                "agent.channel.delivery", row.channelInstanceId(),
                row.segmentId(), row.ordinal(), row.state(),
                row.providerReceipt(), row.createdAt(), row.updatedAt());
    }

    private static String encodeCursor(long createdAt, String id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                (createdAt + ":" + id).getBytes(StandardCharsets.UTF_8));
    }

    private static String[] decodeCursor(String cursor, String message) {
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
            int separator = decoded.indexOf(':');
            if (separator <= 0 || separator == decoded.length() - 1) {
                throw new IllegalArgumentException();
            }
            Long.parseLong(decoded.substring(0, separator));
            return new String[] {decoded.substring(0, separator),
                    decoded.substring(separator + 1)};
        } catch (IllegalArgumentException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor",
                    message);
        }
    }

    /** The route chain identity, exactly as the Harness derives it. */
    static String routeId(String channelId, String accountId, String kind,
            String senderId, String chatId, String threadId) {
        return ROUTE_PREFIX + HexFormat.of().formatHex(sha256(String.join(
                SEPARATOR, channelId, accountId, kind,
                senderId == null ? "" : senderId,
                chatId == null ? "" : chatId,
                threadId == null ? "" : threadId)
                .getBytes(StandardCharsets.UTF_8)));
    }

    /** The Session creation key of a route: the Idempotency-Key it replays by. */
    static String creationKey(String tenantId, String channelId,
            String routeId) {
        return CREATION_PREFIX + HexFormat.of().formatHex(sha256(String.join(
                SEPARATOR, tenantId, channelId, routeId)
                .getBytes(StandardCharsets.UTF_8)));
    }

    private static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    /** For tests: the ledger row as stored. */
    Optional<ChannelDelivery> ledger(String tenantId, String channelId,
            String deliveryId) {
        return deliveries.find(tenantId, channelId, deliveryId);
    }
}
