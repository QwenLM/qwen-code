package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.DaemonTransportException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.daemon.HostedHarnessPlacement;
import com.alibaba.qwen.code.daemon.MutationOutcomeUnknownException;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore.Placement;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.JsonNode;

import javax.net.ssl.SSLContext;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/** Sticky routing over independently fenced Hosted process incarnations. */
public class HarnessPoolConnector implements HarnessConnector {
    private final ManagedAgentSettings properties;
    private final HarnessPlacementStore placements;
    private final WriterCredentialPolicy credentials;
    private final HarnessDiscovery discovery;
    private final Function<HarnessDiscovery.Endpoint, QwenHostedHarnessConnector> connectors;
    private final Function<HarnessDiscovery.Endpoint, HostedHarnessClient> clients;
    private final ManagedSessionSkills skills;
    private final SSLContext tls;
    private final Map<Owner, Member> members = new ConcurrentHashMap<>();
    private final AtomicInteger next = new AtomicInteger();
    private final ScheduledExecutorService refreshes = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "managed-harness-pool");
        thread.setDaemon(true);
        return thread;
    });
    private volatile List<Member> accepting = List.of();
    private volatile Contract contract;
    private volatile boolean closed;

    private record Owner(String instanceId, String bootId) {
    }

    private record Contract(Set<String> features, int title, int lifecycle, Set<String> profiles) {
        static Contract of(HostedHarnessCapabilities capabilities) {
            return new Contract(Set.copyOf(capabilities.getFeatures()), capabilities.getTitleProtocolVersion(),
                    capabilities.getLifecycleProtocolVersion(), Set.copyOf(capabilities.getLifecycleV2Profiles()));
        }
    }

    private static final class Member {
        private final HarnessDiscovery.Endpoint endpoint;
        private final HostedHarnessClient client;
        private final QwenHostedHarnessConnector connector;
        private volatile boolean reachable;
        private volatile boolean quiescing;
        Member(HarnessDiscovery.Endpoint endpoint, HostedHarnessClient client, QwenHostedHarnessConnector connector) {
            this.endpoint = endpoint;
            this.client = client;
            this.connector = connector;
        }

        Owner owner() {
            return new Owner(endpoint.instanceId(), client.capabilities().getBootId());
        }
    }

    private record Selected(Placement placement, Member member, QwenHostedHarnessConnector.PoolCall call) {
    }

    public HarnessPoolConnector(ManagedAgentSettings properties, HarnessPlacementStore placements,
            HarnessDiscovery discovery, Function<HarnessDiscovery.Endpoint, QwenHostedHarnessConnector> connectors,
            ManagedSessionSkills skills) {
        this(properties, placements, discovery, connectors, skills, HarnessTls.poolContext(properties.getHarness().getPool()), null);
    }

    HarnessPoolConnector(ManagedAgentSettings properties, HarnessPlacementStore placements,
            HarnessDiscovery discovery, Function<HarnessDiscovery.Endpoint, QwenHostedHarnessConnector> connectors,
            ManagedSessionSkills skills, SSLContext tls,
            Function<HarnessDiscovery.Endpoint, HostedHarnessClient> clients) {
        this.properties = properties;
        this.placements = placements;
        this.credentials = new WriterCredentialPolicy(properties);
        this.discovery = discovery;
        this.connectors = connectors;
        this.skills = skills;
        this.tls = tls;
        if (!properties.getSessionStore().isEnabled() || !credentials.isBound()) {
            throw new IllegalStateException("Harness pool requires an enabled Session Store and binding key");
        }
        var settings = properties.getHarness();
        if (settings.getToken().isBlank() || !settings.getCapabilityDigest().matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalStateException("Harness pool requires a token and capability digest");
        }
        if ("kubernetes".equals(settings.getPool().getDiscovery()) && tls == null) {
            throw new IllegalStateException("Kubernetes Harness pool requires configured mTLS");
        }
        for (var endpoint : discovery.snapshot().endpoints()) {
            validateEndpoint(endpoint, tls);
        }
        this.clients = clients == null ? this::connect : clients;
        if (clients == null) {
            refreshes.scheduleWithFixedDelay(() -> {
                try {
                    refresh();
                } catch (RuntimeException unavailable) {
                    accepting = List.of();
                }
            }, 0, 5, TimeUnit.SECONDS);
        }
    }

    private HostedHarnessClient connect(HarnessDiscovery.Endpoint endpoint) {
        validateEndpoint(endpoint, tls);
        var settings = properties.getHarness();
        return HostedHarnessClient.builder().baseUri(endpoint.baseUri()).sslContext(tls)
                .bearerToken(settings.getToken()).capabilityDigest(settings.getCapabilityDigest())
                .connectTimeout(settings.getConnectTimeout()).requestTimeout(settings.getRequestTimeout())
                .loadTimeout(settings.getLoadTimeout()).heartbeatInterval(settings.getHeartbeatInterval()).build();
    }

    static void validateEndpoint(HarnessDiscovery.Endpoint endpoint, SSLContext tls) {
        var uri = endpoint.baseUri();
        if (endpoint.instanceId() == null || !endpoint.instanceId().matches("[A-Za-z0-9._:-]{1,128}")
                || uri == null || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null
                || uri.getFragment() != null || uri.getPath() != null && !uri.getPath().isEmpty()
                        && !"/".equals(uri.getPath())) {
            throw new IllegalArgumentException("Invalid Harness pool endpoint");
        }
        boolean local = Set.of("127.0.0.1", "localhost", "[::1]", "::1").contains(uri.getHost());
        if (!("https".equals(uri.getScheme()) || local && "http".equals(uri.getScheme()))
                || !local && tls == null) {
            throw new IllegalArgumentException("Remote Harness pool endpoints require configured mTLS");
        }
    }

    synchronized void refresh() {
        if (closed) {
            return;
        }
        var snapshot = discovery.snapshot();
        if (!snapshot.current()) {
            accepting = List.of();
            return;
        }
        List<Member> ready = new ArrayList<>();
        for (var endpoint : snapshot.endpoints()) {
            if (closed) {
                return;
            }
            Member existing = members.values().stream()
                    .filter(member -> member.endpoint.instanceId().equals(endpoint.instanceId())
                            && member.endpoint.baseUri().equals(endpoint.baseUri()))
                    .filter(member -> member.reachable).findFirst().orElse(null);
            Member member = existing;
            HostedHarnessClient created = null;
            try {
                if (member == null) {
                    created = clients.apply(endpoint);
                    if (closed) {
                        created.close();
                        return;
                    }
                    var capabilities = created.capabilities();
                    if (!endpoint.instanceId().equals(capabilities.getInstanceId())
                            || !capabilities.getFeatures().containsAll(
                                    List.of("harness-pool-owner/1", "harness-instance-lifecycle/1"))) {
                        throw new IllegalStateException("Harness pool identity or capabilities differ");
                    }
                    Contract negotiated = Contract.of(capabilities);
                    if (contract != null && !contract.equals(negotiated)) {
                        throw new IllegalStateException("Harness pool capabilities are not homogeneous");
                    }
                    var leaf = connectors.apply(endpoint);
                    leaf.configurePool(endpoint, created, tls, skills);
                    member = new Member(endpoint, created, leaf);
                    Owner registeredOwner = member.owner();
                    var previous = members.putIfAbsent(registeredOwner, member);
                    if (previous != null) {
                        leaf.close();
                        member = previous;
                    }
                    created = null;
                    if (closed) {
                        members.remove(registeredOwner, member);
                        member.connector.close();
                        return;
                    }
                    contract = negotiated;
                }
                var status = member.client.readInstance();
                member.quiescing = !endpoint.accepting() || !"ACCEPTING".equals(status.get("state"));
                member.reachable = true;
                if (!member.quiescing) {
                    ready.add(member);
                }
            } catch (RuntimeException unavailable) {
                if (member != null) {
                    member.reachable = false;
                }
                if (created != null) {
                    created.close();
                }
            }
        }
        ready.sort(Comparator.comparing(member -> member.endpoint.instanceId()));
        accepting = List.copyOf(ready);
        members.entrySet().removeIf(entry -> {
            if (ready.contains(entry.getValue())) {
                return false;
            }
            Member member = entry.getValue();
            boolean owns = placements.hasUnreleasedOwnership(member.owner().instanceId(), member.owner().bootId());
            if (!owns) {
                member.connector.close();
                return true;
            }
            return false;
        });
    }

    private static boolean matches(Placement placement, Member member) {
        return placement != null && placement.instanceId().equals(member.endpoint.instanceId())
                && placement.bootId().equals(member.client.capabilities().getBootId());
    }

    private Selected select(String tenant, String session, boolean mayAcquire) {
        return select(tenant, session, mayAcquire, null);
    }

    private Selected select(String tenant, String session, boolean mayAcquire, OperationRecord operation) {
        if (closed) {
            throw unavailable();
        }
        Placement placement = placements.get(tenant, session);
        Member member = placement == null ? null : members.get(new Owner(placement.instanceId(), placement.bootId()));
        boolean quiescingOwner = member != null && member.reachable && member.quiescing && "ACTIVE".equals(placement.state());
        if (mayAcquire && (placement == null || member == null || !member.reachable
                || quiescingOwner || !"ACTIVE".equals(placement.state()))) {
            List<Member> candidates = accepting.stream()
                    .filter(value -> value.reachable && !value.quiescing).toList();
            if (candidates.isEmpty()) {
                if (member == null || !member.reachable) {
                    throw unavailable();
                }
            } else {
                Member candidate = candidates.get(Math.floorMod(next.getAndIncrement(), candidates.size()));
                try {
                    if (operation == null) {
                        placement = placement == null
                                ? placements.assign(tenant, session, candidate.endpoint.instanceId(), candidate.owner().bootId())
                                : placements.takeover(tenant, session, placement, candidate.endpoint.instanceId(), candidate.owner().bootId());
                    } else {
                        placement = placement == null
                                ? placements.assignForLifecycle(operation, candidate.endpoint.instanceId(), candidate.owner().bootId())
                                : placements.takeoverForLifecycle(operation, placement, candidate.endpoint.instanceId(), candidate.owner().bootId());
                    }
                } catch (ManagedAgentException refusal) {
                    if (!quiescingOwner || !member.reachable || refusal.getStatus() != 409
                            || !"harness_owner_still_live".equals(refusal.getCode())) {
                        throw refusal;
                    }
                    // Keep completion RPCs on the live owner while its SQL fence
                    // refuses a handoff; its process gate still rejects new work.
                }
                member = members.get(new Owner(placement.instanceId(), placement.bootId()));
            }
        }
        if (placement == null || member == null) {
            if (mayAcquire) {
                throw unavailable();
            }
            return null;
        }
        String workspace = placement.workspaceId() == null
                ? properties.getSessionStore().getWorkspaceId() : placement.workspaceId();
        var descriptor = new HostedHarnessPlacement(placement.instanceId(), placement.bootId(), placement.epoch());
        String token = credentials.issue(tenant, workspace, session, placement.instanceId(), placement.bootId(), placement.epoch());
        return new Selected(placement, member, new QwenHostedHarnessConnector.PoolCall(tenant, session, descriptor, token));
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(503, "harness_pool_unavailable", "No compatible Harness owner is available");
    }

    private <T> T call(String tenant, String session, Function<QwenHostedHarnessConnector, T> action) {
        return call(select(tenant, session, true), action);
    }

    private <T> T lifecycleCall(OperationRecord operation, Function<QwenHostedHarnessConnector, T> action) {
        return call(select(operation.tenantId(), operation.sessionId(), true, operation), action);
    }

    private <T> T call(Selected selected, Function<QwenHostedHarnessConnector, T> action) {
        try {
            return selected.member().connector.withPlacement(selected.call(), () -> action.apply(selected.member().connector));
        } catch (DaemonTransportException | HostedHarnessGenerationException | MutationOutcomeUnknownException error) {
            selected.member().reachable = false;
            throw error;
        }
    }

    private <T> T observe(String tenant, String session, T absent, Function<QwenHostedHarnessConnector, T> action) {
        Selected selected = select(tenant, session, false);
        return selected == null ? absent : selected.member().connector.withPlacement(selected.call(),
                () -> action.apply(selected.member().connector));
    }

    @Override
    public boolean isAvailable() {
        return !closed;
    }

    private boolean feature(String name) {
        return contract != null && contract.features().contains(name);
    }

    @Override
    public boolean supportsApprovalSelection() {
        return feature("approval-selection/1");
    }

    @Override
    public boolean supportsLiveApprovalSelection() {
        return feature("live-approval-selection/1") && supportsApprovalSelection();
    }

    @Override
    public boolean supportsAutoApproval() {
        return feature("auto-approval/1") && supportsApprovalSelection();
    }

    @Override
    public boolean supportsPermissionRules() {
        return feature("permission-rules/1") && supportsApprovalSelection();
    }

    @Override
    public boolean supportsAgentDefinitionApprovalSelection() {
        return feature("agent-definition-approval-selection/1") && supportsApprovalSelection();
    }

    @Override
    public boolean supportsModelSelection() {
        return feature("model-selection/1");
    }

    @Override
    public boolean supportsUserMessageQueue() { return feature("user-message-queue/1"); }

    @Override
    public boolean supportsContextCompression() {
        return feature("context-compression/1");
    }

    @Override
    public boolean supportsPlanMode() {
        return feature("plan-mode/1");
    }

    @Override
    public boolean supportsInputAttachments() {
        return feature("input-attachments/1");
    }

    @Override
    public boolean supportsSessionSkills() {
        return feature("session-skills/2");
    }

    @Override
    public boolean supportsSessionExtensions() {
        return feature("session-extension-packages/1");
    }

    @Override
    public Map<String, Object> applyExtensions(String tenant, String session, Map<String, Object> command) {
        return call(tenant, session, leaf -> leaf.applyExtensions(tenant, session, command));
    }

    @Override
    public Map<String, Object> continueExtensionOperation(String tenant, String session, String operationId, boolean recoverPrevious) {
        return call(tenant, session, leaf -> leaf.continueExtensionOperation(tenant, session, operationId, recoverPrevious));
    }

    @Override
    public boolean isWorkspaceFilesAvailable() {
        return properties.getHarness().isWorkspaceFilesEnabled();
    }

    @Override
    public boolean supportsFencedTitles() {
        return contract != null && contract.title() == 1;
    }

    @Override
    public boolean supportsLifecycle() {
        return supportsLifecycle(WorkspaceToolProfiles.FILES);
    }

    @Override
    public boolean supportsLifecycle(String profile) {
        if (WorkspaceToolProfiles.EXTERNAL_FILES.equals(profile)) {
            return isWorkspaceFilesAvailable() && supportsSavedLifecycle(profile);
        }
        return contract != null && (WorkspaceToolProfiles.FILES.equals(profile)
                ? isWorkspaceFilesAvailable() && contract.lifecycle() == 1
                : WorkspaceToolProfiles.lifecycleProtocol(profile) == 2 && contract.profiles().contains(profile));
    }

    @Override
    public boolean supportsSavedLifecycle(String profile) {
        return WorkspaceToolProfiles.EXTERNAL_FILES.equals(profile)
                ? contract != null && contract.lifecycle() == 1 && contract.features().contains(WorkspaceToolProfiles.EXTERNAL_FILES)
                : supportsLifecycle(profile);
    }

    @Override
    public List<AttachedSession> attachedSessions() {
        List<AttachedSession> attached = new ArrayList<>();
        for (Member member : members.values()) {
            for (var session : member.connector.attachedSessions()) {
                Placement placement = placements.get(session.tenantId(), session.sessionId());
                if (matches(placement, member) && placement.epoch() == session.placementEpoch()) {
                    attached.add(session);
                }
            }
        }
        return List.copyOf(attached);
    }

    @Override
    public Map<String, Object> drainInstance(String instance, String operationId) {
        Member member = members.values().stream().filter(value -> value.endpoint.instanceId().equals(instance)
                && value.reachable).findFirst().orElseThrow(HarnessPoolConnector::unavailable);
        var receipt = member.client.drainInstance(operationId);
        member.quiescing = true;
        accepting = accepting.stream().filter(value -> value != member).toList();
        return receipt;
    }

    @Override
    public ContextCompressionSubmission prepareContextCompression(String tenant, String session, Map<String, Object> body) {
        Selected selected = select(tenant, session, true);
        var submission = selected.member().connector.withPlacement(selected.call(),
                () -> selected.member().connector.prepareContextCompression(tenant, session, body));
        return () -> selected.member().connector.withPlacement(selected.call(), submission::submit);
    }

    @Override
    public void close() {
        closed = true;
        refreshes.shutdownNow();
        discovery.close();
        members.values().forEach(member -> member.connector.close());
        members.clear();
        accepting = List.of();
    }

    @Override
    public void recoverForWake(String tenant, String session) {
        call(tenant, session, leaf -> {
            leaf.recoverForWake(tenant, session);
            return null;
        });
    }

    @Override
    public Attachment createOrLoad(String tenant, String session, boolean existing) {
        return call(tenant, session, leaf -> leaf.createOrLoad(tenant, session, existing));
    }

    @Override
    public Attachment createOrLoad(String tenant, String session, boolean existing, boolean passive) {
        return call(tenant, session, leaf -> leaf.createOrLoad(tenant, session, existing, passive));
    }

    @Override
    public Attachment recoverManagedRuntime(String tenant, String session, boolean cancellation) {
        return call(tenant, session, leaf -> leaf.recoverManagedRuntime(tenant, session, cancellation));
    }

    @Override
    public Attachment recoverManagedRuntime(String tenant, String session, boolean cancellation, String prompt) {
        return call(tenant, session, leaf -> leaf.recoverManagedRuntime(tenant, session, cancellation, prompt));
    }

    @Override
    public Attachment recoverManagedCancellation(String tenant, String session) {
        return call(tenant, session, leaf -> leaf.recoverManagedCancellation(tenant, session));
    }

    @Override
    public Attachment recoverManagedCancellation(String tenant, String session, String prompt) {
        return call(tenant, session, leaf -> leaf.recoverManagedCancellation(tenant, session, prompt));
    }

    @Override
    public Attachment recoverManagedFailureCancellation(String tenant, String session, String turn, String owner) {
        return call(tenant, session, leaf -> leaf.recoverManagedFailureCancellation(tenant, session, turn, owner));
    }

    @Override
    public Attachment recoverManagedFailureCancellation(String tenant, String session, String turn, String owner, String prompt) {
        return call(tenant, session, leaf -> leaf.recoverManagedFailureCancellation(tenant, session, turn, owner, prompt));
    }

    @Override
    public Admission submit(String tenant, String session, String prompt, List<Map<String, Object>> input, String digest) {
        return call(tenant, session, leaf -> leaf.submit(tenant, session, prompt, input, digest));
    }

    @Override
    public Admission continueManagedRuntime(String tenant, String session, String prompt, String checkpoint, String activation) {
        return call(tenant, session, leaf -> leaf.continueManagedRuntime(tenant, session, prompt, checkpoint, activation));
    }

    @Override
    public Admission cancelManagedRuntime(String tenant, String session, String prompt, String checkpoint, String activation) {
        return call(tenant, session, leaf -> leaf.cancelManagedRuntime(tenant, session, prompt, checkpoint, activation));
    }

    @Override
    public SourceStream stream(String tenant, String session, long last, String epoch) {
        return call(tenant, session, leaf -> leaf.stream(tenant, session, last, epoch));
    }

    @Override
    public void resolveAction(String tenant, String session, String action, JsonNode response) {
        call(tenant, session, leaf -> {
            leaf.resolveAction(tenant, session, action, response);
            return null;
        });
    }

    @Override
    public void cancel(String tenant, String session) {
        call(tenant, session, leaf -> {
            leaf.cancel(tenant, session);
            return null;
        });
    }

    @Override
    public void cancelOriginalTurn(String tenant, String session, String prompt) {
        call(tenant, session, leaf -> {
            leaf.cancelOriginalTurn(tenant, session, prompt);
            return null;
        });
    }

    @Override
    public Map<String, Object> runAutomationOperation(String tenant, String session, Map<String, Object> body) {
        return call(tenant, session, leaf -> leaf.runAutomationOperation(tenant, session, body));
    }

    @Override
    public void runChildOperation(String tenant, String session, Map<String, Object> body) {
        call(tenant, session, leaf -> {
            leaf.runChildOperation(tenant, session, body);
            return null;
        });
    }

    @Override
    public Map<String, Object> runMessageOperation(String tenant, String session, Map<String, Object> body) {
        return call(tenant, session, leaf -> leaf.runMessageOperation(tenant, session, body));
    }

    @Override
    public Map<String, Object> runChannelOperation(String tenant, String session, Map<String, Object> body) {
        return call(tenant, session, leaf -> leaf.runChannelOperation(tenant, session, body));
    }

    @Override
    public void rename(String tenant, String session, String title) {
        call(tenant, session, leaf -> {
            leaf.rename(tenant, session, title);
            return null;
        });
    }

    @Override
    public void rename(String tenant, String session, String title, long revision) {
        call(tenant, session, leaf -> {
            leaf.rename(tenant, session, title, revision);
            return null;
        });
    }

    @Override
    public String closeSession(OperationRecord operation) {
        return lifecycleCall(operation, leaf -> leaf.closeSession(operation.tenantId(), operation.sessionId()));
    }

    @Override
    public void runLifecycleChildOperation(OperationRecord operation, Map<String, Object> body) {
        lifecycleCall(operation, leaf -> {
            leaf.runLifecycleChildOperation(operation, body);
            return null;
        });
    }

    @Override
    public String closeSession(String tenant, String session) {
        return call(tenant, session, leaf -> leaf.closeSession(tenant, session));
    }

    @Override
    public boolean activateForWake(String tenant, String session) {
        return call(tenant, session, leaf -> leaf.activateForWake(tenant, session));
    }

    @Override
    public Map<String, Object> runContextCompression(String tenant, String session, Map<String, Object> body) {
        return call(tenant, session, leaf -> leaf.runContextCompression(tenant, session, body));
    }

    @Override
    public Map<String, Object> readContextCompression(String tenant, String session, String operation) {
        return call(tenant, session, leaf -> leaf.readContextCompression(tenant, session, operation));
    }

    @Override
    public Map<String, Object> releaseOwnership(String tenant, String session,
            String operation, long expectedPlacementEpoch) {
        Map<String, Object> committed = placements.releaseReceipt(tenant, session, expectedPlacementEpoch, operation);
        if (committed != null) {
            return committed;
        }
        Selected selected = select(tenant, session, false);
        if (selected == null || selected.placement().epoch() != expectedPlacementEpoch) {
            throw new IllegalStateException("Original Harness placement is unavailable");
        }
        return selected.member().connector.withPlacement(selected.call(),
                () -> selected.member().connector.releaseOwnership(
                        tenant, session, operation, expectedPlacementEpoch));
    }

    @Override
    public boolean recheckRecoveryCleanup(String tenant, String session, String prompt) {
        return call(tenant, session, leaf -> leaf.recheckRecoveryCleanup(tenant, session, prompt));
    }

    @Override
    public JsonNode settleLifecycle(OperationRecord operation) {
        return lifecycleCall(operation, leaf -> leaf.settleLifecycle(operation));
    }

    @Override
    public void prepareLifecycleResources(OperationRecord operation) {
        lifecycleCall(operation, leaf -> {
            leaf.prepareLifecycleResources(operation);
            return null;
        });
    }

    @Override
    public void settleLifecycleResources(OperationRecord operation) {
        lifecycleCall(operation, leaf -> {
            leaf.settleLifecycleResources(operation);
            return null;
        });
    }

    @Override
    public void detachLifecycle(OperationRecord operation) {
        lifecycleCall(operation, leaf -> {
            leaf.detachLifecycle(operation);
            return null;
        });
    }

    @Override
    public void discardManagedRecovery(String tenant, String session) {
        observe(tenant, session, null, leaf -> {
            leaf.discardManagedRecovery(tenant, session);
            return null;
        });
    }

    @Override
    public RecoveryStatus inspectRecovery(String tenant, String session, String prompt) {
        return observe(tenant, session, null, leaf -> leaf.inspectRecovery(tenant, session, prompt));
    }

    @Override
    public Attachment cachedRecoveryAttachment(String tenant, String session) {
        return observe(tenant, session, null, leaf -> leaf.cachedRecoveryAttachment(tenant, session));
    }

    @Override
    public SourceStream observeStream(String tenant, String session, String boot, long last, String epoch) {
        SourceStream stream = observe(tenant, session, null, leaf -> leaf.observeStream(tenant, session, boot, last, epoch));
        if (stream == null) {
            throw unavailable();
        }
        return stream;
    }
}
