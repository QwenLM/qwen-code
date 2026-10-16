package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiNodeSourceStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceClient;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal;
import com.alibaba.qwen.code.runtimebroker.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.name;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.require;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.text;

/** One reviewed node, armed before CREATE and bound durably before the scheduler gate opens. */
public final class WorkspaceCsiNodeEvidence implements AutoCloseable {
    private final WorkspaceCsiNodeSourceStore store;
    private final WorkspaceCsiNodeSourceStore.Node node;
    private final WorkspaceCsiRegistration registration;
    private final KubernetesRuntimeClient api;
    private final CsiNodeSourceClient source;
    private final CsiNodeSourceClient gateway;
    private final String imageDigest;

    public WorkspaceCsiNodeEvidence(WorkspaceCsiNodeSourceStore store, WorkspaceCsiNodeSourceStore.Node node,
            WorkspaceCsiRegistration registration, KubernetesRuntimeClient api, CsiNodeSourceClient source,
            CsiNodeSourceClient gateway, String image) {
        this.store = Objects.requireNonNull(store);
        this.node = Objects.requireNonNull(node);
        this.registration = Objects.requireNonNull(registration);
        this.api = Objects.requireNonNull(api);
        this.source = Objects.requireNonNull(source);
        this.gateway = Objects.requireNonNull(gateway);
        require(image != null && image.matches("[^\\s]+@sha256:[0-9a-f]{64}")
                && registration.pvName().matches("[a-z0-9-]{1,128}"));
        this.imageDigest = image.substring(image.length() - 64);
    }

    public Map<String, Object> affinity() {
        return Map.of("nodeAffinity", Map.of("requiredDuringSchedulingIgnoredDuringExecution", Map.of("nodeSelectorTerms",
                List.of(Map.of("matchFields", List.of(Map.of("key", "metadata.name", "operator", "In", "values", List.of(node.name()))))))));
    }

    public void arm(RuntimeBindingRecord original, WorkspaceCsiReservationStore.Reservation reservation, Runnable admitted) {
        verifyNode(admitted);
        String armId = UUID.nameUUIDFromBytes(("qwen-csi-source-arm/1\0" + original.getBindingId() + "\0" + reservation.reservationId())
                .getBytes(StandardCharsets.UTF_8)).toString();
        var scope = new CsiNodeSourceJournal.Scope(armId, registration.namespace(), name(original.getProvisionSeed()), "", "",
                registration.driver(), registration.volumeHandle(), registration.pvUid(), registration.pvcUid(), "", original.getBindingId(), "");
        var configuration = new WorkspaceCsiNodeSourceStore.Configuration(node, imageDigest, scope);
        var before = source.observeEvidence();
        admitted.run();
        require(node.identity().equals(before.stream().source()) && node.incarnation().equals(before.stream().incarnation()));
        var armed = source.arm(scope, imageDigest);
        admitted.run();
        armed.evidence().requireExtends(before);
        store.saveArm(original, registration, reservation, configuration, armed.evidence());
        admitted.run();
    }

    public Map<String, Object> bindAndOpen(RuntimeBindingRecord original,
            WorkspaceCsiReservationStore.Reservation reservation, Map<String, Object> pod, Runnable admitted) {
        verifyNode(admitted);
        var association = requireAssociation(original, "ARMED");
        var metadata = map(pod.get("metadata"));
        var spec = map(pod.get("spec"));
        require(metadata.get("deletionTimestamp") == null && metadata.get("ownerReferences") == null
                && registration.namespace().equals(metadata.get("namespace"))
                && name(original.getProvisionSeed()).equals(metadata.get("name")) && !spec.containsKey("nodeName")
                && KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS.equals(spec.get("runtimeClassName"))
                && affinity().equals(spec.get("affinity")) && List.of(Map.of("name", KubernetesHttpRuntimeClient.CSI_SOURCE_GATE)).equals(spec.get("schedulingGates")));
        String uid = (String) metadata.get("uid");
        String version = (String) metadata.get("resourceVersion");
        require(uid != null && UUID.fromString(uid).toString().equals(uid) && version != null && !version.isBlank());
        String arm = association.configuration().scope().armId();
        admitted.run();
        gateway.register(arm, registration.namespace(), name(original.getProvisionSeed()), uid, imageDigest);
        admitted.run();
        String gatedSpecSha256 = digest(spec);
        var bound = source.bind(arm, uid, registration.pvName(), gatedSpecSha256, version);
        admitted.run();
        bound.evidence().requireExtends(association.arm());
        store.saveBound(original, registration, reservation, association, uid, gatedSpecSha256, version, bound.evidence());
        verifyNode(admitted);
        var opened = api.releaseCsiSchedulingGate(registration.namespace(), name(original.getProvisionSeed()), uid, version, spec)
                .toCompletableFuture().join();
        admitted.run();
        var expected = new LinkedHashMap<>(spec);
        expected.remove("schedulingGates");
        require(opened != null && uid.equals(map(opened.get("metadata")).get("uid"))
                && expected.equals(map(opened.get("spec"))));
        return opened;
    }

    public boolean publication(RuntimeBindingRecord original, WorkspaceCsiReservationStore.Reservation reservation,
            Map<String, Object> pod, Runnable admitted) {
        admitted.run();
        var association = requireAssociation(original, "BOUND");
        var evidence = source.observeEvidence();
        admitted.run();
        evidence.requireExtends(association.bound());
        require(node.identity().equals(evidence.stream().source()) && node.incarnation().equals(evidence.stream().incarnation()));
        var matches = evidence.stream().observations().stream().filter(value -> value.scope().armId().equals(association.configuration().scope().armId())).toList();
        require(matches.size() == 1);
        var observed = matches.getFirst();
        require(List.of("BOUND", "MONITORED", "PUBLISHED").contains(observed.state()));
        if (observed.publish() == null || observed.custody() == null) {
            return false;
        }
        var status = map(pod.get("status"));
        var containers = (List<?>) status.get("containerStatuses");
        require(containers != null && containers.size() == 1);
        require(("containerd://" + observed.scope().containerId()).equals(map(containers.getFirst()).get("containerID"))
                && association.podUid().equals(map(pod.get("metadata")).get("uid"))
                && node.name().equals(map(pod.get("spec")).get("nodeName")));
        verifyNode(admitted);
        store.savePublication(original, registration, reservation, association, evidence);
        admitted.run();
        return true;
    }

    public void verifyPublished(RuntimeBindingRecord original, Map<String, Object> placement, Runnable deadline) {
        deadline.run();
        var association = requireAssociation(original, "PUBLISHED");
        var observation = WorkspaceCsiNodeSourceStore.validateEvidence(association.configuration(), association.publication(), "PUBLISHED", association.podUid());
        require(node.name().equals(placement.get("nodeName")) && node.identity().nodeUid().equals(placement.get("nodeUid"))
                && association.podUid().equals(placement.get("podUid"))
                && ("containerd://" + observation.scope().containerId()).equals(placement.get("containerId")));
        var current = source.observeEvidence();
        deadline.run();
        current.requireExtends(association.publication());
        require(current.stream().observations().stream().anyMatch(value -> value.scope().equals(observation.scope())
                && "PUBLISHED".equals(value.state()) && value.publish().equals(observation.publish()) && value.custody().equals(observation.custody())));
        verifyNode(deadline);
    }

    private WorkspaceCsiNodeSourceStore.Association requireAssociation(RuntimeBindingRecord original, String phase) {
        var association = store.inspect(original.getBindingId());
        require(association != null && association.generation() == original.getGeneration() && phase.equals(association.phase())
                && association.configuration().node().equals(node) && association.configuration().imageDigest().equals(imageDigest)
                && association.configuration().scope().namespace().equals(registration.namespace())
                && association.configuration().scope().podName().equals(name(original.getProvisionSeed()))
                && association.physicalKey().equals(registration.physicalKey()));
        return association;
    }

    private void verifyNode(Runnable admitted) {
        Objects.requireNonNull(admitted).run();
        var actual = api.getCluster("nodes", node.name()).toCompletableFuture().join();
        require(actual != null);
        var metadata = map(actual.get("metadata"));
        require(node.name().equals(metadata.get("name")) && node.identity().nodeUid().equals(metadata.get("uid"))
                && metadata.get("deletionTimestamp") == null);
        var status = map(actual.get("status"));
        require(node.identity().bootId().equals(map(status.get("nodeInfo")).get("bootID")));
        var conditions = (List<?>) status.get("conditions");
        require(conditions != null);
        var ready = conditions.stream().map(com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity::map)
                .filter(value -> "Ready".equals(value.get("type"))).toList();
        require(ready.size() == 1 && "True".equals(ready.getFirst().get("status")));
        admitted.run();
        var runtime = api.getCluster("runtimeclasses", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS).toCompletableFuture().join();
        admitted.run();
        require(runtime != null && runtime.keySet().equals(Set.of("apiVersion", "kind", "metadata", "handler"))
                && "node.k8s.io/v1".equals(runtime.get("apiVersion")) && "RuntimeClass".equals(runtime.get("kind"))
                && KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS.equals(runtime.get("handler")));
        var runtimeMetadata = map(runtime.get("metadata"));
        require(KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS.equals(runtimeMetadata.get("name"))
                && runtimeMetadata.get("deletionTimestamp") == null && runtimeMetadata.get("deletionGracePeriodSeconds") == null);
        require(text(runtimeMetadata, "uid", 36).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));
    }

    @Override
    public void close() {
        source.close();
        gateway.close();
    }
}
