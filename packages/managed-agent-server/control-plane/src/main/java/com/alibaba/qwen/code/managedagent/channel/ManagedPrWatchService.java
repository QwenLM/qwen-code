package com.alibaba.qwen.code.managedagent.channel;

import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchAdmission;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchBindingList;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchBindingView;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchCreateRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchInjectRequest;
import com.alibaba.qwen.code.managedagent.contracts.channel.ChannelAdapterModels.PrWatchRetireRequest;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.PrWatchInjectionRepository;
import com.alibaba.qwen.code.managedagent.contracts.persistence.PrWatchInjectionRepository.PrWatchInjection;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ChannelInstanceStore;
import com.alibaba.qwen.code.managedagent.repository.ChannelInstanceStore.ChannelInstance;
import com.alibaba.qwen.code.managedagent.repository.PrWatchBindingStore;
import com.alibaba.qwen.code.managedagent.repository.PrWatchBindingStore.PrWatchBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The PR-watch bound-session surface (design
 * 2026-11-17-managed-github-pr-watch-bound-session, slice 1, private-only).
 * Binding writes validate the target Session against the channel instance's
 * Workspace on the trusted adapter surface. Injection forces the bound
 * Session as the target — never a caller-chosen one — and submits the
 * PR-event input + wake through the Harness channel operation path: the
 * journal commits first, the SQL ledger follows, and a crash between the
 * two replays to the same derived admission. No channel_delivery is planned
 * from a pr_event input.
 */
@Service
public class ManagedPrWatchService {
    private final ChannelInstanceStore instances;
    private final SessionQueryStore sessions;
    private final PrWatchBindingStore bindings;
    private final PrWatchInjectionRepository injections;
    private final HarnessConnector harness;
    private final ObjectMapper mapper;

    public ManagedPrWatchService(ChannelInstanceStore instances,
            SessionQueryStore sessions, PrWatchBindingStore bindings,
            PrWatchInjectionRepository injections, HarnessConnector harness,
            @Qualifier("managedAgentObjectMapper") ObjectMapper mapper) {
        this.instances = instances;
        this.sessions = sessions;
        this.bindings = bindings;
        this.injections = injections;
        this.harness = harness;
        this.mapper = mapper;
    }

    public PrWatchBindingView create(String tenantId, String channelId,
            PrWatchCreateRequest request) {
        ChannelInstance instance = requireInstance(tenantId, channelId);
        List<String> events = request.events().stream().distinct().sorted()
                .toList();
        for (String event : events) {
            if (!PrWatchOperations.isPrWatchTransition(event)) {
                throw new ManagedAgentException(400, "invalid_request",
                        "Unknown PR-watch transition.");
            }
        }
        SessionRecord session = requireTargetSession(tenantId, instance,
                request.sessionId());
        String bindingId;
        String eventsJson;
        try {
            bindingId = PrWatchOperations.prWatchBindingId(tenantId,
                    channelId, request.owner(), request.repo(),
                    request.prNumber());
            eventsJson = mapper.writeValueAsString(events);
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(400, "invalid_request",
                    error.getMessage());
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new ManagedAgentException(400, "invalid_request",
                    "The PR-watch event set is not serializable.");
        }
        PrWatchBinding stored = bindings.bind(new PrWatchBinding(tenantId,
                channelId, bindingId, request.owner(), request.repo(),
                request.prNumber(), session.sessionId(), eventsJson, 0));
        if (!stored.sessionId().equals(request.sessionId())
                || !stored.eventsJson().equals(eventsJson)) {
            throw new ManagedAgentException(409, "pr_watch_binding_conflict",
                    "The PR is already bound to another Session or event"
                            + " set.");
        }
        return view(stored);
    }

    public PrWatchBindingList list(String tenantId, String channelId) {
        requireInstance(tenantId, channelId);
        return new PrWatchBindingList(bindings.listByChannel(tenantId,
                channelId).stream().map(this::view).toList());
    }

    public PrWatchBindingView retire(String tenantId, String channelId,
            PrWatchRetireRequest request) {
        requireInstance(tenantId, channelId);
        PrWatchBinding binding = requireBinding(tenantId, channelId,
                request.owner(), request.repo(), request.prNumber());
        bindings.retire(tenantId, channelId, request.owner(), request.repo(),
                request.prNumber());
        return view(binding);
    }

    public PrWatchAdmission inject(String tenantId, String channelId,
            PrWatchInjectRequest request) {
        ChannelInstance instance = requireInstance(tenantId, channelId);
        if (!"connected".equals(instance.state())) {
            throw new ManagedAgentException(409, "channel_disconnected",
                    "The channel is not connected.");
        }
        if (!PrWatchOperations.isPrWatchTransition(request.transition())) {
            throw new ManagedAgentException(400, "invalid_request",
                    "Unknown PR-watch transition.");
        }
        // The internal route's target is always the bound Session, never a
        // caller-chosen one.
        PrWatchBinding binding = requireBinding(tenantId, channelId,
                request.owner(), request.repo(), request.prNumber());
        if (!events(binding).contains(request.transition())) {
            throw new ManagedAgentException(409,
                    "pr_watch_transition_not_enabled",
                    "The binding does not enable this transition.");
        }
        // Defence in depth: re-validate the bound Session against the
        // instance's Workspace on every inject, so a binding that escaped the
        // ownership-move guard (or whose Session was deleted or moved) fails
        // closed instead of starting a turn outside the current owner's grant.
        try {
            requireTargetSession(tenantId, instance, binding.sessionId());
        } catch (ManagedAgentException error) {
            if (error.getStatus() == 404
                    || "session_not_active".equals(error.getCode())) {
                // The bound Session is gone, left the Workspace, or closed
                // (CLOSED/ARCHIVED are terminal — it can never accept an input
                // again): retire the dead binding so the PR can be bound to
                // another Session instead of being blocked by it forever.
                // retire keys on the business key and is a tolerated no-op when
                // the row is already gone.
                bindings.retire(tenantId, channelId, request.owner(),
                        request.repo(), request.prNumber());
            }
            throw error;
        }
        // Refuse before staging any payload the Harness must reject: the
        // Harness bounds the WRAPPED prompt, so a wire-max request would
        // otherwise stage permanently and replay un-admittable forever.
        validateEnvelopeBounds(request);
        String inputId;
        try {
            inputId = PrWatchOperations.prWatchInputId(tenantId, channelId,
                    request.owner(), request.repo(), request.prNumber(),
                    request.transition(), request.headSha(),
                    request.episode());
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(400, "invalid_request",
                    error.getMessage());
        }
        PrWatchInjection candidate = new PrWatchInjection(
                tenantId, inputId, channelId, binding.bindingId(),
                binding.sessionId(), request.owner(), request.repo(),
                request.prNumber(), request.transition(), request.headSha(),
                request.episode(), request.evidence(), request.text(),
                "staged", 0, 0);
        PrWatchInjection row = injections.findOrCreate(candidate);
        if (!row.sessionId().equals(binding.sessionId())) {
            // A merely staged row owned by another Session is not an admission:
            // that binding's Harness call never committed and the PR has since
            // been rebound. Release the stale receipt and re-stage under the
            // current binding so the occurrence can still be delivered; only an
            // admitted row reserves the identity for its Session (a dead
            // binding must not block the PR forever — the lazy-retire rule).
            if ("admitted".equals(row.state())
                    || !injections.releaseStaged(tenantId, inputId)) {
                throw new ManagedAgentException(409,
                        "pr_watch_injection_conflict",
                        "The PR event was already admitted to another Session.");
            }
            row = injections.findOrCreate(candidate);
            if (!row.sessionId().equals(binding.sessionId())) {
                throw new ManagedAgentException(409,
                        "pr_watch_injection_conflict",
                        "The PR event was already admitted to another Session.");
            }
        }
        if ("admitted".equals(row.state())) {
            // Redelivery of an admitted transition: the original admission,
            // nothing new in the journal. The Harness answers the committed
            // input when it can; the row alone answers when it cannot.
            try {
                Map<String, Object> replay = harness.runChannelOperation(
                        tenantId, row.sessionId(), submitBody(row));
                return admission(replay, row);
            } catch (RuntimeException error) {
                return new PrWatchAdmission(row.inputId(), row.inputId(),
                        row.sessionId(), row.bindingId(), true);
            }
        }
        Map<String, Object> result;
        try {
            result = harness.runChannelOperation(tenantId, row.sessionId(),
                    submitBody(row));
        } catch (HarnessFailure error) {
            throw ManagedChannelService.translate(error);
        }
        if (injections.admit(tenantId, inputId) == null) {
            throw new ManagedAgentException(409, "pr_watch_injection_conflict",
                    "The injection row was admitted with another identity.");
        }
        return admission(result, row);
    }

    /**
     * The ingress relationship the wire limits alone do not enforce: the
     * Harness bounds the wrapped prompt (prWatchInputText) against the char
     * and byte caps, so a request at the raw wire maximum can be accepted here
     * yet always refused downstream. Bound the wrapped envelope before staging
     * so an accepted request is an admittable one; the wire limits stay as they
     * are (text ≤ 32000, evidence ≤ 4000).
     */
    private void validateEnvelopeBounds(PrWatchInjectRequest request) {
        if (request.evidence().length()
                > PrWatchOperations.MAX_EVIDENCE_CHARS) {
            throw new ManagedAgentException(400, "invalid_request",
                    "The PR-watch evidence exceeds the character bound.");
        }
        String wrapped = PrWatchOperations.prWatchInputText(request.owner(),
                request.repo(), request.prNumber(), request.transition(),
                request.headSha(), request.evidence(), request.text());
        if (wrapped.length() > PrWatchOperations.MAX_TEXT_CHARS) {
            throw new ManagedAgentException(400, "invalid_request",
                    "The PR-watch prompt exceeds the character bound.");
        }
        try {
            com.fasterxml.jackson.databind.node.ObjectNode envelope =
                    mapper.createObjectNode();
            envelope.put("owner", request.owner());
            envelope.put("repo", request.repo());
            envelope.put("prNumber", request.prNumber());
            envelope.put("transition", request.transition());
            envelope.put("headSha", request.headSha());
            envelope.put("evidence", request.evidence());
            envelope.put("text", wrapped);
            if (mapper.writeValueAsBytes(envelope).length
                    > PrWatchOperations.MAX_ENVELOPE_BYTES) {
                throw new ManagedAgentException(400, "invalid_request",
                        "The PR-watch envelope exceeds the byte bound.");
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new ManagedAgentException(400, "invalid_request",
                    "The PR-watch envelope is not serializable.");
        }
    }

    /** The durable envelope pinned before the commit; a replay sends it byte-identical. */
    private static Map<String, Object> submitBody(PrWatchInjection row) {
        Map<String, Object> body = new LinkedHashMap<>();
        // The Harness channel-operation gate admits only a UUID operationId
        // (HOSTED_UUID); the derived prw-… input id is not one. Name-based UUID
        // v3 keeps the transport token deterministic so a replay stays
        // byte-identical, while idempotency itself rides the inputId/commandId.
        body.put("operationId", UUID.nameUUIDFromBytes(
                row.inputId().getBytes(StandardCharsets.UTF_8)).toString());
        body.put("kind", "submit_pr_event_input");
        body.put("inputId", row.inputId());
        body.put("turnId", row.inputId());
        body.put("owner", row.owner());
        body.put("repo", row.repo());
        body.put("prNumber", row.prNumber());
        body.put("transition", row.transition());
        body.put("headSha", row.headSha());
        body.put("episode", row.episode());
        body.put("evidence", row.evidence());
        body.put("text", row.text());
        body.put("bindingId", row.bindingId());
        return body;
    }

    private static PrWatchAdmission admission(Map<String, Object> result,
            PrWatchInjection row) {
        return new PrWatchAdmission(row.inputId(),
                String.valueOf(result.getOrDefault("turnId", row.inputId())),
                row.sessionId(), row.bindingId(),
                Boolean.TRUE.equals(result.get("replayed")));
    }

    /** Exists, ACTIVE, and of the channel instance's Workspace; invisibility first. */
    private SessionRecord requireTargetSession(String tenantId,
            ChannelInstance instance, String sessionId) {
        SessionRecord session = sessions.findSession(tenantId, sessionId)
                .orElse(null);
        if (session == null || "DELETED".equals(session.status())
                || session.workspace() == null
                || !instance.workspaceId().equals(
                        session.workspace().getWorkspaceId())) {
            throw new ManagedAgentException(404, "session_not_found",
                    "The Session was not found.");
        }
        if (!"ACTIVE".equals(session.status())) {
            throw new ManagedAgentException(409, "session_not_active",
                    "The Session is not active.");
        }
        return session;
    }

    private PrWatchBinding requireBinding(String tenantId, String channelId,
            String owner, String repo, long prNumber) {
        return bindings.findBinding(tenantId, channelId, owner, repo, prNumber)
                .orElseThrow(() -> new ManagedAgentException(404,
                        "pr_watch_binding_not_found",
                        "The PR-watch binding was not found."));
    }

    private ChannelInstance requireInstance(String tenantId,
            String channelId) {
        if (channelId == null
                || !channelId.matches("[A-Za-z0-9._:@+-]{1,128}")) {
            throw new ManagedAgentException(400, "invalid_request",
                    "The channel id is invalid.");
        }
        return instances.findInstance(tenantId, channelId).orElseThrow(() ->
                new ManagedAgentException(404, "channel_not_found",
                        "The channel was not found."));
    }

    private List<String> events(PrWatchBinding binding) {
        JsonNode node;
        try {
            node = mapper.readTree(binding.eventsJson());
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(
                    "PR-watch binding events are not JSON", error);
        }
        List<String> events = new ArrayList<>();
        node.forEach(event -> events.add(event.asText()));
        return events;
    }

    private PrWatchBindingView view(PrWatchBinding binding) {
        return new PrWatchBindingView(binding.bindingId(), binding.owner(),
                binding.repo(), binding.prNumber(), binding.sessionId(),
                events(binding), binding.createdAt());
    }
}
