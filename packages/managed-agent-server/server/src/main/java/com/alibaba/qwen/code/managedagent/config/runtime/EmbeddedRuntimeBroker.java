package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.ChildWorkspaceProvider;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeRecoveryCoordinator;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRuntimeProvisioner;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRuntimeResolver;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.http.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeBackendSelection;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.CompletionStage;

public class EmbeddedRuntimeBroker implements RuntimeWarmer, AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(
            EmbeddedRuntimeBroker.class);
    public static final Duration LEASE = Duration.ofSeconds(30);
    private final RuntimeBrokerService service;
    private final RuntimeBrokerHttpServer server;
    private final RuntimeRecoveryCoordinator recovery;
    private final WorkspaceRuntimeResolver workspaces;
    private final ChildWorkspaceProvider childWorkspaces;
    private final com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceCatalog residents;
    private final boolean resident;
    private final com.alibaba.qwen.code.managedagent.workspace.runtime.ManagedRuntimeCoordinator coordinator;
    private final RuntimeProvisioner primaryProvisioner;
    private final RuntimeBindingRepository extensionBindings;
    private final HttpRuntimeTransport extensionTransport;

    public EmbeddedRuntimeBroker(SessionQueryStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository, null);
    }

    public EmbeddedRuntimeBroker(SessionQueryStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            JdbcWorkspaceExecutionStore workspaceExecutionStore) {
        this(store, properties, bindingRepository, sessionRepository,
                executionRepository, workspaceExecutionStore, null, null);
    }

    public EmbeddedRuntimeBroker(SessionQueryStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            JdbcWorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications,
            ToolPublicationDataStore publicationData) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, null, null, null, null);
    }

    public EmbeddedRuntimeBroker(SessionQueryStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            JdbcWorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications,
            ToolPublicationDataStore publicationData,
            SshWorkspaceService ssh) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, null, null, null, ssh);
    }

    public EmbeddedRuntimeBroker(SessionQueryStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, JdbcWorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, jdbc, manager, null, null);
    }

    public EmbeddedRuntimeBroker(SessionQueryStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, JdbcWorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager, SshWorkspaceService ssh) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, jdbc, manager, null, ssh);
    }

    EmbeddedRuntimeBroker(SessionQueryStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, JdbcWorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager,
            RuntimeProvisioner residentProvisioner) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, jdbc, manager, residentProvisioner, null);
    }

    private EmbeddedRuntimeBroker(SessionQueryStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, JdbcWorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager,
            RuntimeProvisioner residentProvisioner, SshWorkspaceService ssh) {
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        this.residents = new com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceCatalog(broker.getResidentWorkspaces());
        this.resident = "kubernetes-workspace".equals(broker.getProvisioner());
        require(broker.getToken(), "Runtime Broker token");
        require(broker.getWorkspaceGeneration(),
                "Runtime Broker workspace generation");
        require(broker.getWorkspaceCwd(), "Runtime Broker workspace cwd");
        Duration v3ResultWindow = broker.getV3ResultWindow();
        if (v3ResultWindow == null || v3ResultWindow.compareTo(
                RuntimeBrokerService.MIN_V3_RESULT_WINDOW) < 0) {
            // A suffix-less number binds as seconds, so this floor refuses
            // only sub-second values; a stale milliseconds-style override
            // passes. Fail before the provisioner exists rather than
            // degrade every v3 execution.
            throw new IllegalStateException(
                    "Runtime Broker v3 result window must be at least "
                            + RuntimeBrokerService.MIN_V3_RESULT_WINDOW);
        }
        String workspaceCwd = resolveWorkspaceCwd(broker);
        String workspaceId = resolveWorkspaceId(broker, workspaceCwd);
        require(properties.getHarness().getCapabilityDigest(),
                "Hosted Harness capability digest");
        var selection = RuntimeBackendSelection.from(properties);
        var registry = new RuntimeProviderRegistry();
        if (residentProvisioner == null) {
            registry.validateSelected(properties);
        }
        boolean remote = selection.includes(RuntimeProviderKinds.SSH_PROCESS);
        if (remote && (ssh == null || !ssh.configured() || workspaceExecutionStore == null)) {
            throw new IllegalStateException("SSH Runtime requires configured Workspace services");
        }
        if (resident && remote) {
            throw new IllegalStateException("Resident Workspace and SSH nodes require separate Broker configurations");
        }
        HttpRuntimeTransport http = remote ? new HttpRuntimeTransport(ssh.connections()::resolveEndpoint) : new HttpRuntimeTransport();
        this.extensionBindings = bindingRepository;
        this.extensionTransport = http;
        this.workspaces = workspaceExecutionStore == null ? null
                : new WorkspaceRuntimeResolver(store, workspaceExecutionStore, properties, ssh);
        WorkspaceRuntimeResolver workspaces = this.workspaces;
        this.childWorkspaces = broker.isChildWorkspacesEnabled()
                ? childWorkspaces(workspaces, broker) : null;
        RuntimeTransport transport = workspaces == null ? http
                : new WorkspaceRuntimeTransport(http, workspaces, workspaceExecutionStore,
                        bindingRepository, sessionRepository);
        RuntimeProviderDependencies dependencies = new RuntimeProviderDependencies() {
            private com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry external;
            private com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations csi;

            @Override
            public RuntimeBindingRepository bindings() { return bindingRepository; }

            @Override
            public com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry externalStorage() {
                if (jdbc == null || manager == null) {
                    return RuntimeProviderDependencies.super.externalStorage();
                }
                if (external == null) {
                    external = new ExternalStorageRegistrationStore(jdbc, manager);
                }
                return external;
            }

            @Override
            public com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations csiReservations() {
                if (!(bindingRepository instanceof com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository original)
                        || jdbc == null || manager == null || workspaceExecutionStore == null
                        || !original.usesDataSource(jdbc.getDataSource())) {
                    throw new IllegalStateException("Resident Workspace requires original JDBC authority");
                }
                if (csi == null) {
                    csi = new com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiReservationStore(jdbc, manager, new ObjectMapper());
                }
                return csi;
            }

            @Override
            public com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeAccess ssh() {
                if (ssh == null || !ssh.configured()) {
                    return RuntimeProviderDependencies.super.ssh();
                }
                return ssh;
            }
        };
        RuntimeProvisioner baseProvisioner;
        if (resident) {
            dependencies.csiReservations();
            if (residentProvisioner != null && !"kubernetes-workspace".equals(residentProvisioner.kind())) {
                throw new IllegalArgumentException("Resident provisioner kind differs");
            }
            baseProvisioner = residentProvisioner == null
                    ? registry.create(properties, http, dependencies) : residentProvisioner;
        } else {
            if (residentProvisioner != null) {
                throw new IllegalArgumentException("Resident provisioner requires resident configuration");
            }
            if (!broker.getResidentWorkspaces().isEmpty()) {
                throw new IllegalStateException("Resident mappings require kubernetes-workspace provisioner");
            }
            baseProvisioner = provisioner(properties,
                    remote && !RuntimeProviderKinds.SSH_PROCESS.equals(broker.getProvisioner())
                            ? new HttpRuntimeTransport() : http, dependencies);
        }
        this.primaryProvisioner = baseProvisioner;
        if (remote && !RuntimeProviderKinds.SSH_PROCESS.equals(broker.getProvisioner())) {
            RuntimeProvisioner local = baseProvisioner;
            RuntimeProvisioner remoteProvisioner = null;
            try {
                remoteProvisioner = registry.create(RuntimeProviderKinds.SSH_PROCESS, properties, http, dependencies);
                baseProvisioner = new com.alibaba.qwen.code.runtimebroker.routing.RoutingRuntimeProvisioner(
                        java.util.Map.of(local.kind(), local, RuntimeProviderKinds.SSH_PROCESS, remoteProvisioner),
                        scope -> ssh.runtimeStorage(scope) == null ? local.kind() : RuntimeProviderKinds.SSH_PROCESS,
                        (kind, lease) -> {
                            if (!RuntimeProviderKinds.SSH_PROCESS.equals(kind)) {
                                ssh.connections().registerDirect(lease);
                            }
                        }, ssh.connections()::forget);
            } catch (RuntimeException | Error failure) {
                local.close();
                if (remoteProvisioner != null) {
                    remoteProvisioner.close();
                }
                throw failure;
            }
        }
        RuntimeProvisioner provisioner = workspaces == null || resident ? baseProvisioner
                : new WorkspaceRuntimeProvisioner(baseProvisioner, workspaces, workspaceExecutionStore);
        HarnessSessionResolver resolver = com.alibaba.qwen.code.managedagent.workspace.runtime.ManagedRuntimeCoordinator.resolver(
                store, workspaces, properties, workspaceId, workspaceCwd);
        ObjectMapper mapper = new ObjectMapper();
        RuntimePublicationVerifier verifier = publications == null || publicationData == null
                ? null : new RuntimePublicationVerifier() {
                    @Override
                    public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                            String id, String token) {
                        var binding = publications.verifyDispatch(execution, id, token);
                        var fields = mapper.convertValue(binding,
                                new TypeReference<java.util.Map<String, Object>>() { });
                        var runtime = bindingRepository.findById(execution.getBindingId());
                        var storage = remote && runtime != null ? ssh.runtimeStorage(runtime.getRequest().getScope()) : null;
                        String publicationUrl = storage == null ? properties.getToolPublication().getServiceBaseUrl()
                                : ssh.connections().publicationEndpoint(ssh.node(storage.nodeId())).toString();
                        return new RuntimePublicationGrant(id, token, publicationUrl, fields);
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
        try {
            this.service = new RuntimeBrokerService(resolver, provisioner,
                    transport, bindingRepository, sessionRepository,
                    executionRepository, UUID.randomUUID().toString(), LEASE,
                    LEASE, verifier, v3ResultWindow);
        } catch (RuntimeException | Error failure) {
            provisioner.close();
            throw failure;
        }
        try {
            this.server = new RuntimeBrokerHttpServer(
                    new InetSocketAddress(broker.getHost(), broker.getPort()),
                    broker.getToken(), service, broker.isAllowNonLoopback());
            server.start();
        } catch (IOException | IllegalArgumentException error) {
            service.close();
            // The same catch covers the token and port validation, so name
            // the actual refusal instead of blaming the listener for all of
            // them.
            throw new IllegalStateException(
                    "Runtime Broker listener could not start: "
                            + error.getMessage(), error);
        }
        this.recovery = broker.isTrustedLocalRebootRecovery()
                ? new RuntimeRecoveryCoordinator(service, bindingRepository) : null;
        this.coordinator = new com.alibaba.qwen.code.managedagent.workspace.runtime.ManagedRuntimeCoordinator(
                service, store, workspaces, childWorkspaces, residents, resident, ssh, primaryProvisioner, extensionBindings, extensionTransport);
        // Log the resolved window: a suffix-less config value binds as
        // seconds, so a stale milliseconds-style "1800000" meant as 30
        // minutes shows up here as PT500H.
        LOG.info("Embedded Runtime Broker listening at {} (v3 result window {})",
                server.getBaseUri(), v3ResultWindow);
    }

    @Override
    public boolean isEnabled() {
        return coordinator.isEnabled();
    }

    public void configureExtensions(com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService packages) {
        coordinator.configureExtensions(packages);
    }

    @Override
    public CompletionStage<Void> warm(String sessionId) {
        return coordinator.warm(sessionId);
    }

    /**
     * Marks an unbound Harness Session closed for later warm calls without
     * tearing down the worker. Workspace-bound close uses the durable fence
     * and harness-level drain through requestWorkspaceClose and closeWorkspace.
     */
    @Override
    public CompletionStage<Void> drain(String sessionId) {
        return coordinator.drain(sessionId);
    }

    @Override
    public boolean supportsWorkspaceClose() {
        return coordinator.supportsWorkspaceClose();
    }

    @Override
    public boolean supportsWorkspaceContextChange(ContextBinding binding) {
        return coordinator.supportsWorkspaceContextChange(binding);
    }

    @Override
    public boolean supportsWorkspaceClose(com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding binding) {
        return coordinator.supportsWorkspaceClose(binding);
    }

    @Override
    public void requestWorkspaceClose(String tenantId, String sessionId) {
        coordinator.requestWorkspaceClose(tenantId, sessionId);
    }

    @Override
    public CompletionStage<Void> closeWorkspace(String tenantId, String sessionId) {
        return coordinator.closeWorkspace(tenantId, sessionId);
    }

    @Override
    public CompletionStage<Void> drainWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return coordinator.drainWorkspaceResources(tenantId, sessionId, authority);
    }

    @Override
    public CompletionStage<Void> prepareWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return coordinator.prepareWorkspaceResources(tenantId, sessionId, authority);
    }

    @Override
    public CompletionStage<Void> recoverStoppedWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return coordinator.recoverStoppedWorkspaceResources(tenantId, sessionId, authority);
    }

    @Override
    public ChildWorkspaceProvider childWorkspaces() {
        return coordinator.childWorkspaces();
    }

    private static ChildWorkspaceProvider childWorkspaces(WorkspaceRuntimeResolver workspaces,
            ManagedAgentProperties.RuntimeBroker broker) {
        if (workspaces == null) {
            throw new IllegalStateException("Child Workspaces require Workspace mounts");
        }
        ChildWorktreeGit git = new ChildWorktreeGit(broker.getChildWorkspaceGit(),
                broker.getChildWorkspaceGitTimeout());
        try {
            LOG.info("Child Workspaces enabled with {}", git.requireSupportedVersion());
        } catch (RuntimeException error) {
            git.close();
            throw error;
        }
        return new ChildWorkspaceProvider() {
            @Override
            public java.nio.file.Path storageRoot(ContextBinding binding) {
                return workspaces.storageRoot(binding);
            }

            @Override
            public ChildWorktreeGit git() {
                return git;
            }
        };
    }

    @Override
    public void verifyWorkspaceCwdTarget(ContextBinding binding,
            String targetCwdRelative) {
        coordinator.verifyWorkspaceCwdTarget(binding, targetCwdRelative);
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

    /**
     * The owned Runtime Broker Service, exposed for the child result relay
     * and the close cascade's binding probe at registration time. The
     * closing lifecycle stays with this Broker alone — the wiring uses
     * {@code destroyMethod = ""} so Spring never closes it twice.
     */
    public RuntimeBrokerService service() {
        return service;
    }

    @Override
    public void close() {
        if (recovery != null) {
            recovery.close();
        }
        server.close();
        if (childWorkspaces != null) {
            childWorkspaces.git().close();
        }
    }

    static RuntimeProvisioner provisioner(
            ManagedAgentProperties properties,
            HttpRuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        var broker = properties.getRuntimeBroker();
        if (broker.isTrustedLocalRebootRecovery()
                && (!broker.isDurableLocalProcess() || !com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(broker.getProvisioner()))) {
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
        return new RuntimeProviderRegistry().create(properties, transport, dependencies);
    }

    /** The workspace ID this Broker resolves, which the Session Store shares. */
    public static String workspaceId(ManagedAgentProperties.RuntimeBroker broker) {
        return resolveWorkspaceId(broker, resolveWorkspaceCwd(broker));
    }

    private static String resolveWorkspaceCwd(
            ManagedAgentProperties.RuntimeBroker broker) {
        if ("kubernetes".equals(broker.getProvisioner()) || "kubernetes-workspace".equals(broker.getProvisioner())) {
            // This is a Pod path, independent of the server host filesystem.
            String configured = broker.getWorkspaceCwd();
            if (configured == null || !configured.startsWith("/") || configured.indexOf('\0') >= 0
                    || !configured.equals("/") && Arrays.stream(configured.substring(1).split("/", -1))
                            .anyMatch(part -> part.isEmpty() || part.equals(".") || part.equals(".."))) {
                throw new IllegalStateException("Kubernetes Runtime Broker"
                        + " workspace cwd must be an absolute normalized path");
            }
            return configured;
        }
        if (!com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(broker.getProvisioner())) {
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
        if (!com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(broker.getProvisioner())
                && !"kubernetes".equals(broker.getProvisioner())) {
            require(configured, "Runtime Broker workspace ID");
            return configured;
        }
        String expected;
        try {
            expected = DigestUtils.sha256Hex(
                    workspaceCwd.getBytes(StandardCharsets.UTF_8)).substring(0, 16);
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
        if (StringUtils.isBlank(configured)) {
            return expected;
        }
        if (!expected.equals(configured)) {
            throw new IllegalStateException("Runtime Broker workspace ID must"
                    + " match the canonical workspace path hash");
        }
        return configured;
    }

    private static void require(String value, String name) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException(name + " is required");
        }
    }
}
