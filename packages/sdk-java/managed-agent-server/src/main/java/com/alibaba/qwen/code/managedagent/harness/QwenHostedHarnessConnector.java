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
import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class QwenHostedHarnessConnector implements HarnessConnector {
    private final ManagedAgentProperties.Harness properties;
    private final ManagedAgentProperties.SessionStore sessionStore;
    private final String workspaceId;
    private final DaemonApprovalMode approvalMode;
    private volatile HostedHarnessClient client;
    private final Map<AttachmentKey, HarnessSessionRef> attachments =
            new ConcurrentHashMap<>();

    public QwenHostedHarnessConnector(ManagedAgentProperties properties) {
        this.properties = properties.getHarness();
        this.sessionStore = properties.getSessionStore();
        this.workspaceId = sessionStore.getWorkspaceId();
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
        this.approvalMode = parseApprovalMode(
                this.properties.getApprovalMode());
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting) {
        return createOrLoad(tenantId, sessionId, loadExisting, false);
    }

    @Override
    public Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting, boolean passiveManagedRuntimeRecovery) {
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef attached = passiveManagedRuntimeRecovery
                ? load(tenantId, sessionId, true)
                : attachments.computeIfAbsent(key, ignored -> loadExisting
                        ? load(tenantId, sessionId, false)
                        : create(tenantId, sessionId));
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
        SubmitHarnessTurn.Builder builder = SubmitHarnessTurn.builder()
                .session(attachment(tenantId, sessionId))
                .promptId(promptId)
                .payloadDigest(payloadDigest);
        input.forEach(builder::addContent);
        PromptReceipt receipt = client().submitTurn(builder.build());
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public Admission continueManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        PromptReceipt receipt = client().continueManagedRuntime(
                attachment(tenantId, sessionId), promptId, checkpointId,
                activationId);
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public Admission cancelManagedRuntime(String tenantId, String sessionId,
            String promptId, String checkpointId, String activationId) {
        PromptReceipt receipt = client().cancelManagedRuntime(
                new CancelManagedRuntime(attachment(tenantId, sessionId),
                        promptId, checkpointId, activationId));
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public SourceStream stream(String tenantId, String sessionId,
            long lastEventId,
            String eventEpoch) {
        HarnessEventStream stream = client().streamEvents(
                StreamHarnessEvents.builder()
                        .session(attachment(tenantId, sessionId))
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
    public void cancel(String tenantId, String sessionId) {
        client().cancelTurn(attachment(tenantId, sessionId));
    }

    @Override
    public void rename(String tenantId, String sessionId, String title) {
        client().updateSessionTitle(attachment(tenantId, sessionId), title);
    }

    @Override
    public void closeSession(String tenantId, String sessionId) {
        attachments.remove(new AttachmentKey(tenantId, sessionId));
        client().closeSession(sessionId);
    }

    @Override
    public void close() {
        HostedHarnessClient current = client;
        if (current != null) {
            current.close();
        }
        attachments.clear();
    }

    private HarnessSessionRef attachment(String tenantId, String sessionId) {
        AttachmentKey key = new AttachmentKey(tenantId, sessionId);
        HarnessSessionRef attachment = attachments.get(key);
        if (attachment == null) {
            createOrLoad(tenantId, sessionId, true);
            attachment = attachments.get(key);
        }
        return attachment;
    }

    private HarnessSessionRef create(String tenantId, String sessionId) {
        try {
            CreateHarnessSession.Builder builder = CreateHarnessSession
                    .builder()
                    .harnessSessionId(sessionId)
                    .approvalMode(approvalMode);
            ManagedSessionStoreConnection store = managedSessionStore(
                    tenantId);
            if (store != null) {
                builder.managedSessionStore(store);
            }
            return client().createSession(builder.build());
        } catch (DaemonHttpException error) {
            if (error.getStatusCode() != 409) {
                throw error;
            }
            return load(tenantId, sessionId, false);
        } catch (SessionCreationOutcomeUnknownException error) {
            return load(tenantId, sessionId, false);
        }
    }

    private HarnessSessionRef load(String tenantId, String sessionId,
            boolean passiveManagedRuntimeRecovery) {
        ManagedSessionStoreConnection store = managedSessionStore(tenantId);
        return client().loadSession(new LoadHarnessSession(sessionId, store,
                passiveManagedRuntimeRecovery));
    }

    private ManagedSessionStoreConnection managedSessionStore(
            String tenantId) {
        if (!sessionStore.isEnabled()) {
            return null;
        }
        return ManagedSessionStoreConnection.builder()
                .baseUri(URI.create(sessionStore.getBaseUrl()))
                .tenantId(tenantId)
                .workspaceId(workspaceId)
                .writerId(client().capabilities().getBootId())
                .leaseDuration(sessionStore.getWriterLeaseDuration())
                .build();
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
