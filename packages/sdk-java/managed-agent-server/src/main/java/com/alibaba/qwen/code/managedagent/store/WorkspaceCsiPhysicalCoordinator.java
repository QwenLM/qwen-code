package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationJson.require;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;

import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceClient;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal;
import com.alibaba.qwen.code.runtimebroker.CsiPodDeletion;
import com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Fixed original-source operations and normal Pod deletion, outside every SQL transaction. */
public final class WorkspaceCsiPhysicalCoordinator {
    private final WorkspaceCsiPhysicalStore store;
    private final WorkspaceCsiNodeSourceStore.Node node;
    private final CsiNodeSourceClient source;
    private final KubernetesRuntimeClient api;
    private final WorkspaceCsiResourceGuard guard;

    public WorkspaceCsiPhysicalCoordinator(WorkspaceCsiPhysicalStore store, WorkspaceCsiNodeSourceStore.Node node,
            CsiNodeSourceClient source, KubernetesRuntimeClient api, WorkspaceCsiResourceGuard guard) {
        this.store = Objects.requireNonNull(store);
        this.node = Objects.requireNonNull(node);
        this.source = Objects.requireNonNull(source);
        this.api = Objects.requireNonNull(api);
        this.guard = Objects.requireNonNull(guard);
    }

    public WorkspaceCsiPhysicalStore.Status plan(WorkspaceCsiPhysicalStore.Original original, String token) {
        return work(original, token).status();
    }

    public WorkspaceCsiPhysicalStore.Status intent(WorkspaceCsiPhysicalStore.Original original, String token) {
        var work = work(original, token);
        if (!"PLANNED".equals(work.status().stage())) {
            return work.status();
        }
        corroborate(work);
        var reply = source.requestStop(work.source().configuration().scope().armId(), original.retirementId(), work.status().planSha256());
        WorkspaceCsiPhysicalSource.validate(work.source(), original.retirementId(), work.status().planSha256(), reply.evidence());
        return store.saveIntent(original, token, reply.evidence());
    }

    public WorkspaceCsiPhysicalStore.Status delete(WorkspaceCsiPhysicalStore.Original original, String token) {
        var work = work(original, token);
        require(List.of("INTENT", "STOPPED", "UNPUBLISHED").contains(work.status().stage()));
        if ("UNPUBLISHED".equals(work.status().stage())) {
            return work.status();
        }
        corroborate(work);
        var before = observeSource(work);
        if ("UNPUBLISHED".equals(before.observation().state())) {
            return store.observe(original, token, before.evidence());
        }
        JsonNode plan = WorkspaceCsiApplicationJson.object(work.plan(), 64 * 1024);
        String namespace = plan.path("namespace").textValue();
        String name = plan.path("podName").textValue();
        var pod = await(api.get("pods", namespace, name));
        require(pod != null && "v1".equals(pod.get("apiVersion")) && "Pod".equals(pod.get("kind")));
        var metadata = map(pod.get("metadata"));
        require(namespace.equals(metadata.get("namespace")) && name.equals(metadata.get("name"))
                && plan.path("podUid").textValue().equals(metadata.get("uid"))
                && metadata.get("deletionTimestamp") == null && metadata.get("deletionGracePeriodSeconds") == null
                && empty(metadata.get("ownerReferences")) && empty(metadata.get("finalizers"))
                && plan.path("podSpecDigest").textValue().equals(WorkspaceCsiRuntimeIdentity.digest(pod.get("spec"))));
        var request = CsiPodDeletion.prepare(namespace, name, plan.path("podUid").textValue(),
                WorkspaceCsiRuntimeIdentity.text(metadata, "resourceVersion", 128));
        var attempt = store.prepareDeletion(original, token, request);
        if (!attempt.send()) {
            return attempt.status();
        }
        corroborate(work);
        var latest = observeSource(work);
        if ("UNPUBLISHED".equals(latest.observation().state())) {
            return store.observe(original, token, latest.evidence());
        }
        var result = await(api.deleteCsiPod(attempt.request()));
        return store.saveReply(original, token, attempt.ordinal(), result);
    }

    public WorkspaceCsiPhysicalStore.Status observe(WorkspaceCsiPhysicalStore.Original original, String token) {
        var work = work(original, token);
        require(!"PLANNED".equals(work.status().stage()));
        corroborate(work);
        var observed = observeSource(work);
        return store.observe(original, token, observed.evidence());
    }

    private WorkspaceCsiPhysicalStore.Work work(WorkspaceCsiPhysicalStore.Original original, String token) {
        require(!TransactionSynchronizationManager.isActualTransactionActive());
        return store.plan(original, token, node);
    }

    private void corroborate(WorkspaceCsiPhysicalStore.Work work) {
        require(!TransactionSynchronizationManager.isActualTransactionActive());
        var receipt = await(guard.verify());
        var plan = WorkspaceCsiApplicationJson.object(work.plan(), 64 * 1024);
        var pin = receipt.protection();
        var protection = Map.of("namespaceUid", pin.namespaceUid(), "policyName", pin.policyName(), "policyUid", pin.policyUid(),
                "policyGeneration", Long.toString(pin.policyGeneration()), "bindingName", pin.bindingName(), "bindingUid", pin.bindingUid(),
                "bindingGeneration", Long.toString(pin.bindingGeneration()));
        require(work.source().physicalKey().equals(receipt.physicalKey()) && Long.toString(receipt.registrationRevision()).equals(plan.path("registrationRevision").textValue())
                && receipt.namespaceUid().equals(pin.namespaceUid()) && plan.path("protection").equals(
                        WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(protection), 4096)));
        var actual = await(api.getCluster("nodes", node.name()));
        require(actual != null && "v1".equals(actual.get("apiVersion")) && "Node".equals(actual.get("kind")));
        var metadata = map(actual.get("metadata"));
        require(node.name().equals(metadata.get("name")) && node.identity().nodeUid().equals(metadata.get("uid"))
                && metadata.get("deletionTimestamp") == null);
        var status = map(actual.get("status"));
        require(node.identity().bootId().equals(map(status.get("nodeInfo")).get("bootID")) && status.get("conditions") instanceof List<?>);
        var ready = ((List<?>) status.get("conditions")).stream().map(WorkspaceCsiRuntimeIdentity::map)
                .filter(value -> "Ready".equals(value.get("type"))).toList();
        require(ready.size() == 1 && "True".equals(ready.getFirst().get("status")));
    }

    private Observed observeSource(WorkspaceCsiPhysicalStore.Work work) {
        require(!TransactionSynchronizationManager.isActualTransactionActive());
        var evidence = source.observeEvidence();
        require(work.previous() != null);
        evidence.requireExtends(work.previous());
        var observation = WorkspaceCsiPhysicalSource.validate(work.source(), work.status().retirementId(), work.status().planSha256(), evidence);
        return new Observed(evidence, observation);
    }

    private static <T> T await(CompletionStage<T> stage) {
        var future = stage.toCompletableFuture();
        try {
            return future.get(10, TimeUnit.SECONDS);
        } catch (Exception failure) {
            future.cancel(true);
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new IllegalStateException("The original CSI physical operation result is unavailable", failure);
        }
    }

    private static boolean empty(Object value) { return value == null || value instanceof List<?> values && values.isEmpty(); }
    private record Observed(CsiNodeSourceJournal.Evidence evidence, CsiNodeSourceJournal.Observation observation) { }
}
