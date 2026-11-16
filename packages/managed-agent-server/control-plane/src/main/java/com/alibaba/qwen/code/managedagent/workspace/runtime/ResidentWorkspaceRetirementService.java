package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.repository.ResidentRetirementRepository;
import com.alibaba.qwen.code.managedagent.repository.ResidentRetirementRepository.*;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.spi.KubernetesMaintenanceClient;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
public final class ResidentWorkspaceRetirementService {
    private final ResidentRetirementRepository repository;
    public ResidentWorkspaceRetirementService(ResidentRetirementRepository repository) { this.repository = repository; }

    public Status deletePod(
            Request request, String resourceVersion, KubernetesMaintenanceClient api) {
        require(resourceVersion != null && resourceVersion.matches("[\\x21-\\x7e]{1,256}"));
        var selected = repository.selected(request);
        var original = repository.original(request, selected);
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        String workKey = com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key((String) placement.get("podUid"), resourceVersion);
        if (repository.hasDeletionAttempt(request, workKey)) {
            return repository.inspect(request);
        }
        api.verifyProtection(selected.registration(), selected.protection()).toCompletableFuture().join();
        String podName = (String) placement.get("podName");
        var pod = api.get("pods", selected.registration().namespace(), podName).toCompletableFuture().join();
        var saved = repository.loadState(request);
        var baseline = saved.get("reclamationBaseline") == null ? null : repository.baseline(saved);
        verifyPod(original, pod, resourceVersion, baseline == null ? List.of() : List.of(baseline.finalizer()));
        var node = api.getCluster("nodes", (String) placement.get("nodeName")).toCompletableFuture().join();
        require(node != null && placement.get("nodeUid").equals(map(node.get("metadata")).get("uid"))
                && map(node.get("status")).get("conditions") instanceof List<?> conditions
                && conditions.stream().anyMatch(value -> "Ready".equals(map(value).get("type"))
                        && "True".equals(map(value).get("status"))));
        byte[] body = WorkspaceCsiRuntimeIdentity.bytes(Map.of("apiVersion", "v1", "kind", "DeleteOptions",
                "gracePeriodSeconds", 30, "propagationPolicy", "Background", "preconditions",
                Map.of("uid", placement.get("podUid"), "resourceVersion", resourceVersion)));
        Attempt attempt = repository.beginDeletion(request, selected, workKey, resourceVersion, body);
        if (attempt == null) {
            return repository.inspect(request);
        }
        KubernetesMaintenanceClient.DeleteResponse reply = null;
        try {
            reply = api.deletePod(selected.registration().namespace(), podName, attempt.body()).toCompletableFuture().join();
        } catch (java.util.concurrent.CompletionException failure) {
            // The durable UNKNOWN attempt must survive a lost reply without resending.
        }
        var response = reply;
        repository.completeDeletion(request, selected, attempt, response);
        return repository.inspect(request);
    }

    public Status prepareReclamation(
            Request request, String resourceVersion, KubernetesMaintenanceClient api) {
        require(resourceVersion != null && resourceVersion.matches("[\\x21-\\x7e]{1,256}"));
        var prior = repository.inspect(request);
        if (!"DRAINING".equals(prior.state())) {
            require(!"NOT_STARTED".equals(prior.state()));
            return prior;
        }
        var selected = repository.selected(request);
        var original = repository.original(request, selected);
        var saved = repository.loadState(request);
        require(repository.planVersion(request, saved) == 2);
        verifyProtection(selected, api);
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        var pod = api.get("pods", selected.registration().namespace(), (String) placement.get("podName")).toCompletableFuture().join();
        require(pod != null);
        String finalizer = finalizer(request, original);
        var retained = saved.get("reclamationBaseline") == null ? null : repository.baseline(saved);
        if (retained != null && List.of(finalizer).equals(map(pod.get("metadata")).get("finalizers"))) {
            verifyPod(original, pod, resourceVersion, List.of(finalizer));
            return repository.inspect(request);
        }
        verifyPod(original, pod, resourceVersion, List.of());
        var observed = api.reclamationBaseline(original, selected, finalizer, Instant.now());
        repository.recordBaseline(request, selected, observed, finalizer);
        patchFinalizer(request, selected, original, pod, "ADD", api);
        return repository.inspect(request);
    }

    public Status reclaim(Request request, KubernetesMaintenanceClient api) {
        var prior = repository.inspect(request);
        if ("RELEASED".equals(prior.state())) {
            return prior;
        }
        var selected = repository.selected(request);
        var original = repository.original(request, selected);
        var saved = repository.loadState(request);
        require(repository.planVersion(request, saved) == 2);
        var baseline = repository.baseline(saved);
        require(baseline.finalizer().equals(finalizer(request, original)));
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        String namespace = selected.registration().namespace();
        String name = (String) placement.get("podName");
        if ("DRAINING".equals(saved.get("state"))) {
            require(repository.hasDeletionAttempts(request));
            verifyProtection(selected, api);
            var pod = api.get("pods", namespace, name).toCompletableFuture().join();
            var observed = api.reclamationReceipt(original, selected, baseline, pod, Instant.now());
            repository.recordCleanup(request, selected, baseline, observed, original);
        }
        saved = repository.loadState(request);
        var proof = repository.receipt(saved, original);
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
                return repository.inspect(request);
            }
        }
        return repository.release(request, selected, proof);
    }

    private void patchFinalizer(
            Request request,
            ResidentWorkspace selected,
            RuntimeBindingRecord original,
            Map<String, Object> pod,
            String action,
            KubernetesMaintenanceClient api) {
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
        var attempt = repository.beginFinalizer(request, selected, original, finalizer, action, metadata, resourceVersion, body);
        KubernetesMaintenanceClient.DeleteResponse response = null;
        try {
            response = api.patchPodFinalizers(selected.registration().namespace(),
                    (String) map(original.getResourceHandle().getValue().get("placement")).get("podName"), body).toCompletableFuture().join();
        } catch (java.util.concurrent.CompletionException failure) {
            // Independent platform readback can recover the effect; this attempt stays UNKNOWN.
        }
        var reply = response;
        repository.completeFinalizer(request, selected, attempt, reply);
    }

    private static void verifyProtection(
            ResidentWorkspace selected, KubernetesMaintenanceClient api) {
        api.verifyProtection(selected.registration(), selected.protection()).toCompletableFuture().join();
    }

    private static void verifyPod(
            RuntimeBindingRecord original,
            Map<String, Object> pod,
            String resourceVersion,
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

    private static String finalizer(Request request, RuntimeBindingRecord original) {
        return "qwen.ai/retirement-" + com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(request.tenantId(), request.retirementId(), original.getBindingId()).substring(0, 40);
    }

    private static boolean empty(Object value) {
        return value == null || value instanceof List<?> list && list.isEmpty();
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
