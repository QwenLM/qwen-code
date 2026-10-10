package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.CancelManagedRuntime;
import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonApprovalMode;
import com.alibaba.qwen.code.daemon.DaemonEvent;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.daemon.ManagedSessionStoreConnection;
import com.alibaba.qwen.code.daemon.PromptReceipt;
import com.alibaba.qwen.code.daemon.SessionCreationOutcomeUnknownException;
import com.alibaba.qwen.code.daemon.StreamHarnessEvents;
import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.WriterCredentialPolicy;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import com.fasterxml.jackson.databind.JsonNode;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;

public class QwenHostedHarnessConnector implements HarnessConnector {
    private final ManagedAgentProperties.Harness properties;
    private final ManagedAgentProperties.SessionStore sessionStore;
    private final String workspaceId;
    private final AgentStateStore sessions;
    private final WorkspaceExecutionStore workspaceExecution;
    private final DaemonApprovalMode approvalMode;
    private final ManagedActionStore actions;
    private final WriterCredentialPolicy credentials;
    /** #13753 I2: this control plane serves child Workspaces (startup checks the shape). */
    private final boolean childWorkspaces;
    private volatile HostedHarnessClient client;
    private final ReentrantLock clientLock = new ReentrantLock();
    // Sessions whose takeover load reported parked Runtime work that no
    // continue/cancel has been admitted for yet.
    private final Set<AttachmentKey> pendingRecovery =
            ConcurrentHashMap.newKeySet();
    private final Map<AttachmentKey, HarnessSessionRef> attachments =
            new ConcurrentHashMap<>();
    // Single flight for the first attachment of a Session. computeIfAbsent
    // would run the blocking Harness call under the map bin monitor, which
    // pins the caller virtual thread to its carrier on JDK 21. Entries are
    // reference-counted and dropped when their last caller leaves, so the
    // map drains with each burst instead of growing with Session churn.
    private final Map<AttachmentKey, AttachmentLock> attachmentLocks =
            new ConcurrentHashMap<>();

    public QwenHostedHarnessConnector(ManagedAgentProperties properties,
            AgentStateStore sessions, WorkspaceExecutionStore workspaceExecution) {
        this(properties, sessions, workspaceExecution, null);
    }

    public QwenHostedHarnessConnector(
            ManagedAgentProperties properties,
            AgentStateStore sessions,
            WorkspaceExecutionStore workspaceExecution,
            ManagedActionStore actions) {
        this.properties = properties.getHarness();
        this.sessionStore = properties.getSessionStore();
        this.workspaceId = sessionStore.getWorkspaceId();
        this.sessions = sessions;
        this.actions = actions;
        this.workspaceExecution = workspaceExecution;
        this.credentials = new WriterCredentialPolicy(properties);
        this.childWorkspaces = properties.getRuntimeBroker().isChildWorkspacesEnabled();
        if (this.properties.getToken() == null
                || this.properties.getToken().isBlank()
                || this.properties.getCapabilityDigest() == null
                || this.properties.getCapabilityDigest().isBlank()) {
            throw new IllegalStateException("Enabled Hosted Harness requires"
                    + " token and capability digest");
        }
        URI.create(this.properties.getBaseUrl());
        // The load timeout is operator-settable, so a bad value must fail
        // here: the client builder rejects it, and failing lazily inside
        // client() would surface as an endless transient retry that logs
        // only the exception class.
        Duration loadTimeout = this.properties.getLoadTimeout();
        if (loadTimeout == null || loadTimeout.isZero()
                || loadTimeout.isNegative()) {
            throw new IllegalStateException("Enabled Hosted Harness requires"
                    + " a positive load-timeout");
        }
        if (sessionStore.isEnabled()
                && (sessionStore.getBaseUrl() == null
                        || sessionStore.getBaseUrl().isBlank()
                        || workspaceId == null || workspaceId.isBlank())) {
            throw new IllegalStateException("Enabled Managed Session Store"
                    + " requires base URL and Runtime workspace ID");
        }
        String runtimeWorkspaceId = properties.getRuntimeBroker()
                .getWorkspaceId();
        if (sessionStore.isEnabled() && runtimeWorkspaceId != null
                && !runtimeWorkspaceId.isBlank()
                && !workspaceId.equals(runtimeWorkspaceId)) {
            throw new IllegalStateException("Managed Session Store and"
                    + " Runtime Broker workspace IDs must match");
        }
        Duration turnDeadline = this.properties.getTurnDeadline();
        if (turnDeadline == null
                || turnDeadline.compareTo(Duration.ofMillis(1)) < 0
                || turnDeadline.compareTo(
                        Duration.ofMillis(Integer.MAX_VALUE)) > 0) {
            throw new IllegalStateException("Hosted Harness turn deadline must"
                    + " be between 1 and 2147483647 milliseconds");
        }
        this.approvalMode = parseApprovalMode(
                this.properties.getApprovalMode());
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public boolean supportsFencedTitles() {
        try {
            return client().capabilities().getTitleProtocolVersion() == 1;
        } catch (com.alibaba.qwen.code.daemon.DaemonException
                | IllegalStateException unavailable) {
            return false;
        }
    }

    @Override
    public boolean supportsLifecycle() {
        if (!isWorkspaceFilesAvailable()) {
            return false;
        }
        try {
            return client().capabilities().getLifecycleProtocolVersion() == 1;
        } catch (com.alibaba.qwen.code.daemon.DaemonException
                | IllegalStateException unavailable) {
            return false;
        }
    }

    @Override
    public com.fasterxml.jackson.databind.JsonNode settleLifecycle(
            com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord operation) {
        try {
            return doSettleLifecycle(operation);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private com.fasterxml.jackson.databind.JsonNode doSettleLifecycle(
            com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord operation) {
        SessionRecord session = sessions.requireSession(operation.tenantId(), operation.sessionId());
        AttachmentKey key = new AttachmentKey(operation.tenantId(), operation.sessionId());
        HarnessSessionRef ref = attachments.get(key);
        if (ref == null) {
            ref = client().loadSession(new LoadHarnessSession(session.sessionId(), managedSessionStore(session),
                    false, toolProfile(session), false).withChildWorkspaces(childWorkspaces)
                    .forLifecycle(operation.operationId(), operation.claimGeneration()));
            attachments.put(key, ref);
        }
        var authority = Map.<String, Object>of("operationId", operation.operationId(), "claimGeneration", operation.claimGeneration());
        var request = Map.<String, Object>of("sessionKey", Map.of("tenantId", session.tenantId(),
                "workspaceId", session.workspace().getWorkspaceId(), "sessionId", session.sessionId()),
                "kind", operation.kind().name().toLowerCase(java.util.Locale.ROOT), "authority", authority);
        return new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(client().settleLifecycle(ref, request));
    }

    @Override
    public void detachLifecycle(com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord operation) {
        try {
            doDetachLifecycle(operation);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private void doDetachLifecycle(com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord operation) {
        AttachmentKey key = new AttachmentKey(operation.tenantId(), operation.sessionId());
        HarnessSessionRef ref = attachments.get(key);
        try {
            var authority = Map.<String, Object>of("operationId", operation.operationId(), "claimGeneration", operation.claimGeneration());
            if (ref == null) {
                client().detachLifecycle(operation.sessionId(), authority);
            } else {
                client().detachLifecycle(ref, authority);
            }
        } catch (DaemonHttpException error) {
            if (error.getStatusCode() != 404) {
                throw error;
            }
        }
        attachments.remove(key);
        pendingRecovery.remove(key);
    }

    @Override
    public boolean isWorkspaceFilesAvailable() {
        return properties.isWorkspaceFilesEnabled();
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting) {
        return createOrLoad(tenantId, sessionId, loadExisting, false);
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting, boolean passiveManagedRuntimeRecovery) {
        try {
            return doCreateOrLoad(tenantId, sessionId, loadExisting,
                    passiveManagedRuntimeRecovery, false);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private Attachment doCreateOrLoad(String tenantId, String sessionId,
            boolean loadExisting, boolean passiveManagedRuntimeRecovery,
            boolean actionResponse) {
        SessionRecord session = sessions.requireSession(tenantId, sessionId);
        if (session.workspace() != null) {
            if (!isWorkspaceFilesAvailable()) {
                throw new IllegalStateException("Hosted Workspace files are disabled");
            }
            if (actions == null) {
                throw new IllegalStateException("Hosted Workspace Sessions"
                        + " require the Managed Action store");
            }
            if (actionResponse) {
                workspaceExecution.authorizeActionResponse(session);
                if (!passiveManagedRuntimeRecovery) {
                    workspaceExecution.verifyMountForProbe(session.workspace());
                }
            } else if (passiveManagedRuntimeRecovery && loadExisting) {
                workspaceExecution.authorizePassiveAttachment(session);
            } else {
                workspaceExecution.authorize(session);
            }
        }
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef attached = passiveManagedRuntimeRecovery && loadExisting
                ? load(session, true) : attachments.get(key);
        if (attached == null) {
            AttachmentLock slot = attachmentLocks.compute(key,
                    (ignored, held) -> {
                        AttachmentLock next = held == null
                                ? new AttachmentLock() : held;
                        next.holders++;
                        return next;
                    });
            slot.lock.lock();
            try {
                attached = attachments.get(key);
                if (attached == null) {
                    attached = loadExisting ? load(session, passiveManagedRuntimeRecovery)
                            : create(session, passiveManagedRuntimeRecovery);
                    attachments.put(key, attached);
                }
            } finally {
                slot.lock.unlock();
                attachmentLocks.compute(key, (ignored, held) ->
                        --held.holders == 0 ? null : held);
            }
        }
        if (session.workspace() != null
                && !actions.approvalMode(tenantId, sessionId).equals(attached.getApprovalMode())) {
            attachments.remove(key);
            throw new IllegalStateException(
                    "Hosted Harness did not confirm the Session approval mode");
        }
        attachments.put(key, attached);
        // A passive re-attach (rename / close / the adoptGeneration notices)
        // carries the takeover recovery snapshot exactly like the
        // recovery-load path that re-mints it: restore the pending marker
        // or the next dispatch's cached branch answers "nothing parked"
        // over the snapshot it still holds (R11-3). The marker is safe
        // here: it was minted under the live boot, so a boot-identity
        // eviction drops the attachment itself first.
        if (attached.getRuntimeRecovery() != null) {
            pendingRecovery.add(key);
        } else {
            pendingRecovery.remove(key);
        }
        return new Attachment(attached.getHarnessBootId(),
                attached.getRuntimeRecovery(),
                attached.getHarnessLastEventId(),
                attached.getHarnessEventEpoch());
    }

    @Override
    public Admission submit(String tenantId, String sessionId,
            String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        try {
            return doSubmit(tenantId, sessionId, promptId, input,
                    payloadDigest);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private Admission doSubmit(String tenantId, String sessionId,
            String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        requireReadyForNewWork(tenantId, sessionId, false);
        SubmitHarnessTurn.Builder builder = SubmitHarnessTurn.builder()
                .session(attachment(tenantId, sessionId, true))
                .promptId(promptId)
                .payloadDigest(payloadDigest)
                .deadline(properties.getTurnDeadline());
        input.forEach(builder::addContent);
        PromptReceipt receipt = client().submitTurn(builder.build());
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public Admission continueManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        try {
            return doContinueManagedRuntime(tenantId, sessionId, promptId,
                    checkpointId, activationId);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private Admission doContinueManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        requireReadyForNewWork(tenantId, sessionId, false);
        // Resolve the attachment BEFORE fetching the client: the resolution
        // may block on a create/load round trip, and an adoption closing the
        // captured client during that window would strand this call on a
        // dead instance instead of the rebuilt one.
        HarnessSessionRef ref = attachment(tenantId, sessionId, true);
        PromptReceipt receipt = client().continueManagedRuntime(
                ref, promptId, checkpointId, activationId);
        pendingRecovery.remove(new AttachmentKey(tenantId, sessionId));
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public Admission cancelManagedRuntime(String tenantId, String sessionId,
            String promptId, String checkpointId, String activationId) {
        try {
            return doCancelManagedRuntime(tenantId, sessionId, promptId,
                    checkpointId, activationId);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private Admission doCancelManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        HarnessSessionRef ref = cancellationAttachment(tenantId, sessionId);
        PromptReceipt receipt = client().cancelManagedRuntime(
                new CancelManagedRuntime(ref,
                        promptId, checkpointId, activationId));
        pendingRecovery.remove(new AttachmentKey(tenantId, sessionId));
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public SourceStream stream(String tenantId, String sessionId,
            long lastEventId,
            String eventEpoch) {
        try {
            return doStream(tenantId, sessionId, lastEventId, eventEpoch);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private SourceStream doStream(String tenantId, String sessionId,
            long lastEventId, String eventEpoch) {
        HarnessSessionRef ref = attachment(tenantId, sessionId, false);
        HarnessEventStream stream = client().streamEvents(
                StreamHarnessEvents.builder()
                        .session(ref)
                        .lastEventId(lastEventId)
                        .eventEpoch(eventEpoch)
                        .build());
        return new SourceStream() {
            @Override
            public String eventEpoch() {
                return stream.getEventEpoch();
            }

            @Override
            public SourceEvent next() {
                DaemonEvent event = stream.next();
                return event == null ? null : new SourceEvent(event.getId(),
                        event.getType(), event.getData(),
                        event.getPromptId(), event.getMetadata());
            }

            @Override
            public void close() {
                stream.close();
            }
        };
    }

    @Override
    public void resolveAction(
            String tenantId,
            String sessionId,
            String actionId,
            JsonNode response) {
        try {
            doResolveAction(tenantId, sessionId, actionId, response);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private void doResolveAction(
            String tenantId,
            String sessionId,
            String actionId,
            JsonNode response) {
        SessionRecord session = requireReadyForNewWork(tenantId, sessionId, true);
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef ref = attachments.get(key);
        if (ref == null) {
            // A resident Harness refuses an ordinary load after the dispatcher loses its cache.
            doCreateOrLoad(tenantId, sessionId, true,
                    session.workspace() != null || workspaceExecution.verifiedRecoveryEnabled(), true);
            ref = attachments.get(key);
        }
        client().resolveAction(
                        ref,
                        actionId,
                        response.path("optionId").asText(),
                        response.path("inputRevision").asLong(),
                        response.path("policyRevision").asText());
    }

    @Override
    public void cancel(String tenantId, String sessionId) {
        try {
            doCancel(tenantId, sessionId);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private void doCancel(String tenantId, String sessionId) {
        HarnessSessionRef ref = cancellationAttachment(tenantId, sessionId);
        client().cancelTurn(ref);
        pendingRecovery.remove(new AttachmentKey(tenantId, sessionId));
    }

    @Override
    public void rename(String tenantId, String sessionId, String title) {
        try {
            doRename(tenantId, sessionId, title);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    @Override
    public void rename(String tenantId, String sessionId, String title, long revision) {
        try {
            HarnessSessionRef ref = attachment(tenantId, sessionId, false);
            client().updateSessionTitle(ref, title, revision);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private void doRename(String tenantId, String sessionId, String title) {
        HarnessSessionRef ref = attachment(tenantId, sessionId, false);
        client().updateSessionTitle(ref, title);
    }

    @Override
    public Map<String, Object> runAutomationOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        try {
            // Automation operations drive new work (a fire admits an input
            // and wakes a turn), so a cached attachment is no admission:
            // the Workspace checks submit and continueManagedRuntime run
            // apply to every relay.
            requireReadyForNewWork(tenantId, sessionId, false);
            reattachTakenOver(tenantId, sessionId);
            // Resolve the attachment BEFORE fetching the client: the
            // resolution may block on a create/load round trip, and an
            // adoption closing the captured client during that window
            // would strand this call on a dead instance instead of the
            // rebuilt one (the ordering doContinueManagedRuntime follows).
            HarnessSessionRef ref = attachment(tenantId, sessionId, true);
            return client().runAutomationOperation(ref, body);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    @Override
    public void runChildOperation(String tenantId, String sessionId,
            Map<String, Object> body) {
        try {
            // Same ordering as the automation relay: the attachment
            // resolves first, the client reads after it.
            HarnessSessionRef ref = attachment(tenantId, sessionId, true);
            client().runChildOperation(ref, body);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    @Override
    public void runMessageOperation(String tenantId, String sessionId,
            Map<String, Object> body) {
        try {
            // A receipt admits an input and wakes a turn in its target, and
            // the consume reconciliation reloads a Session whose wake pump
            // then runs the waiting input: both drive new work, so they take
            // the automation relay's Workspace checks. The sender's own
            // steps are journal writes. Every verb re-attaches a Session a
            // prior control-plane process attached, since the relay's
            // ledger outlives that process.
            Object kind = body.get("kind");
            if ("stop".equals(kind)) {
                // Resolve the attachment before fetching the client: the
                // load can adopt a new generation, which closes the old one.
                HarnessSessionRef ref = messageStopAttachment(tenantId,
                        sessionId);
                client().runMessageOperation(ref, body);
                return;
            }
            if ("receive".equals(kind) || "consume".equals(kind)) {
                requireReadyForNewWork(tenantId, sessionId, false);
            }
            reattachTakenOver(tenantId, sessionId);
            HarnessSessionRef ref = attachment(tenantId, sessionId, true);
            client().runMessageOperation(ref, body);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    /**
     * H4f × H4d-b: the attachment a stopped run's message stop goes
     * through. A Session this process does not hold is loaded with its
     * message inputs already stopped, so the load's wake pump never starts
     * one before the stop arrives; a Session an earlier process attached
     * re-attaches passively, driving nothing. It is authorized by the
     * committed stop its caller read, not by a CANCELLING Turn (message
     * work never makes one) or a grant that may have changed since.
     */
    private HarnessSessionRef messageStopAttachment(String tenantId,
            String sessionId) {
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef cached = attachments.get(key);
        if (cached != null) {
            return cached;
        }
        SessionRecord session = sessions.requireSession(tenantId, sessionId);
        if (session.workspace() != null) {
            if (!isWorkspaceFilesAvailable()) {
                throw new IllegalStateException("Hosted Workspace files are disabled");
            }
            if (actions == null) {
                throw new IllegalStateException("Hosted Workspace Sessions"
                        + " require the Managed Action store");
            }
            workspaceExecution.authorizeCommittedStop(session);
        }
        HarnessSessionRef attached = client().loadSession(
                new LoadHarnessSession(session.sessionId(),
                        managedSessionStore(session),
                        session.harnessBootId() != null, toolProfile(session),
                        false, false).withChildWorkspaces(childWorkspaces)
                        .withStoppedMessages());
        if (session.workspace() != null && !actions.approvalMode(tenantId,
                sessionId).equals(attached.getApprovalMode())) {
            throw new IllegalStateException(
                    "Hosted Harness did not confirm the Session approval mode");
        }
        attachments.put(key, attached);
        if (attached.getRuntimeRecovery() != null) {
            pendingRecovery.add(key);
        } else {
            pendingRecovery.remove(key);
        }
        return attached;
    }

    /**
     * A Session a prior control-plane process attached: a plain load
     * answers hosted_session_already_attached until the Harness evicts it,
     * so re-attach through the takeover load a Turn uses
     * (HarnessCoordinator.runClaimed).
     */
    private void reattachTakenOver(String tenantId, String sessionId) {
        if (!attachments.containsKey(new AttachmentKey(tenantId, sessionId))
                && sessions.requireSession(tenantId, sessionId)
                        .harnessBootId() != null) {
            recoverManagedRuntime(tenantId, sessionId, false);
        }
    }

    @Override
    public Map<String, Object> runChannelOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        try {
            requireReadyForNewWork(tenantId, sessionId, false);
            return client().runChannelOperation(
                    channelAttachment(tenantId, sessionId), body);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    @Override
    public String closeSession(String tenantId, String sessionId) {
        try {
            return doCloseSession(tenantId, sessionId);
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private String doCloseSession(String tenantId, String sessionId) {
        attachments.remove(new AttachmentKey(tenantId, sessionId));
        pendingRecovery.remove(new AttachmentKey(tenantId, sessionId));
        HostedHarnessClient current = client();
        current.closeSession(sessionId);
        // The client rejects an answer from any other boot.
        return current.capabilities().getBootId();
    }

    @Override
    public void close() {
        HostedHarnessClient current = client;
        if (current != null) {
            current.close();
        }
        attachments.clear();
        pendingRecovery.clear();
    }

    /**
     * A channel route's Session is created without input, so the Harness
     * holds no journal for it until its first channel operation: create it
     * then. A Session the Harness already holds answers the create with 409,
     * which create() turns into a load.
     */
    private HarnessSessionRef channelAttachment(String tenantId,
            String sessionId) {
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef attachment = attachments.get(key);
        if (attachment == null) {
            SessionRecord session = sessions.requireSession(tenantId,
                    sessionId);
            try {
                createOrLoad(tenantId, sessionId,
                        session.harnessBootId() != null, false);
            } catch (DaemonHttpException error) {
                // The Harness still holds the Session this control plane
                // attached before it restarted: re-take it passively, the
                // way the other cold attachments re-acquire a live one.
                if (error.getStatusCode() != 409) {
                    throw error;
                }
                createOrLoad(tenantId, sessionId, true, true);
            }
            attachment = attachments.get(key);
        }
        return attachment;
    }

    private HarnessSessionRef attachment(String tenantId, String sessionId, boolean newWork) {
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef attachment = attachments.get(key);
        if (attachment == null) {
            createOrLoad(tenantId, sessionId, true,
                    !newWork && workspaceExecution.verifiedRecoveryEnabled());
            attachment = attachments.get(key);
        }
        return attachment;
    }

    private HarnessSessionRef cancellationAttachment(String tenantId, String sessionId) {
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef attached = attachments.get(key);
        if (attached == null) {
            recoverManagedRuntime(tenantId, sessionId, true);
            attached = attachments.get(key);
        }
        return attached;
    }

    private SessionRecord requireReadyForNewWork(String tenantId, String sessionId, boolean actionResponse) {
        SessionRecord session = sessions.requireSession(tenantId, sessionId);
        if (session.workspace() != null) {
            if (!isWorkspaceFilesAvailable()) {
                throw new IllegalStateException("Hosted Workspace files are disabled");
            }
            if (actionResponse) {
                workspaceExecution.authorizeActionResponse(session);
                workspaceExecution.verifyMountForProbe(session.workspace());
            } else {
                workspaceExecution.authorize(session);
            }
        }
        return session;
    }

    private HarnessSessionRef create(SessionRecord session, boolean passiveManagedRuntimeRecovery) {
        try {
            CreateHarnessSession.Builder builder =
                    CreateHarnessSession.builder()
                            .harnessSessionId(session.sessionId())
                            .approvalMode(
                                    session.workspace() == null
                                            ? approvalMode
                                            : parseApprovalMode(
                                                    actions.approvalMode(
                                                            session.tenantId(),
                                                            session.sessionId())))
                            .approvalTimeoutMs(properties.getApprovalTimeout().toMillis())
                            .toolProfile(toolProfile(session))
                            .childWorkspaces(childWorkspaces);
            ManagedSessionStoreConnection store = managedSessionStore(
                    session);
            if (store != null) {
                builder.managedSessionStore(store);
            }
            StoreModels.SessionLineage lineage = sessions.findChildLineage(
                    session.tenantId(), session.sessionId());
            if (lineage != null) {
                builder.lineage(lineage.parentSessionId(),
                        lineage.rootSessionId(), lineage.parentChildRunId(),
                        lineage.depth());
            }
            return client().createSession(builder.build());
        } catch (DaemonHttpException error) {
            if (error.getStatusCode() != 409) {
                throw error;
            }
            return load(session, passiveManagedRuntimeRecovery);
        } catch (SessionCreationOutcomeUnknownException error) {
            return load(session, passiveManagedRuntimeRecovery);
        }
    }

    private HarnessSessionRef load(SessionRecord session,
            boolean passiveManagedRuntimeRecovery) {
        return load(session, passiveManagedRuntimeRecovery, false);
    }

    private HarnessSessionRef load(SessionRecord session,
            boolean passiveManagedRuntimeRecovery,
            boolean driveRuntimeRecovery) {
        return load(session, passiveManagedRuntimeRecovery,
                driveRuntimeRecovery, false);
    }

    private HarnessSessionRef load(SessionRecord session,
            boolean passiveManagedRuntimeRecovery,
            boolean driveRuntimeRecovery, boolean cancellationTakeover) {
        String profile = toolProfile(session);
        ManagedSessionStoreConnection store = managedSessionStore(session);
        return client().loadSession(new LoadHarnessSession(session.sessionId(), store,
                passiveManagedRuntimeRecovery, profile,
                driveRuntimeRecovery, cancellationTakeover)
                .withChildWorkspaces(childWorkspaces));
    }

    @Override
    public Attachment recoverManagedRuntime(String tenantId, String sessionId,
            boolean cancellation) {
        try {
            return doRecoverManagedRuntime(tenantId, sessionId,
                    cancellation);
        } catch (DaemonHttpException error) {
            // The one place a daemon error code is read: a takeover refusal
            // that can never change under retry is terminal, not retriable.
            if (error.getStatusCode() == 409
                    && HostedHarnessRecoveryDeclinedException.CODE.equals(
                            error.getErrorCode())) {
                throw new HostedHarnessRecoveryDeclinedException(
                        error.getBodyField("reason"));
            }
            throw error;
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    @Override
    public Attachment recoverManagedCancellation(String tenantId,
            String sessionId) {
        try {
            return doRecoverManagedCancellation(tenantId, sessionId);
        } catch (DaemonHttpException error) {
            // The same takeover-refusal mapping as recoverManagedRuntime.
            if (error.getStatusCode() == 409
                    && HostedHarnessRecoveryDeclinedException.CODE.equals(
                            error.getErrorCode())) {
                throw new HostedHarnessRecoveryDeclinedException(
                        error.getBodyField("reason"));
            }
            throw error;
        } catch (HostedHarnessGenerationException error) {
            adoptGeneration(error);
            throw error;
        }
    }

    private Attachment doRecoverManagedCancellation(String tenantId,
            String sessionId) {
        SessionRecord session = requireRecoverableSession(tenantId, sessionId,
                true);
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        // A Session THIS Harness already serves can still park a dead
        // generation's Turn: the plain cancel route settles nothing there
        // and answered the coded refusal, so the cancellation load always
        // goes out — the redispatch path's healthy-attachment shortcut
        // would swallow it. The fresh ref replaces the cached entry.
        HarnessSessionRef attached = load(session, true, false, true);
        attachments.put(key, attached);
        if (attached.getRuntimeRecovery() != null) {
            pendingRecovery.add(key);
        } else {
            pendingRecovery.remove(key);
        }
        return new Attachment(attached.getHarnessBootId(),
                pendingRecovery.contains(key) ? attached.getRuntimeRecovery()
                        : null,
                attached.getHarnessLastEventId(),
                attached.getHarnessEventEpoch());
    }

    private SessionRecord requireRecoverableSession(String tenantId,
            String sessionId, boolean cancellation) {
        SessionRecord session = sessions.requireSession(tenantId, sessionId);
        if (session.workspace() != null) {
            if (!isWorkspaceFilesAvailable()) {
                throw new IllegalStateException("Hosted Workspace files are disabled");
            }
            if (actions == null) {
                throw new IllegalStateException("Hosted Workspace Sessions"
                        + " require the Managed Action store");
            }
            if (cancellation) {
                workspaceExecution.authorizeCancellation(session);
            } else {
                workspaceExecution.authorize(session);
            }
        }
        return session;
    }

    private Attachment doRecoverManagedRuntime(String tenantId,
            String sessionId, boolean cancellation) {
        SessionRecord session = requireRecoverableSession(tenantId, sessionId,
                cancellation);
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef cached = attachments.get(key);
        if (cached == null) {
            HarnessSessionRef attached = load(session, cancellation,
                    !cancellation, cancellation);
            attachments.put(key, attached);
            if (attached.getRuntimeRecovery() != null) {
                pendingRecovery.add(key);
            } else {
                pendingRecovery.remove(key);
            }
            cached = attached;
        } else {
            // A Session this Harness already serves is healthy, not parked on
            // a dead owner: reuse the attachment instead of re-loading it.
        }
        if (session.workspace() != null
                && !actions.approvalMode(tenantId, sessionId).equals(cached.getApprovalMode())) {
            attachments.remove(key);
            pendingRecovery.remove(key);
            throw new IllegalStateException(
                    "Hosted Harness did not confirm the Session approval mode");
        }
        // The snapshot of the takeover load that created the attachment is
        // handed out again only until its continue or cancel has been
        // admitted; after that a re-entered Turn just resumes its stream.
        return new Attachment(cached.getHarnessBootId(),
                pendingRecovery.contains(key) ? cached.getRuntimeRecovery()
                        : null,
                cached.getHarnessLastEventId(),
                cached.getHarnessEventEpoch());
    }

    private static String toolProfile(SessionRecord session) {
        if (session.workspace() == null) {
            return null;
        }
        if (session.toolProfile() == null || session.toolProfile().isBlank()) {
            throw new IllegalStateException("Hosted Workspace Session tool profile is missing");
        }
        return session.toolProfile();
    }

    private ManagedSessionStoreConnection managedSessionStore(
            SessionRecord session) {
        if (!sessionStore.isEnabled()) {
            return null;
        }
        String workspace = session.workspace() == null ? workspaceId
                : session.workspace().getWorkspaceId();
        ManagedSessionStoreConnection.Builder builder =
                ManagedSessionStoreConnection.builder()
                        .baseUri(URI.create(sessionStore.getBaseUrl()))
                        .tenantId(session.tenantId())
                        .workspaceId(workspace)
                        .writerId(client().capabilities().getBootId())
                        .leaseDuration(
                                sessionStore.getWriterLeaseDuration())
                        .allowInsecureHttp(
                                sessionStore.isAllowInsecureHttp());
        if (credentials.isBound()) {
            builder.writerToken(credentials.issue(session.tenantId(),
                    workspace, session.sessionId()));
        }
        return builder.build();
    }

    private HostedHarnessClient client() {
        HostedHarnessClient current = client;
        if (current != null) {
            return current;
        }
        // A ReentrantLock, not a monitor: the first build blocks on the
        // capabilities round trip, and callers waiting to enter a monitor
        // pin their virtual-thread carriers on JDK 21 while AQS waiters
        // unmount.
        clientLock.lock();
        try {
            current = client;
            if (current == null) {
                current = createClient();
                client = current;
            }
            return current;
        } finally {
            clientLock.unlock();
        }
    }

    // Package-private so the adoption race test substitutes the
    // replacement instead of standing up a live /capabilities call.
    HostedHarnessClient createClient() {
        return HostedHarnessClient.builder()
                .baseUri(URI.create(properties.getBaseUrl()))
                .bearerToken(properties.getToken())
                .capabilityDigest(properties.getCapabilityDigest())
                .connectTimeout(properties.getConnectTimeout())
                .requestTimeout(properties.getRequestTimeout())
                .loadTimeout(properties.getLoadTimeout())
                .heartbeatInterval(properties.getHeartbeatInterval())
                .build();
    }

    /**
     * G3: instead of pinning every bound Session to one dead Harness
     * process, a live control plane adopts the next generation. The next
     * {@link #client()} call renegotiates, so a capability change fails
     * closed at the boundary instead of masking it. The connector monitor
     * only guards the client handoff and never wraps the map churn (a
     * {@code ConcurrentHashMap.computeIfAbsent} bin lock is held across an
     * in-flight load, so clearing maps under the monitor would invert the
     * lock order and could deadlock). The handoff does build the
     * replacement under the monitor, so a renegotiation blocks other
     * Sessions' attaches for at most its connect + request timeouts —
     * bounded, unlike the in-flight load it replaced.
     * <p>
     * Cached Attachments re-mint on demand, and both branches evict by
     * boot identity rather than by clearing: only entries
     * minted under the boot now serving stay, so a stale ref cannot
     * retry-loop on itself, entries a concurrent rebuild already minted
     * survive, and Sessions the live client still heartbeats keep working.
     * Recovery markers follow their attachment, because a marker outliving
     * an evicted attachment is what makes the recovery path hand out a
     * null report.
     */
    private void adoptGeneration(HostedHarnessGenerationException error) {
        HostedHarnessClient stale = null;
        boolean dropped = false;
        synchronized (this) {
            HostedHarnessClient current = client;
            if (current == null) {
                return;
            }
            if (!error.getActualBootId().equals(
                    current.capabilities().getBootId())) {
                client = null;
                stale = current;
                dropped = true;
            }
        }
        // No map work under the monitor: a computeIfAbsent bin lock is
        // held across an in-flight load elsewhere, so touching either map
        // while holding `this` inverts the lock order. Evicting by boot
        // identity instead of clearing also keeps whatever a concurrent
        // rebuild already minted under the generation now serving, and
        // dropping the markers of evicted entries keeps the two maps in
        // agreement (a marker outliving its attachment is what made the
        // recovery path hand out a null report).
        String liveBootId = error.getActualBootId();
        attachments.entrySet().removeIf(entry ->
                !liveBootId.equals(entry.getValue().getHarnessBootId()));
        pendingRecovery.retainAll(attachments.keySet());
        if (dropped) {
            stale.close();
        }
    }

    private static DaemonApprovalMode parseApprovalMode(String value) {
        if (value == null || value.isBlank()) {
            return DaemonApprovalMode.YOLO;
        }
        try {
            return DaemonApprovalMode.valueOf(value.toUpperCase(Locale.ROOT)
                    .replace('-', '_'));
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException(
                    "Unsupported Hosted Harness approval mode", error);
        }
    }

    private static final class AttachmentLock {
        private final ReentrantLock lock = new ReentrantLock();
        private int holders;
    }

    private record AttachmentKey(String tenantId, String sessionId) {
    }
}
