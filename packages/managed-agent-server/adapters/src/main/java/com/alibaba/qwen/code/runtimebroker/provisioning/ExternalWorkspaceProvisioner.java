package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocol;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;

import org.apache.commons.lang3.StringUtils;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Session-exclusive workers whose Workspace is a registered EXTERNAL storage
 * tree instead of a local directory.
 *
 * <p>This is internal provisioning, acquisition proof and drain plumbing, not
 * a public Hosted profile. It mints the shipped {@code managed-context/1} boot
 * plus the admitted {@code storage} member. Acquisition additionally requires
 * positive current storage continuity and independent original-worker attestation.
 * Public profile activation is separately gated by the control plane. The guarded
 * drain primitive is not blanket close support: {@link #supportsDrainedStop()}
 * stays {@code false}; kind eligibility never substitutes for saved-binding proof.
 *
 * <p>Trust boundary: the request only names a tenant-bound alias. Provider
 * identity, physical key, registration revision, alias path and mount root come
 * from {@link ExternalStorageRegistry}, never from the request, the provider
 * reply or the boot document. Any disagreement is a permanent refusal.
 */
public final class ExternalWorkspaceProvisioner extends ExternalRuntimeProvisioner {
    public static final String KIND = "external-workspace";
    /** The shipped worker contract's storage discriminator. */
    static final String STORAGE_KIND = "external";
    private static final List<String> CONTINUITY = List.of("confirms", "denies", "unknown");
    /**
     * The evidence members this profile verifies. The design's wider set also
     * names {@code mountNonce}; the persisted registration cannot carry it yet
     * (S2), so it is refused rather than ignored and this tuple is the one both
     * documents state.
     */
    private static final Set<String> EVIDENCE_KEYS =
            Set.of("storageRef", "mountRoot", "continuity");
    private final ExternalStorageRegistry registry;
    private final ExternalRuntimeClient client;
    private final String provider;

    public ExternalWorkspaceProvisioner(ExternalRuntimeClient client, ExternalStorageRegistry registry,
            String providerId, Duration startupTimeout) {
        super(client, providerId, startupTimeout);
        this.registry = Objects.requireNonNull(registry, "registry");
        this.client = client;
        this.provider = providerId;
    }

    @Override
    public String kind() {
        return KIND;
    }

    /** Structural selection only; not acquisition or execution authority. */
    public static boolean isWorkspaceRequest(RuntimeProvisionRequest request) {
        return request != null && KIND.equals(request.getProvisionerKind()) && request.isManagedContext()
                && WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(request.getScope().getCapabilityDigest())
                && "session".equals(request.getScope().getIsolationClass())
                && StringUtils.isNotBlank(request.getIsolationKey())
                && request.getScope().getWorkspaceId().equals(request.getStorageId());
    }

    /** Verifies the saved original for acquisition; never provisions a replacement. */
    public CompletionStage<Void> verifyAcquisition(RuntimeBindingRecord binding) {
        try {
            if (binding == null || !isWorkspaceRequest(binding.getRequest())
                    || binding.getState() != RuntimeBindingRecord.State.READY || binding.isDrainRequested()
                    || binding.getAttestationGeneration() <= 0) {
                throw refuse("external_workspace_acquisition_unverified", "Original Workspace binding is not ready.");
            }
            validatedSavedBoot(binding);
            var request = binding.getRequest();
            var seed = binding.getProvisionSeed();
            var handle = binding.getResourceHandle();
            var lease = binding.getLease();
            // Reconcile only the saved original. Unlike provision-only observation,
            // this same response must also positively confirm storage continuity.
            return client.observe(Map.of("protocolVersion", 1,
                    "provisionRequestId", seed.getProvisionRequestId(),
                    "identity", handle.getValue().get("identity"),
                    "handle", handle.getValue().get("provider"))).thenCompose(response -> {
                        if (response == null || !Long.valueOf(1).equals(
                                BrokerValues.exactLong(response.get("protocolVersion")))) {
                            throw refuse("external_workspace_acquisition_unverified", "Original provider response is invalid.");
                        }
                        requireOriginalReady(binding, observation(request, seed, handle, response));
                        if (!(response.get("storage") instanceof Map<?, ?> evidence)
                                || !"confirms".equals(evidence.get("continuity"))) {
                            throw new RuntimeBrokerException(503, "runtime_external_unavailable",
                                "External Workspace continuity is not confirmed.", true);
                        }
                        return transport.attest(lease, request, seed);
                    }).thenAccept(attestation -> {
                        if (attestation == null
                                || !lease.getRuntimeInstanceId().equals(attestation.getRuntimeInstanceId())
                                || !seed.getGatewayIncarnation().equals(attestation.getRuntimeIncarnation())
                                || !lease.getLeaseId().equals(attestation.getLeaseId())
                                || lease.getEpoch() != attestation.getEpoch()
                                || !request.getScope().equals(attestation.getScope())
                                || !request.getStorageId().equals(attestation.getStorageId())
                                || !seed.getProvisionRequestId().equals(attestation.getProvisionRequestId())) {
                            throw refuse("runtime_broker_attestation_conflict", "Original Workspace attestation differs.");
                        }
                    });
        } catch (RuntimeException invalid) {
            return CompletableFuture.failedFuture(invalid);
        }
    }

    private static void requireOriginalReady(RuntimeBindingRecord binding, RuntimeObservation observed) {
        if (observed == null || observed.getOutcome() == RuntimeObservation.Outcome.UNKNOWN
                || observed.getOutcome() == RuntimeObservation.Outcome.STARTING) {
            throw new RuntimeBrokerException(503, "runtime_external_unavailable",
                    "Original Workspace readiness is unknown.", true);
        }
        var lease = binding.getLease();
        if (observed.getOutcome() != RuntimeObservation.Outcome.READY
                || !binding.getResourceHandle().equals(observed.getHandle())
                || !lease.getRuntimeInstanceId().equals(observed.getRuntimeInstanceId())
                || !lease.getEndpoint().equals(observed.getEndpoint())
                || !lease.getLeaseId().equals(observed.getLeaseId()) || lease.getEpoch() != observed.getEpoch()) {
            throw refuse("external_workspace_acquisition_unverified", "Original Workspace identity differs.");
        }
    }

    @Override
    public boolean supportsDrainedStopKind(String kind) {
        return KIND.equals(kind) && registry != null && client != null && transport != null;
    }

    @Override
    public boolean supportsDrainedStop(RuntimeBindingRecord binding) {
        try {
            validatedSavedBoot(binding);
            return true;
        } catch (RuntimeBrokerException failure) {
            if (failure.isRetryable()) {
                throw failure;
            }
            return false;
        } catch (RuntimeException invalid) {
            return false;
        }
    }

    @Override
    public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord binding) {
        try {
            if (binding == null || !binding.isDrainRequested()) {
                throw refuse("workspace_close_identity_unverified", "External Workspace drain is not authorized.");
            }
            Map<String, Object> boot = validatedSavedBoot(binding);
            Map<?, ?> storage = (Map<?, ?>) boot.get("storage");
            long revision = ((Number) storage.get("registrationRevision")).longValue();
            var stop = transport.stopExternalWorkspaceDrained(binding.getLease(), binding.getRequest(),
                    binding.getProvisionSeed(), revision).toCompletableFuture();
            var receipt = stop.thenApply(ignored -> new RuntimeDrainReceipt(binding.getBindingId(),
                    binding.getGeneration(), binding.getProvisionSeed().getProvisionRequestId(),
                    binding.getResourceHandle(), Instant.now()));
            receipt.whenComplete((ignored, error) -> {
                if (receipt.isCancelled()) {
                    stop.cancel(true);
                }
            });
            return receipt;
        } catch (RuntimeException invalid) {
            return CompletableFuture.failedFuture(invalid);
        }
    }

    /**
     * The registered alias id <em>is</em> the Workspace id, so selecting it makes
     * the request managed-context and carries the storage binding explicitly
     * instead of letting the boot guess one.
     *
     * <p>A scope that does not admit the Hosted Workspace capability digest is not
     * storage-bound: it keeps the base (scratch-shaped) request and fails closed in
     * {@link #validateProfile} rather than being silently re-typed as a Workspace
     * placement with an unregistered binding.
     */
    @Override
    public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
        if (!WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(scope.getCapabilityDigest())) {
            return super.createRequest(scope, isolationKey);
        }
        return new RuntimeProvisionRequest(scope, isolationKey, KIND, scope.getWorkspaceId());
    }

    @Override
    protected void validateProfile(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        if (!request.isManagedContext()) {
            throw refuse("external_workspace_storage_required",
                    "External Workspace provisioning requires a registered storage binding.");
        }
    }

    /**
     * The shipped worker admits a boot-v2 document only with a {@code storage}
     * member whose {@code mountRoot} equals the context {@code mountRoot}, under
     * {@code session} isolation and the Workspace capability digest.
     */
    @Override
    protected Map<String, Object> bootDocument(RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        ExternalStorageRegistry.RegisteredExternalStorage storage = binding(request);
        Map<String, Object> boot = new LinkedHashMap<>(ManagedContextProtocol.boot(request, seed));
        boot.put("storage", Map.of(
                "kind", STORAGE_KIND,
                "physicalKey", storage.physicalKey(),
                "aliasPath", storage.aliasPath(),
                "mountRoot", storage.mountRoot(),
                "registrationRevision", storage.registrationRevision()));
        return Map.copyOf(boot);
    }

    /**
     * A provider may report storage continuity on {@code RUNNING}. Present evidence
     * must corroborate the registration; absent evidence keeps the phase-1
     * meaning because this profile authorizes no writes yet.
     */
    @Override
    protected RuntimeObservation observation(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, Map<String, Object> response) {
        Object reported = response.get("storage");
        if (reported != null) {
            if (!"RUNNING".equals(response.get("state"))
                    || !(reported instanceof Map<?, ?> evidence)) {
                throw refuse("external_storage_registration_mismatch",
                        "External storage evidence does not match the registration.");
            }
            // The registration record cannot persist a mount nonce yet, so a
            // reported nonce cannot be verified. Refuse it explicitly instead of
            // accepting a member this profile would silently ignore.
            if (evidence.containsKey("mountNonce")) {
                throw refuse("external_storage_registration_mismatch",
                        "External storage evidence carries a mount nonce this profile"
                                + " cannot verify yet.");
            }
            if (!evidence.keySet().equals(EVIDENCE_KEYS)
                    || !CONTINUITY.contains(String.valueOf(evidence.get("continuity")))) {
                throw refuse("external_storage_registration_mismatch",
                        "External storage evidence does not match the registration.");
            }
            ExternalStorageRegistry.RegisteredExternalStorage storage = binding(request);
            if (!storageRef(storage).equals(evidence.get("storageRef"))
                    || !storage.mountRoot().equals(evidence.get("mountRoot"))) {
                throw refuse("external_storage_registration_mismatch",
                        "External storage evidence does not match the registration.");
            }
            if ("denies".equals(evidence.get("continuity"))) {
                throw refuse("external_storage_continuity_denied",
                        "External storage continuity is denied.");
            }
            if ("unknown".equals(evidence.get("continuity"))) {
                // Indeterminate continuity loses readiness evidence but never
                // ownership: retry, adopt nothing, replace nothing.
                return RuntimeObservation.unknown(handle);
            }
        }
        return super.observation(request, seed, handle, response);
    }

    /**
     * The canonical storage identity digest the provider echoes as
     * {@code storageRef}: sorted-key JSON of the registered identity, SHA-256,
     * lowercase hex. The token-free discipline is the same one the handle uses.
     */
    static String storageRef(ExternalStorageRegistry.RegisteredExternalStorage storage) {
        // Canonical JSON (members sorted by name, integers as JSON integers,
        // SHA-256 lowercase hex) over exactly the registered identity tuple the
        // design documents: providerId, physicalKey, registrationRevision.
        return canonicalDigest(Map.of(
                "providerId", storage.providerId(),
                "physicalKey", storage.physicalKey(),
                "registrationRevision", storage.registrationRevision()));
    }

    private ExternalStorageRegistry.RegisteredExternalStorage binding(RuntimeProvisionRequest request) {
        String tenant = request.getScope().getTenantId();
        String alias = request.getStorageId();
        Optional<ExternalStorageRegistry.RegisteredExternalStorage> found;
        try {
            found = registry.find(tenant, alias);
        } catch (RuntimeBrokerException error) {
            throw error;
        } catch (RuntimeException failure) {
            // A registry read that could not complete is not evidence of absence:
            // keep the placement adoptable so the Broker retries it.
            throw new RuntimeBrokerException(503, "runtime_external_unavailable",
                    "External Runtime provider is unavailable.", true);
        }
        if (found.isEmpty()) {
            throw refuse("external_storage_registration_not_found",
                    "No external storage registration matches this Workspace.");
        }
        ExternalStorageRegistry.RegisteredExternalStorage storage = found.get();
        if (!alias.equals(storage.tenantWorkspaceId())
                || !request.getScope().getWorkspaceId().equals(storage.tenantWorkspaceId())
                || !provider.equals(storage.providerId())
                || !request.getScope().getCanonicalCwd().equals(storage.mountRoot())
                || !WorkspaceExecutionProfile.CAPABILITY_DIGEST
                        .equals(request.getScope().getCapabilityDigest())) {
            throw refuse("external_storage_registration_mismatch",
                    "The external storage registration does not match this placement.");
        }
        return storage;
    }

    private static RuntimeBrokerException refuse(String code, String message) {
        return new RuntimeBrokerException(409, code, message, false);
    }
}
