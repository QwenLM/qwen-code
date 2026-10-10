package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class WorkspaceCsiResourceGuardTest {
    private final WorkspaceCsiRegistration registration = new WorkspaceCsiRegistration("tenant", "storage",
            "cluster", "runtime", "claim", "pvc-uid", "volume", "pv-uid", "diskplugin.csi.alibabacloud.com",
            "opaque-handle", "backend", "serial", "/workspace", 1);
    private final WorkspaceCsiResourceGuard.ProtectionIdentity protection =
            new WorkspaceCsiResourceGuard.ProtectionIdentity("ns-uid", "protect", "policy-uid", 2,
                    "protect-binding", "binding-uid", 1);

    @Test
    void corroboratesExactBoundObjectsAndRechecksBothProtectionIncarnations() {
        var api = new Api();
        var receipt = guard(api).verify().toCompletableFuture().join();
        assertThat(receipt.physicalKey()).isEqualTo(registration.physicalKey());
        assertThat(receipt.registrationRevision()).isEqualTo(1);
        assertThat(receipt.namespaceUid()).isEqualTo("ns-uid");
        assertThat(api.reads).isEqualTo(7);
        assertThat(api.policyReads).isEqualTo(2);
        assertThat(api.bindingReads).isEqualTo(2);
        assertThat(api.creates).isZero();
        assertThatThrownBy(() -> new WorkspaceCsiResourceGuard(api, "another-cluster", registration, protection))
                .isInstanceOf(RuntimeBrokerException.class);
    }

    @Test
    void rejectsReplacementWrongBindingModesDriverHandleFilesystemAndNamespace() {
        for (String resource : List.of("persistentvolumeclaims", "persistentvolumes", "namespaces",
                "validatingadmissionpolicies", "validatingadmissionpolicybindings")) {
            reject(resource, object -> nested(object, "metadata").put("uid", "replacement"));
            reject(resource, object -> nested(object, "metadata").put("deletionTimestamp", "2026-10-02T00:00:00Z"));
            reject(resource, object -> nested(object, "metadata").remove("resourceVersion"));
            var absent = new Api();
            absent.objects.remove(resource);
            refused(absent);
        }
        reject("persistentvolumeclaims", object -> nested(object, "spec").put("volumeName", "different"));
        for (String resource : List.of("persistentvolumeclaims", "persistentvolumes")) {
            reject(resource, object -> nested(object, "spec").put("accessModes", List.of("ReadWriteOnce")));
            reject(resource, object -> nested(object, "spec").put("volumeMode", "Block"));
            reject(resource, object -> nested(object, "status").put("phase", "Pending"));
        }
        for (String field : List.of("namespace", "name", "uid", "kind", "apiVersion")) {
            reject("persistentvolumes", object -> nested(object, "spec", "claimRef").put(field, "foreign"));
        }
        for (String field : List.of("driver", "volumeHandle", "fsType", "readOnly")) {
            reject("persistentvolumes", object -> nested(object, "spec", "csi").put(field, "foreign"));
        }
        reject("persistentvolumes", object -> nested(object, "spec").put("hostPath", Map.of("path", "/")));
        reject("namespaces", object -> nested(object, "status").put("phase", "Terminating"));
        reject("namespaces", object -> nested(object, "metadata", "labels").put("pod-security.kubernetes.io/enforce", "privileged"));
    }

    @Test
    void rejectsPolicyWeakeningStaleTypeCheckingAndChangeDuringStorageReads() {
        reject("validatingadmissionpolicies", object -> nested(object, "spec").put("failurePolicy", "Ignore"));
        reject("validatingadmissionpolicies", object -> nested(object, "spec").put("validations", List.of()));
        reject("validatingadmissionpolicies", object -> nested(object, "metadata").put("generation", 3));
        reject("validatingadmissionpolicies", object -> nested(object, "status").put("observedGeneration", 1));
        reject("validatingadmissionpolicies", object -> nested(object, "status").remove("typeChecking"));
        reject("validatingadmissionpolicies", object -> nested(object, "status", "typeChecking")
                .put("expressionWarnings", List.of(Map.of("warning", "invalid expression"))));
        reject("validatingadmissionpolicybindings", object -> nested(object, "spec").put("validationActions", List.of("Audit")));
        reject("validatingadmissionpolicybindings", object -> nested(object, "spec").put("policyName", "different"));
        for (String resource : List.of("validatingadmissionpolicies", "validatingadmissionpolicybindings")) {
            var api = new Api();
            api.afterStorage = () -> nested(api.objects.get(resource), "metadata").put("generation", 4);
            refused(api);
        }
        var denied = new Api();
        denied.failure = new RuntimeBrokerException(403, "denied", "sensitive body", false);
        refused(denied);
    }

    @Test
    void preservesRetryabilityWithoutExposingUpstreamFailure() {
        for (boolean synchronous : List.of(false, true)) {
            for (int status : List.of(429, 503)) {
                var api = new Api();
                api.synchronousFailure = synchronous;
                api.failure = new RuntimeBrokerException(status, "runtime_kubernetes_api_failed",
                        "sensitive body opaque-handle", true, new IllegalStateException("sensitive cause"));
                assertThatThrownBy(() -> guard(api).verify().toCompletableFuture().join())
                        .hasCauseInstanceOf(RuntimeBrokerException.class).satisfies(error -> {
                            var cause = (RuntimeBrokerException) error.getCause();
                            assertThat(cause.getStatusCode()).isEqualTo(503);
                            assertThat(cause.getCode()).isEqualTo("workspace_csi_protection_unavailable");
                            assertThat(cause.isRetryable()).isTrue();
                            assertThat(cause.getCause()).isNull();
                            assertThat(cause.getDetails()).isEmpty();
                            assertThat(cause.toString()).doesNotContain("sensitive body", "opaque-handle", "sensitive cause");
                        });
                assertThat(api.creates).isZero();
            }
            var denied = new Api();
            denied.synchronousFailure = synchronous;
            denied.failure = new RuntimeBrokerException(403, "denied", "sensitive body", false);
            refused(denied);
        }
    }

    private WorkspaceCsiResourceGuard guard(Api api) {
        return new WorkspaceCsiResourceGuard(api, "cluster", registration, protection);
    }

    private void reject(String resource, Consumer<Map<String, Object>> mutation) {
        var api = new Api();
        mutation.accept(api.objects.get(resource));
        refused(api);
    }

    private void refused(Api api) {
        assertThatThrownBy(() -> guard(api).verify().toCompletableFuture().join())
                .hasCauseInstanceOf(RuntimeBrokerException.class).satisfies(error -> {
                    var cause = (RuntimeBrokerException) error.getCause();
                    assertThat(cause.getCode()).isEqualTo("workspace_csi_protection_unavailable");
                    assertThat(cause.isRetryable()).isFalse();
                    assertThat(cause.toString()).doesNotContain("opaque-handle", "sensitive body");
                });
        assertThat(api.creates).isZero();
    }

    private final class Api implements KubernetesRuntimeClient {
        private final Map<String, Map<String, Object>> objects = new LinkedHashMap<>();
        private int reads;
        private int creates;
        private int policyReads;
        private int bindingReads;
        private Runnable afterStorage = () -> { };
        private RuntimeBrokerException failure;
        private boolean synchronousFailure;

        private Api() {
            objects.put("persistentvolumeclaims", object("PersistentVolumeClaim", "claim", "runtime", "pvc-uid",
                    Map.of("volumeName", "volume", "volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"))));
            objects.put("persistentvolumes", object("PersistentVolume", "volume", null, "pv-uid",
                    Map.of("volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"),
                            "claimRef", Map.of("apiVersion", "v1", "kind", "PersistentVolumeClaim", "name", "claim",
                                    "namespace", "runtime", "uid", "pvc-uid"),
                            "csi", Map.of("driver", registration.driver(), "volumeHandle", "opaque-handle", "fsType", "ext4"))));
            var namespace = object("Namespace", "runtime", null, "ns-uid", Map.of());
            nested(namespace, "metadata").put("labels", new LinkedHashMap<>(Map.of(
                    "pod-security.kubernetes.io/enforce", "restricted", "pod-security.kubernetes.io/enforce-version", "v1.36")));
            nested(namespace, "status").put("phase", "Active");
            objects.put("namespaces", namespace);
            var policy = copy(WorkspaceCsiResourceGuard.policy(registration, "protect"));
            nested(policy, "metadata").putAll(Map.of("uid", "policy-uid", "generation", 2, "resourceVersion", "12"));
            policy.put("status", new LinkedHashMap<>(Map.of("observedGeneration", 2, "typeChecking", new LinkedHashMap<>())));
            objects.put("validatingadmissionpolicies", policy);
            var binding = copy(WorkspaceCsiResourceGuard.binding("protect", "protect-binding"));
            nested(binding, "metadata").putAll(Map.of("uid", "binding-uid", "generation", 1, "resourceVersion", "13"));
            objects.put("validatingadmissionpolicybindings", binding);
        }

        @Override
        public CompletionStage<Map<String, Object>> get(String resource, String namespace, String name) {
            assertThat(resource).isEqualTo("persistentvolumeclaims");
            assertThat(namespace).isEqualTo("runtime");
            assertThat(name).isEqualTo("claim");
            return read(resource);
        }

        @Override
        public CompletionStage<Map<String, Object>> getCluster(String resource, String name) {
            if (resource.equals("validatingadmissionpolicies")) {
                policyReads++;
            } else if (resource.equals("validatingadmissionpolicybindings")) {
                bindingReads++;
            }
            var result = read(resource);
            if (resource.equals("namespaces")) {
                afterStorage.run();
            }
            return result;
        }

        private CompletionStage<Map<String, Object>> read(String resource) {
            reads++;
            if (failure != null && synchronousFailure) {
                throw failure;
            }
            return failure == null ? CompletableFuture.completedFuture(objects.get(resource))
                    : CompletableFuture.failedFuture(failure);
        }

        @Override
        public CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body) {
            creates++;
            throw new AssertionError("Guard must not create resources");
        }
    }

    private static Map<String, Object> object(String kind, String name, String namespace, String uid, Map<String, Object> spec) {
        var metadata = new LinkedHashMap<String, Object>(Map.of("name", name, "uid", uid, "resourceVersion", "10"));
        if (namespace != null) {
            metadata.put("namespace", namespace);
        }
        return copy(Map.of("apiVersion", "v1", "kind", kind, "metadata", metadata, "spec", spec,
                "status", Map.of("phase", "Bound")));
    }

    private static Map<String, Object> copy(Map<String, Object> object) {
        return new ObjectMapper().convertValue(object, new TypeReference<>() { });
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> nested(Map<String, Object> object, String... path) {
        Map<String, Object> current = object;
        for (String field : path) {
            current = (Map<String, Object>) current.get(field);
        }
        return current;
    }
}
