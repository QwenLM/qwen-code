package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonApprovalMode;
import com.alibaba.qwen.code.daemon.DaemonEvent;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
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
    private final DaemonApprovalMode approvalMode;
    private volatile HostedHarnessClient client;
    private final Map<String, HarnessSessionRef> attachments =
            new ConcurrentHashMap<>();

    public QwenHostedHarnessConnector(ManagedAgentProperties properties) {
        this.properties = properties.getHarness();
        if (this.properties.getToken() == null
                || this.properties.getToken().isBlank()
                || this.properties.getCapabilityDigest() == null
                || this.properties.getCapabilityDigest().isBlank()) {
            throw new IllegalStateException("Enabled Hosted Harness requires"
                    + " token and capability digest");
        }
        URI.create(this.properties.getBaseUrl());
        this.approvalMode = parseApprovalMode(
                this.properties.getApprovalMode());
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public Attachment createOrLoad(String harnessSessionId,
            boolean loadExisting) {
        HarnessSessionRef attached = attachments.computeIfAbsent(
                harnessSessionId, ignored -> loadExisting
                        ? load(harnessSessionId) : create(harnessSessionId));
        return new Attachment(attached.getHarnessBootId());
    }

    @Override
    public Admission submit(String harnessSessionId, String promptId,
            List<Map<String, Object>> input, String payloadDigest) {
        SubmitHarnessTurn.Builder builder = SubmitHarnessTurn.builder()
                .session(attachment(harnessSessionId))
                .promptId(promptId)
                .payloadDigest(payloadDigest);
        input.forEach(builder::addContent);
        PromptReceipt receipt = client().submitTurn(builder.build());
        return new Admission(receipt.getLastEventId(),
                receipt.getEventEpoch());
    }

    @Override
    public SourceStream stream(String harnessSessionId, long lastEventId,
            String eventEpoch) {
        HarnessEventStream stream = client().streamEvents(
                StreamHarnessEvents.builder()
                        .session(attachment(harnessSessionId))
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
    public void cancel(String harnessSessionId) {
        client().cancelTurn(attachment(harnessSessionId));
    }

    @Override
    public void close() {
        HostedHarnessClient current = client;
        if (current != null) {
            current.close();
        }
        attachments.clear();
    }

    private HarnessSessionRef attachment(String harnessSessionId) {
        HarnessSessionRef attachment = attachments.get(harnessSessionId);
        if (attachment == null) {
            createOrLoad(harnessSessionId, true);
            attachment = attachments.get(harnessSessionId);
        }
        return attachment;
    }

    private HarnessSessionRef create(String harnessSessionId) {
        try {
            return client().createSession(CreateHarnessSession.builder()
                    .harnessSessionId(harnessSessionId)
                    .approvalMode(approvalMode)
                    .build());
        } catch (DaemonHttpException error) {
            if (error.getStatusCode() != 409) {
                throw error;
            }
            return load(harnessSessionId);
        } catch (SessionCreationOutcomeUnknownException error) {
            return load(harnessSessionId);
        }
    }

    private HarnessSessionRef load(String harnessSessionId) {
        return client().loadSession(new LoadHarnessSession(harnessSessionId));
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
}
