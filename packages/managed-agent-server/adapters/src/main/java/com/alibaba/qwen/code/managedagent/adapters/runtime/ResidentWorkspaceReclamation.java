package com.alibaba.qwen.code.managedagent.adapters.runtime;

import com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation.*;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.spi.KubernetesMaintenanceClient;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation.DATA_POLICY;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.text;

/** Normal platform cleanup inside an exclusive Managed namespace; never an exceptional fence. */
public final class ResidentWorkspaceReclamation {
    private record Node(Map<String, Object> value, String bootId, String resourceVersion, Instant heartbeat) { }
    private record Lease(String uid, String resourceVersion, Instant renewed) { }

    private ResidentWorkspaceReclamation() { }

    public static Baseline prepare(RuntimeBindingRecord original, ResidentWorkspace selected,
            String finalizer, KubernetesMaintenanceClient api, Instant now) {
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        var node = node(placement, api, now, false);
        var lease = lease(placement, api, now);
        requireVolumes(node.value(), uniqueVolume(selected), true);
        exclusive(original, selected, api);
        var attachments = attachments(selected, api);
        require(attachments.size() == 1);
        var attachment = attachments.getFirst();
        var metadata = map(attachment.get("metadata"));
        require(metadata.get("deletionTimestamp") == null
                && placement.get("nodeName").equals(map(attachment.get("spec")).get("nodeName"))
                && Boolean.TRUE.equals(map(attachment.get("status")).get("attached")));
        return new Baseline(finalizer, node.bootId(), node.resourceVersion(), node.heartbeat().toString(),
                lease.uid(), lease.resourceVersion(), lease.renewed().toString(), text(metadata, "uid", 128));
    }

    public static Receipt complete(RuntimeBindingRecord original, ResidentWorkspace selected, Baseline baseline,
            Map<String, Object> pod, KubernetesMaintenanceClient api, Instant now) {
        var handle = original.getResourceHandle().getValue();
        var placement = map(handle.get("placement"));
        require(pod != null);
        var metadata = map(pod.get("metadata"));
        require(placement.get("podUid").equals(metadata.get("uid"))
                && placement.get("podName").equals(metadata.get("name"))
                && placement.get("namespace").equals(metadata.get("namespace"))
                && List.of(baseline.finalizer()).equals(metadata.get("finalizers"))
                && empty(metadata.get("ownerReferences")) && digest(pod.get("spec")).equals(handle.get("podSpecDigest")));
        var spec = map(pod.get("spec"));
        require(empty(spec.get("initContainers")) && empty(spec.get("ephemeralContainers")));
        var status = map(pod.get("status"));
        require(List.of("Succeeded", "Failed").contains(status.get("phase"))
                && status.get("containerStatuses") instanceof List<?> containers && containers.size() == 1);
        var container = map(((List<?>) status.get("containerStatuses")).getFirst());
        var state = map(container.get("state"));
        require(placement.get("containerName").equals(container.get("name"))
                && placement.get("containerId").equals(container.get("containerID"))
                && placement.get("imageId").equals(container.get("imageID"))
                && Long.valueOf(0).equals(BrokerValues.exactLong(container.get("restartCount")))
                && Boolean.FALSE.equals(container.get("ready")) && state.keySet().equals(java.util.Set.of("terminated")));
        var terminated = map(state.get("terminated"));
        require(placement.get("containerId").equals(terminated.get("containerID"))
                && !"ContainerStatusUnknown".equals(terminated.get("reason")));
        Instant deletion = instant(metadata, "deletionTimestamp");
        Instant finished = instant(terminated, "finishedAt");
        // The API deletion timestamp is a grace deadline, not the start of termination.
        require(!finished.isAfter(now));
        var node = node(placement, api, now, true);
        var lease = lease(placement, api, now);
        require(node.bootId().equals(baseline.bootId()) && !node.resourceVersion().equals(baseline.nodeResourceVersion())
                && node.heartbeat().isAfter(Instant.parse(baseline.nodeHeartbeat())) && !node.heartbeat().isBefore(finished)
                && lease.uid().equals(baseline.leaseUid()) && !lease.resourceVersion().equals(baseline.leaseResourceVersion())
                && lease.renewed().isAfter(Instant.parse(baseline.leaseRenewTime())) && !lease.renewed().isBefore(finished));
        requireVolumes(node.value(), uniqueVolume(selected), false);
        exclusive(original, selected, api);
        require(attachments(selected, api).isEmpty());
        return new Receipt((String) handle.get("identity"), digest(baseline), text(metadata, "resourceVersion", 256),
                deletion.toString(), finished.toString(), node.resourceVersion(), node.heartbeat().toString(),
                lease.resourceVersion(), lease.renewed().toString(), now.toString(), DATA_POLICY);
    }

    private static Node node(Map<String, Object> placement, KubernetesMaintenanceClient api, Instant now, boolean fresh) {
        var node = api.getCluster("nodes", (String) placement.get("nodeName")).toCompletableFuture().join();
        require(node != null);
        var metadata = map(node.get("metadata"));
        require(placement.get("nodeUid").equals(metadata.get("uid")) && placement.get("nodeName").equals(metadata.get("name"))
                && metadata.get("deletionTimestamp") == null);
        var spec = map(node.get("spec"));
        if (spec.get("taints") instanceof List<?> taints) {
            require(taints.stream().noneMatch(value -> List.of("node.kubernetes.io/out-of-service",
                    "node.kubernetes.io/unreachable", "node.kubernetes.io/not-ready").contains(map(value).get("key"))));
        }
        var status = map(node.get("status"));
        require(status.get("conditions") instanceof List<?>);
        var conditions = ((List<?>) status.get("conditions")).stream().map(value -> map(value))
                .filter(value -> "Ready".equals(value.get("type"))).toList();
        require(conditions.size() == 1 && "True".equals(conditions.getFirst().get("status")));
        var heartbeat = instant(conditions.getFirst(), "lastHeartbeatTime");
        require(!heartbeat.isAfter(now) && (!fresh || !heartbeat.isBefore(now.minusSeconds(60))));
        return new Node(node, text(map(status.get("nodeInfo")), "bootID", 256),
                text(metadata, "resourceVersion", 256), heartbeat);
    }

    private static Lease lease(Map<String, Object> placement, KubernetesMaintenanceClient api, Instant now) {
        var lease = api.getNodeLease((String) placement.get("nodeName")).toCompletableFuture().join();
        require(lease != null);
        var metadata = map(lease.get("metadata"));
        require(placement.get("nodeName").equals(metadata.get("name"))
                && "kube-node-lease".equals(metadata.get("namespace")) && metadata.get("deletionTimestamp") == null
                && metadata.get("ownerReferences") instanceof List<?> owners && owners.size() == 1);
        var owner = map(((List<?>) metadata.get("ownerReferences")).getFirst());
        require("v1".equals(owner.get("apiVersion")) && "Node".equals(owner.get("kind"))
                && placement.get("nodeUid").equals(owner.get("uid")) && placement.get("nodeName").equals(owner.get("name")));
        var spec = map(lease.get("spec"));
        Long duration = BrokerValues.exactLong(spec.get("leaseDurationSeconds"));
        Instant renewed = instant(spec, "renewTime");
        require(placement.get("nodeName").equals(spec.get("holderIdentity")) && duration != null && duration > 0 && duration <= 60
                && !renewed.isAfter(now) && renewed.plusSeconds(duration).isAfter(now));
        return new Lease(text(metadata, "uid", 128), text(metadata, "resourceVersion", 256), renewed);
    }

    private static void exclusive(RuntimeBindingRecord original, ResidentWorkspace selected, KubernetesMaintenanceClient api) {
        var registration = selected.registration();
        var physical = api.listPersistentVolumes().toCompletableFuture().join().stream().filter(pv -> {
            var spec = map(pv.get("spec"));
            return spec.get("csi") instanceof Map<?, ?> csi && registration.driver().equals(csi.get("driver"))
                    && registration.volumeHandle().equals(csi.get("volumeHandle"));
        }).toList();
        require(physical.size() == 1 && registration.pvName().equals(map(physical.getFirst().get("metadata")).get("name"))
                && registration.pvUid().equals(map(physical.getFirst().get("metadata")).get("uid")));
        var placement = map(original.getResourceHandle().getValue().get("placement"));
        var consumers = api.listPods(registration.namespace()).toCompletableFuture().join().stream().filter(pod -> {
            var volumes = map(pod.get("spec")).get("volumes");
            return volumes instanceof List<?> list && list.stream().anyMatch(value -> map(value).get("persistentVolumeClaim")
                    instanceof Map<?, ?> pvc && registration.pvcName().equals(pvc.get("claimName")));
        }).toList();
        require(consumers.size() == 1 && placement.get("podUid").equals(map(consumers.getFirst().get("metadata")).get("uid"))
                && placement.get("podName").equals(map(consumers.getFirst().get("metadata")).get("name")));
    }

    private static List<Map<String, Object>> attachments(ResidentWorkspace selected, KubernetesMaintenanceClient api) {
        return api.listVolumeAttachments().toCompletableFuture().join().stream().filter(value -> {
            var spec = map(value.get("spec"));
            if (!selected.registration().pvName().equals(map(spec.get("source")).get("persistentVolumeName"))) {
                return false;
            }
            require(selected.registration().driver().equals(spec.get("attacher")));
            return true;
        }).toList();
    }

    private static void requireVolumes(Map<String, Object> node, String unique, boolean mounted) {
        var status = map(node.get("status"));
        var inUse = status.get("volumesInUse");
        var attached = status.get("volumesAttached");
        require(inUse == null || inUse instanceof List<?>);
        require(attached == null || attached instanceof List<?>);
        boolean using = inUse instanceof List<?> list && list.contains(unique);
        boolean attaching = attached instanceof List<?> list && list.stream().anyMatch(value -> unique.equals(map(value).get("name")));
        require(using == mounted && attaching == mounted);
    }

    private static String uniqueVolume(ResidentWorkspace selected) {
        return "kubernetes.io/csi/" + selected.registration().driver() + "^" + selected.registration().volumeHandle();
    }

    private static Instant instant(Map<String, Object> value, String key) {
        try {
            return Instant.parse(text(value, key, 128));
        } catch (java.time.DateTimeException failure) {
            throw unavailable();
        }
    }

    private static boolean empty(Object value) { return value == null || value instanceof List<?> list && list.isEmpty(); }
    private static void require(boolean valid) {
        if (!valid) {
            throw unavailable();
        }
    }
    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "resident_reclamation_incomplete", "Original platform cleanup is incomplete.", false);
    }
}
