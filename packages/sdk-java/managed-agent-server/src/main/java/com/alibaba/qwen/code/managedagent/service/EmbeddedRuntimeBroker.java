package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.StaticRuntimeProvisioner;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class EmbeddedRuntimeBroker implements RuntimeWarmer, AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(
            EmbeddedRuntimeBroker.class);
    private final RuntimeBrokerService service;
    private final RuntimeBrokerHttpServer server;

    public EmbeddedRuntimeBroker(ManagedAgentStore store,
            ManagedAgentProperties properties) {
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        require(broker.getToken(), "Runtime Broker token");
        require(broker.getWorkspaceGeneration(),
                "Runtime Broker workspace generation");
        require(broker.getWorkspaceCwd(), "Runtime Broker workspace cwd");
        String workspaceCwd = resolveWorkspaceCwd(broker);
        String workspaceId = resolveWorkspaceId(broker, workspaceCwd);
        require(properties.getHarness().getCapabilityDigest(),
                "Hosted Harness capability digest");
        RuntimeProvisioner provisioner = provisioner(broker);
        HarnessSessionResolver resolver = harnessSessionId -> {
            SessionRecord session = store.findSessionByHarnessId(
                    harnessSessionId).orElse(null);
            if (session == null) {
                CompletableFuture<RuntimeScope> failed =
                        new CompletableFuture<>();
                failed.completeExceptionally(new IllegalArgumentException(
                        "Harness Session is not owned by this service"));
                return failed;
            }
            return CompletableFuture.completedFuture(new RuntimeScope(
                    session.tenantId(), workspaceId,
                    broker.getWorkspaceGeneration(),
                    workspaceCwd,
                    properties.getHarness().getCapabilityDigest(),
                    broker.getIsolationClass()));
        };
        this.service = new RuntimeBrokerService(resolver, provisioner,
                new HttpRuntimeTransport());
        try {
            this.server = new RuntimeBrokerHttpServer(
                    new InetSocketAddress(broker.getHost(), broker.getPort()),
                    broker.getToken(), service);
            server.start();
        } catch (IOException error) {
            service.close();
            throw new IllegalStateException(
                    "Runtime Broker listener could not start", error);
        }
        LOG.info("Embedded Runtime Broker listening at {}",
                server.getBaseUri());
    }

    @Override
    public boolean isEnabled() {
        return true;
    }

    @Override
    public CompletionStage<Void> warm(String harnessSessionId) {
        return service.warm(harnessSessionId);
    }

    public URI getBaseUri() {
        return server.getBaseUri();
    }

    @Override
    public void close() {
        server.close();
    }

    private static RuntimeProvisioner provisioner(
            ManagedAgentProperties.RuntimeBroker broker) {
        if ("local-process".equals(broker.getProvisioner())) {
            require(broker.getStateDirectory(),
                    "Runtime Broker state directory");
            require(broker.getNodeExecutable(), "Node.js executable");
            require(broker.getWorkerEntry(), "Runtime worker entry");
            require(broker.getCliEntry(), "Qwen CLI entry");
            return new LocalProcessRuntimeProvisioner(
                    Path.of(broker.getStateDirectory()),
                    Path.of(broker.getNodeExecutable()),
                    Path.of(broker.getWorkerEntry()),
                    Path.of(broker.getCliEntry()), broker.getEnvironment());
        }
        if ("static".equals(broker.getProvisioner())) {
            if (!"workspace".equals(broker.getIsolationClass())) {
                throw new IllegalStateException("Static Runtime requires"
                        + " workspace isolation");
            }
            require(broker.getStaticEndpoint(), "Static Runtime endpoint");
            require(broker.getStaticToken(), "Static Runtime token");
            return new StaticRuntimeProvisioner(new RuntimeLease(
                    broker.getStaticRuntimeInstanceId(),
                    URI.create(broker.getStaticEndpoint()),
                    broker.getStaticToken(), broker.getStaticLeaseId(),
                    broker.getStaticEpoch()));
        }
        throw new IllegalStateException("Runtime Broker provisioner must be"
                + " local-process or static");
    }

    private static String resolveWorkspaceCwd(
            ManagedAgentProperties.RuntimeBroker broker) {
        if (!"local-process".equals(broker.getProvisioner())) {
            return broker.getWorkspaceCwd();
        }
        try {
            return Path.of(broker.getWorkspaceCwd()).toRealPath().toString();
        } catch (IOException error) {
            throw new IllegalStateException(
                    "Runtime Broker workspace cwd could not be resolved",
                    error);
        }
    }

    private static String resolveWorkspaceId(
            ManagedAgentProperties.RuntimeBroker broker,
            String workspaceCwd) {
        String configured = broker.getWorkspaceId();
        if (!"local-process".equals(broker.getProvisioner())) {
            require(configured, "Runtime Broker workspace ID");
            return configured;
        }
        String expected;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    workspaceCwd.getBytes(StandardCharsets.UTF_8));
            expected = HexFormat.of().formatHex(digest).substring(0, 16);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
        if (configured == null || configured.isBlank()) {
            return expected;
        }
        if (!expected.equals(configured)) {
            throw new IllegalStateException("Runtime Broker workspace ID must"
                    + " match the canonical workspace path hash");
        }
        return configured;
    }

    private static void require(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
    }
}
