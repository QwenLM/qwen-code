package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.workspace.ChildWorkspaceProvider;
import com.alibaba.qwen.code.managedagent.workspace.ChildWorktreeGit;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeKinds;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.StaticRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.transport.RuntimeBrokerHttpServer;
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
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;

public class EmbeddedRuntimeBroker implements RuntimeWarmer, AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(
            EmbeddedRuntimeBroker.class);
    public static final Duration LEASE = Duration.ofSeconds(30);
    private final RuntimeBrokerService service;
    private final RuntimeBrokerHttpServer server;
    private final RuntimeRecoveryCoordinator recovery;
    private final AgentStateStore store;
    private final WorkspaceRuntimeResolver workspaces;
    private final ChildWorkspaceProvider childWorkspaces;
    private final com.alibaba.qwen.code.managedagent.persistence.ResidentWorkspaces residents;
    private final boolean resident;
    private final Set<String> retired = ConcurrentHashMap.newKeySet();
    private static final Set<String> LIFECYCLE_FENCED = Set.of("CLOSING",
            "CLOSED", "ARCHIVING", "ARCHIVED", "DELETING", "DELETED");
    private final SshWorkspaceService ssh;
    private final RuntimeProvisioner localProvisioner;
    private final RuntimeBindingRepository extensionBindings;
    private final HttpRuntimeTransport extensionTransport;

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
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, null, null, null, null);
    }

    public EmbeddedRuntimeBroker(AgentStateStore store,
            ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            WorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications,
            ToolPublicationDataStore publicationData,
            SshWorkspaceService ssh) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, null, null, null, ssh);
    }

    public EmbeddedRuntimeBroker(AgentStateStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, WorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, jdbc, manager, null, null);
    }

    public EmbeddedRuntimeBroker(AgentStateStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, WorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager, SshWorkspaceService ssh) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, jdbc, manager, null, ssh);
    }

    EmbeddedRuntimeBroker(AgentStateStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, WorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager,
            RuntimeProvisioner residentProvisioner) {
        this(store, properties, bindingRepository, sessionRepository, executionRepository,
                workspaceExecutionStore, publications, publicationData, jdbc, manager, residentProvisioner, null);
    }

    private EmbeddedRuntimeBroker(AgentStateStore store, ManagedAgentProperties properties,
            RuntimeBindingRepository bindingRepository, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, WorkspaceExecutionStore workspaceExecutionStore,
            ToolPublicationStore publications, ToolPublicationDataStore publicationData,
            org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager,
            RuntimeProvisioner residentProvisioner, SshWorkspaceService ssh) {
        properties.validateExternalRuntime();
        this.store = store;
        this.ssh = ssh;
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        this.residents = new com.alibaba.qwen.code.managedagent.persistence.ResidentWorkspaces(broker.getResidentWorkspaces());
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
        boolean remote = ssh != null && ssh.configured();
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
        RuntimeProvisioner baseProvisioner;
        if (resident) {
            if (!(bindingRepository instanceof com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository original)
                    || jdbc == null || manager == null || workspaceExecutionStore == null
                    || !original.usesDataSource(jdbc.getDataSource())) {
                throw new IllegalStateException("Resident Workspace requires original JDBC authority");
            }
            if (residentProvisioner != null
                    && !"kubernetes-workspace".equals(residentProvisioner.kind())) {
                throw new IllegalArgumentException("Resident provisioner kind differs");
            }
            baseProvisioner = residentProvisioner == null
                    ? new ResidentWorkspaceProvisioner(properties, jdbc, manager, original)
                    : residentProvisioner;
        } else {
            if (residentProvisioner != null) {
                throw new IllegalArgumentException("Resident provisioner requires resident configuration");
            }
            if (!broker.getResidentWorkspaces().isEmpty()) {
                throw new IllegalStateException("Resident mappings require kubernetes-workspace provisioner");
            }
            baseProvisioner = provisioner(broker, remote ? new HttpRuntimeTransport() : http,
                    jdbc == null || manager == null ? null
                            : new ExternalStorageRegistrationStore(jdbc, manager));
        }
        if (properties.getManagedExtensions().isEnabled() && baseProvisioner instanceof LocalProcessRuntimeProvisioner local) {
            local.withManagedExtensionCacheDirectory(properties.getManagedExtensions().getCacheDirectory(), properties.getManagedExtensions().getCgroupRoot());
        }
        this.localProvisioner = baseProvisioner;
        if (remote) {
            RuntimeProvisioner local = baseProvisioner;
            var remoteProvisioner = new com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner(
                    ssh::node, ssh::runtimeStorage, ssh.connections(), http);
            if (properties.getManagedExtensions().isEnabled()) {
                remoteProvisioner.withManagedExtensionCacheDirectory(properties.getManagedExtensions().getCacheDirectory(), properties.getManagedExtensions().getCgroupRoot());
            }
            baseProvisioner = new com.alibaba.qwen.code.runtimebroker.provisioning.RoutingRuntimeProvisioner(
                    java.util.Map.of(local.kind(), local, com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner.KIND, remoteProvisioner),
                    scope -> ssh.runtimeStorage(scope) == null ? local.kind() : com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner.KIND,
                    (kind, lease) -> {
                        if (!com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeProvisioner.KIND.equals(kind)) {
                            ssh.connections().registerDirect(lease);
                        }
                    }, ssh.connections()::forget);
        }
        RuntimeProvisioner provisioner = workspaces == null || resident ? baseProvisioner
                : new WorkspaceRuntimeProvisioner(baseProvisioner, workspaces, workspaceExecutionStore);
        HarnessSessionResolver resolver = new HarnessSessionResolver() {
            @Override
            public CompletionStage<RuntimeScope> resolve(String sessionId) {
                return resolveScope(sessionId, false, null);
            }

            @Override
            public CompletionStage<RuntimeScope> resolve(String sessionId,
                    RuntimeLifecycleAuthority authority) {
                return resolveScope(sessionId, false, authority);
            }

            @Override
            public CompletionStage<RuntimeScope> resolveAdmission(
                    String sessionId) {
                return resolveScope(sessionId, true, null);
            }

            @Override
            public CompletionStage<RuntimeScope> resolveAdmission(
                    String sessionId, RuntimeLifecycleAuthority authority) {
                return resolveScope(sessionId, true, authority);
            }

            @Override
            public CompletionStage<String> resolveTenant(String sessionId) {
                return store.findSessionById(sessionId)
                        .map(session -> CompletableFuture.completedFuture(
                                session.tenantId()))
                        .orElseGet(() -> CompletableFuture.failedFuture(
                                new IllegalArgumentException(
                                        "Session is not owned by this"
                                                + " service")));
            }

            private CompletionStage<RuntimeScope> resolveScope(
                    String sessionId, boolean admission,
                    RuntimeLifecycleAuthority authority) {
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
                        return CompletableFuture.completedFuture(workspaces.resolve(sessionId, authority).scope());
                    }
                    return CompletableFuture.failedFuture(
                            new RuntimeBrokerException(409,
                                    "workspace_unavailable",
                                    "Hosted Workspace execution is not available.",
                                    false));
                }
                // The durable row is the admission fence for closing/closed,
                // archived and deleted Sessions: unlike the in-process
                // retired set it survives restarts and never accumulates in
                // memory. Only the admission resolve fences: release and the
                // unknown-outcome reconcile run after a close and must still
                // resolve the scope to settle the binding.
                if (admission && LIFECYCLE_FENCED.contains(session.status())) {
                    return CompletableFuture.failedFuture(
                            new RuntimeBrokerException(409,
                                    "runtime_broker_session_closed",
                                    "Harness Session is closed.", false));
                }
                return CompletableFuture.completedFuture(new RuntimeScope(
                        session.tenantId(), workspaceId,
                        broker.getWorkspaceGeneration(),
                        workspaceCwd,
                        properties.getHarness().getCapabilityDigest(),
                        broker.getIsolationClass()));
            }
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
        this.service = new RuntimeBrokerService(resolver, provisioner,
                transport, bindingRepository, sessionRepository,
                executionRepository, UUID.randomUUID().toString(), LEASE,
                LEASE, verifier, v3ResultWindow);
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
        // Log the resolved window: a suffix-less config value binds as
        // seconds, so a stale milliseconds-style "1800000" meant as 30
        // minutes shows up here as PT500H.
        LOG.info("Embedded Runtime Broker listening at {} (v3 result window {})",
                server.getBaseUri(), v3ResultWindow);
    }

    @Override
    public boolean isEnabled() {
        return true;
    }

    public void configureExtensions(com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService packages) {
        extensionTransport.configureExtensionPreparation((binding, sessionId, operation) -> {
            String tenant = binding.getRequest().getScope().getTenantId();
            @SuppressWarnings("unchecked")
            var selected = (List<java.util.Map<String, Object>>) operation.get("extensions");
            CompletionStage<java.util.Map<String, java.util.Map<String, String>>> delivery =
                    CompletableFuture.completedFuture(new java.util.LinkedHashMap<>());
            java.util.Map<String, Object> manifests = new java.util.LinkedHashMap<>();
            for (var pin : selected) {
                delivery = delivery.thenCompose(settings -> {
                    var parsed = new com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackages.Pin(
                            (String) pin.get("extensionId"), ((Number) pin.get("packageRevision")).longValue(),
                            (String) pin.get("packageDigest"), pin.get("settingsRevision") == null ? null
                            : ((Number) pin.get("settingsRevision")).longValue());
                    try {
                        var resolved = packages.resolvePin(tenant, binding.getRequest().getScope().getWorkspaceId(), parsed);
                        var manifest = resolved.descriptor().manifest();
                        java.util.Map<String, Object> metadata = new java.util.LinkedHashMap<>(java.util.Map.of(
                                "schemaVersion", manifest.schemaVersion(), "compilerVersion", manifest.compilerVersion(),
                                "name", manifest.name(), "version", manifest.version(),
                                "target", java.util.Map.of("platform", manifest.target().platform(), "arch", manifest.target().arch()),
                                "components", manifest.components()));
                        if (manifest.sourceType() != null) {
                            metadata.put("sourceType", manifest.sourceType());
                            metadata.put("sourceRevision", manifest.sourceRevision());
                        }
                        manifests.put(parsed.extensionId(), metadata);
                        return installExtensionPackage(tenant, sessionId, binding, parsed.packageDigest(), resolved.archive())
                                .thenApply(ignored -> {
                                    settings.put(parsed.extensionId(), resolved.settings());
                                    return settings;
                                });
                    } catch (IOException error) {
                        return CompletableFuture.failedFuture(error);
                    }
                });
            }
            return delivery.thenApply(settings -> {
                java.util.Map<String, Object> prepared = new java.util.LinkedHashMap<>(operation);
                prepared.put("settings", settings);
                prepared.put("packageManifests", manifests);
                prepared.put("toolProfile", store.requireSession(tenant, sessionId).toolProfile());
                return prepared;
            });
        });
    }

    private CompletionStage<java.util.Map<String, Object>> installExtensionPackage(String tenantId,
            String sessionId, com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord expected, String digest, Path archive) {
        SessionRecord session = store.requireSession(tenantId, sessionId);
        var binding = extensionBindings.findById(expected.getBindingId());
        if (binding == null || binding.getGeneration() != expected.getGeneration()
                || !binding.getRequest().equals(expected.getRequest())
                || !java.util.Objects.equals(binding.getProvisionSeed(), expected.getProvisionSeed())
                || !sameExtensionLease(binding.getLease(), expected.getLease())
                || binding.getState() != com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY
                || binding.isDrainRequested() || binding.getLease() == null || session.workspace() == null
                || !tenantId.equals(binding.getRequest().getScope().getTenantId())
                || !session.workspace().getWorkspaceId().equals(binding.getRequest().getScope().getWorkspaceId())
                || !"session".equals(binding.getRequest().getScope().getIsolationClass())
                || !sessionId.equals(binding.getRequest().getIsolationKey())) {
            return CompletableFuture.failedFuture(WorkspaceExecutionStore.unavailable());
        }
        return extensionTransport.installExtensionPackage(binding, digest, archive).thenApply(result -> {
            var current = extensionBindings.findById(expected.getBindingId());
            if (current == null || current.getGeneration() != binding.getGeneration()
                    || !current.getRequest().equals(binding.getRequest())
                    || !java.util.Objects.equals(current.getProvisionSeed(), binding.getProvisionSeed())
                    || current.getState() != com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.READY
                    || current.isDrainRequested() || !sameExtensionLease(current.getLease(), binding.getLease())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return result;
        });
    }

    private static boolean sameExtensionLease(RuntimeLease left, RuntimeLease right) {
        return left != null && right != null && left.getRuntimeInstanceId().equals(right.getRuntimeInstanceId())
                && left.getLeaseId().equals(right.getLeaseId()) && left.getEpoch() == right.getEpoch()
                && left.getEndpoint().equals(right.getEndpoint()) && left.getToken().equals(right.getToken());
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
        // drain() runs while the row still reads CLOSING/DELETING; the
        // admission resolve fences every lifecycle status durably, so only
        // a vanished row needs the in-process entry.
        if (store.findSessionById(sessionId).isEmpty()) {
            retired.add(sessionId);
        }
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public boolean supportsWorkspaceClose() {
        return service.supportsDrainedStop() || resident;
    }

    @Override
    public boolean supportsWorkspaceContextChange(ContextBinding binding) {
        return residents.find(binding) == null && (workspaces == null || workspaces.externalStorage(binding) == null);
    }

    @Override
    public boolean supportsWorkspaceClose(com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding binding) {
        if (resident && residents.find(binding) != null) {
            return true;
        }
        if (binding != null && ssh != null && ssh.runtimeStorage(binding) != null) {
            ssh.node(ssh.runtimeStorage(binding).nodeId());
            return true;
        }
        return localProvisioner.supportsDrainedStop();
    }

    @Override
    public void requestWorkspaceClose(String tenantId, String sessionId) {
        service.requestHarnessDrain(tenantId, sessionId);
    }

    @Override
    public CompletionStage<Void> closeWorkspace(String tenantId, String sessionId) {
        var session = store.findSessionById(sessionId).orElse(null);
        if (resident) {
            if (session == null || !tenantId.equals(session.tenantId()) || residents.find(session.workspace()) == null) {
                return CompletableFuture.failedFuture(com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore.unavailable());
            }
            return service.closeResidentHarnessSession(residents.request(session.workspace()), sessionId);
        }
        return service.drainHarnessSession(tenantId, sessionId);
    }

    @Override
    public CompletionStage<Void> drainWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return service.drainHarnessResources(tenantId, sessionId, authority, false);
    }

    @Override
    public CompletionStage<Void> prepareWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return service.prepareHarnessResources(tenantId, sessionId, authority);
    }

    @Override
    public CompletionStage<Void> recoverStoppedWorkspaceResources(String tenantId, String sessionId,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return service.drainHarnessResources(tenantId, sessionId, authority, true);
    }

    @Override
    public ChildWorkspaceProvider childWorkspaces() {
        return childWorkspaces;
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
        if (workspaces == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        workspaces.verifyInstallable(binding, targetCwdRelative);
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
            ManagedAgentProperties.RuntimeBroker broker,
            HttpRuntimeTransport transport,
            com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry registry) {
        if (broker.isTrustedLocalRebootRecovery()
                && (!broker.isDurableLocalProcess() || !LocalProcessRuntimeProvisioner.KIND.equals(broker.getProvisioner()))) {
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
        if (LocalProcessRuntimeProvisioner.KIND.equals(broker.getProvisioner())) {
            require(broker.getStateDirectory(),
                    "Runtime Broker state directory");
            require(broker.getNodeExecutable(), "Node.js executable");
            require(broker.getWorkerEntry(), "Runtime worker entry");
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
        if (ExternalRuntimeKinds.isExternal(broker.getProvisioner())) {
            // validateExternalRuntime() runs first in the constructor and
            // owns every rule for this family; duplicating it here would
            // only rot against it.
            ExternalHttpRuntimeClient client = new ExternalHttpRuntimeClient(
                    URI.create(broker.getExternalProviderUrl()), broker.getExternalProviderToken(),
                    broker.getExternalRequestTimeout());
            if (ExternalRuntimeKinds.isWorkspace(broker.getProvisioner())) {
                if (registry == null) {
                    throw new IllegalStateException("External Workspace provisioning"
                            + " requires the Managed Session Store database");
                }
                return new ExternalWorkspaceProvisioner(client, registry,
                                broker.getExternalProviderId(), broker.getExternalStartupTimeout(),
                                ExternalRuntimeKinds.isFiles(broker.getProvisioner()) ? transport : null, ExternalRuntimeKinds.isTools(broker.getProvisioner()));
            }
            return new ExternalRuntimeProvisioner(client, broker.getExternalProviderId(),
                    broker.getExternalStartupTimeout());
        }
        if ("kubernetes".equals(broker.getProvisioner()) || "kubernetes-workspace".equals(broker.getProvisioner())) {
            throw new IllegalStateException("Kubernetes Runtime provisioner"
                    + " is not supported (supported: local-process, static, "
                    + ExternalRuntimeKinds.supported() + ")");
        }
        throw new IllegalStateException("Runtime Broker provisioner must be"
                + " local-process, static or "
                + ExternalRuntimeKinds.supported());
    }

    private static void requireRecoveryDirectoryOutsideWorkspaces(ManagedAgentProperties.RuntimeBroker broker,
            Path directory) {
        try {
            Path candidate = java.nio.file.Files.exists(directory) ? directory.toRealPath()
                    : directory.getParent().toRealPath().resolve(directory.getFileName());
            if (candidate.startsWith(Path.of(broker.getWorkspaceCwd()).toRealPath())) {
                throw new IllegalStateException(recoveryDirectoryOutsideRootsMessage());
            }
            if (!broker.getWorkspaceCreationRoot().isBlank()
                    && candidate.startsWith(Path.of(broker.getWorkspaceCreationRoot()).toRealPath())) {
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

    /** The workspace ID this Broker resolves, which the Session Store shares. */
    public static String workspaceId(ManagedAgentProperties.RuntimeBroker broker) {
        return resolveWorkspaceId(broker, resolveWorkspaceCwd(broker));
    }

    private static String resolveWorkspaceCwd(
            ManagedAgentProperties.RuntimeBroker broker) {
        if ("kubernetes".equals(broker.getProvisioner()) || "kubernetes-workspace".equals(broker.getProvisioner())) {
            Path configured = Path.of(broker.getWorkspaceCwd());
            if (!configured.isAbsolute()
                    || !configured.normalize().toString().equals(
                            broker.getWorkspaceCwd())) {
                throw new IllegalStateException("Kubernetes Runtime Broker"
                        + " workspace cwd must be an absolute normalized path");
            }
            return broker.getWorkspaceCwd();
        }
        if (!LocalProcessRuntimeProvisioner.KIND.equals(broker.getProvisioner())) {
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
        if (!LocalProcessRuntimeProvisioner.KIND.equals(broker.getProvisioner())
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
