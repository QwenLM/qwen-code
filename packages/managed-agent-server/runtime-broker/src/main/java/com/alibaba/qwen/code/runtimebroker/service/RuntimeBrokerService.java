package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.ExecutionReconciliation;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.NativeCsiExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeExtensionCommandVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeToolMeasurements;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.TerminalHoldAdmission;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.protocol.ProviderRuntimeProtocol;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.BindingContext;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import com.alibaba.qwen.code.runtimebroker.transport.CsiFileHistoryProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedExtensionCommandProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedExtensionProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHoldFamily;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHookProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedMcpProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedMonitorProtocol;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.sameLease;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.immutableMap;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.invalid;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isDetachedCapture;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isProtocolV3;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isPublicationV3;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapStoreFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.prepareExecutionReference;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.referenceString;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireSameSession;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.sameReceipt;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.sshNoStartReceipt;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/** Repository-backed orchestration for the private Managed Runtime contract. */
public final class RuntimeBrokerService implements AutoCloseable, RuntimeBrokerOperations {
    /**
     * Floor for {@code v3ResultWindow}: refuses sub-second durations. The
     * managed-agent-server property declares {@code @DurationUnit(SECONDS)},
     * so a suffix-less override there binds as seconds and its startup
     * sweep warns on the bare number — always write the suffix. A consumer
     * binding its own {@code Duration} without that annotation gets Spring
     * Boot's millisecond default instead; this module performs no config
     * binding and runs no startup sweep, so such callers must validate
     * their own window.
     */
    public static final Duration MIN_V3_RESULT_WINDOW = Duration.ofSeconds(1);
    private static final Duration DEFAULT_V3_RESULT_WINDOW =
            Duration.ofMinutes(30);

    private final HarnessSessionResolver sessionResolver;
    private RuntimeExtensionCommandVerifier extensionCommandVerifier;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimePublicationVerifier publicationVerifier;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Duration dispatchLeaseDuration;
    private final Duration v3ResultWindow;
    private final Clock clock;
    private final Supplier<String> executionIdSupplier;
    private final ScheduledExecutorService scheduler;
    private final ScheduledExecutorService renewalScheduler;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeBindingProvisioning bindingProvisioning;
    private final TerminalHolds terminalHolds;
    private final BackgroundProcessAdmission backgroundProcessAdmission;
    private final RuntimeExecutionState executionState;
    private final RuntimeExecutionDispatcher executionDispatcher;
    private final RuntimeExecutionReconciler executionReconciler;
    private final RuntimeExecutionRecovery executionRecovery;
    private final RuntimeExecutionCancellation executionCancellation;
    private final RuntimeSessionRelease sessionRelease;
    private final RuntimeDrainCoordinator drainCoordinator;
    private final RuntimeHoldInventory holdInventory;

    /**
     * H4b: the live physical Runtime binding of a Harness Session — how
     * the child result relay and the close cascade confirm the child
     * Session's Runtime identity and generation. {@code warm()} creates
     * the binding when the Hosted tool turn is constructed, so it exists
     * even for a child that finishes without ever acquiring a tool
     * Session. Only READY rows answer: a drained, lost, recovering or
     * released binding no longer holds the live Runtime it would pin.
     * "Latest" is the greatest READY binding id across the whole
     * traversal — the page a row lands on says nothing, and
     * {@code generation} is not consulted for the choice.
     */
    public RuntimeBindingRecord findLatestBindingByHarnessSession(
            String tenantId, String harnessSessionId) {
        return bindingRegistry.findLatestBindingByHarnessSession(tenantId, harnessSessionId, true);
    }

    /**
     * The newest binding row of a Harness Session in ANY state — evidence
     * reads only: the close cascade's started proof and its repair's
     * dispatch identity. A RELEASED or LOST row still proves the child
     * once dispatched (and names the identity that dispatch committed),
     * while it can never warm a retry, so the repair-for-warmth read
     * above stays READY-only.
     */
    public RuntimeBindingRecord findLatestBindingByHarnessSessionAnyState(
            String tenantId, String harnessSessionId) {
        return bindingRegistry.findLatestBindingByHarnessSession(tenantId, harnessSessionId, false);
    }

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, null,
                DEFAULT_V3_RESULT_WINDOW, Clock.systemUTC(),
                () -> UUID.randomUUID().toString(), newScheduler(),
                newRenewalScheduler());
    }

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration,
            RuntimePublicationVerifier publicationVerifier) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, publicationVerifier,
                DEFAULT_V3_RESULT_WINDOW, Clock.systemUTC(),
                () -> UUID.randomUUID().toString(), newScheduler(),
                newRenewalScheduler());
    }

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration,
            RuntimePublicationVerifier publicationVerifier,
            Duration v3ResultWindow) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, publicationVerifier,
                v3ResultWindow, Clock.systemUTC(),
                () -> UUID.randomUUID().toString(), newScheduler(),
                newRenewalScheduler());
    }

    RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration, Clock clock,
            Supplier<String> executionIdSupplier) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, null,
                DEFAULT_V3_RESULT_WINDOW, clock, executionIdSupplier,
                newScheduler(), newRenewalScheduler());
    }

    private RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration,
            RuntimePublicationVerifier publicationVerifier,
            Duration v3ResultWindow, Clock clock,
            Supplier<String> executionIdSupplier,
            ScheduledExecutorService scheduler,
            ScheduledExecutorService renewalScheduler) {
        if (sessionResolver == null || provisioner == null
                || transport == null || bindingRepository == null
                || sessionRepository == null || executionRepository == null
                || clock == null || executionIdSupplier == null
                || scheduler == null || renewalScheduler == null) {
            throw new IllegalArgumentException(
                    "service dependencies are required");
        }
        this.brokerOwnerId = BrokerValues.requireId(brokerOwnerId,
                "brokerOwnerId");
        this.operationLeaseDuration = requireDuration(
                operationLeaseDuration, "operationLeaseDuration");
        this.dispatchLeaseDuration = requireDuration(
                dispatchLeaseDuration, "dispatchLeaseDuration");
        this.v3ResultWindow = requireDuration(v3ResultWindow,
                "v3ResultWindow");
        if (this.v3ResultWindow.compareTo(MIN_V3_RESULT_WINDOW) < 0) {
            // In managed-agent-server a suffix-less override binds as
            // seconds, so the floor refuses only sub-second values; a
            // stale milliseconds-style override passes as that many
            // seconds. Refuse values below a floor no intended
            // configuration lands under.
            throw new IllegalArgumentException(
                    "v3ResultWindow must be at least "
                            + MIN_V3_RESULT_WINDOW);
        }
        this.sessionResolver = sessionResolver;
        this.provisioner = provisioner;
        this.transport = transport;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.publicationVerifier = publicationVerifier;
        this.clock = clock;
        this.executionIdSupplier = executionIdSupplier;
        this.scheduler = scheduler;
        this.renewalScheduler = renewalScheduler;
        this.holdInventory = new RuntimeHoldInventory(executionRepository, sessionRepository);
        this.bindingRegistry = new RuntimeBindingRegistry(bindingRepository, provisioner,
                sessionRepository, sessionResolver, this.brokerOwnerId, this.operationLeaseDuration, clock);
        this.bindingProvisioning = new RuntimeBindingProvisioning(bindingRegistry, bindingRepository,
                sessionRepository, executionRepository, provisioner, transport, this.brokerOwnerId,
                this.operationLeaseDuration, clock, scheduler, closed, this::newBindingRenewal);
        this.terminalHolds = new TerminalHolds(this, bindingRegistry, bindingRepository,
                sessionRepository, executionRepository, clock, closed);
        this.backgroundProcessAdmission = new BackgroundProcessAdmission(bindingRepository,
                sessionRepository, executionRepository);
        this.executionState = new RuntimeExecutionState(bindingRepository, sessionRepository, executionRepository,
                this.brokerOwnerId, this.dispatchLeaseDuration, clock);
        this.executionDispatcher = new RuntimeExecutionDispatcher(bindingRegistry, executionState,
                bindingRepository, sessionRepository, executionRepository, provisioner, transport,
                publicationVerifier, this.brokerOwnerId, this.dispatchLeaseDuration, this.v3ResultWindow,
                clock, scheduler, renewalScheduler, closed);
        this.executionReconciler = new RuntimeExecutionReconciler(bindingRegistry, executionState, executionRepository,
                provisioner, transport, publicationVerifier, this.operationLeaseDuration, clock, scheduler, closed,
                new ExecutionObservationCooldown(clock, scheduler));
        this.executionRecovery = new RuntimeExecutionRecovery(bindingRegistry, executionState, executionRepository,
                sessionRepository, transport, executionReconciler, closed);
        this.executionCancellation = new RuntimeExecutionCancellation(bindingRegistry, executionState, executionRepository,
                transport, executionDispatcher, scheduler, this.operationLeaseDuration, closed);
        this.sessionRelease = new RuntimeSessionRelease(bindingRepository, sessionRepository, executionRepository,
                provisioner, transport, bindingRegistry, executionRecovery);
        this.drainCoordinator = new RuntimeDrainCoordinator(bindingRegistry, bindingRepository, sessionRepository,
                executionRepository, provisioner, transport, bindingProvisioning, executionRecovery,
                executionDispatcher, sessionRelease, this.brokerOwnerId, this.operationLeaseDuration,
                clock, closed, this::newBindingRenewal);
    }

    private BindingRenewal newBindingRenewal(RuntimeBindingRecord claimed) {
        return new BindingRenewal(claimed, bindingRepository, executionRepository,
                bindingRegistry, sessionRelease, brokerOwnerId, operationLeaseDuration,
                clock, closed, renewalScheduler);
    }

    public boolean supportsDrainedStop() {
        return provisioner.supportsDrainedStop();
    }

    public boolean supportsDrainedStop(RuntimeBindingRecord binding) {
        return provisioner.supportsDrainedStop(binding);
    }

    public void requestHarnessDrain(String tenantId, String harnessSessionId) {
        requireOpen(closed);
        bindingRepository.requestHarnessDrain(tenantId, harnessSessionId);
    }

    public CompletionStage<Void> drainHarnessSession(String tenantId, String harnessSessionId) {
        return drainCoordinator.drainHarnessSession(tenantId, harnessSessionId);
    }

    public CompletionStage<Void> closeResidentHarnessSession(RuntimeProvisionRequest request, String harnessSessionId) {
        return drainCoordinator.closeResidentHarnessSession(request, harnessSessionId);
    }

    public CompletionStage<Void> drainHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority, boolean stoppedOnly) {
        return drainCoordinator.drainHarnessResources(tenantId, harnessSessionId, authority, stoppedOnly);
    }

    public CompletionStage<Void> prepareHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        return drainCoordinator.prepareHarnessResources(tenantId, harnessSessionId, authority);
    }

    public CompletionStage<Void> retireStorageBinding(String tenantId, String storageId,
            String operationId, String bindingId, long generation) {
        return drainCoordinator.retireStorageBinding(tenantId, storageId, operationId, bindingId, generation);
    }

    public CompletionStage<RuntimeBindingRecord> warm(
            String harnessSessionId) {
        return warm(harnessSessionId, null);
    }

    public CompletionStage<RuntimeScope> capabilities(
            String harnessSessionId, RuntimeLifecycleAuthority authority) {
        return capabilitiesContext(harnessSessionId, authority).thenApply(HarnessSessionResolver.Capabilities::scope);
    }

    @Override
    public CompletionStage<HarnessSessionResolver.Capabilities> capabilitiesContext(String harnessSessionId, RuntimeLifecycleAuthority authority) {
        requireOpen(closed);
        return RuntimeBrokerSupport.resolveCapabilities(sessionResolver, harnessSessionId, authority);
    }

    public CompletionStage<List<Map<String, Object>>> mcpDefinitions(String harnessSessionId, String runtimeSessionId) {
        requireOpen(closed);
        String harnessId = BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        return resolveScope(harnessId, true, null).thenCompose(scope -> {
            bindingRepository.requireHarnessAdmission(scope, harnessId, null);
            RuntimeSessionRecord owner = McpOwners.resolve(sessionRepository, scope, harnessId, runtimeSessionId);
            CompletionStage<RuntimeBindingRecord> selected;
            if (owner != null) {
                RuntimeBindingRecord original = bindingRepository.findById(owner.getBindingId());
                if (!owner.getSession().getHarnessSessionId().equals(harnessId)
                        || !owner.getSession().getScope().equals(scope) || owner.getState() != RuntimeSessionRecord.State.READY
                        || original == null || original.getGeneration() != owner.getRuntimeGeneration()
                        || original.getState() != RuntimeBindingRecord.State.READY || original.isDrainRequested()
                        || !original.getRequest().getScope().equals(scope)) {
                    throw conflict("managed_mcp_owner_unavailable", "The original MCP Runtime is unavailable.");
                }
                selected = bindingRegistry.matchingLiveBinding(original) == null
                        ? bindingProvisioning.recoverBinding(original.getBindingId(), original.getGeneration(), true)
                        : CompletableFuture.completedFuture(original);
                selected = selected.thenApply(record -> {
                    if (!record.sameIdentity(original) || record.getGeneration() != original.getGeneration()) {
                        throw conflict("managed_mcp_owner_unavailable", "The original MCP Runtime changed.");
                    }
                    return record;
                });
            } else {
                RuntimeProvisionRequest request = provisionRequest(scope, harnessId);
                RuntimeBindingRecord existing = bindingRepository.findOrCreate(request);
                if (existing.getState() != RuntimeBindingRecord.State.READY
                        && existing.getState() != RuntimeBindingRecord.State.PROVISIONING) {
                    throw conflict("managed_mcp_owner_unavailable", "The selected MCP Runtime is unavailable.");
                }
                selected = bindingProvisioning.ensureBinding(request).thenApply(BindingContext::record);
            }
            return selected.thenCompose(record -> {
                RuntimeBindingRecord current = bindingRepository.findById(record.getBindingId());
                if (current == null || !current.sameIdentity(record) || current.getGeneration() != record.getGeneration()
                        || current.getState() != RuntimeBindingRecord.State.READY || current.isDrainRequested()) {
                    throw conflict("managed_mcp_owner_unavailable", "The selected MCP Runtime changed.");
                }
                bindingRegistry.requireLiveBinding(current);
                if (!provisioner.isUsable(current.getLease())) {
                    throw unavailable("managed_mcp_owner_unavailable", "The selected MCP Runtime is not alive.");
                }
                bindingRepository.requireHarnessAdmission(current.getRequest(), scope, harnessId, null);
                return transport.mcpDefinitions(current);
            });
        });
    }

    public CompletionStage<Map<String, Object>> extensionControl(String harnessSessionId, String expectedBindingId,
            Long expectedGeneration, Map<String, Object> operation) {
        requireOpen(closed);
        String harnessId = BrokerValues.requirePathSafe(BrokerValues.requireId(harnessSessionId, "harnessSessionId"), "harnessSessionId");
        Map<String, Object> immutable = immutableMap(operation, "extension operation");
        ManagedExtensionProtocol.validateOperation(immutable);
        boolean recovery = ManagedExtensionProtocol.isRecovery(immutable);
        boolean status = "extension-status".equals(immutable.get("kind")) || "extension-skill-candidates".equals(immutable.get("kind"));
        if ((expectedBindingId == null) != (expectedGeneration == null) || expectedBindingId == null && !status) {
            throw invalid("runtime_control_operation_invalid", "Extension mutations require the original Runtime identity.");
        }
        return resolveScope(harnessId, !recovery, null).thenCompose(scope -> {
            if (!ManagedExtensionExecutionProfile.admits(scope.getCapabilityDigest())) {
                throw conflict("managed_extension_unavailable", "The selected Runtime profile does not support extensions.");
            }
            RuntimeBindingRecord original;
            if (expectedBindingId != null) {
                original = bindingRepository.findById(expectedBindingId);
            } else {
                RuntimeBindingRecord found = null;
                String after = null;
                for (;;) {
                    var candidates = bindingRepository.findByHarnessSession(scope.getTenantId(), harnessId, after, 100);
                    for (var candidate : candidates) {
                        if (candidate.getState() == RuntimeBindingRecord.State.READY && !candidate.isDrainRequested()
                                && candidate.getRequest().getScope().equals(scope)) {
                            if (found != null) {
                                throw conflict("managed_extension_owner_unavailable", "The original extension Runtime is ambiguous.");
                            }
                            found = candidate;
                        }
                    }
                    if (candidates.size() < 100) {
                        break;
                    }
                    after = candidates.getLast().getBindingId();
                }
                if (found == null) {
                    throw conflict("managed_extension_owner_unavailable", "The original extension Runtime is unavailable or ambiguous.");
                }
                original = found;
            }
            if (original == null || expectedGeneration != null && original.getGeneration() != expectedGeneration
                    || !original.getRequest().getScope().equals(scope)
                    || !harnessId.equals(original.getRequest().getIsolationKey())
                    || original.getLease() == null
                    || original.getState() != RuntimeBindingRecord.State.READY
                    && !(recovery && original.getState() == RuntimeBindingRecord.State.DRAINING)
                    || !recovery && original.isDrainRequested()) {
                throw conflict("managed_extension_owner_unavailable", "The original extension Runtime changed.");
            }
            if (recovery) {
                bindingRepository.requireHarnessRecovery(original.getRequest(), scope, harnessId, null);
            } else {
                bindingRepository.requireHarnessAdmission(original.getRequest(), scope, harnessId, null);
            }
            return observeExtensionOwner(original).thenCompose(ignored -> {
                requireExtensionOwner(original, recovery);
                return transport.extensionControl(original, harnessId, immutable);
            }).thenApply(result -> {
                requireExtensionOwner(original, recovery);
                return Map.of("protocolVersion", 1, "harnessSessionId", harnessId,
                        "scope", Map.of("tenantId", scope.getTenantId(), "workspaceId", scope.getWorkspaceId(),
                                "workspaceGeneration", scope.getWorkspaceGeneration(), "isolationClass", scope.getIsolationClass(),
                                "capabilityDigest", scope.getCapabilityDigest()),
                        "runtime", Map.of("bindingId", original.getBindingId(), "generation", Long.toString(original.getGeneration())),
                        "result", result);
            });
        });
    }

    private void requireExtensionOwner(RuntimeBindingRecord original, boolean recovery) {
        RuntimeBindingRecord current = bindingRepository.findById(original.getBindingId());
        if (current == null || !current.sameIdentity(original) || current.getLease() == null
                || !sameLease(current.getLease(), original.getLease())
                || current.getState() != RuntimeBindingRecord.State.READY
                && !(recovery && current.getState() == RuntimeBindingRecord.State.DRAINING)
                || !recovery && current.isDrainRequested()) {
            throw conflict("managed_extension_owner_unavailable", "The original extension Runtime changed.");
        }
    }

    private CompletionStage<Void> observeExtensionOwner(RuntimeBindingRecord original) {
        if (bindingRegistry.matchingLiveBinding(original) != null && provisioner.isUsable(original.getLease())) {
            return CompletableFuture.completedFuture(null);
        }
        if (original.getProvisionSeed() == null || original.getResourceHandle() == null) {
            return failed(conflict("managed_extension_owner_unavailable", "The original extension Runtime cannot be observed."));
        }
        return safeStage(() -> provisioner.reconcile(original.getRequest(), original.getProvisionSeed(),
                original.getResourceHandle(), original.getLease())).thenCompose(observation -> {
                    RuntimeLease lease = original.getLease();
                    if (observation == null || observation.getOutcome() != RuntimeObservation.Outcome.READY
                            || !observation.matchesRuntime(original.getResourceHandle(), lease)) {
                        throw conflict("managed_extension_owner_unavailable", "The original extension Runtime cannot be observed.");
                    }
                    return safeStage(() -> transport.attest(lease, original.getRequest(), original.getProvisionSeed()))
                            .thenAccept(attestation -> {
                                if (!RuntimeBindingProvisioning.validAttestation(attestation, lease, original.getProvisionSeed(), original.getRequest())) {
                                    throw conflict("managed_extension_owner_unavailable", "The original extension Runtime identity changed.");
                                }
                            });
                });
    }

    public CompletionStage<RuntimeBindingRecord> warm(String harnessSessionId, RuntimeLifecycleAuthority authority) {
        requireOpen(closed);
        String harnessId = BrokerValues.requirePathSafe(
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
                "harnessSessionId");
        return resolveScope(harnessId, true, authority)
                .thenCompose(scope -> bindingProvisioning.ensureBinding(
                        provisionRequest(scope, harnessId)))
                .thenApply(BindingContext::record);
    }

    public String runtimeProvisionerKind(RuntimeSessionRecord record) {
        return bindingRegistry.runtimeProvisionerKind(record);
    }

    public CompletionStage<RuntimeSessionRecord> acquire(
            String harnessSessionId, String runtimeSessionId,
            String turnKind) {
        return acquire(harnessSessionId, runtimeSessionId, turnKind, null);
    }

    public CompletionStage<RuntimeSessionRecord> acquire(String harnessSessionId, String runtimeSessionId,
            String turnKind, RuntimeLifecycleAuthority authority) {
        return acquire(harnessSessionId, runtimeSessionId, turnKind, authority, null);
    }

    /**
     * Acquires the Runtime Session and records {@code mountClaimId} as the
     * claim a later {@link #releaseMount} must name: any later acquire of
     * the same identity supersedes it, so a stale mount handback can never
     * free the mount of a turn that re-drove this Session. A mount handed
     * back earlier is claimed again here, never left to fail every tool.
     */
    public CompletionStage<RuntimeSessionRecord> acquire(String harnessSessionId, String runtimeSessionId,
            String turnKind, RuntimeLifecycleAuthority authority, String mountClaimId) {
        requireOpen(closed);
        String harnessId = BrokerValues.requirePathSafe(
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
                "harnessSessionId");
        String runtimeId = BrokerValues.requirePathSafe(
                BrokerValues.requireId(runtimeSessionId, "runtimeSessionId"),
                "runtimeSessionId");
        CompletableFuture<SessionContext> current = bindingRegistry.session(runtimeId);
        if (current != null) {
            return current.thenCompose(context -> {
                RuntimeSessionRecord record;
                context.lock();
                try {
                    bindingRepository.requireHarnessAdmission(context.binding().getRequest(),
                            context.session().getScope(), harnessId, authority);
                    requireSameSession(context.session(), new RuntimeSession(harnessId,
                            runtimeId, turnKind, context.session().getScope()));
                    record = requireAcquireSessionRecord(context);
                    context.mountClaim(mountClaimId);
                } finally {
                    context.unlock();
                }
                return reclaimMount(context, record);
            });
        }
        // A Runtime Session this process does not hold yet admits new work
        // (ensureBinding can provision a Runtime), so it takes the admission
        // resolve like warm; release and reconcile stay off the fence.
        return resolveScope(harnessId, true, authority).thenCompose(scope -> {
            RuntimeSession session = new RuntimeSession(harnessId,
                    runtimeId, turnKind, scope);
            return acquireSession(session, mountClaimId);
        });
    }

    public CompletionStage<RuntimeSessionRecord> acquireRecovery(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation) {
        return acquireRecovery(harnessSessionId, runtimeSessionId, bindingId, generation, null);
    }

    public CompletionStage<RuntimeSessionRecord> acquireRecovery(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation, RuntimeLifecycleAuthority authority) {
        return acquireRecovery(harnessSessionId, runtimeSessionId, bindingId, generation, authority, null);
    }

    public CompletionStage<RuntimeSessionRecord> acquireRecovery(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation, RuntimeLifecycleAuthority authority, String mountClaimId) {
        requireOpen(closed);
        RuntimeBindingRecord original = bindingRepository.findById(bindingId);
        boolean shared = original != null && HarnessOwnership.sharesRuntimeSessions(original.getRequest());
        if (original == null || original.getGeneration() != generation
                || !shared && (!harnessSessionId.equals(original.getRequest().getIsolationKey())
                        || !"session".equals(original.getRequest().getScope().getIsolationClass()))
                || original.getState() != RuntimeBindingRecord.State.READY) {
            return failed(conflict("workspace_close_identity_unverified", "Original Hook Runtime is unavailable"));
        }
        bindingRepository.requireHarnessRecovery(original.getRequest(), original.getRequest().getScope(),
                harnessSessionId, authority);
        RuntimeSessionRecord saved = sessionRepository.findById(original.getRequest().getScope(), runtimeSessionId);
        if (saved == null || !harnessSessionId.equals(saved.getSession().getHarnessSessionId())
                || !bindingId.equals(saved.getBindingId()) || saved.getRuntimeGeneration() != generation
                || saved.getState() != RuntimeSessionRecord.State.READY) {
            return failed(conflict("workspace_close_identity_unverified", "Original Hook Session is unavailable"));
        }
        CompletionStage<RuntimeBindingRecord> recovered = bindingRegistry.matchingLiveBinding(original) == null
                ? bindingProvisioning.recoverBinding(bindingId, generation, true) : CompletableFuture.completedFuture(original);
        return recovered.thenCompose(record -> {
            if (record.getState() != RuntimeBindingRecord.State.READY || !record.sameIdentity(original)) {
                throw conflict("workspace_close_identity_unverified", "Original Hook Runtime cannot be recovered");
            }
            BindingContext live = bindingRegistry.requireLiveBinding(record);
            var context = CompletableFuture.completedFuture(new SessionContext(saved.getSession(), record, live.lease()));
            var existing = bindingRegistry.registerSession(runtimeSessionId, context);
            SessionContext selected = context.join();
            if (existing != null) {
                if (!existing.isDone() || existing.isCompletedExceptionally()) {
                    throw conflict("workspace_close_identity_unverified", "Original Hook Session is not attested in this Broker");
                }
                selected = existing.join();
                requireSameSession(selected.session(), saved.getSession());
                if (!selected.binding().sameIdentity(original)) {
                    throw conflict("workspace_close_identity_unverified", "Hook Runtime identity changed");
                }
            }
            selected.mountClaim(mountClaimId);
            return reclaimMount(selected, saved);
        });
    }

    // A recovery-blocked turn may have handed the mount back (#13800); the
    // Session that acquires this identity again needs it held, or every
    // tool and recovery control would answer workspace_busy. The claim is
    // holder-conditioned, so a mount still held is left as it is and one a
    // rival took answers the retryable busy refusal.
    private CompletionStage<RuntimeSessionRecord> reclaimMount(SessionContext context,
            RuntimeSessionRecord record) {
        return safeStage(() -> transport.reclaimMount(context.lease(), context.session()))
                .thenApply(ignored -> record);
    }

    public CompletionStage<RuntimeScope> authorizeLifecycle(String harnessSessionId, RuntimeLifecycleAuthority authority) {
        if (authority == null) {
            return failed(conflict("runtime_lifecycle_authority_required", "Lifecycle authority is required"));
        }
        return resolveScope(harnessSessionId, authority).thenApply(scope -> {
            bindingRepository.requireHarnessAdmission(scope, harnessSessionId, authority);
            return scope;
        });
    }

    public void configureExtensionCommandVerifier(RuntimeExtensionCommandVerifier verifier) {
        this.extensionCommandVerifier = Objects.requireNonNull(verifier, "verifier");
    }

    public CompletionStage<Object> control(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> operation) {
        return control(harnessSessionId, runtimeSessionId, operation, null);
    }

    public CompletionStage<Object> control(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> operation, RuntimeLifecycleAuthority authority) {
        requireOpen(closed);
        Map<String, Object> immutable = immutableMap(operation,
                "operation");
        if (ManagedExtensionProtocol.isOperation(immutable)) {
            throw invalid("runtime_control_operation_invalid", "Extensions require the metadata control route.");
        }
        if (CsiFileHistoryProtocol.isOperation(immutable)) {
            CsiFileHistoryProtocol.operation(immutable);
            if (authority != null) {
                throw conflict("runtime_lifecycle_operation_invalid", "CSI history cannot use lifecycle authority");
            }
            return csiFileHistory(harnessSessionId, runtimeSessionId, immutable);
        }
        if (!ManagedMcpProtocol.isOperation(immutable) && !ManagedHookProtocol.isOperation(immutable)
                && !ManagedExtensionCommandProtocol.isOperation(immutable)
                && !ManagedMonitorProtocol.isOperation(immutable)) {
            ProviderRuntimeProtocol.control(immutable, harnessSessionId, runtimeSessionId);
        }
        return bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    if (CsiFilesRetirementProfile.isProfile(context.session().getScope())) {
                        throw new RuntimeBrokerException(501, "csi_control_not_qualified",
                                "Generic CSI runtime controls are not qualified.", false);
                    }
                    if (ManagedMcpProtocol.isOperation(immutable)) {
                        ManagedMcpProtocol.validateSession(context.session(), immutable);
                    }
                    if (ManagedHookProtocol.isOperation(immutable)) {
                        ManagedHookProtocol.validateSession(context.session(), immutable);
                    }
                    if (ManagedExtensionCommandProtocol.isOperation(immutable)) {
                        ManagedExtensionCommandProtocol.validateSession(context.session(), immutable);
                    }
                    ToolExecutionRecord watch = ManagedMonitorProtocol.isOperation(immutable)
                            ? requireMonitorWatch(context, immutable) : null;
                    boolean recovery = ManagedMcpProtocol.isRecovery(immutable) || ManagedHookProtocol.isRecovery(immutable)
                            || ManagedExtensionCommandProtocol.isRecovery(immutable)
                            || ManagedMonitorProtocol.isRecovery(immutable);
                    if (recovery && bindingRepository.requireHarnessRecovery(context.binding().getRequest(),
                            context.session().getScope(), harnessSessionId, authority)) {
                        if ("mcp-release".equals(immutable.get("kind"))
                                && !bindingRepository.isHarnessDraining(context.session().getScope().getTenantId(), harnessSessionId)) {
                            throw conflict("runtime_lifecycle_operation_invalid", "MCP release requires resource drain");
                        }
                    }
                    if (!recovery) {
                        if (authority != null && !ManagedHookProtocol.isOperation(immutable)) {
                            throw conflict("runtime_lifecycle_operation_invalid", "Only Hook control may use lifecycle authority");
                        }
                        if (ManagedHookProtocol.isOperation(immutable)) {
                            bindingRepository.requireHookAdmission(context.binding().getRequest(),
                                    context.session().getScope(), harnessSessionId, authority);
                        } else {
                            bindingRepository.requireHarnessAdmission(context.binding().getRequest(),
                                    context.session().getScope(), harnessSessionId, authority);
                        }
                    }
                    // A Monitor control runs unfenced, like the scan's status
                    // ask: its watch's hold row, not the control fence, keeps
                    // the Runtime Session from releasing while the watch may
                    // run, so the watch's own turn finishing during an
                    // auto-stop answers held, never busy (#13896).
                    boolean fenced = watch == null;
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        if (ManagedExtensionCommandProtocol.isOperation(immutable)) {
                            if (extensionCommandVerifier == null) {
                                throw new RuntimeBrokerException(501, "managed_extension_command_unavailable",
                                        "Extension command permission verification is unavailable.", false);
                            }
                            extensionCommandVerifier.verify(context.binding(), context.session(), immutable);
                        }
                        if (fenced) {
                            context.beginControl();
                        }
                    } finally {
                        context.unlock();
                    }
                    CompletionStage<Object> result;
                    try {
                        bindingRegistry.requireUsableLease(context);
                        result = mapFailure(safeStage(() ->
                                transport.control(context.lease(),
                                        authority == null && context.session().getScope().getLifecycleAuthority() == null ? context.session()
                                                : new RuntimeSession(context.session().getHarnessSessionId(), context.session().getRuntimeSessionId(),
                                                        context.session().getTurnKind(), context.session().getScope().withLifecycleAuthority(authority)), immutable)),
                                "runtime_control_failed",
                                "Runtime control operation failed");
                    } catch (RuntimeException | Error failure) {
                        if (fenced) {
                            context.endControl();
                        }
                        throw failure;
                    }
                    if (watch != null) {
                        // The worker's exit evidence ends the watch's hold
                        // here, as the sweep's own answer would: a Harness
                        // auto-stop releases the row without a close (#13896).
                        result = result.thenApply(view -> {
                            if (view instanceof Map<?, ?> answer
                                    && "exited".equals(answer.get("state"))) {
                                executionState.settleBackgroundProcess(watch, (Map<String, Object>) view);
                            }
                            return view;
                        });
                    }
                    return result.whenComplete((ignored, error) -> {
                        if (fenced) {
                            context.endControl();
                        }
                    });
                });
    }

    private CompletionStage<Object> csiFileHistory(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> operation) {
        return bindingRegistry.requireSession(harnessSessionId, runtimeSessionId).thenCompose(context -> {
            if (!CsiFilesRetirementProfile.isProfile(context.session().getScope())) {
                throw conflict("runtime_control_invalid", "CSI history requires the original private Runtime");
            }
            context.lock();
            try {
                RuntimeSessionRecord record = sessionRepository.findById(context.session().getScope(), runtimeSessionId);
                RuntimeBindingRecord parent = bindingRepository.findById(context.binding().getBindingId());
                if (record == null || parent == null
                        || !record.getSession().getHarnessSessionId().equals(harnessSessionId)
                        || !record.getSession().getRuntimeSessionId().equals(runtimeSessionId)
                        || !record.getSession().getTurnKind().equals(context.session().getTurnKind())
                        || !record.getSession().getScope().equals(context.session().getScope())
                        || !record.getBindingId().equals(parent.getBindingId())
                        || record.getRuntimeGeneration() != context.binding().getGeneration()
                        || parent.getGeneration() != context.binding().getGeneration()
                        || !parent.hasSameLease(context.lease())
                        || parent.getState() != RuntimeBindingRecord.State.READY || parent.isDrainRequested()
                        || record.getState() != RuntimeSessionRecord.State.READY) {
                    throw conflict("csi_original_runtime_unavailable", "Original CSI history owner is unavailable");
                }
                bindingRegistry.requireReadySessionRecord(context);
                bindingRepository.requireHarnessAdmission(context.session().getScope(), harnessSessionId, null);
                context.beginControl();
            } finally {
                context.unlock();
            }
            CompletionStage<Object> result;
            try {
                if (!provisioner.isUsable(context.lease())) {
                    throw conflict("csi_original_runtime_unavailable", "Original CSI worker is unavailable");
                }
                result = mapFailure(safeStage(() -> transport.control(context.lease(), context.session(), operation)),
                        "csi_file_history_unavailable", "Original CSI history observation failed");
            } catch (RuntimeException | Error failure) {
                context.endControl();
                throw failure;
            }
            return result.whenComplete((ignored, error) -> context.endControl());
        });
    }

    /**
     * A client Monitor control names one of this Runtime Session's own
     * watches: {@code operationId} is the execution that started it and
     * {@code targetOperationId} the call the worker derived its unit from.
     * Another Session's watch, a row of another family or a mismatched pair
     * is refused with the protocol's own shape before the worker sees it.
     */
    private ToolExecutionRecord requireMonitorWatch(SessionContext context,
            Map<String, Object> operation) {
        ManagedMonitorProtocol.validateSession(context.session(), operation);
        String rowId = operation.get("operationId") + ":process";
        // Every hold row passed the ledger's id bounds on the way in, so an
        // id that cannot (a NUL, or too long once suffixed) names no watch:
        // it gets the protocol's refusal, not the ledger's (#13896).
        ToolExecutionRecord watch;
        try {
            watch = executionRepository.findByExecutionCallId(
                    BrokerValues.requireId(rowId, "operationId"));
        } catch (IllegalArgumentException unnamed) {
            watch = null;
        }
        if (watch == null || ManagedHoldFamily.of(watch) != ManagedHoldFamily.MONITOR
                || !operation.get("targetOperationId").equals(watch.getReference().get("callId"))
                || !watch.getHarnessSessionId().equals(context.session().getHarnessSessionId())
                || !watch.getRuntimeSessionId().equals(context.session().getRuntimeSessionId())
                || !watch.getBindingId().equals(context.binding().getBindingId())
                || watch.getRuntimeGeneration() != context.binding().getGeneration()) {
            throw invalid("runtime_control_operation_invalid",
                    "Monitor operation does not belong to the acquired Session.");
        }
        return watch;
    }

    public CompletionStage<ToolExecutionRecord> createExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference) {
        requireOpen(closed);
        String key = BrokerValues.requireId(idempotencyKey,
                "idempotencyKey");
        if (reference == null || reference.containsKey("dispatchMode")
                || reference.containsKey("payloadDigest")
                || reference.containsKey("publicationId")
                || reference.containsKey("runtimeProtocol")
                || reference.containsKey("inputDigest")
                || reference.containsKey("executionCallId")) {
            throw invalid("runtime_reference_invalid", "Execution reference contains reserved fields");
        }
        Map<String, Object> immutable;
        try {
            immutable = immutableMap(reference, "reference");
        } catch (RuntimeBrokerException invalidReference) {
            return CompletableFuture.failedFuture(invalidReference);
        }
        if (immutable.containsKey("invocationId") || immutable.containsKey("capabilityDigest")
                || immutable.containsKey("policyRevision")) {
            return CompletableFuture.failedFuture(invalid("runtime_reference_invalid",
                    "Prepared provider invocations require reserve and start"));
        }
        return createExecutionReceipt(harnessSessionId, runtimeSessionId, key, immutable, true);
    }

    public CompletionStage<ToolExecutionRecord> prepareExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference) {
        return prepareExecution(harnessSessionId, runtimeSessionId,
                idempotencyKey, reference, null);
    }

    @Override
    public CompletionStage<TerminalHoldAdmission> admitTerminalHold(
            String harnessSessionId, String terminalId) {
        return terminalHolds.admit(harnessSessionId, terminalId);
    }

    @Override
    public CompletionStage<ToolExecutionRecord> abandonTerminalHold(
            String harnessSessionId, String terminalId, String executionCallId) {
        return terminalHolds.abandon(harnessSessionId, terminalId, executionCallId);
    }

    @Override
    public CompletionStage<Void> markTerminalPtyEstablished(
            String harnessSessionId, String terminalId) {
        return terminalHolds.markPtyEstablished(harnessSessionId, terminalId);
    }

    public CompletionStage<ToolExecutionRecord> prepareCsiExecution(String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference, byte[] inputBytes, byte[] definitionBytes) {
        requireOpen(closed);
        String key = BrokerValues.requireId(idempotencyKey, "idempotencyKey");
        Map<String, Object> deferred = new LinkedHashMap<>(immutableMap(reference, "reference"));
        if (deferred.containsKey("dispatchMode") || inputBytes == null || definitionBytes == null) {
            throw invalid("runtime_reference_invalid", "Private CSI allocation fields are invalid");
        }
        deferred.put("dispatchMode", "deferred");
        Map<String, Object> immutable = immutableMap(deferred, "reference");
        byte[] input = inputBytes.clone();
        byte[] definition = definitionBytes.clone();
        return mapStoreFailure(safeStage(() -> bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                .thenApply(context -> {
                    context.lock();
                    try {
                        NativeCsiExecutionRepository jdbc = privateCsiRepository(context);
                        ToolExecutionRecord candidate = ToolExecutionRecord.prepared(nextExecutionId(), key,
                                context.binding().getBindingId(), context.binding().getGeneration(), harnessSessionId, runtimeSessionId,
                                referenceString(immutable, "promptId"), referenceString(immutable, "callId"),
                                referenceString(immutable, "argsDigest"), immutable);
                        return jdbc.prepareCsiExecution(sessionRepository, executionRepository, context.binding(), candidate, input, definition);
                    } finally {
                        context.unlock();
                    }
                })));
    }

    public CompletionStage<Map<String, Object>> readCsiBatch(String harnessSessionId, String runtimeSessionId,
            String promptId, String batchId) {
        return readCsiBatch(harnessSessionId, runtimeSessionId, promptId, batchId, null);
    }

    public CompletionStage<Map<String, Object>> readCsiBatch(String harnessSessionId, String runtimeSessionId,
            String promptId, String batchId, Map<String, Object> recoveryOwner) {
        requireOpen(closed);
        BrokerValues.requireId(promptId, "promptId");
        BrokerValues.requireId(batchId, "batchId");
        return mapStoreFailure(safeStage(() -> bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                .thenApply(context -> {
                    context.lock();
                    try {
                        return privateCsiRepository(context).readCsiBatch(sessionRepository, executionRepository,
                                context.binding(), promptId, batchId, recoveryOwner);
                    } finally {
                        context.unlock();
                    }
                })));
    }

    private NativeCsiExecutionRepository privateCsiRepository(SessionContext context) {
        bindingRegistry.requireReadySessionRecord(context);
        if (!CsiFilesRetirementProfile.isProfile(context.binding().getRequest().getScope())
                || !context.session().getHarnessSessionId().equals(context.session().getRuntimeSessionId())
                || !context.session().getRuntimeSessionId().equals(context.binding().getRequest().getIsolationKey())
                || !context.session().getScope().equals(context.binding().getRequest().getScope())
                || !(bindingRepository instanceof NativeCsiExecutionRepository jdbc)) {
            throw invalid("csi_native_reservation_unavailable", "Original private CSI repositories are required");
        }
        return jdbc;
    }

    /** A v3 reservation keeps the raw payload digest distinct from canonical input. */
    public CompletionStage<ToolExecutionRecord> prepareExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference,
            String payloadDigest) {
        return prepareExecution(harnessSessionId, runtimeSessionId,
                idempotencyKey, reference, payloadDigest, null);
    }

    public CompletionStage<ToolExecutionRecord> prepareExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference,
            String payloadDigest, String publicationId) {
        requireOpen(closed);
        String key = BrokerValues.requireId(idempotencyKey, "idempotencyKey");
        return prepareExecutionReference(runtimeSessionId, reference, payloadDigest, publicationId)
                .thenCompose(immutable -> createExecutionReceipt(harnessSessionId, runtimeSessionId, key, immutable, false));
    }

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, String payloadJson) {
        return startExecution(harnessSessionId, runtimeSessionId,
                executionCallId, payloadJson, null, null);
    }

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, String payloadJson,
            String publicationId, String publicationToken) {
        requireOpen(closed);
        String executionId = BrokerValues.requireId(executionCallId, "executionCallId");
        CompletionStage<ToolExecutionRecord> started = bindingRegistry.requireReadySession(
                harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        ToolExecutionRecord record = executionState.requireExecution(context, executionId);
                        if (RuntimeToolMeasurements.selected(record.getReference())) {
                            RuntimeToolMeasurements.requireProfile(context.session());
                        }
                        boolean v3 = isPublicationV3(record.getReference());
                        if (!"deferred".equals(record.getReference().get("dispatchMode")) && !v3) {
                            throw conflict("runtime_execution_conflict", "Execution was not reserved for deferred dispatch");
                        }
                        if (v3 && (publicationVerifier == null || publicationId == null
                                || publicationToken == null)) {
                            throw unavailable("runtime_execution_publication_required",
                                    "Tool v3 requires an installed publication before dispatch", null);
                        }
                        if (v3 && !publicationId.equals(record.getReference().get("publicationId"))) {
                            throw conflict("runtime_execution_conflict", "Original publication ID changed");
                        }
                        if (!v3 && (publicationId != null || publicationToken != null)) {
                            throw invalid("runtime_reference_invalid", "Tool v2 has no publication grant");
                        }
                        // The UTF-8 encoder would turn an unpaired surrogate into '?'.
                        if (payloadJson == null || !BrokerValues.isWellFormedJson(payloadJson)) {
                            throw invalid("runtime_payload_invalid", "Tool payload is invalid");
                        }
                        byte[] bytes = payloadJson.getBytes(StandardCharsets.UTF_8);
                        if (bytes.length > 256 * 1024) {
                            throw invalid("runtime_payload_invalid", "Tool payload exceeds 256 KiB");
                        }
                        String digest = "sha256:" + DigestUtils.sha256Hex(bytes);
                        if (!digest.equals(record.getRequestDigest())) {
                            throw conflict("runtime_idempotency_conflict", "Tool payload differs from its reserved digest");
                        }
                        Map<String, Object> payload = JsonCodec.parseObject(bytes, "tool payload");
                        // An escaped unpaired surrogate passes the text check above but
                        // would still reach the Worker, and run, as '?'.
                        if (!payload.keySet().equals(Set.of("toolName", "input"))
                                || !(payload.get("toolName") instanceof String toolName) || toolName.isEmpty()
                                || !(payload.get("input") instanceof Map)
                                || !BrokerValues.isWellFormedJson(payload)
                                || isProtocolV3(record.getReference())
                                    && !"run_shell_command".equals(toolName) && !"monitor".equals(toolName)) {
                            throw invalid("runtime_payload_invalid", "Tool payload is invalid");
                        }
                        if (CsiFilesRetirementProfile.isProfile(context.binding().getRequest().getScope())
                                && (v3 || !Set.of("read_file", "write_file", "edit").contains(toolName))) {
                            throw invalid("runtime_payload_invalid", "The private CSI profile requires a file Tool v2 payload");
                        }
                        if (ResidentWorkspaceProfile.selects(context.binding().getRequest().getScope())
                                && (v3 || !Set.of("read_file", "write_file", "edit").contains(toolName))) {
                            Map<String, Object> refusal = new LinkedHashMap<>();
                            refusal.put("executionStatus", "not_started");
                            refusal.put("responseParts", List.of());
                            refusal.put("capture", null);
                            refusal.put("error", Map.of("type", "resident_tool_unsupported",
                                    "message", "Resident Workspace supports only read_file, write_file and edit."));
                            ToolExecutionRecord settled = executionRepository.settlePrepared(record, refusal, clock.instant());
                            return CompletableFuture.completedFuture(settled == null
                                    ? executionState.requireExecution(context, executionId) : settled);
                        }
                        if (v3) {
                            if (!"run_shell_command".equals(payload.get("toolName"))
                                    && !"monitor".equals(payload.get("toolName"))) {
                                throw invalid("runtime_payload_invalid", "Tool v3 requires Shell or Monitor");
                            }
                            RuntimePublicationGrant grant = publicationVerifier.verify(record,
                                    publicationId, publicationToken);
                            if (!shouldDriveDispatch(record)) {
                                return CompletableFuture.completedFuture(record);
                            }
                            bindingRegistry.requireUsableLease(context);
                            return mapFailure(safeStage(() -> transport.installPublication(
                                    context.lease(), context.session(), grant)),
                                    "runtime_publication_install_failed", "Publication installation failed")
                                    .thenApply(ignored -> {
                                        context.lock();
                                        try {
                                            ToolExecutionRecord current = executionRepository
                                                    .findByExecutionCallId(executionId);
                                            if (current == null || current.isTerminal()
                                                    || current.isCancelRequested()
                                                    || current.getState() == ToolExecutionRecord.State.UNKNOWN) {
                                                return current == null ? record : current;
                                            }
                                            // The detached family holds its Runtime
                                            // through its own ledger row: a monitor
                                            // turn for `monitor`, the Shell process
                                            // for `is_background`. The family keys on
                                            // the validated toolName, never on the
                                            // optional caller marker (#13930 R1-23):
                                            // a marker-less monitor payload must
                                            // still admit its hold row.
                                            Map<?, ?> toolInput = (Map<?, ?>) payload.get("input");
                                            ManagedHoldFamily family = "monitor".equals(toolName)
                                                    ? ManagedHoldFamily.MONITOR
                                                    : Boolean.TRUE.equals(toolInput.get("is_background"))
                                                            ? ManagedHoldFamily.SHELL
                                                            : null;
                                            if (family != null) {
                                                admitBackgroundProcess(context, current, family);
                                            }
                                            executionDispatcher.beginDispatch(context, current, payload, grant);
                                            ToolExecutionRecord latest = executionRepository
                                                    .findByExecutionCallId(executionId);
                                            return latest == null ? current : latest;
                                        } finally {
                                            context.unlock();
                                        }
                                    });
                        }
                        if (shouldDriveDispatch(record)) {
                            executionDispatcher.beginDispatch(context, record, payload);
                        }
                        ToolExecutionRecord latest = executionRepository.findByExecutionCallId(executionId);
                        return CompletableFuture.completedFuture(latest == null ? record : latest);
                    } finally {
                        context.unlock();
                    }
                });
        return mapStoreFailure(executionState.unknownWhenAdmissionClosed(started,
                harnessSessionId, runtimeSessionId, executionId)
                .thenCompose(record -> executionReconciler.measuredResult(record, 0)));
    }

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId, String executionCallId) {
        requireOpen(closed);
        String executionId = BrokerValues.requireId(executionCallId, "executionCallId");
        CompletionStage<ToolExecutionRecord> started = bindingRegistry.requireReadySession(
                harnessSessionId, runtimeSessionId)
                .thenApply(context -> {
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        ToolExecutionRecord record = executionState.requireExecution(context, executionId);
                        if (!ProviderRuntimeProtocol.isReference(record.getReference())) {
                            throw invalid("runtime_payload_invalid", "Deferred execution requires payloadJson");
                        }
                        ProviderRuntimeProtocol.reference(record.getReference(), runtimeSessionId);
                        if (shouldDriveDispatch(record)) {
                            executionDispatcher.beginDispatch(context, record);
                        }
                        return executionState.requireExecution(context, executionId);
                    } finally {
                        context.unlock();
                    }
                });
        return mapStoreFailure(executionState.unknownWhenAdmissionClosed(started,
                harnessSessionId, runtimeSessionId, executionId));
    }

    private CompletionStage<ToolExecutionRecord> createExecutionReceipt(
            String harnessSessionId, String runtimeSessionId, String key,
            Map<String, Object> reference, boolean dispatch) {
        // Clients replay an idempotent prepare once on retryable failure; an
        // unmapped store outage must read as that class, not as a terminal
        // 500 carrying an unclassified retryable flag.
        return mapStoreFailure(safeStage(() -> {
            ToolExecutionRecord receipt = executionRepository.findByIdempotencyKey(key);
            if (receipt != null && receipt.isTerminal()) {
                executionState.requireOwnedExecution(harnessSessionId, runtimeSessionId,
                        receipt.getExecutionCallId());
                RuntimeBindingRecord parent = bindingRepository.findById(receipt.getBindingId());
                if (parent != null && CsiFilesRetirementProfile.isProfile(parent.getRequest().getScope())) {
                    throw invalid("csi_native_resources_required", "Private CSI retry requires original resource bytes");
                }
                if (!BrokerValues.sameJsonMap(receipt.getReference(),
                        immutableMap(reference, "reference"))) {
                    throw conflict("runtime_idempotency_conflict",
                            "idempotency key belongs to another request");
                }
                return executionReconciler.measuredResult(receipt, 0);
            }
            return bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                    .thenApply(context -> createExecution(context, key, reference, dispatch));
        }));
    }

    public CompletionStage<ToolExecutionRecord> getExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen(closed);
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return mapStoreFailure(safeStage(() -> {
            ToolExecutionRecord saved = executionState.requireOwnedExecution(harnessSessionId,
                    runtimeSessionId, executionId);
            if (saved.isTerminal()) {
                return executionReconciler.measuredResult(saved, 0);
            }
            if (isPublicationV3(saved.getReference())) {
                if (saved.getState() == ToolExecutionRecord.State.UNKNOWN
                        && publicationVerifier != null) {
                    Map<String, Object> durable = publicationVerifier.finished(saved);
                    if (durable != null) {
                        return CompletableFuture.completedFuture(executionReconciler.absorbRuntimeStatus(saved,
                                Map.of("state", "settled", "result", durable), false).getRecord());
                    }
                }
            }
            return executionState.unknownWhenAdmissionClosed(
                    bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                            .thenApply(context -> executionState.requireExecution(context,
                                    executionId)),
                    harnessSessionId, runtimeSessionId, executionId);
        }));
    }

    /**
     * The runtime Session ids of this Harness Session still owed the close's
     * drain — restore the obligation after a restart, never discharge it
     * (#13930 R1-2). The durable pagination and the RELEASED-only discharge
     * invariant live in {@link RuntimeHoldInventory}; this method keeps the
     * admission, tenant resolution and error-mapping boundary.
     */
    public CompletionStage<List<String>> listActiveHoldRuntimeSessionIds(
            String harnessSessionId) {
        requireOpen(closed);
        String id = BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        return mapFailure(safeStage(() -> sessionResolver.resolveTenant(id)),
                "runtime_hold_inventory_scope_failed",
                "Runtime hold inventory scope resolution failed")
                .thenApply(tenant -> holdInventory.activeRuntimeSessionIds(id, tenant));
    }

    public CompletionStage<Map<String, Object>> installPublisher(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> publisher) {
        requireOpen(closed);
        Map<String, Object> descriptor = immutableMap(publisher, "publisher");
        return mapStoreFailure(safeStage(() -> bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        context.beginControl();
                    } finally {
                        context.unlock();
                    }
                    return safeStage(() -> {
                        bindingRegistry.requireUsableLease(context);
                        return transport.installPublisher(context.lease(), context.session(), descriptor);
                    }).thenApply(ignored -> Map.<String, Object>of("installed", true,
                            "bindingGeneration", Long.toString(context.binding().getGeneration())))
                            .whenComplete((ignored, error) -> context.endControl());
                })));
    }

    private CompletionStage<Map<String, Object>> acknowledgeLocalExecution(String harnessSessionId,
            String runtimeSessionId, String executionCallId, Map<String, Object> receipt) {
        requireOpen(closed);
        Map<String, Object> savedReceipt = immutableMap(receipt, "receipt");
        return bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId).thenCompose(context -> {
            ToolExecutionRecord record;
            context.lock();
            try {
                bindingRegistry.requireReadySessionRecord(context);
                record = executionState.requireExecution(context, executionCallId);
                if (!record.isSettled()
                        || !isProtocolV3(record.getReference())
                        || !record.getExecutionCallId().equals(savedReceipt.get("executionCallId"))) {
                    throw conflict("runtime_execution_conflict", "Only the original settled Tool v3 result can be acknowledged");
                }
                Map<String, Object> noStart = sshNoStartReceipt(context.binding(), record);
                if (noStart != null && !sameReceipt(noStart, savedReceipt)) {
                    throw conflict("runtime_execution_conflict", "Session receipt conflicts with the durable no-start result");
                }
                context.beginControl();
            } finally {
                context.unlock();
            }
            return safeStage(() -> {
                bindingRegistry.requireUsableLease(context);
                return RuntimeToolMeasurements.selected(record.getReference())
                        ? executionReconciler.acknowledgeMeasured(context, record, savedReceipt)
                        : transport.acknowledge(context.lease(), context.session(), record.getReference(), savedReceipt);
            }).thenApply(status -> {
                if (!"settled".equals(status.get("state"))) {
                    throw conflict("runtime_execution_conflict", "Runtime did not confirm the result acknowledgement");
                }
                return status;
            }).whenComplete((ignored, error) -> context.endControl());
        });
    }

    public CompletionStage<Map<String, Object>> acknowledgeExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, Map<String, Object> receipt) {
        requireOpen(closed);
        String id = BrokerValues.requireId(executionCallId, "executionCallId");
        return mapStoreFailure(safeStage(() -> bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    ToolExecutionRecord execution = executionState.requireExecution(context, id);
                    if (!isPublicationV3(execution.getReference())) {
                        return acknowledgeLocalExecution(harnessSessionId, runtimeSessionId, id, receipt);
                    }
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        execution = executionState.requireExecution(context, id);
                        if (!execution.isSettled()
                                || !execution.getBindingId().equals(context.binding().getBindingId())
                                || execution.getRuntimeGeneration() != context.binding().getGeneration()
                                || publicationVerifier == null && sshNoStartReceipt(context.binding(), execution) == null) {
                            throw conflict("runtime_execution_conflict", "Original Tool v3 execution is unavailable");
                        }
                        context.beginControl();
                    } finally {
                        context.unlock();
                    }
                    ToolExecutionRecord original = execution;
                    if (isDetachedCapture(original.getResult())) {
                        return mapFailure(safeStage(() -> {
                            // The detached family has no publication durable
                            // of its own: the settled handle envelope is
                            // canonical, and a matching blocked receipt
                            // acknowledges exactly it. The refuse-rides the
                            // stage so the control always ends with it.
                            if (receipt == null
                                    || !receipt.keySet().equals(Set.of("executionCallId",
                                            "manifest", "deliveryStatus", "historyRevision"))
                                    || !id.equals(receipt.get("executionCallId"))
                                    || receipt.get("manifest") != null
                                    || !"blocked".equals(receipt.get("deliveryStatus"))
                                    || receipt.get("historyRevision") != null) {
                                throw conflict("runtime_execution_conflict",
                                        "Session receipt conflicts with publication");
                            }
                            bindingRegistry.requireUsableLease(context);
                            return RuntimeToolMeasurements.selected(original.getReference())
                                    ? executionReconciler.acknowledgeMeasured(context, original, receipt)
                                    : transport.acknowledgeV3(context.lease(),
                                    context.session(), original.getReference(),
                                    receipt);
                        }), "runtime_execution_ack_failed", "Tool v3 acknowledgement failed")
                            .whenComplete((ignored, error) -> context.endControl());
                    }
                    return mapFailure(safeStage(() -> {
                        Map<String, Object> saved = sshNoStartReceipt(context.binding(), original);
                        if (saved == null) {
                            saved = publicationVerifier.receipt(original);
                        }
                        if (saved == null || !sameReceipt(saved, receipt)) {
                            throw conflict("runtime_execution_conflict", "Session receipt conflicts with publication");
                        }
                        bindingRegistry.requireUsableLease(context);
                        return RuntimeToolMeasurements.selected(original.getReference())
                                ? executionReconciler.acknowledgeMeasured(context, original, saved)
                                : transport.acknowledgeV3(context.lease(), context.session(),
                                original.getReference(), saved);
                    }), "runtime_execution_ack_failed", "Tool v3 acknowledgement failed")
                            .whenComplete((ignored, error) -> context.endControl());
                })));
    }

    public CompletionStage<ToolExecutionRecord> cancelExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return executionCancellation.cancelExecution(harnessSessionId, runtimeSessionId, executionCallId);
    }

    /**
     * Asks the original Runtime once whether an {@code UNKNOWN} execution
     * settled, and settles the record only on that evidence. Any other
     * answer, and any failure, leaves it {@code UNKNOWN}. This never executes
     * or re-claims the dispatch, and it never retries: polling belongs to
     * the caller. A record that is not {@code UNKNOWN} is answered from the
     * repository before any Session or liveness check.
     */
    public CompletionStage<ExecutionReconciliation> reconcileExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return executionReconciler.reconcileExecution(harnessSessionId, runtimeSessionId, executionCallId);
    }

    /**
     * The HTTP face's automatic observation of an UNKNOWN execution: the
     * same evidence-only lookup as {@link #reconcileExecution}, except that
     * a lookup that just ran cools the execution for a short window, so
     * rapid polling shares the one answer instead of fanning every request
     * through to the worker (issue #13183 saw hundreds of status calls per
     * execution this way).
     */
    public CompletionStage<ExecutionReconciliation> observeExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return executionReconciler.observeExecution(harnessSessionId, runtimeSessionId, executionCallId);
    }

    public CompletionStage<Boolean> releaseOriginal(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation) {
        return releaseOriginal(harnessSessionId, runtimeSessionId, bindingId, generation, null);
    }

    public CompletionStage<Boolean> releaseOriginal(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation, RuntimeLifecycleAuthority authority) {
        return releaseOriginal(harnessSessionId, runtimeSessionId, bindingId, generation, authority, false);
    }

    public CompletionStage<Boolean> releaseOriginal(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation, RuntimeLifecycleAuthority authority, boolean drain) {
        requireOpen(closed);
        RuntimeBindingRecord binding = bindingRepository.findById(bindingId);
        boolean shared = binding != null && (HarnessOwnership.sharesRuntimeSessions(binding.getRequest())
                || ResidentWorkspaceProfile.selects(binding.getRequest()));
        if (binding == null || binding.getGeneration() != generation
                || !shared && (!harnessSessionId.equals(binding.getRequest().getIsolationKey())
                        || !"session".equals(binding.getRequest().getScope().getIsolationClass()))) {
            return failed(conflict("runtime_session_conflict", "Cleanup owner differs from original binding"));
        }
        RuntimeSessionRecord stored = sessionRepository.findById(binding.getRequest().getScope(), runtimeSessionId);
        if (stored == null && shared) {
            // Nothing on a shared binding proves this Harness owns an unused Runtime Session id.
            return failed(conflict("runtime_session_conflict", "Cleanup owner has no original Session"));
        }
        if (stored == null) {
            // Admission and this tombstone serialize under the binding lock. A late
            // acquire must observe RELEASED instead of creating a new owner.
            stored = bindingRepository.createSessionTombstone(sessionRepository, new RuntimeSessionRecord(
                    new RuntimeSession(harnessSessionId, runtimeSessionId, "bootstrap", binding.getRequest().getScope().withLifecycleAuthority(authority)),
                    bindingId, generation, RuntimeSessionRecord.State.RELEASED, 0, clock.instant()));
        }
        if (!bindingId.equals(stored.getBindingId()) || stored.getRuntimeGeneration() != generation
                || !binding.getRequest().getScope().equals(stored.getSession().getScope())
                || !harnessSessionId.equals(stored.getSession().getHarnessSessionId())) {
            return failed(conflict("runtime_session_conflict", "Cleanup owner differs from original Session"));
        }
        return stored.getState() == RuntimeSessionRecord.State.RELEASED
                ? CompletableFuture.completedFuture(true) : release(harnessSessionId, runtimeSessionId, drain, authority);
    }

    /**
     * A routine release holds nothing back and stops nothing: a Session
     * with a provably live hold row is refused {@code runtime_session_held}
     * and its run keeps its Runtime. The drain arm — the Session close and
     * the control plane's close cascade — stops what is live first.
     */
    public CompletionStage<Boolean> release(String harnessSessionId,
            String runtimeSessionId) {
        return release(harnessSessionId, runtimeSessionId, false);
    }

    public CompletionStage<Boolean> release(String harnessSessionId,
            String runtimeSessionId, boolean drain) {
        return release(harnessSessionId, runtimeSessionId, drain, null);
    }

    public CompletionStage<Boolean> release(String harnessSessionId,
            String runtimeSessionId, boolean drain, RuntimeLifecycleAuthority authority) {
        requireOpen(closed);
        String harnessId = BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId, "runtimeSessionId");
        CompletableFuture<SessionContext> local = bindingRegistry.session(runtimeId);
        if (local == null) {
            return releasedSession(harnessId, runtimeId, drain, authority);
        }
        return local.thenCompose(context -> {
            if (!context.session().getHarnessSessionId().equals(harnessId)) {
                throw conflict("runtime_session_conflict",
                        "Runtime Session belongs to another Harness Session");
            }
            requireLifecycleRelease(context.binding().getRequest(), context.session(), authority);
            return sessionRelease.releaseSession(context, drain);
        });
    }

    private void requireLifecycleRelease(RuntimeProvisionRequest bindingRequest, RuntimeSession session,
            RuntimeLifecycleAuthority authority) {
        if (bindingRepository.requireHarnessRecovery(bindingRequest, session.getScope(), session.getHarnessSessionId(), authority)
                && !bindingRepository.isHarnessDraining(session.getScope().getTenantId(), session.getHarnessSessionId())) {
            throw conflict("runtime_admission_closed", "Lifecycle release requires resource drain");
        }
    }

    /**
     * Frees only the Workspace execution mount the Session holds, for the
     * recovery-blocked turn that parks alive forever by contract: the
     * Session row keeps its READY identity for the recovery fleet, so the
     * full release path — and its RELEASED-forever verdict — never runs
     * here. Only the latest acquire's claim may hand the mount back, and a
     * lifecycle operation's window refuses it like the sibling release.
     * A Session with an active operation keeps its mount honestly, the
     * same freeze the fleet promises while anything is unproven. An
     * observe-only sweep first settles any background row whose exit it
     * can prove — stopping nothing, because this handback is
     * observe-and-hold (#13800), not a drain — and the busy check then
     * re-reads without the exclusion, so a background row still live or
     * unproven keeps the mount instead of being handed back over a
     * running writer. A settled execution whose capture
     * never proved its writer stopped keeps the mount for good: the
     * operator-recovery family fences exactly that Workspace, and the
     * distinct refusal tells the caller that waiting settles nothing. The
     * gate reads the state as registered at this instant; it does not
     * fence a concurrent out-of-contract admission landing one instant
     * later. Resident-only: a Session this Broker does not hold (a dead
     * Daemon's residue) belongs to the LOST family's own sweep.
     */
    public CompletionStage<Boolean> releaseMount(String harnessSessionId,
            String runtimeSessionId, String mountClaimId,
            RuntimeLifecycleAuthority authority) {
        requireOpen(closed);
        String harnessId = BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId, "runtimeSessionId");
        String claimId = BrokerValues.requireId(mountClaimId, "mountClaimId");
        CompletableFuture<SessionContext> local = bindingRegistry.session(runtimeId);
        if (local == null) {
            return failed(unavailable("runtime_reconciliation_required",
                    "Runtime Session is not active in this Broker process"));
        }
        return local.thenCompose(context -> {
            if (!context.session().getHarnessSessionId().equals(harnessId)) {
                throw conflict("runtime_session_conflict",
                        "Runtime Session belongs to another Harness Session");
            }
            requireLifecycleRelease(context.binding().getRequest(), context.session(), authority);
            // The check and the clear share the lock every acquire records
            // its claim under, so a re-drive that claimed this identity
            // after the block can never lose its mount to the old handback.
            context.lock();
            try {
                if (!claimId.equals(context.mountClaim())) {
                    throw conflict("runtime_session_conflict",
                            "Mount claim was superseded by a later acquire");
                }
            } finally {
                context.unlock();
            }
            // R17-2 / R18-1: observe the unproven background rows (stop nothing —
            // observe-and-hold, #13800), then hand back under the claim/busy/
            // unproven guard in releaseMountAfterSweep: a provable exit un-wedges
            // a routine detach, a live or unproven row keeps the mount. Mount
            // handback only — the owner id stays re-acquirable (R13-1).
            return executionRecovery.settleUnprovenBackgroundRows(context, false)
                    .thenCompose(ignored -> executionRecovery.releaseMountAfterSweep(
                            context, claimId, runtimeId));
        });
    }

    private CompletionStage<Boolean> releasedSession(
            String harnessSessionId, String runtimeSessionId,
            boolean drain, RuntimeLifecycleAuthority authority) {
        return bindingRegistry.persistedSession(harnessSessionId, runtimeSessionId)
                .thenCompose(record -> {
                    RuntimeBindingRecord owner = bindingRepository.findById(record.getBindingId());
                    requireLifecycleRelease(owner == null ? null : owner.getRequest(), record.getSession(), authority);
                    if (record.getState()
                            == RuntimeSessionRecord.State.RELEASED) {
                        return CompletableFuture.completedFuture(true);
                    }
                    RuntimeBindingRecord binding = owner;
                    if ((record.getState() == RuntimeSessionRecord.State.ACQUIRING
                            || record.getState() == RuntimeSessionRecord.State.RELEASING)
                            && binding != null && binding.getGeneration() == record.getRuntimeGeneration()
                            && bindingRegistry.matchingLiveBinding(binding) != null) {
                        CompletableFuture<SessionContext> adopted = CompletableFuture.completedFuture(
                                new SessionContext(record.getSession(), binding, bindingRegistry.requireLiveBinding(binding).lease()));
                        boolean inserted = bindingRegistry.registerSession(runtimeSessionId, adopted) == null;
                        return release(harnessSessionId, runtimeSessionId, drain, authority).whenComplete((released, error) -> {
                            if (inserted && (error != null || !Boolean.TRUE.equals(released))) {
                                bindingRegistry.removeSession(runtimeSessionId, adopted);
                            }
                        });
                    }
                    if (record.isActive() && binding != null && binding.getRequest().isManagedContext()
                            && binding.getGeneration() == record.getRuntimeGeneration()
                            && (binding.getState() == RuntimeBindingRecord.State.READY
                                    || binding.getState() == RuntimeBindingRecord.State.DRAINING)
                            && bindingRepository.isHarnessDraining(record.getSession().getScope().getTenantId(),
                                    harnessSessionId)) {
                        return drainCoordinator.releaseSavedSession(binding, record, null).thenApply(ignored -> true);
                    }
                    // A Broker that died mid-acquire or mid-release leaves the
                    // Session ACQUIRING or RELEASING; both pin a LOST
                    // generation, and neither can ever be confirmed by a
                    // Runtime that is proven gone.
                    if (record.isActive()
                            && binding != null
                            && binding.getState()
                                    == RuntimeBindingRecord.State.LOST
                            && binding.getGeneration()
                                    == record.getRuntimeGeneration()
                            && binding.hasStoppedWriters()
                            && !binding.getRequest().isManagedContext()
                            && !executionRepository.hasActiveByRuntimeSession(
                                    record.getBindingId(), record.getRuntimeGeneration(), runtimeSessionId)) {
                        RuntimeSessionRecord releasing = record;
                        if (releasing.getState()
                                != RuntimeSessionRecord.State.RELEASING) {
                            releasing = sessionRepository.compareAndSet(
                                    releasing, releasing.withState(
                                            RuntimeSessionRecord.State
                                                    .RELEASING,
                                            clock.instant()));
                        }
                        if (releasing != null) {
                            sessionRelease.finishSessionRelease(releasing);
                            return CompletableFuture.completedFuture(true);
                        }
                    }
                    throw unavailable("runtime_reconciliation_required",
                            "Runtime Session is not active in this Broker "
                                    + "process");
                });
    }

    private ToolExecutionRecord createExecution(SessionContext context,
            String idempotencyKey, Map<String, Object> reference, boolean dispatch) {
        ToolExecutionRecord record;
        context.lock();
        try {
            bindingRegistry.requireReadySessionRecord(context);
            Map<String, Object> safeReference = immutableMap(reference,
                    "reference");
            String referenceSessionId = referenceString(safeReference,
                    "sessionId");
            if (!context.session().getRuntimeSessionId().equals(
                    referenceSessionId)) {
                throw invalid("runtime_reference_invalid",
                        "reference sessionId does not match the Runtime "
                                + "Session");
            }
            ToolExecutionRecord candidate = ToolExecutionRecord.prepared(
                    nextExecutionId(), idempotencyKey,
                    context.binding().getBindingId(),
                    context.binding().getGeneration(),
                    context.session().getHarnessSessionId(),
                    context.session().getRuntimeSessionId(),
                    referenceString(safeReference, "promptId"),
                    referenceString(safeReference, "callId"),
                    referenceString(safeReference,
                            isPublicationV3(safeReference)
                                    ? "payloadDigest" : "argsDigest"),
                    safeReference);
            // The JSON writer and the JDBC codec write an unpaired surrogate
            // as '?', so the Worker would run another tool name or input.
            if (!BrokerValues.isWellFormedJson(safeReference)) {
                throw invalid("runtime_reference_invalid",
                        "reference must be well-formed text");
            }
            try {
                record = bindingRepository.admitExecution(sessionRepository,
                        executionRepository, candidate);
            } catch (IllegalArgumentException exception) {
                throw conflict("runtime_execution_conflict",
                        "execution identity is already in use", exception);
            }
            if (!record.sameRequest(candidate)) {
                throw conflict("runtime_idempotency_conflict",
                        "idempotency key belongs to another request");
            }
        } finally {
            context.unlock();
        }
        if (dispatch && shouldDriveDispatch(record)) {
            executionDispatcher.beginDispatch(context, record);
        }
        ToolExecutionRecord current = executionRepository
                .findByExecutionCallId(record.getExecutionCallId());
        return current == null ? record : current;
    }

    // H3: the background process (or Monitor watch) is its own ledger row,
    // admitted at start, carrying no model result and staying non-terminal
    // until physical proof — that is what `hasActiveBy*` counts while it
    // lives.
    void admitBackgroundProcess(SessionContext context,
            ToolExecutionRecord invocation, ManagedHoldFamily family) {
        backgroundProcessAdmission.admit(context, invocation, family);
    }

    /**
     * Asks the physical owner of a background process for status. An
     * exited answer settles the process row with that evidence; anything
     * else keeps the row active and its hold, exactly the wedge semantics
     * — a status that cannot be proven never becomes a claimed end.
     */
    public CompletionStage<ToolExecutionRecord> observeBackgroundProcess(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return executionRecovery.observeBackgroundProcess(harnessSessionId, runtimeSessionId, executionCallId);
    }

    /**
     * H4f: the public task cancel's stop of one background Shell or
     * Monitor watch, named by the call that started it inside the Harness
     * Session that owns the task. It runs the drain sweep's status → stop
     * → status for that one hold row, so only the worker's exit evidence
     * settles the row, and the worker answers a stop only after the
     * stop-marked finalize that settles the task's record has returned.
     * It runs unfenced, like a client Monitor control: the hold row itself
     * keeps the Runtime Session from releasing while the process may run,
     * so a racing close's drain is never refused busy because of it.
     */
    public CompletionStage<ToolExecutionRecord> stopBackgroundProcess(
            String tenantId, String harnessSessionId,
            String executionCallId) {
        return executionRecovery.stopBackgroundProcess(tenantId, harnessSessionId, executionCallId);
    }

    private CompletionStage<RuntimeSessionRecord> acquireSession(
            RuntimeSession session, String mountClaimId) {
        String runtimeSessionId = session.getRuntimeSessionId();
        CompletableFuture<SessionContext> created =
                new CompletableFuture<>();
        CompletableFuture<SessionContext> existing = bindingRegistry.registerSession(
                runtimeSessionId, created);
        CompletableFuture<SessionContext> selected = existing == null
                ? created : existing;
        if (existing == null) {
            safeStage(() -> acquireNewSession(session)).whenComplete(
                    (context, error) -> {
                        if (error == null) {
                            created.complete(context);
                        } else {
                            bindingRegistry.removeSession(runtimeSessionId, created);
                            created.completeExceptionally(unwrap(error));
                        }
                    });
        }
        return selected.thenCompose(context -> {
            RuntimeSessionRecord record;
            context.lock();
            try {
                bindingRepository.requireHarnessAdmission(context.binding().getRequest(), session.getScope(),
                        session.getHarnessSessionId(), session.getScope().getLifecycleAuthority());
                requireSameSession(context.session(), session);
                record = requireAcquireSessionRecord(context);
                context.mountClaim(mountClaimId);
            } finally {
                context.unlock();
            }
            return reclaimMount(context, record);
        });
    }

    private CompletionStage<SessionContext> acquireNewSession(
            RuntimeSession session) {
        RuntimeProvisionRequest request = provisionRequest(
                session.getScope(), session.getHarnessSessionId());
        return bindingProvisioning.ensureBinding(request).thenCompose(binding -> {
            RuntimeSessionRecord candidate = new RuntimeSessionRecord(
                    session, binding.record().getBindingId(),
                    binding.record().getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0,
                    clock.instant());
            RuntimeSessionRecord stored;
            try {
                stored = bindingRepository.admitSession(sessionRepository, candidate);
            } catch (IllegalArgumentException exception) {
                throw conflict("runtime_session_conflict",
                        "runtimeSessionId belongs to another Session",
                        exception);
            }
            if (!stored.sameIdentity(candidate)) {
                throw conflict("runtime_session_conflict",
                        "runtimeSessionId belongs to another Session");
            }
            SessionContext context = new SessionContext(session,
                    binding.record(), binding.lease());
            if (stored.getState() == RuntimeSessionRecord.State.READY) {
                return executionRecovery.scanExecutions(context, stored, null);
            }
            if (stored.getState()
                    != RuntimeSessionRecord.State.ACQUIRING) {
                throw conflict("runtime_session_not_acquirable",
                        "Runtime Session is not acquirable");
            }
            RuntimeSessionRecord expected = stored;
            return mapFailure(safeStage(() -> transport.acquire(
                    binding.lease(), session)),
                    "runtime_session_acquire_failed",
                    "Runtime Session acquisition failed")
                    .handle((ignored, error) -> {
                        if (error != null) {
                            throw new CompletionException(unwrap(error));
                        }
                        RuntimeSessionRecord ready =
                                sessionRepository.compareAndSet(expected,
                                        expected.withState(
                                                RuntimeSessionRecord.State
                                                        .READY,
                                                clock.instant()));
                        if (ready == null) {
                            RuntimeSessionRecord current = sessionRepository
                                    .findById(session.getScope(),
                                            session.getRuntimeSessionId());
                            if (current == null
                                    || !current.sameIdentity(candidate)
                                    || current.getState()
                                            != RuntimeSessionRecord.State
                                                    .READY) {
                                throw conflict(
                                        "runtime_session_state_conflict",
                                        "Runtime Session changed while it "
                                                + "was being acquired");
                            }
                        }
                        return context;
                    });
        });
    }

    /** Trusted maintenance of the saved generation; never resolves current authorization or provisions a replacement. */
    public CompletionStage<RuntimeBindingRecord> recoverBinding(String bindingId, long expectedGeneration) {
        return bindingProvisioning.recoverBinding(bindingId, expectedGeneration, false);
    }

    private RuntimeSessionRecord requireAcquireSessionRecord(SessionContext context) {
        RuntimeSessionRecord record = bindingRegistry.requireReadySessionRecord(context);
        return CsiFilesRetirementProfile.isProfile(record.getSession().getScope())
                ? bindingRepository.requireSessionAdmission(sessionRepository, record) : record;
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        bindingRegistry.cancelPendingOperations();
        executionDispatcher.cancelPendingOperations();
        executionReconciler.cancelPendingOperations();
        scheduler.shutdownNow();
        renewalScheduler.shutdownNow();
        provisioner.close();
    }

    private CompletionStage<RuntimeScope> resolveScope(
            String harnessSessionId, RuntimeLifecycleAuthority authority) {
        return resolveScope(harnessSessionId, false, authority);
    }

    private CompletionStage<RuntimeScope> resolveScope(
            String harnessSessionId, boolean admission, RuntimeLifecycleAuthority authority) {
        return RuntimeBrokerSupport.resolveScope(sessionResolver, harnessSessionId, admission, authority);
    }

    private RuntimeProvisionRequest provisionRequest(
            RuntimeScope scope, String harnessSessionId) {
        try {
            return provisioner.createRequest(scope,
                    "session".equals(scope.getIsolationClass())
                            ? harnessSessionId : null,
                    harnessSessionId);
        } catch (IllegalArgumentException exception) {
            // A managed-context provisioner refuses a scope it cannot place,
            // such as one without a storage ID, rather than fall back.
            throw new RuntimeBrokerException(400, "runtime_placement_invalid",
                    "Runtime placement is invalid", false, exception);
        }
    }

    private String nextExecutionId() {
        return BrokerValues.requireId(executionIdSupplier.get(),
                "executionCallId");
    }

    private boolean shouldDriveDispatch(ToolExecutionRecord record) {
        // The repository judges the lease: claimDispatch leaves a live claim
        // alone and fences a lapsed EXECUTING or CANCEL_REQUESTED record.
        return !record.isTerminal()
                && record.getState() != ToolExecutionRecord.State.UNKNOWN;
    }

    private static Duration requireDuration(Duration duration,
            String name) {
        if (duration == null || duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return duration;
    }

    private static ScheduledExecutorService newScheduler() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable,
                    "qwen-runtime-broker-coordination");
            thread.setDaemon(true);
            return thread;
        });
    }

    // Renewals run their synchronous JDBC on their own pool, so a stalled
    // tick no longer occupies the coordination thread, and a second thread
    // absorbs one slow call. That is not isolation: the tick holds its
    // claim's monitor while parked, and the fence and settlement paths take
    // that monitor from coordination tasks, so a long stall can still block
    // coordination behind it (#13275).
    private static ScheduledExecutorService newRenewalScheduler() {
        ScheduledThreadPoolExecutor executor =
                new ScheduledThreadPoolExecutor(2,
                        runnable -> {
                            Thread thread = new Thread(runnable,
                                    "qwen-runtime-broker-lease-renewal");
                            thread.setDaemon(true);
                            return thread;
                        });
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }
}
