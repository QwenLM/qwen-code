package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.adapters.runtime.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public final class ResidentRetirementFixture {
    private static final String UID = "11111111-1111-4111-8111-111111111111";
    private static final ObjectMapper JSON = new ObjectMapper();
    public final DataSource source;
    public final ManagedSchemaJdbcTemplate jdbc;
    public final DataSourceTransactionManager manager;
    public final JdbcRuntimeBindingRepository bindings;
    public final WorkspaceCsiReservationStore storage;
    public final ResidentWorkspace mapping;
    public final ResidentWorkspaceRetirementStore.Request request;
    public final RuntimeProvisionRequest runtimeRequest;
    public final Map<String, Map<String, Object>> objects = new LinkedHashMap<>();
    public final List<Map<String, Object>> attachments = new java.util.ArrayList<>();
    public RuntimeBindingRecord original;
    private final ManagedAgentProperties properties = new ManagedAgentProperties();

    public ResidentRetirementFixture(DataSource source) {
        this(source, "workspace");
    }

    public ResidentRetirementFixture(DataSource source, String workspaceId) {
        this.source = source;
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        mapping = new ResidentWorkspace(workspaceId, 1,
                new WorkspaceCsiRegistration("tenant", "storage", "cluster", "runtime", "claim", "pvc-uid",
                        "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "handle", "backend", "serial", "/workspace", 1),
                new com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity(UID, "protect", UID, 1, "protect-binding", UID, 1),
                "worker@sha256:" + "a".repeat(64), List.of("node", "/worker/cli.js"), List.of());
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setResidentWorkspaces(List.of(mapping));
        request = new ResidentWorkspaceRetirementStore.Request("tenant", workspaceId, 1, "owner", UUID.randomUUID().toString());
        runtimeRequest = new RuntimeProvisionRequest(ResidentWorkspaces.scope(mapping), null, "kubernetes-workspace", "storage");
        storage = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
        storage.register(mapping.registration());
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES ('tenant', ?, 1, 'storage', 'resident', ?, ?, 'ACTIVE')",
                workspaceId, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', ?, ?, 'OWNER')", workspaceId, com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "owner"));
    }

    public ResidentWorkspaceRetirementStore store() {
        return new ResidentWorkspaceRetirementStore(jdbc, manager, bindings, List.of(mapping), JSON);
    }

    public StoreModels.Admission create(String key) {
        var store = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), mock(CommittedEventPublisher.class),
                new ManagedWorkspaceRegistry(jdbc), properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        return new TransactionTemplate(manager).execute(status -> store.insertWorkspaceSessionCommand(SessionCreationCommand.builder()
                .tenantId("tenant")
                .actorId("owner")
                .idempotencyKey(key)
                .requestDigest("digest-" + key)
                .agentId("qwen-code")
                .title("Session")
                .selection(new WorkspaceSelection(mapping.workspaceId(), "."))
                .build()));
    }

    public RuntimeBindingRecord ready() {
        if (original != null) {
            return original;
        }
        var created = bindings.findOrCreate(runtimeRequest);
        var claimed = bindings.claimOperation(created.getBindingId(), "setup", Duration.ofMinutes(5));
        var reserved = storage.reserve(mapping.registration(), bindings, claimed, UUID.randomUUID().toString());
        var seed = claimed.getProvisionSeed();
        var registration = mapping.registration();
        var tuple = new LinkedHashMap<String, Object>();
        tuple.putAll(Map.of("clusterDomain", registration.clusterDomain(), "namespace", registration.namespace(),
                "backendDomain", registration.backendDomain(), "driver", registration.driver(), "volumeHandle", registration.volumeHandle(),
                "diskSerial", registration.diskSerial(), "physicalKey", registration.physicalKey(), "pvcUid", registration.pvcUid(),
                "pvUid", registration.pvUid(), "registrationRevision", "1"));
        tuple.putAll(Map.of("reservationId", reserved.reservationId(), "reservationRevision", Long.toString(reserved.revision())));
        String name = WorkspaceCsiRuntimeIdentity.name(seed);
        String podUid = "workspace".equals(mapping.workspaceId()) ? UID
                : UUID.nameUUIDFromBytes(mapping.workspaceId().getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
        var placement = new LinkedHashMap<String, Object>();
        placement.putAll(Map.of("clusterDomain", "cluster", "namespace", "runtime", "namespaceUid", UID,
                "podName", name, "podUid", podUid, "nodeName", "node-a", "nodeUid", UID));
        placement.putAll(Map.of("containerName", "runtime", "containerId", "containerd://" + "b".repeat(64),
                "image", mapping.image(), "imageId", "sha256:" + "a".repeat(64), "podIp", "10.4.0.8",
                "secretName", name, "secretUid", UID));
        var protection = Map.<String, Object>of("namespaceUid", UID, "policyName", "protect", "policyUid", UID,
                "policyGeneration", "1", "bindingName", "protect-binding", "bindingUid", UID, "bindingGeneration", "1");
        var spec = Map.<String, Object>of("nodeName", "node-a", "restartPolicy", "Never", "containers",
                List.of(Map.of("name", "runtime", "image", mapping.image(), "command", mapping.command(), "volumeMounts",
                        List.of(Map.of("name", "workspace", "mountPath", "/workspace")))), "volumes",
                List.of(Map.of("name", "workspace", "persistentVolumeClaim", Map.of("claimName", "claim"))));
        var boot = WorkspaceCsiRuntimeIdentity.boot(runtimeRequest, seed, tuple);
        var identity = new LinkedHashMap<String, Object>();
        identity.putAll(Map.of("bindingId", claimed.getBindingId(), "runtimeGeneration", "1",
                "context", WorkspaceCsiRuntimeIdentity.context(boot), "storage", tuple, "placement", placement,
                "protection", protection, "artifacts", List.of(), "bootDigest", digest(boot), "podSpecDigest", digest(spec),
                "mount", Map.of("mountId", "9", "device", "259:1", "source", "/dev/nvme1n1", "diskSerial", "serial",
                        "rootDevice", "66305", "rootInode", "2")));
        identity.put("identity", digest(identity));
        var attested = bindings.compareAndSet(claimed, claimed.withAttestation(WorkspaceCsiRuntimeIdentity.lease(seed, placement),
                new RuntimeResourceHandle("kubernetes-workspace", 1, identity), Instant.now(), Instant.now()));
        original = bindings.releaseOperation(attested.getBindingId(), "setup", attested.getOperationGeneration());
        WorkspaceCsiRuntimeIdentity.verify(original);
        objects.put("pods", object("Pod", name, "runtime", podUid, spec));
        objects.get("pods").put("status", copy(Map.of("phase", "Running", "podIP", "10.4.0.8", "containerStatuses",
                List.of(Map.of("name", "runtime", "containerID", placement.get("containerId"), "imageID", placement.get("imageId"),
                        "restartCount", 0, "ready", true, "state", Map.of("running", Map.of()))))));
        objects.put("nodes", object("Node", "node-a", null, UID, Map.of()));
        objects.get("nodes").put("status", copy(Map.of("conditions", List.of(Map.of("type", "Ready", "status", "True")))));
        resources();
        return original;
    }

    public static KubernetesHttpRuntimeClient maintenanceMethods(KubernetesHttpRuntimeClient api) {
        org.mockito.Mockito.doCallRealMethod().when(api).verifyProtection(any(), any());
        org.mockito.Mockito.doCallRealMethod().when(api).reclamationBaseline(any(), any(), anyString(), any());
        org.mockito.Mockito.doCallRealMethod().when(api).reclamationReceipt(any(), any(), any(), any(), any());
        return api;
    }

    public KubernetesHttpRuntimeClient api() {
        var api = ResidentRetirementFixture.maintenanceMethods(mock(KubernetesHttpRuntimeClient.class));
        when(api.get(anyString(), anyString(), anyString())).thenAnswer(call ->
                CompletableFuture.completedFuture(objects.get(call.<String>getArgument(0))));
        when(api.getCluster(anyString(), anyString())).thenAnswer(call ->
                CompletableFuture.completedFuture(objects.get(call.<String>getArgument(0))));
        when(api.deletePod(anyString(), anyString(), any(byte[].class))).thenReturn(
                CompletableFuture.completedFuture(new KubernetesHttpRuntimeClient.DeleteResponse(200, new byte[0], true)));
        when(api.getNodeLease(anyString())).thenAnswer(call -> CompletableFuture.completedFuture(objects.get("leases")));
        when(api.listPersistentVolumes()).thenAnswer(call -> CompletableFuture.completedFuture(List.of(objects.get("persistentvolumes"))));
        when(api.listVolumeAttachments()).thenAnswer(call -> CompletableFuture.completedFuture(List.copyOf(attachments)));
        when(api.listPods(anyString())).thenAnswer(call -> CompletableFuture.completedFuture(objects.containsKey("pods")
                ? List.of(objects.get("pods")) : List.of()));
        when(api.patchPodFinalizers(anyString(), anyString(), any(byte[].class))).thenAnswer(call -> {
            var patch = JSON.readTree(call.<byte[]>getArgument(2));
            var finalizers = JSON.convertValue(patch.get(patch.size() - 1).get("value"), new TypeReference<List<String>>() { });
            var pod = objects.get("pods");
            var metadata = map(pod.get("metadata"));
            if (!patch.get(0).get("value").textValue().equals(metadata.get("uid"))
                    || !patch.get(1).get("value").textValue().equals(metadata.get("resourceVersion"))) {
                return CompletableFuture.completedFuture(new KubernetesHttpRuntimeClient.DeleteResponse(409, new byte[0], true));
            }
            metadata.put("finalizers", finalizers);
            metadata.put("resourceVersion", Long.toString(Long.parseLong((String) metadata.get("resourceVersion")) + 1));
            if (finalizers.isEmpty() && metadata.containsKey("deletionTimestamp")) {
                objects.remove("pods");
            }
            return CompletableFuture.completedFuture(new KubernetesHttpRuntimeClient.DeleteResponse(200, new byte[0], true));
        });
        return api;
    }

    public void preparePlatform() {
        var now = Instant.now();
        String volume = "kubernetes.io/csi/" + mapping.registration().driver() + "^handle";
        objects.get("nodes").put("status", copy(Map.of("nodeInfo", Map.of("bootID", "boot-a"),
                "conditions", List.of(Map.of("type", "Ready", "status", "True", "lastHeartbeatTime", now.minusSeconds(10).toString())),
                "volumesInUse", List.of(volume), "volumesAttached", List.of(Map.of("name", volume)))));
        objects.put("leases", object("Lease", "node-a", "kube-node-lease", "lease-uid", Map.of("holderIdentity", "node-a",
                "leaseDurationSeconds", 40, "renewTime", now.minusSeconds(2).toString())));
        map(objects.get("leases").get("metadata")).put("ownerReferences", List.of(Map.of("apiVersion", "v1", "kind", "Node", "name", "node-a", "uid", UID)));
        var attachment = object("VolumeAttachment", "attachment", null, "attachment-uid", Map.of("attacher", mapping.registration().driver(),
                "source", Map.of("persistentVolumeName", "volume"), "nodeName", "node-a"));
        attachment.put("status", Map.of("attached", true));
        attachments.add(attachment);
    }

    public void completePlatform() {
        var now = Instant.now();
        var pod = objects.get("pods");
        map(pod.get("metadata")).put("deletionTimestamp", now.minusSeconds(3).toString());
        var status = map(pod.get("status"));
        status.put("phase", "Failed");
        var container = map(((List<?>) status.get("containerStatuses")).getFirst());
        container.put("ready", false);
        container.put("state", Map.of("terminated", Map.of("containerID", container.get("containerID"),
                "finishedAt", now.minusSeconds(2).toString(), "reason", "Error", "exitCode", 143)));
        var nodeStatus = map(objects.get("nodes").get("status"));
        nodeStatus.put("volumesInUse", List.of());
        nodeStatus.put("volumesAttached", List.of());
        nodeStatus.put("conditions", List.of(Map.of("type", "Ready", "status", "True", "lastHeartbeatTime", now.minusSeconds(1).toString())));
        map(objects.get("nodes").get("metadata")).put("resourceVersion", "20");
        map(objects.get("leases").get("metadata")).put("resourceVersion", "20");
        map(objects.get("leases").get("spec")).put("renewTime", now.minusSeconds(1).toString());
        attachments.clear();
    }

    public void resourceVersion(String version) {
        map(objects.get("pods").get("metadata")).put("resourceVersion", version);
    }

    public List<Map<String, Object>> attempts() {
        return jdbc.query("SELECT * FROM ma_operation_work WHERE work_kind = 'POD_DELETE_ATTEMPT' ORDER BY target_key",
                (row, index) -> WorkspaceOperations.work(row));
    }

    private void resources() {
        var registration = mapping.registration();
        objects.put("persistentvolumeclaims", object("PersistentVolumeClaim", "claim", "runtime", "pvc-uid",
                Map.of("volumeName", "volume", "volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"))));
        objects.put("persistentvolumes", object("PersistentVolume", "volume", null, "pv-uid",
                Map.of("volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"),
                        "claimRef", Map.of("apiVersion", "v1", "kind", "PersistentVolumeClaim", "name", "claim", "namespace", "runtime", "uid", "pvc-uid"),
                        "csi", Map.of("driver", registration.driver(), "volumeHandle", "handle", "fsType", "ext4"))));
        objects.put("namespaces", object("Namespace", "runtime", null, UID, Map.of()));
        map(objects.get("namespaces").get("metadata")).put("labels", Map.of("pod-security.kubernetes.io/enforce", "restricted",
                "pod-security.kubernetes.io/enforce-version", "v1.36"));
        objects.get("namespaces").put("status", Map.of("phase", "Active"));
        var policy = copy(WorkspaceCsiResourceGuard.policy(registration, "protect"));
        map(policy.get("metadata")).putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "12"));
        policy.put("status", Map.of("observedGeneration", 1, "typeChecking", Map.of()));
        objects.put("validatingadmissionpolicies", policy);
        var binding = copy(WorkspaceCsiResourceGuard.binding("protect", "protect-binding"));
        map(binding.get("metadata")).putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "13"));
        objects.put("validatingadmissionpolicybindings", binding);
    }

    private static Map<String, Object> object(String kind, String name, String namespace, String uid, Map<String, Object> spec) {
        var metadata = new LinkedHashMap<String, Object>(Map.of("name", name, "uid", uid, "resourceVersion", "10"));
        if (namespace != null) {
            metadata.put("namespace", namespace);
        }
        return copy(Map.of("apiVersion", "v1", "kind", kind, "metadata", metadata, "spec", spec, "status", Map.of("phase", "Bound")));
    }

    private static Map<String, Object> copy(Map<String, Object> value) {
        return JSON.convertValue(value, new TypeReference<>() { });
    }
}
