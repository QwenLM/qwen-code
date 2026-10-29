package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.CsiOwnershipRevision;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceOperations.Kind.WORKSPACE_RETIREMENT;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.same;

/** Explicit idle maintenance with original platform cleanup and atomic ownership release. */
public final class ResidentWorkspaceRetirementStore {
    private static final String WORK = "POD_DELETE_ATTEMPT";
    private static final String FINALIZER_WORK = "POD_FINALIZER_ATTEMPT";
    private static final int PLAN_LIMIT = 256 * 1024;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final JdbcRuntimeBindingRepository bindings;
    private final List<ResidentWorkspace> mappings;
    private final ObjectMapper json;

    public record Request(String tenantId, String workspaceId, long workspaceGeneration,
            String actorId, String retirementId) {
        public Request {
            for (String value : new String[] {tenantId, workspaceId, actorId, retirementId}) {
                require(value != null && !value.isBlank() && value.getBytes(StandardCharsets.UTF_8).length <= 512
                        && value.codePoints().noneMatch(point -> point < 32 || point >= 127 && point <= 159
                                || point >= 0xd800 && point <= 0xdfff));
            }
            require(workspaceGeneration > 0);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record Plan(int version, Request request, String bindingId, long runtimeGeneration,
            String resourceIdentity, String mappingDigest, ResidentWorkspace mapping) { }

    public record AttemptStatus(int ordinal, String resourceVersion, String state, Integer httpStatus,
            String responseSha256) { }

    public record FinalizerAttemptStatus(int ordinal, String action, String resourceVersion, String state,
            Integer httpStatus, String responseSha256) { }

    public record Status(String retirementId, String state, String bindingId, long runtimeGeneration,
            List<AttemptStatus> attempts, List<FinalizerAttemptStatus> finalizerAttempts, Completion completion) { }

    public record Completion(String receiptSha256, String dataPolicy, Long releasedRevision) { }

    private record Attempt(String workKey, String owner, long generation, byte[] body) { }

    public ResidentWorkspaceRetirementStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            JdbcRuntimeBindingRepository bindings, List<ResidentWorkspace> mappings, ObjectMapper json) {
        require(jdbc.getDataSource() != null && bindings.usesDataSource(jdbc.getDataSource()));
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        this.bindings = bindings;
        new ResidentWorkspaces(mappings);
        this.mappings = List.copyOf(mappings);
        this.json = json.copy().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    public Status inspect(Request request) {
        return transaction.execute(status -> {
            var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
            if (saved == null) {
                authorize(request, false);
                return new Status(request.retirementId(), "NOT_STARTED", null, 0, List.of(), List.of(), null);
            }
            Plan plan = readPlan(request, saved);
            boolean released = "RELEASED".equals(saved.get("state"));
            var selected = released ? plan.mapping() : selected(request);
            require(selected != null && digest(selected).equals(plan.mappingDigest()));
            authorize(request, selected, false);
            var original = bindings.findById(plan.bindingId());
            verifyPlan(plan, original);
            if (released) {
                require(original.getState() == RuntimeBindingRecord.State.RELEASED);
                receipt(saved, original);
            } else {
                require(original.getState() == RuntimeBindingRecord.State.DRAINING);
                verifyOriginal(selected, original, false);
                if ("PLATFORM_CLEANED".equals(saved.get("state"))) {
                    receipt(saved, original);
                }
            }
            return status(request, plan);
        });
    }

    public Status begin(Request request) {
        Status prior = inspect(request);
        if (!"NOT_STARTED".equals(prior.state())) {
            return prior;
        }
        var selected = selected(request);
        var original = bindings.findActive(runtimeRequest(selected));
        require(original != null);
        if (original.getState() != RuntimeBindingRecord.State.READY || original.isDrainRequested()) {
            Status raced = inspect(request);
            require(!"NOT_STARTED".equals(raced.state()));
            return raced;
        }
        String owner = "resident-retirement:" + UUID.randomUUID();
        var claimed = bindings.claimOperation(original.getBindingId(), owner, Duration.ofSeconds(30));
        if (claimed == null) {
            Status raced = inspect(request);
            require(!"NOT_STARTED".equals(raced.state()));
            return raced;
        }
        try {
            return transaction.execute(status -> {
                authorize(request, true);
                var operations = operations(request);
                var saved = operations.find(WORKSPACE_RETIREMENT, request.retirementId(), true);
                if (saved != null) {
                    var plan = plan(request, selected, saved);
                    verifyPlan(plan, bindings.findById(plan.bindingId()));
                    return status(request, plan);
                }
                require(jdbc.queryForObject("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                        String.class, request.tenantId(), request.workspaceId()).equals("ACTIVE"));
                var locked = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                        bindings.lockActiveForRetirement(connection, claimed));
                require(owner.equals(locked.getOperationOwner()) && claimed.getOperationGeneration() == locked.getOperationGeneration()
                        && locked.getState() == RuntimeBindingRecord.State.READY && !locked.isDrainRequested());
                verifyOriginal(selected, locked, true);
                idle(request);
                require(jdbc.queryForList("SELECT operation_key FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'"
                        + " AND target_key = ? AND target_revision = ? FOR UPDATE", String.class,
                        WorkspaceOperations.hash(locked.getBindingId()), locked.getGeneration()).isEmpty());
                Plan plan = new Plan(2, request, locked.getBindingId(), locked.getGeneration(),
                        (String) locked.getResourceHandle().getValue().get("identity"), digest(selected), selected);
                String encoded = encode(plan);
                require(encoded.getBytes(StandardCharsets.UTF_8).length <= PLAN_LIMIT);
                operations.create(WORKSPACE_RETIREMENT, request.retirementId(), WorkspaceOperations.values(
                        "binding_id", locked.getBindingId(), "runtime_generation", locked.getGeneration(),
                        "storage_id", selected.registration().storageId(), "physical_key", selected.registration().physicalKey(),
                        "state", "DRAINING", "request_json", encoded, "request_digest", digest(plan)));
                require(jdbc.update("UPDATE ma_workspace SET state = 'DRAINING' WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND workspace_generation = ? AND state = 'ACTIVE'", request.tenantId(), request.workspaceId(),
                        request.workspaceGeneration()) == 1);
                jdbc.execute((ConnectionCallback<Void>) connection -> {
                    bindings.sealForRetirement(connection, locked);
                    return null;
                });
                return status(request, plan);
            });
        } finally {
            bindings.releaseOperation(claimed.getBindingId(), owner, claimed.getOperationGeneration());
        }
    }

    public Status deletePod(Request request, String resourceVersion, KubernetesHttpRuntimeClient api) {
        require(resourceVersion != null && resourceVersion.matches("[\\x21-\\x7e]{1,256}"));
        var selected = selected(request);
        var original = transaction.execute(status -> lockedPlan(request, selected, true));
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        String workKey = WorkspaceOperations.hash((String) placement.get("podUid"), resourceVersion);
        if (operations(request).findWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, workKey, false) != null) {
            return inspect(request);
        }
        new WorkspaceCsiResourceGuard(api, selected.registration().clusterDomain(), selected.registration(),
                selected.protection()).verify().toCompletableFuture().join();
        String podName = (String) placement.get("podName");
        var pod = api.get("pods", selected.registration().namespace(), podName).toCompletableFuture().join();
        var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        var baseline = saved.get("reclamationBaseline") == null ? null : baseline(saved);
        verifyPod(original, pod, resourceVersion, baseline == null ? List.of() : List.of(baseline.finalizer()));
        var node = api.getCluster("nodes", (String) placement.get("nodeName")).toCompletableFuture().join();
        require(node != null && placement.get("nodeUid").equals(map(node.get("metadata")).get("uid"))
                && map(node.get("status")).get("conditions") instanceof List<?> conditions
                && conditions.stream().anyMatch(value -> "Ready".equals(map(value).get("type"))
                        && "True".equals(map(value).get("status"))));
        byte[] body = WorkspaceCsiRuntimeIdentity.bytes(Map.of("apiVersion", "v1", "kind", "DeleteOptions",
                "gracePeriodSeconds", 30, "propagationPolicy", "Background", "preconditions",
                Map.of("uid", placement.get("podUid"), "resourceVersion", resourceVersion)));
        Attempt attempt = transaction.execute(status -> {
            lockedPlan(request, selected, true);
            idle(request);
            var operations = operations(request);
            if (operations.findWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, workKey, true) != null) {
                return null;
            }
            int count = attempts(request).size();
            require(count < 8);
            String owner = UUID.randomUUID().toString();
            require(jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_generation = claim_generation + 1,"
                    + " claim_until = " + ManagedSchemaTime.SQL_NOW + " + 60000 WHERE operation_key = ?"
                    + " AND (claim_until IS NULL OR claim_until <= " + ManagedSchemaTime.SQL_NOW + ")",
                    owner, operationKey(request)) == 1);
            long generation = jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_key = ?",
                    Long.class, operationKey(request));
            operations.insertWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, workKey, workKey, null,
                    WorkspaceOperations.values("ordinal", count + 1, "resourceVersion", resourceVersion,
                            "requestBase64", Base64.getEncoder().encodeToString(body), "claimGeneration", generation), "UNKNOWN");
            return new Attempt(workKey, owner, generation, body);
        });
        if (attempt == null) {
            return inspect(request);
        }
        KubernetesHttpRuntimeClient.DeleteResponse reply = null;
        try {
            reply = api.deletePod(selected.registration().namespace(), podName, attempt.body()).toCompletableFuture().join();
        } catch (java.util.concurrent.CompletionException failure) {
            // The durable UNKNOWN attempt must survive a lost reply without resending.
        }
        var response = reply;
        transaction.executeWithoutResult(status -> {
            lockedPlan(request, selected, false);
            require(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_key = ? AND claim_owner = ?"
                    + " AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW,
                    Long.class, operationKey(request), attempt.owner(), attempt.generation()) == 1);
            if (response != null) {
                require(response.body().length <= 64 * 1024);
                operations(request).updateWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, attempt.workKey(),
                        WorkspaceOperations.values("state", response.complete() ? "RETURNED" : "UNKNOWN", "httpStatus", response.status(),
                                "responseBase64", Base64.getEncoder().encodeToString(response.body()),
                                "responseSha256", org.apache.commons.codec.digest.DigestUtils.sha256Hex(response.body()),
                                "complete", response.complete()));
            }
            jdbc.update("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL WHERE operation_key = ?"
                    + " AND claim_owner = ? AND claim_generation = ?", operationKey(request), attempt.owner(), attempt.generation());
        });
        return inspect(request);
    }

    public Status prepareReclamation(Request request, String resourceVersion, KubernetesHttpRuntimeClient api) {
        require(resourceVersion != null && resourceVersion.matches("[\\x21-\\x7e]{1,256}"));
        var prior = inspect(request);
        if (!"DRAINING".equals(prior.state())) {
            require(!"NOT_STARTED".equals(prior.state()));
            return prior;
        }
        var selected = selected(request);
        var original = transaction.execute(status -> lockedPlan(request, selected, true));
        var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        require(readPlan(request, saved).version() == 2);
        verifyProtection(selected, api);
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        var pod = api.get("pods", selected.registration().namespace(), (String) placement.get("podName")).toCompletableFuture().join();
        require(pod != null);
        String finalizer = finalizer(request, original);
        var retained = saved.get("reclamationBaseline") == null ? null : baseline(saved);
        if (retained != null && List.of(finalizer).equals(map(pod.get("metadata")).get("finalizers"))) {
            verifyPod(original, pod, resourceVersion, List.of(finalizer));
            return inspect(request);
        }
        verifyPod(original, pod, resourceVersion, List.of());
        var observed = ResidentWorkspaceReclamation.prepare(original, selected, finalizer, api, Instant.now());
        transaction.executeWithoutResult(status -> {
            lockedPlan(request, selected, true);
            idle(request);
            var current = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true);
            require("DRAINING".equals(current.get("state")));
            if (current.get("reclamationBaseline") == null) {
                operations(request).update(WORKSPACE_RETIREMENT, request.retirementId(), WorkspaceOperations.values(
                        "reclamationBaseline", json.valueToTree(observed), "reclamationBaselineDigest", digest(observed)));
            } else {
                var first = baseline(current);
                require(first.finalizer().equals(finalizer) && first.bootId().equals(observed.bootId())
                        && first.leaseUid().equals(observed.leaseUid()) && first.attachmentUid().equals(observed.attachmentUid()));
            }
        });
        patchFinalizer(request, selected, original, pod, "ADD", api);
        return inspect(request);
    }

    public Status reclaim(Request request, KubernetesHttpRuntimeClient api) {
        var prior = inspect(request);
        if ("RELEASED".equals(prior.state())) {
            return prior;
        }
        var selected = selected(request);
        var original = transaction.execute(status -> lockedPlan(request, selected, true));
        var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        require(readPlan(request, saved).version() == 2);
        var baseline = baseline(saved);
        require(baseline.finalizer().equals(finalizer(request, original)));
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        String namespace = selected.registration().namespace();
        String name = (String) placement.get("podName");
        if ("DRAINING".equals(saved.get("state"))) {
            require(!attempts(request).isEmpty());
            verifyProtection(selected, api);
            var pod = api.get("pods", namespace, name).toCompletableFuture().join();
            var observed = ResidentWorkspaceReclamation.complete(original, selected, baseline, pod, api, Instant.now());
            transaction.executeWithoutResult(status -> {
                lockedPlan(request, selected, true);
                idle(request);
                var current = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true);
                if ("DRAINING".equals(current.get("state"))) {
                    require(digest(baseline).equals(current.get("reclamationBaselineDigest")));
                    operations(request).update(WORKSPACE_RETIREMENT, request.retirementId(), WorkspaceOperations.values(
                            "state", "PLATFORM_CLEANED", "cleanupReceipt", json.valueToTree(observed), "cleanupReceiptDigest", digest(observed)));
                } else {
                    receipt(current, original);
                }
            });
        }
        saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        var proof = receipt(saved, original);
        var pod = api.get("pods", namespace, name).toCompletableFuture().join();
        if (pod != null) {
            var metadata = map(pod.get("metadata"));
            require(placement.get("podUid").equals(metadata.get("uid"))
                    && placement.get("podName").equals(metadata.get("name"))
                    && placement.get("namespace").equals(metadata.get("namespace"))
                    && metadata.get("deletionTimestamp") instanceof String
                    && digest(pod.get("spec")).equals(original.getResourceHandle().getValue().get("podSpecDigest")));
            Instant.parse((String) metadata.get("deletionTimestamp"));
            if (List.of(baseline.finalizer()).equals(metadata.get("finalizers"))) {
                patchFinalizer(request, selected, original, pod, "REMOVE", api);
            } else {
                require(empty(metadata.get("finalizers")));
            }
            if (api.get("pods", namespace, name).toCompletableFuture().join() != null) {
                return inspect(request);
            }
        }
        return transaction.execute(status -> {
            var current = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
            if ("RELEASED".equals(current.get("state"))) {
                return inspect(request);
            }
            var locked = lockedPlan(request, selected, true);
            idle(request);
            current = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true);
            require("PLATFORM_CLEANED".equals(current.get("state")) && digest(proof).equals(current.get("cleanupReceiptDigest")));
            receipt(current, locked);
            require(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_key = ?"
                    + " AND (claim_until IS NULL OR claim_until <= " + ManagedSchemaTime.SQL_NOW + ")", Long.class, operationKey(request)) == 1);
            var storage = map(locked.getResourceHandle().getValue().get("storage"));
            long revision = Math.addExact(Long.parseLong((String) storage.get("reservationRevision")), 1);
            jdbc.execute((ConnectionCallback<Void>) connection -> {
                bindings.releaseResidentForRetirement(connection, locked);
                return null;
            });
            require(jdbc.update("UPDATE ma_storage_owner SET csi_phase = 'RELEASED', csi_revision = ?, tenant_id = ?,"
                    + " binding_id = NULL, runtime_generation = NULL, csi_reservation_id = NULL, csi_registration_key = NULL,"
                    + " csi_registration_revision = NULL, csi_provision_request_id = NULL"
                    + " WHERE storage_key = ? AND storage_kind = 'CSI' AND csi_phase = 'RESERVED' AND csi_revision = ?"
                    + " AND binding_id = ? AND runtime_generation = ? AND csi_reservation_id = ?"
                    + " AND (tenant_id IS NULL OR tenant_id = ?)", revision, request.tenantId(), selected.registration().physicalKey(),
                    revision - 1, locked.getBindingId(), locked.getGeneration(), storage.get("reservationId"), request.tenantId()) == 1);
            operations(request).update(WORKSPACE_RETIREMENT, request.retirementId(), WorkspaceOperations.values(
                    "state", "RELEASED", "releasedRevision", revision));
            require(jdbc.update("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL, claim_generation = claim_generation + 1"
                    + " WHERE operation_key = ?", operationKey(request)) == 1);
            return status(request, readPlan(request, operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false)));
        });
    }

    private void patchFinalizer(Request request, ResidentWorkspace selected, RuntimeBindingRecord original,
            Map<String, Object> pod, String action, KubernetesHttpRuntimeClient api) {
        var metadata = map(pod.get("metadata"));
        String resourceVersion = (String) metadata.get("resourceVersion");
        require(resourceVersion != null && resourceVersion.matches("[\\x21-\\x7e]{1,256}"));
        String finalizer = finalizer(request, original);
        var before = metadata.get("finalizers");
        require("ADD".equals(action) ? empty(before) : List.of(finalizer).equals(before));
        var patch = new java.util.ArrayList<Map<String, Object>>();
        patch.add(Map.of("op", "test", "path", "/metadata/uid", "value", metadata.get("uid")));
        patch.add(Map.of("op", "test", "path", "/metadata/resourceVersion", "value", resourceVersion));
        if (before != null) {
            patch.add(Map.of("op", "test", "path", "/metadata/finalizers", "value", before));
        }
        patch.add(Map.of("op", "add", "path", "/metadata/finalizers", "value", "ADD".equals(action) ? List.of(finalizer) : List.of()));
        byte[] body = WorkspaceCsiRuntimeIdentity.bytes(patch);
        var attempt = transaction.execute(status -> {
            lockedPlan(request, selected, true);
            idle(request);
            var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true);
            require(baseline(saved).finalizer().equals(finalizer)
                    && ("ADD".equals(action) ? "DRAINING".equals(saved.get("state")) : "PLATFORM_CLEANED".equals(saved.get("state"))));
            if ("REMOVE".equals(action)) {
                receipt(saved, original);
            }
            var previous = finalizerAttempts(request);
            require(previous.size() < 16 && previous.stream().filter(value -> action.equals(value.get("action"))).count() < 8);
            String owner = UUID.randomUUID().toString();
            require(jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_generation = claim_generation + 1,"
                    + " claim_until = " + ManagedSchemaTime.SQL_NOW + " + 60000 WHERE operation_key = ?"
                    + " AND (claim_until IS NULL OR claim_until <= " + ManagedSchemaTime.SQL_NOW + ")", owner, operationKey(request)) == 1);
            long generation = jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_key = ?", Long.class, operationKey(request));
            String workKey = WorkspaceOperations.hash(action, (String) metadata.get("uid"), resourceVersion, Long.toString(generation));
            operations(request).insertWork(WORKSPACE_RETIREMENT, request.retirementId(), FINALIZER_WORK, workKey, workKey, null,
                    WorkspaceOperations.values("ordinal", previous.size() + 1, "action", action, "resourceVersion", resourceVersion,
                            "requestBase64", Base64.getEncoder().encodeToString(body), "claimGeneration", generation), "UNKNOWN");
            return new Attempt(workKey, owner, generation, body);
        });
        KubernetesHttpRuntimeClient.DeleteResponse response = null;
        try {
            response = api.patchPodFinalizers(selected.registration().namespace(),
                    (String) map(original.getResourceHandle().getValue().get("placement")).get("podName"), body).toCompletableFuture().join();
        } catch (java.util.concurrent.CompletionException failure) {
            // Independent platform readback can recover the effect; this attempt stays UNKNOWN.
        }
        var reply = response;
        transaction.executeWithoutResult(status -> {
            lockedPlan(request, selected, false);
            require(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_key = ? AND claim_owner = ?"
                    + " AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW, Long.class,
                    operationKey(request), attempt.owner(), attempt.generation()) == 1);
            if (reply != null) {
                require(reply.body().length <= 64 * 1024);
                operations(request).updateWork(WORKSPACE_RETIREMENT, request.retirementId(), FINALIZER_WORK, attempt.workKey(),
                        WorkspaceOperations.values("state", reply.complete() ? "RETURNED" : "UNKNOWN", "httpStatus", reply.status(),
                                "responseSha256", org.apache.commons.codec.digest.DigestUtils.sha256Hex(reply.body()), "complete", reply.complete()));
            }
            jdbc.update("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL WHERE operation_key = ?"
                    + " AND claim_owner = ? AND claim_generation = ?", operationKey(request), attempt.owner(), attempt.generation());
        });
    }

    private ResidentWorkspaceReclamation.Baseline baseline(Map<String, Object> saved) {
        require(saved.get("reclamationBaseline") != null);
        var baseline = json.convertValue(saved.get("reclamationBaseline"), ResidentWorkspaceReclamation.Baseline.class);
        require(baseline != null && digest(baseline).equals(saved.get("reclamationBaselineDigest")));
        return baseline;
    }

    private ResidentWorkspaceReclamation.Receipt receipt(Map<String, Object> saved, RuntimeBindingRecord original) {
        require(saved.get("cleanupReceipt") != null);
        var receipt = json.convertValue(saved.get("cleanupReceipt"), ResidentWorkspaceReclamation.Receipt.class);
        require(receipt != null && digest(receipt).equals(saved.get("cleanupReceiptDigest")));
        ResidentWorkspaceReclamation.verifyReceipt(original, baseline(saved), receipt);
        return receipt;
    }

    private static String finalizer(Request request, RuntimeBindingRecord original) {
        return "qwen.ai/retirement-" + WorkspaceOperations.hash(request.tenantId(), request.retirementId(), original.getBindingId()).substring(0, 40);
    }

    private static void verifyProtection(ResidentWorkspace selected, KubernetesHttpRuntimeClient api) {
        new WorkspaceCsiResourceGuard(api, selected.registration().clusterDomain(), selected.registration(),
                selected.protection()).verify().toCompletableFuture().join();
    }

    private ResidentWorkspace authorize(Request request, boolean lock) {
        return authorize(request, selected(request), lock);
    }

    private ResidentWorkspace authorize(Request request, ResidentWorkspace selected, boolean lock) {
        if (lock) {
            WorkspaceMigrationAdmission.lockTenant(jdbc, request.tenantId(), 10);
            ToolPublicationRetentionStore.lockTenant(jdbc, request.tenantId(), 10);
        }
        var rows = jdbc.queryForList("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?"
                + " AND workspace_generation = ? AND storage_id = ? AND config_ref = ? AND policy_ref = ?"
                + (lock ? " FOR UPDATE" : ""), String.class, request.tenantId(), request.workspaceId(), request.workspaceGeneration(),
                selected.registration().storageId(), com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        require(rows.size() == 1 && List.of("ACTIVE", "DRAINING").contains(rows.getFirst()));
        require(jdbc.queryForList("SELECT role FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ?"
                + " AND actor_id = ?" + (lock ? " FOR UPDATE" : ""), String.class, request.tenantId(), request.workspaceId(),
                ManagedWorkspaceRegistry.actorKey(request.tenantId(), request.actorId())).equals(List.of("OWNER")));
        return selected;
    }

    private ResidentWorkspace selected(Request request) {
        return mappings.stream().filter(value -> value.registration().tenantId().equals(request.tenantId())
                && value.workspaceId().equals(request.workspaceId()) && value.workspaceGeneration() == request.workspaceGeneration())
                .findFirst().orElseThrow(ResidentWorkspaceRetirementStore::unavailable);
    }

    private void idle(Request request) {
        require(jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ? AND workspace_id = ?"
                + " AND session_kind = 'PUBLIC' AND status NOT IN ('CLOSED', 'ARCHIVED', 'DELETED') LIMIT 1 FOR UPDATE",
                String.class, request.tenantId(), request.workspaceId()).isEmpty());
        require(jdbc.queryForList("SELECT session_id FROM ma_session_head WHERE tenant_id = ? AND workspace_id = ?"
                + " AND head_kind = 'MANAGED_SESSION' AND (state IS NULL OR state NOT IN ('SEALED', 'DELETED')"
                + " OR writer_lease_until > " + ManagedSchemaTime.SQL_NOW
                + " OR state = 'DELETED' AND (writer_id IS NOT NULL OR writer_lease_until IS NOT NULL)) LIMIT 1 FOR UPDATE",
                String.class, request.tenantId(), request.workspaceId()).isEmpty());
        require(jdbc.queryForList("SELECT rs.runtime_session_id FROM ma_runtime_session rs JOIN ma_runtime_binding b"
                + " ON b.binding_id = rs.binding_id WHERE b.tenant_id = ? AND b.workspace_id = ?"
                + " AND rs.session_state <> 'RELEASED' LIMIT 1 FOR UPDATE", String.class,
                request.tenantId(), request.workspaceId()).isEmpty());
        require(jdbc.queryForList("SELECT e.execution_call_id FROM ma_tool_execution e JOIN ma_runtime_binding b"
                + " ON b.binding_id = e.binding_id WHERE b.tenant_id = ? AND b.workspace_id = ?"
                + " AND e.execution_state <> 'SETTLED' LIMIT 1 FOR UPDATE", String.class,
                request.tenantId(), request.workspaceId()).isEmpty());
    }

    private RuntimeBindingRecord lockedPlan(Request request, ResidentWorkspace selected, boolean checkOwner) {
        if (checkOwner) {
            authorize(request, true);
        } else {
            WorkspaceMigrationAdmission.lockTenant(jdbc, request.tenantId(), 10);
        }
        var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        require(saved != null);
        var plan = plan(request, selected, saved);
        var hint = bindings.findById(plan.bindingId());
        require(hint != null);
        var original = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                bindings.lockActiveForRetirement(connection, hint));
        verifyPlan(plan, original);
        require(original.getState() == RuntimeBindingRecord.State.DRAINING);
        verifyOriginal(selected, original, true);
        plan(request, selected, operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true));
        require(jdbc.queryForObject("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                String.class, request.tenantId(), request.workspaceId()).equals("DRAINING"));
        return original;
    }

    private void verifyOriginal(ResidentWorkspace selected, RuntimeBindingRecord original, boolean lock) {
        WorkspaceCsiRuntimeIdentity.verify(original);
        require(original.getRequest().equals(runtimeRequest(selected)));
        require(jdbc.queryForList("SELECT active_binding_id FROM ma_runtime_slot WHERE request_key = ?"
                + " AND last_generation = ?" + (lock ? " FOR UPDATE" : ""), String.class,
                original.getRequest().requestKey(), original.getGeneration()).equals(List.of(original.getBindingId())));
        if (lock) {
            require(jdbc.queryForList("SELECT alias_key FROM ma_storage WHERE alias_key = ? FOR UPDATE", String.class,
                    selected.registration().aliasKey()).equals(List.of(selected.registration().aliasKey())));
        }
        ResidentWorkspaces.requireRegistration(jdbc, selected);
        var registration = selected.registration();
        var storage = map(original.getResourceHandle().getValue().get("storage"));
        var expected = new LinkedHashMap<String, Object>(Map.of("clusterDomain", registration.clusterDomain(), "namespace", registration.namespace(),
                "pvcUid", registration.pvcUid(), "pvUid", registration.pvUid(), "driver", registration.driver(),
                "volumeHandle", registration.volumeHandle(), "backendDomain", registration.backendDomain(),
                "diskSerial", registration.diskSerial(), "physicalKey", registration.physicalKey()));
        require(storage.get("reservationRevision") instanceof String revision && revision.matches("[1-9][0-9]{0,18}")
                && CsiOwnershipRevision.residentReserved(Long.parseLong(revision)));
        expected.putAll(Map.of("registrationRevision", Long.toString(registration.revision()),
                "reservationId", storage.get("reservationId"), "reservationRevision", storage.get("reservationRevision")));
        require(same(expected, storage));
        var protection = selected.protection();
        require(same(Map.of("namespaceUid", protection.namespaceUid(), "policyName", protection.policyName(), "policyUid", protection.policyUid(),
                "policyGeneration", Long.toString(protection.policyGeneration()), "bindingName", protection.bindingName(),
                "bindingUid", protection.bindingUid(), "bindingGeneration", Long.toString(protection.bindingGeneration())),
                original.getResourceHandle().getValue().get("protection")));
        require(jdbc.queryForList("SELECT binding_id FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'CSI'"
                + " AND csi_phase = 'RESERVED' AND binding_id = ? AND runtime_generation = ? AND csi_registration_key = ?"
                + " AND csi_registration_revision = ? AND csi_reservation_id = ? AND csi_revision = ?"
                + " AND csi_provision_request_id = ? AND holder_key IS NULL AND runtime_session_id IS NULL"
                + (lock ? " FOR UPDATE" : ""), String.class, registration.physicalKey(), original.getBindingId(), original.getGeneration(),
                registration.aliasKey(), registration.revision(), storage.get("reservationId"), Long.parseLong((String) storage.get("reservationRevision")),
                original.getProvisionSeed().getProvisionRequestId()).equals(List.of(original.getBindingId())));
    }

    private Plan plan(Request request, ResidentWorkspace selected, Map<String, Object> saved) {
        Plan plan = readPlan(request, saved);
        require(digest(selected).equals(plan.mappingDigest()) && !"RELEASED".equals(saved.get("state")));
        return plan;
    }

    private Plan readPlan(Request request, Map<String, Object> saved) {
        try {
            String encoded = (String) saved.get("request_json");
            require(encoded != null && encoded.getBytes(StandardCharsets.UTF_8).length <= PLAN_LIMIT);
            Plan plan = json.readValue(encoded, Plan.class);
            require(request.equals(plan.request()) && digest(plan).equals(saved.get("request_digest"))
                    && List.of("DRAINING", "PLATFORM_CLEANED", "RELEASED").contains(saved.get("state"))
                    && (plan.version() == 1 && plan.mapping() == null && "DRAINING".equals(saved.get("state"))
                            || plan.version() == 2 && plan.mapping() != null
                                    && digest(plan.mapping()).equals(plan.mappingDigest())
                                    && request.tenantId().equals(plan.mapping().registration().tenantId())
                                    && request.workspaceId().equals(plan.mapping().workspaceId())
                                    && request.workspaceGeneration() == plan.mapping().workspaceGeneration()));
            return plan;
        } catch (java.io.IOException failure) {
            throw unavailable();
        }
    }

    private static void verifyPlan(Plan plan, RuntimeBindingRecord original) {
        require(original != null && original.getGeneration() == plan.runtimeGeneration()
                && List.of(RuntimeBindingRecord.State.DRAINING, RuntimeBindingRecord.State.RELEASED).contains(original.getState())
                && original.isDrainRequested()
                && original.getResourceHandle() != null && Objects.equals(plan.resourceIdentity(), original.getResourceHandle().getValue().get("identity")));
        WorkspaceCsiRuntimeIdentity.verify(original);
        require(plan.mapping() == null || original.getRequest().equals(runtimeRequest(plan.mapping())));
    }

    private static void verifyPod(RuntimeBindingRecord original, Map<String, Object> pod, String resourceVersion,
            List<String> finalizers) {
        require(pod != null && "v1".equals(pod.get("apiVersion")) && "Pod".equals(pod.get("kind")));
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        var metadata = map(pod.get("metadata"));
        require(placement.get("podName").equals(metadata.get("name")) && placement.get("namespace").equals(metadata.get("namespace"))
                && placement.get("podUid").equals(metadata.get("uid")) && resourceVersion.equals(metadata.get("resourceVersion"))
                && metadata.get("deletionTimestamp") == null && metadata.get("deletionGracePeriodSeconds") == null
                && empty(metadata.get("ownerReferences"))
                && (finalizers.isEmpty() ? empty(metadata.get("finalizers")) : finalizers.equals(metadata.get("finalizers")))
                && digest(pod.get("spec")).equals(original.getResourceHandle().getValue().get("podSpecDigest")));
        var status = map(pod.get("status"));
        require("Running".equals(status.get("phase")) && placement.get("podIp").equals(status.get("podIP"))
                && status.get("containerStatuses") instanceof List<?> containers && containers.size() == 1);
        var container = map(((List<?>) status.get("containerStatuses")).getFirst());
        require(placement.get("containerName").equals(container.get("name"))
                && placement.get("containerId").equals(container.get("containerID")) && placement.get("imageId").equals(container.get("imageID"))
                && Long.valueOf(0).equals(BrokerValues.exactLong(container.get("restartCount")))
                && Boolean.TRUE.equals(container.get("ready")) && map(container.get("state")).containsKey("running"));
    }

    private List<Map<String, Object>> attempts(Request request) {
        return jdbc.query("SELECT * FROM ma_operation_work WHERE operation_key = ? AND work_kind = ? ORDER BY target_key LIMIT 9",
                (row, index) -> WorkspaceOperations.work(row), operationKey(request), WORK);
    }

    private List<Map<String, Object>> finalizerAttempts(Request request) {
        return jdbc.query("SELECT * FROM ma_operation_work WHERE operation_key = ? AND work_kind = ? ORDER BY target_key LIMIT 17",
                (row, index) -> WorkspaceOperations.work(row), operationKey(request), FINALIZER_WORK);
    }

    private Status status(Request request, Plan plan) {
        var attempts = attempts(request);
        var metadata = finalizerAttempts(request);
        var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        require(attempts.size() <= 8 && metadata.size() <= 16);
        return new Status(request.retirementId(), (String) saved.get("state"), plan.bindingId(), plan.runtimeGeneration(), attempts.stream()
                .map(value -> new AttemptStatus(((Number) value.get("ordinal")).intValue(), (String) value.get("resourceVersion"),
                        (String) value.get("state"), value.get("httpStatus") instanceof Number code ? code.intValue() : null,
                        (String) value.get("responseSha256"))).sorted(java.util.Comparator.comparingInt(AttemptStatus::ordinal)).toList(),
                metadata.stream().map(value -> new FinalizerAttemptStatus(((Number) value.get("ordinal")).intValue(),
                        (String) value.get("action"), (String) value.get("resourceVersion"), (String) value.get("state"),
                        value.get("httpStatus") instanceof Number code ? code.intValue() : null, (String) value.get("responseSha256")))
                        .sorted(java.util.Comparator.comparingInt(FinalizerAttemptStatus::ordinal)).toList(),
                saved.get("cleanupReceiptDigest") instanceof String sha ? new Completion(sha, ResidentWorkspaceReclamation.DATA_POLICY,
                        saved.get("releasedRevision") instanceof Number revision ? revision.longValue() : null) : null);
    }

    private WorkspaceOperations operations(Request request) { return new WorkspaceOperations(jdbc, request.tenantId()); }
    private static String operationKey(Request request) { return WorkspaceOperations.key(WORKSPACE_RETIREMENT, request.tenantId(), request.retirementId()); }
    private static RuntimeProvisionRequest runtimeRequest(ResidentWorkspace selected) {
        return new RuntimeProvisionRequest(ResidentWorkspaces.scope(selected), null, WorkspaceCsiReservationStore.PROVISIONER_KIND, selected.registration().storageId());
    }
    private static boolean empty(Object value) { return value == null || value instanceof List<?> list && list.isEmpty(); }
    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (java.io.IOException failure) {
            throw unavailable();
        }
    }
    private static void require(boolean valid) {
        if (!valid) {
            throw unavailable();
        }
    }
    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "resident_retirement_unavailable", "Original idle Workspace maintenance is unavailable.", false);
    }
}
