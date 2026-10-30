package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;

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
 * <p>The legacy profile remains provisioning-only. The explicit files and tools
 * profiles also require a qualified worker drain proof and confirmation that
 * the provider stopped the original physical resource.
 *
 * <p>Trust boundary: the request only names a tenant-bound alias. Provider
 * identity, physical key, registration revision, alias path and mount root come
 * from {@link ExternalStorageRegistry}, never from the request, the provider
 * reply or the boot document. Any disagreement is a permanent refusal.
 */
public final class ExternalWorkspaceProvisioner extends ExternalRuntimeProvisioner {
    public static final String KIND = "external-workspace";
    public static final String FILES_KIND = "external-workspace-files";
    public static final String TOOLS_KIND = "external-workspace-tools";
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
    private final String provider;
    private final HttpRuntimeTransport filesTransport;
    private final boolean foregroundShell;
    private final ExternalRuntimeClient retirementClient;

    public ExternalWorkspaceProvisioner(ExternalRuntimeClient client, ExternalStorageRegistry registry,
            String providerId, Duration startupTimeout) {
        this(client, registry, providerId, startupTimeout, null);
    }

    public ExternalWorkspaceProvisioner(ExternalRuntimeClient client, ExternalStorageRegistry registry,
            String providerId, Duration startupTimeout, HttpRuntimeTransport filesTransport) {
        this(client, registry, providerId, startupTimeout, filesTransport, false);
    }

    public ExternalWorkspaceProvisioner(ExternalRuntimeClient client, ExternalStorageRegistry registry,
            String providerId, Duration startupTimeout, HttpRuntimeTransport filesTransport, boolean foregroundShell) {
        super(client, providerId, startupTimeout);
        if (foregroundShell && filesTransport == null) {
            throw new IllegalArgumentException("External tools require the retirement transport");
        }
        this.foregroundShell = foregroundShell;
        this.retirementClient = client;
        this.registry = Objects.requireNonNull(registry, "registry");
        this.provider = providerId;
        this.filesTransport = filesTransport;
    }

    @Override
    public String kind() {
        return filesTransport == null ? KIND : foregroundShell ? TOOLS_KIND : FILES_KIND;
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
        return new RuntimeProvisionRequest(scope, isolationKey, kind(), scope.getWorkspaceId());
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
        if (filesTransport != null) {
            boot.put("externalFiles", "external-files/1");
            if (foregroundShell) {
                boot.put("externalShell", true);
            }
        }
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
        if (filesTransport != null && "RUNNING".equals(response.get("state")) && reported == null) {
            return RuntimeObservation.unknown(handle);
        }
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

    @Override
    public boolean supportsDrainedStop() {
        return filesTransport != null;
    }

    @Override
    public CompletionStage<RuntimeDrainReceipt> stopDrained(RuntimeBindingRecord saved) {
        if (filesTransport == null || !saved.isDrainRequested() || saved.getProvisionSeed() == null
                || saved.getLease() == null || saved.getResourceHandle() == null
                || !kind().equals(saved.getRequest().getProvisionerKind())) {
            return CompletableFuture.failedFuture(new RuntimeBrokerException(503,
                    "external_files_stop_unconfirmed", "External files retirement is unconfirmed.", true));
        }
        var storage = binding(saved.getRequest());
        String key = canonicalDigest(Map.of("bindingId", saved.getBindingId(), "generation", saved.getGeneration(),
                "provisionRequestId", saved.getProvisionSeed().getProvisionRequestId(), "handle", saved.getResourceHandle().getValue()));
        return retire(saved, key, true, null).thenCompose(observed -> {
            if ("STOPPED".equals(observed.get("state"))) {
                return CompletableFuture.completedFuture(retirementReceipt(saved, storage, key, observed));
            }
            if ("RETIRING".equals(observed.get("state"))) {
                Map<String, Object> proof = retirementProof(saved, storage, key, observed, false);
                return retire(saved, key, false, proof)
                        .thenApply(stopped -> retirementReceipt(saved, storage, key, stopped));
            }
            return filesTransport.stopExternalFiles(saved, storage)
                    .thenCompose(proof -> retire(saved, key, false, proof))
                    .thenApply(stopped -> retirementReceipt(saved, storage, key, stopped));
        });
    }

    private CompletionStage<Map<String, Object>> retire(RuntimeBindingRecord saved, String key, boolean confirmOnly,
            Map<String, Object> proof) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 1);
        body.put("provisionRequestId", saved.getProvisionSeed().getProvisionRequestId());
        body.put("identity", identity(saved.getRequest(), saved.getProvisionSeed()));
        body.put("handle", saved.getResourceHandle().getValue().get("provider"));
        body.put("retirementKey", key);
        body.put("confirmOnly", confirmOnly);
        if (proof != null) {
            body.put("proof", proof);
        }
        return retirementClient.retire(Map.copyOf(body));
    }

    private RuntimeDrainReceipt retirementReceipt(RuntimeBindingRecord saved,
            ExternalStorageRegistry.RegisteredExternalStorage storage, String key, Map<String, Object> response) {
        retirementProof(saved, storage, key, response, true);
        Instant stopped = Instant.parse((String) response.get("retiredAt"));
        if (stopped.isAfter(Instant.now().plusSeconds(30))) {
            throw new RuntimeBrokerException(503, "external_files_stop_unconfirmed", "Original E2B resource stop is unconfirmed.", true);
        }
        return new RuntimeDrainReceipt(saved.getBindingId(), saved.getGeneration(), saved.getProvisionSeed().getProvisionRequestId(), saved.getResourceHandle(), stopped);
    }

    private Map<String, Object> retirementProof(RuntimeBindingRecord saved,
            ExternalStorageRegistry.RegisteredExternalStorage storage, String key, Map<String, Object> response, boolean stopped) {
        Set<String> keys = stopped
                ? Set.of("protocolVersion", "state", "identity", "handle", "retirementKey", "proof", "retiredAt")
                : Set.of("protocolVersion", "state", "identity", "handle", "retirementKey", "proof");
        if (!response.keySet().equals(keys)
                || !Long.valueOf(1).equals(com.alibaba.qwen.code.runtimebroker.BrokerValues.exactLong(response.get("protocolVersion")))
                || !(stopped ? "STOPPED" : "RETIRING").equals(response.get("state")) || !key.equals(response.get("retirementKey"))
                || !identity(saved.getRequest(), saved.getProvisionSeed()).equals(response.get("identity"))
                || !saved.getResourceHandle().getValue().get("provider").equals(response.get("handle"))
                || !(response.get("proof") instanceof Map<?, ?> proof)) {
            throw new RuntimeBrokerException(503, "external_files_stop_unconfirmed", "Original E2B resource stop is unconfirmed.", true);
        }
        Map<String, Object> originalProof = new LinkedHashMap<>();
        proof.forEach((name, value) -> originalProof.put(String.valueOf(name), value));
        HttpRuntimeTransport.verifyExternalStopProof(saved, storage, originalProof);
        return Map.copyOf(originalProof);
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
