package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.StaticRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class EmbeddedRuntimeBroker implements RuntimeWarmer, AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(
            EmbeddedRuntimeBroker.class);
    public static final Duration LEASE = Duration.ofSeconds(30);
    private final RuntimeBrokerService service;
    private final RuntimeBrokerHttpServer server;
    private final RuntimeRecoveryCoordinator recovery;
    private final Set<String> retired = ConcurrentHashMap.newKeySet();

    public EmbeddedRuntimeBroker(AgentStateStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository, null);
    }

    public EmbeddedRuntimeBroker(AgentStateStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            WorkspaceExecutionStore workspaceExecutionStore) {
        this(store, properties, bindingRepository, sessionRepository,
                executionRepository, workspaceExecutionStore, null, null);
    }

    public EmbeddedRuntimeBroker(AgentStateStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            WorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications,
            ToolPublicationDataStore publicationData) {
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
        HttpRuntimeTransport http = new HttpRuntimeTransport();
        WorkspaceRuntimeResolver workspaces = workspaceExecutionStore == null ? null
                : new WorkspaceRuntimeResolver(store, workspaceExecutionStore, properties);
        RuntimeTransport transport = workspaces == null ? http
                : new WorkspaceRuntimeTransport(http, workspaces, workspaceExecutionStore,
                        bindingRepository, sessionRepository);
        RuntimeProvisioner baseProvisioner = provisioner(broker, http);
        RuntimeProvisioner provisioner = workspaces == null ? baseProvisioner
                : new WorkspaceRuntimeProvisioner(baseProvisioner, workspaces, workspaceExecutionStore);
        HarnessSessionResolver resolver = sessionId -> {
            SessionRecord session = store.findSessionById(sessionId)
                    .orElse(null);
            if (session == null) {
                CompletableFuture<RuntimeScope> failed =
                        new CompletableFuture<>();
                failed.completeExceptionally(new IllegalArgumentException(
                        "Session is not owned by this service"));
                return failed;
            }
            if (session.workspace() != null) {
                if (workspaces != null) {
                    return CompletableFuture.completedFuture(workspaces.resolve(sessionId).scope());
                }
                return CompletableFuture.failedFuture(
                        new RuntimeBrokerException(409,
                                "workspace_unavailable",
                                "Hosted Workspace execution is not available.",
                                false));
            }
            return CompletableFuture.completedFuture(new RuntimeScope(
                    session.tenantId(), workspaceId,
                    broker.getWorkspaceGeneration(),
                    workspaceCwd,
                    properties.getHarness().getCapabilityDigest(),
                    broker.getIsolationClass()));
        };
        ObjectMapper mapper = new ObjectMapper();
        RuntimePublicationVerifier verifier = publications == null || publicationData == null
                ? null : new RuntimePublicationVerifier() {
                    @Override
                    public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                            String id, String token) {
                        var binding = publications.verifyDispatch(execution, id, token);
                        var fields = mapper.convertValue(binding,
                                new TypeReference<java.util.Map<String, Object>>() { });
                        return new RuntimePublicationGrant(id, token,
                                properties.getToolPublication().getServiceBaseUrl(), fields);
                    }

                    @Override
                    public java.util.Map<String, Object> finished(ToolExecutionRecord execution) {
                        var saved = publicationData.finishedForBroker(execution);
                        return saved == null ? null : mapper.convertValue(saved.path("result"),
                                new TypeReference<java.util.Map<String, Object>>() { });
                    }

                    @Override
                    public java.util.Map<String, Object> receipt(ToolExecutionRecord execution) {
                        var saved = publicationData.receiptForBroker(execution);
                        return saved == null ? null : mapper.convertValue(saved,
                                new TypeReference<java.util.Map<String, Object>>() { });
                    }
                };
        this.service = new RuntimeBrokerService(resolver, provisioner,
                transport, bindingRepository, sessionRepository,
                executionRepository, UUID.randomUUID().toString(), LEASE,
                LEASE, verifier);
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
        this.recovery = broker.isTrustedLocalRebootRecovery()
                ? new RuntimeRecoveryCoordinator(service, bindingRepository) : null;
        LOG.info("Embedded Runtime Broker listening at {}",
                server.getBaseUri());
    }

    @Override
    public boolean isEnabled() {
        return true;
    }

    @Override
    public CompletionStage<Void> warm(String sessionId) {
        if (retired.contains(sessionId)) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(new RuntimeBrokerException(409,
                    "runtime_broker_session_closed",
                    "Harness Session is closed.", false));
            return failed;
        }
        return service.warm(sessionId).thenApply(ignored -> null);
    }

    /**
     * Marks an unbound Harness Session closed for later warm calls without
     * tearing down the worker. Workspace-bound close uses the durable fence
     * and harness-level drain through requestWorkspaceClose and closeWorkspace.
     */
    @Override
    public CompletionStage<Void> drain(String sessionId) {
        retired.add(sessionId);
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public boolean supportsWorkspaceClose() {
        return service.supportsDrainedStop();
    }

    @Override
    public void requestWorkspaceClose(String tenantId, String sessionId) {
        service.requestHarnessDrain(tenantId, sessionId);
    }

    @Override
    public CompletionStage<Void> closeWorkspace(String tenantId, String sessionId) {
        return service.drainHarnessSession(tenantId, sessionId);
    }

    public URI getBaseUri() {
        return server.getBaseUri();
    }

    @org.springframework.scheduling.annotation.Scheduled(scheduler = "runtimeRecoveryScheduler",
            fixedDelay = 5000)
    public void recoverSavedRuntimes() {
        if (recovery != null) {
            recovery.scan();
        }
    }

    @Override
    public void close() {
        if (recovery != null) {
            recovery.close();
        }
        server.close();
    }

    private static RuntimeProvisioner provisioner(
            ManagedAgentProperties.RuntimeBroker broker,
            HttpRuntimeTransport transport) {
        if (broker.isTrustedLocalRebootRecovery()
                && (!broker.isDurableLocalProcess() || !"local-process".equals(broker.getProvisioner()))) {
            if (!broker.isDurableLocalProcess()) {
                throw new IllegalStateException("Trusted reboot recovery requires durable local-process"
                        + " provisioning; enable durable local-process"
                        + " (QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=true),"
                        + " or set trusted-local-reboot-recovery=false"
                        + " (QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false)");
            }
            throw new IllegalStateException("Trusted reboot recovery requires durable local-process"
                    + " provisioning with the local-process provisioner (configured: "
                    + broker.getProvisioner() + "); set trusted-local-reboot-recovery=false"
                    + " (QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false)"
                    + " for non-durable provisioners");
        }
        if ("local-process".equals(broker.getProvisioner())) {
            require(broker.getStateDirectory(),
                    "Runtime Broker state directory");
            require(broker.getNodeExecutable(), "Node.js executable");
            require(broker.getWorkerEntry(), "Runtime worker entry");
            require(broker.getCliEntry(), "Qwen CLI entry");
            if (!broker.getEnvironment().isEmpty()) {
                throw new IllegalStateException("Merged local Runtime"
                        + " provisioner does not accept extra environment");
            }
            List<String> command = List.of(
                    Path.of(broker.getNodeExecutable()).toAbsolutePath()
                            .toString(),
                    Path.of(broker.getWorkerEntry()).toAbsolutePath()
                            .toString(), "managed-runtime-worker");
            Path stateDirectory = Path.of(broker.getStateDirectory()).toAbsolutePath().normalize();
            if (broker.isDurableLocalProcess()) {
                requireRecoveryDirectoryOutsideWorkspaces(broker, stateDirectory);
                return LocalProcessRuntimeProvisioner.durable(command, stateDirectory, transport,
                        broker.isTrustedLocalRebootRecovery());
            }
            return new LocalProcessRuntimeProvisioner(command, stateDirectory, transport);
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
        if ("kubernetes".equals(broker.getProvisioner())) {
            throw new IllegalStateException("Kubernetes Runtime provisioner"
                    + " is outside this review slice");
        }
        throw new IllegalStateException("Runtime Broker provisioner must be"
                + " local-process or static");
    }

    private static void requireRecoveryDirectoryOutsideWorkspaces(ManagedAgentProperties.RuntimeBroker broker,
            Path directory) {
        try {
            Path candidate = java.nio.file.Files.exists(directory) ? directory.toRealPath()
                    : directory.getParent().toRealPath().resolve(directory.getFileName());
            if (candidate.startsWith(Path.of(broker.getWorkspaceCwd()).toRealPath())) {
                throw new IllegalStateException(recoveryDirectoryOutsideRootsMessage());
            }
            for (var mount : broker.getWorkspaceMounts()) {
                if (candidate.startsWith(Path.of(mount.root()).toRealPath())) {
                    throw new IllegalStateException(recoveryDirectoryOutsideRootsMessage());
                }
            }
        } catch (IOException error) {
            throw new IllegalStateException("Runtime recovery directory could not be verified", error);
        }
    }

    private static String recoveryDirectoryOutsideRootsMessage() {
        return "Runtime recovery directory must be outside Workspace roots; set"
                + " QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY outside every configured Workspace"
                + " root, or opt out with QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=false"
                + " and QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false";
    }

    private static String resolveWorkspaceCwd(
            ManagedAgentProperties.RuntimeBroker broker) {
        if ("kubernetes".equals(broker.getProvisioner())) {
            Path configured = Path.of(broker.getWorkspaceCwd());
            if (!configured.isAbsolute()
                    || !configured.normalize().toString().equals(
                            broker.getWorkspaceCwd())) {
                throw new IllegalStateException("Kubernetes Runtime Broker"
                        + " workspace cwd must be an absolute normalized path");
            }
            return broker.getWorkspaceCwd();
        }
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
        if (!"local-process".equals(broker.getProvisioner())
                && !"kubernetes".equals(broker.getProvisioner())) {
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
