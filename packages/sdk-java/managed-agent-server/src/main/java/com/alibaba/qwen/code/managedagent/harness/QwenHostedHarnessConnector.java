package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.CancelManagedRuntime;
import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonApprovalMode;
import com.alibaba.qwen.code.daemon.DaemonEvent;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.daemon.ManagedSessionStoreConnection;
import com.alibaba.qwen.code.daemon.PromptReceipt;
import com.alibaba.qwen.code.daemon.SessionCreationOutcomeUnknownException;
import com.alibaba.qwen.code.daemon.StreamHarnessEvents;
import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
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
    private volatile HostedHarnessClient client;
    // Sessions whose takeover load reported parked Runtime work that no
    // continue/cancel has been admitted for yet.
    private final Set<AttachmentKey> pendingRecovery =
            ConcurrentHashMap.newKeySet();
    private final Map<AttachmentKey, HarnessSessionRef> attachments =
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
        if (this.properties.getToken() == null
                || this.properties.getToken().isBlank()
                || this.properties.getCapabilityDigest() == null
                || this.properties.getCapabilityDigest().isBlank()) {
            throw new IllegalStateException("Enabled Hosted Harness requires"
                    + " token and capability digest");
        }
        URI.create(this.properties.getBaseUrl());
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
        SessionRecord session = sessions.requireSession(tenantId, sessionId);
        if (session.workspace() != null) {
            if (!isWorkspaceFilesAvailable()) {
                throw new IllegalStateException("Hosted Workspace files are disabled");
            }
            if (actions == null) {
                throw new IllegalStateException("Hosted Workspace Sessions"
                        + " require the Managed Action store");
            }
            if (passiveManagedRuntimeRecovery) {
                workspaceExecution.authorizePassiveAttachment(session);
            } else {
                workspaceExecution.authorize(session);
            }
        }
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef attached = passiveManagedRuntimeRecovery
                ? load(session, true)
                : attachments.computeIfAbsent(key, ignored -> loadExisting
                        ? load(session, false)
                        : create(session));
        if (session.workspace() != null
                && !actions.approvalMode(tenantId, sessionId).equals(attached.getApprovalMode())) {
            attachments.remove(key);
            throw new IllegalStateException(
                    "Hosted Harness did not confirm the Session approval mode");
        }
        attachments.put(key, attached);
        return new Attachment(attached.getHarnessBootId(),
                attached.getRuntimeRecovery(),
                attached.getHarnessLastEventId(),
                attached.getHarnessEventEpoch());
    }

    @Override
    public Admission submit(String tenantId, String sessionId,
            String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        requireReadyForNewWork(tenantId, sessionId);
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
        requireReadyForNewWork(tenantId, sessionId);
        PromptReceipt receipt = client().continueManagedRuntime(
                attachment(tenantId, sessionId, true), promptId, checkpointId,
                activationId);
        pendingRecovery.remove(new AttachmentKey(tenantId, sessionId));
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public Admission cancelManagedRuntime(String tenantId, String sessionId,
            String promptId, String checkpointId, String activationId) {
        PromptReceipt receipt = client().cancelManagedRuntime(
                new CancelManagedRuntime(attachment(tenantId, sessionId, false),
                        promptId, checkpointId, activationId));
        pendingRecovery.remove(new AttachmentKey(tenantId, sessionId));
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public SourceStream stream(String tenantId, String sessionId,
            long lastEventId,
            String eventEpoch) {
        HarnessEventStream stream = client().streamEvents(
                StreamHarnessEvents.builder()
                        .session(attachment(tenantId, sessionId, false))
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
        requireReadyForNewWork(tenantId, sessionId);
        client().resolveAction(
                        attachment(tenantId, sessionId, true),
                        actionId,
                        response.path("optionId").asText(),
                        response.path("inputRevision").asLong(),
                        response.path("policyRevision").asText());
    }

    @Override
    public void cancel(String tenantId, String sessionId) {
        client().cancelTurn(attachment(tenantId, sessionId, false));
    }

    @Override
    public void rename(String tenantId, String sessionId, String title) {
        client().updateSessionTitle(attachment(tenantId, sessionId, false), title);
    }

    @Override
    public String closeSession(String tenantId, String sessionId) {
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

    private void requireReadyForNewWork(String tenantId, String sessionId) {
        if (!workspaceExecution.verifiedRecoveryEnabled()) {
            return;
        }
        SessionRecord session = sessions.requireSession(tenantId, sessionId);
        if (session.workspace() != null) {
            if (!isWorkspaceFilesAvailable()) {
                throw new IllegalStateException("Hosted Workspace files are disabled");
            }
            workspaceExecution.authorize(session);
        }
    }

    private HarnessSessionRef create(SessionRecord session) {
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
                            .toolProfile(toolProfile(session));
            ManagedSessionStoreConnection store = managedSessionStore(
                    session);
            if (store != null) {
                builder.managedSessionStore(store);
            }
            return client().createSession(builder.build());
        } catch (DaemonHttpException error) {
            if (error.getStatusCode() != 409) {
                throw error;
            }
            return load(session, false);
        } catch (SessionCreationOutcomeUnknownException error) {
            return load(session, false);
        }
    }

    private HarnessSessionRef load(SessionRecord session,
            boolean passiveManagedRuntimeRecovery) {
        return load(session, passiveManagedRuntimeRecovery, false);
    }

    private HarnessSessionRef load(SessionRecord session,
            boolean passiveManagedRuntimeRecovery,
            boolean driveRuntimeRecovery) {
        String profile = toolProfile(session);
        ManagedSessionStoreConnection store = managedSessionStore(session);
        return client().loadSession(new LoadHarnessSession(session.sessionId(), store,
                passiveManagedRuntimeRecovery, profile,
                driveRuntimeRecovery));
    }

    @Override
    public Attachment recoverManagedRuntime(String tenantId, String sessionId,
            boolean cancellation) {
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
                workspaceExecution.authorizePassiveAttachment(session);
            } else {
                workspaceExecution.authorize(session);
            }
        }
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef cached = attachments.get(key);
        if (cached == null) {
            HarnessSessionRef attached = load(session, cancellation,
                    !cancellation);
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
        synchronized (this) {
            current = client;
            if (current == null) {
                current = HostedHarnessClient.builder()
                        .baseUri(URI.create(properties.getBaseUrl()))
                        .bearerToken(properties.getToken())
                        .capabilityDigest(properties.getCapabilityDigest())
                        .connectTimeout(properties.getConnectTimeout())
                        .requestTimeout(properties.getRequestTimeout())
                        .heartbeatInterval(properties.getHeartbeatInterval())
                        .build();
                client = current;
            }
            return current;
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

    private record AttachmentKey(String tenantId, String sessionId) {
    }
}
