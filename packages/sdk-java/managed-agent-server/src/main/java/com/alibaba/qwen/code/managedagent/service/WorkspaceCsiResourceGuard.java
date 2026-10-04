package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;

/** Read-only corroboration of registered objects; not proof of an authorization boundary. */
public final class WorkspaceCsiResourceGuard {
    private static final String ADMISSION_VERSION = "admissionregistration.k8s.io/v1";
    private static final String ACK_DRIVER = "diskplugin.csi.alibabacloud.com";
    private final KubernetesRuntimeClient api;
    private final WorkspaceCsiRegistration registration;
    private final ProtectionIdentity protection;

    public record ProtectionIdentity(String namespaceUid, String policyName, String policyUid,
            long policyGeneration, String bindingName, String bindingUid, long bindingGeneration) {
        public ProtectionIdentity {
            for (String value : List.of(namespaceUid, policyName, policyUid, bindingName, bindingUid)) {
                if (value.isBlank() || value.length() > 253 || value.codePoints().anyMatch(point -> point < 33)) {
                    throw new IllegalArgumentException("Invalid CSI protection identity");
                }
            }
            if (policyGeneration < 1 || bindingGeneration < 1) {
                throw new IllegalArgumentException("Invalid CSI protection generation");
            }
        }
    }

    public record Receipt(String physicalKey, long registrationRevision, String namespaceUid,
            String pvcResourceVersion, String pvResourceVersion, ProtectionIdentity protection) {
    }

    public WorkspaceCsiResourceGuard(KubernetesRuntimeClient api, String trustedClusterDomain,
            WorkspaceCsiRegistration registration, ProtectionIdentity protection) {
        this.api = Objects.requireNonNull(api);
        this.registration = Objects.requireNonNull(registration);
        this.protection = Objects.requireNonNull(protection);
        if (!registration.clusterDomain().equals(trustedClusterDomain) || !ACK_DRIVER.equals(registration.driver())) {
            throw unavailable();
        }
    }

    public CompletionStage<Receipt> verify() {
        try {
            return verifyProtection().thenCompose(ignored -> {
                var pvc = api.get("persistentvolumeclaims", registration.namespace(), registration.pvcName())
                        .toCompletableFuture();
                var pv = api.getCluster("persistentvolumes", registration.pvName()).toCompletableFuture();
                var namespace = api.getCluster("namespaces", registration.namespace()).toCompletableFuture();
                return CompletableFuture.allOf(pvc, pv, namespace).thenApply(done ->
                        verifyStorage(pvc.join(), pv.join(), namespace.join()));
            }).thenCompose(receipt -> verifyProtection().thenApply(ignored -> receipt))
                    .exceptionallyCompose(error -> CompletableFuture.failedFuture(verificationFailure(error)));
        } catch (RuntimeException failure) {
            return CompletableFuture.failedFuture(verificationFailure(failure));
        }
    }

    /** Install before registration, after the PVC is Bound. It protects fixed names, not selectors. */
    public static Map<String, Object> policy(WorkspaceCsiRegistration registration, String name) {
        var constraints = Map.of("matchPolicy", "Exact", "namespaceSelector", Map.of(), "objectSelector", Map.of(),
                "resourceRules", List.of(rule("persistentvolumeclaims", "Namespaced"),
                        rule("persistentvolumes", "Cluster"), rule("namespaces", "Cluster")));
        var spec = Map.of("failurePolicy", "Fail", "matchConstraints", constraints,
                "matchConditions", List.of(Map.of("name", "registered-object", "expression",
                        "(request.resource.resource == 'persistentvolumeclaims' && request.namespace == '"
                                + registration.namespace() + "' && oldObject.metadata.name == '" + registration.pvcName()
                                + "') || (request.resource.resource == 'persistentvolumes' && oldObject.metadata.name == '"
                                + registration.pvName() + "') || (request.resource.resource == 'namespaces' && oldObject.metadata.name == '"
                                + registration.namespace() + "')")),
                "validations", List.of(
                        validation("request.operation != 'DELETE'"),
                        validation("request.resource.resource != 'persistentvolumeclaims' || object.spec == oldObject.spec"),
                        validation("request.resource.resource != 'persistentvolumes' || object.spec == oldObject.spec"),
                        validation("request.resource.resource != 'namespaces' || object.metadata.labels == oldObject.metadata.labels")));
        return Map.of("apiVersion", ADMISSION_VERSION, "kind", "ValidatingAdmissionPolicy",
                "metadata", Map.of("name", name), "spec", spec);
    }

    public static Map<String, Object> binding(String policyName, String bindingName) {
        return Map.of("apiVersion", ADMISSION_VERSION, "kind", "ValidatingAdmissionPolicyBinding",
                "metadata", Map.of("name", bindingName), "spec", Map.of("policyName", policyName,
                        "validationActions", List.of("Deny"), "matchResources",
                        Map.of("matchPolicy", "Exact", "namespaceSelector", Map.of(), "objectSelector", Map.of())));
    }

    private CompletionStage<Void> verifyProtection() {
        var policy = api.getCluster("validatingadmissionpolicies", protection.policyName()).toCompletableFuture();
        var binding = api.getCluster("validatingadmissionpolicybindings", protection.bindingName()).toCompletableFuture();
        return CompletableFuture.allOf(policy, binding).thenAccept(ignored -> {
            var actualPolicy = policy.join();
            var actualBinding = binding.join();
            identity(actualPolicy, ADMISSION_VERSION, "ValidatingAdmissionPolicy", protection.policyName(),
                    null, protection.policyUid());
            identity(actualBinding, ADMISSION_VERSION, "ValidatingAdmissionPolicyBinding", protection.bindingName(),
                    null, protection.bindingUid());
            require(number(map(actualPolicy.get("metadata")).get("generation")) == protection.policyGeneration());
            require(number(map(actualBinding.get("metadata")).get("generation")) == protection.bindingGeneration());
            require(policy(registration, protection.policyName()).get("spec").equals(actualPolicy.get("spec")));
            require(binding(protection.policyName(), protection.bindingName()).get("spec").equals(actualBinding.get("spec")));
            var status = map(actualPolicy.get("status"));
            require(number(status.get("observedGeneration")) == protection.policyGeneration());
            var typeChecking = map(status.get("typeChecking"));
            require(typeChecking.isEmpty() || List.of().equals(typeChecking.get("expressionWarnings")));
        });
    }

    private Receipt verifyStorage(Map<String, Object> pvc, Map<String, Object> pv, Map<String, Object> namespace) {
        identity(namespace, "v1", "Namespace", registration.namespace(), null, protection.namespaceUid());
        require("Active".equals(map(namespace.get("status")).get("phase")));
        var labels = map(map(namespace.get("metadata")).get("labels"));
        require("restricted".equals(labels.get("pod-security.kubernetes.io/enforce")));
        require("v1.36".equals(labels.get("pod-security.kubernetes.io/enforce-version")));
        identity(pvc, "v1", "PersistentVolumeClaim", registration.pvcName(), registration.namespace(), registration.pvcUid());
        identity(pv, "v1", "PersistentVolume", registration.pvName(), null, registration.pvUid());
        var pvcSpec = map(pvc.get("spec"));
        var pvSpec = map(pv.get("spec"));
        require("Bound".equals(map(pvc.get("status")).get("phase")));
        require("Bound".equals(map(pv.get("status")).get("phase")));
        require(registration.pvName().equals(pvcSpec.get("volumeName")));
        for (Map<String, Object> spec : List.of(pvcSpec, pvSpec)) {
            require(List.of("ReadWriteOncePod").equals(spec.get("accessModes")));
            require("Filesystem".equals(spec.get("volumeMode")));
        }
        var claim = map(pvSpec.get("claimRef"));
        require("v1".equals(claim.get("apiVersion")) && "PersistentVolumeClaim".equals(claim.get("kind")));
        require(registration.namespace().equals(claim.get("namespace")));
        require(registration.pvcName().equals(claim.get("name")) && registration.pvcUid().equals(claim.get("uid")));
        var csi = map(pvSpec.get("csi"));
        require(registration.driver().equals(csi.get("driver")) && registration.volumeHandle().equals(csi.get("volumeHandle")));
        require("ext4".equals(csi.get("fsType")));
        require(!csi.containsKey("readOnly") || Boolean.FALSE.equals(csi.get("readOnly")));
        for (String unsupported : List.of("hostPath", "local", "nfs", "iscsi", "fc", "flexVolume")) {
            require(!pvSpec.containsKey(unsupported));
        }
        return new Receipt(registration.physicalKey(), registration.revision(), protection.namespaceUid(),
                text(map(pvc.get("metadata")).get("resourceVersion")),
                text(map(pv.get("metadata")).get("resourceVersion")), protection);
    }

    private static Map<String, Object> rule(String resource, String scope) {
        List<String> resources = resource.equals("namespaces")
                ? List.of("namespaces", "namespaces/status", "namespaces/finalize") : List.of(resource);
        return Map.of("operations", List.of("UPDATE", "DELETE"), "apiGroups", List.of(""), "apiVersions", List.of("v1"),
                "resources", resources, "scope", scope);
    }

    private static Map<String, Object> validation(String expression) {
        return Map.of("expression", expression, "message", "Registered Workspace CSI objects are protected.");
    }

    private static void identity(Map<String, Object> object, String version, String kind,
            String name, String namespace, String uid) {
        require(object != null && version.equals(object.get("apiVersion")) && kind.equals(object.get("kind")));
        var metadata = map(object.get("metadata"));
        require(name.equals(metadata.get("name")) && uid.equals(metadata.get("uid")));
        require(Objects.equals(namespace, metadata.get("namespace")));
        require(!metadata.containsKey("deletionTimestamp") && !metadata.containsKey("deletionGracePeriodSeconds"));
        text(metadata.get("resourceVersion"));
    }

    private static Map<String, Object> map(Object value) {
        if (!(value instanceof Map<?, ?> fields)) {
            throw unavailable();
        }
        var result = new LinkedHashMap<String, Object>();
        fields.forEach((key, field) -> {
            if (!(key instanceof String name)) {
                throw unavailable();
            }
            result.put(name, field);
        });
        return result;
    }

    private static long number(Object value) {
        if (!(value instanceof Integer || value instanceof Long) || ((Number) value).longValue() <= 0) {
            throw unavailable();
        }
        return ((Number) value).longValue();
    }

    private static String text(Object value) {
        if (!(value instanceof String text) || text.isBlank() || text.length() > 256) {
            throw unavailable();
        }
        return text;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw unavailable();
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_csi_protection_unavailable",
                "Workspace CSI resource protection is unavailable.", false);
    }

    private static RuntimeBrokerException verificationFailure(Throwable error) {
        while (error instanceof CompletionException && error.getCause() != null) {
            error = error.getCause();
        }
        if (error instanceof RuntimeBrokerException failure && failure.isRetryable()) {
            return new RuntimeBrokerException(503, "workspace_csi_protection_unavailable",
                    "Workspace CSI resource protection is temporarily unavailable.", true);
        }
        return unavailable();
    }
}
