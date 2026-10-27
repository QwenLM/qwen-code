package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Session-exclusive workers whose Workspace is a registered EXTERNAL storage
 * tree instead of a local directory.
 *
 * <p>This is the <em>provisioning prerequisite</em> of
 * {@code docs/design/2026-10-25-external-hosted-workspace.md} (step 3a), not the
 * product feature: it mints the shipped {@code managed-context/1} boot plus the
 * already-admitted {@code storage} member, so a provider can place a worker on a
 * registered tree and report continuity evidence. Hosted files, foreground shell,
 * approval, capture and close/drain stay unimplemented, and
 * {@link #supportsDrainedStop()} therefore stays {@code false}: a Session placed
 * here cannot be closed, which is why no configuration admits one yet.
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
    private final String provider;

    public ExternalWorkspaceProvisioner(ExternalRuntimeClient client, ExternalStorageRegistry registry,
            String providerId, Duration startupTimeout) {
        super(client, providerId, startupTimeout);
        this.registry = Objects.requireNonNull(registry, "registry");
        this.provider = providerId;
    }

    @Override
    public String kind() {
        return KIND;
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
