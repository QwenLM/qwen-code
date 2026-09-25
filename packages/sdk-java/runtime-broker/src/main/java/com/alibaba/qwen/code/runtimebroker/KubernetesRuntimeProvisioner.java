package com.alibaba.qwen.code.runtimebroker;

import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Bare-Pod and Secret provisioner with UID-fenced recovery. */
public final class KubernetesRuntimeProvisioner
        implements RuntimeProvisioner {
    private static final String MANAGED_BY = "qwen-managed-agent";
    private static final String MANAGED_BY_LABEL =
            "app.kubernetes.io/managed-by";
    private static final String PROVISION_LABEL =
            "qwen.alibaba.com/provision-hash";
    private static final String TEMPLATE_LABEL =
            "qwen.alibaba.com/template-hash";
    private static final String RUNTIME_LABEL =
            "qwen.alibaba.com/runtime-hash";
    private static final String BOOT_ENV = "QWEN_MANAGED_RUNTIME_BOOT";
    private static final String OUTPUT_ROOT = "/tmp/qwen-runtime-output";
    private static final List<String> HANDLE_FIELDS = List.of(
            "schemaVersion", "kind", "clusterUid", "namespace",
            "podName", "podUid", "podResourceVersion", "secretName",
            "secretUid", "secretResourceVersion");

    private final KubernetesRuntimeClient client;
    private final String clusterUid;
    private final String namespace;
    private final String image;
    private final int containerPort;
    private final String nodeExecutable;
    private final String workerEntry;
    private final String cliEntry;
    private final String serviceAccountName;
    private final String workspaceClaimName;
    private final String placementDomain;
    private final String templateDigest;

    public KubernetesRuntimeProvisioner(KubernetesRuntimeClient client,
            String clusterUid, String namespace, String image,
            int containerPort, String nodeExecutable, String workerEntry,
            String cliEntry, String serviceAccountName,
            String workspaceClaimName) {
        if (client == null) {
            throw new IllegalArgumentException("client is required");
        }
        if (containerPort <= 0 || containerPort > 65535) {
            throw new IllegalArgumentException(
                    "containerPort must be a valid port");
        }
        this.client = client;
        this.clusterUid = required(clusterUid, "clusterUid");
        this.namespace = dnsLabel(namespace, "namespace");
        this.image = required(image, "image");
        this.containerPort = containerPort;
        this.nodeExecutable = absoluteContainerPath(nodeExecutable,
                "nodeExecutable");
        this.workerEntry = absoluteContainerPath(workerEntry, "workerEntry");
        this.cliEntry = absoluteContainerPath(cliEntry, "cliEntry");
        this.serviceAccountName = optionalDnsLabel(serviceAccountName,
                "serviceAccountName");
        this.workspaceClaimName = optionalDnsLabel(workspaceClaimName,
                "workspaceClaimName");
        this.placementDomain = "kubernetes:" + this.clusterUid + "/"
                + this.namespace;
        this.templateDigest = "sha256:" + digest(String.join("\u0000",
                this.image, Integer.toString(containerPort),
                this.nodeExecutable, this.workerEntry, this.cliEntry,
                valueOrEmpty(this.serviceAccountName),
                valueOrEmpty(this.workspaceClaimName)));
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        CompletableFuture<RuntimeLease> failed = new CompletableFuture<>();
        failed.completeExceptionally(new UnsupportedOperationException(
                "Kubernetes requires durable provisioning"));
        return failed;
    }

    @Override
    public String kind() {
        return "kubernetes";
    }

    @Override
    public String placementDomain() {
        return placementDomain;
    }

    @Override
    public String runtimeTemplateDigest() {
        return templateDigest;
    }

    @Override
    public boolean supportsDurableRecovery() {
        return true;
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle knownHandle) {
        validateRequest(request, seed);
        String name = resourceName(seed);
        HandleIdentity known = knownHandle == null ? null
                : parseHandle(knownHandle, name);
        return resources(name).thenCompose(resources -> {
            Map<String, Object> secret = resources.secret;
            Map<String, Object> pod = resources.pod;
            if (secret != null) {
                validateResource(secret, name, seed, known == null
                        ? null : known.secretUid, "Secret");
            }
            if (pod != null) {
                validateResource(pod, name, seed,
                        known == null ? null : known.podUid, "Pod");
            }
            if (secret == null && pod != null) {
                return failed(conflict(
                        "Kubernetes Pod exists without its Secret."));
            }
            CompletionStage<Map<String, Object>> ensuredSecret =
                    secret == null
                            ? client.createSecret(namespace, name,
                                    secretBody(request, seed, name))
                            : CompletableFuture.completedFuture(secret);
            return ensuredSecret.thenCompose(createdSecret -> {
                validateResource(createdSecret, name, seed,
                        known == null ? null : known.secretUid, "Secret");
                CompletionStage<Map<String, Object>> ensuredPod = pod == null
                        ? client.createPod(namespace, name,
                                podBody(request, seed, name))
                        : CompletableFuture.completedFuture(pod);
                return ensuredPod.thenApply(createdPod -> {
                    validateResource(createdPod, name, seed,
                            known == null ? null : known.podUid, "Pod");
                    return handle(createdPod, createdSecret, name);
                });
            });
        });
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        validateRequest(request, seed);
        String name = resourceName(seed);
        HandleIdentity identity = parseHandle(handle, name);
        return resources(name).handle((resources, error) -> {
            if (error != null) {
                Throwable cause = unwrap(error);
                return cause instanceof RuntimeBrokerException
                                && !((RuntimeBrokerException) cause)
                                        .isRetryable()
                        ? RuntimeObservation.conflict(handle)
                        : RuntimeObservation.unknown(handle);
            }
            if (resources.secret == null && resources.pod == null) {
                return RuntimeObservation.notFound();
            }
            if (resources.secret == null || resources.pod == null) {
                return RuntimeObservation.conflict(handle);
            }
            try {
                validateResource(resources.secret, name, seed,
                        identity.secretUid, "Secret");
                validateResource(resources.pod, name, seed,
                        identity.podUid, "Pod");
            } catch (RuntimeException exception) {
                return RuntimeObservation.conflict(handle);
            }
            Map<String, Object> metadata = object(resources.pod, "metadata");
            if (metadata.get("deletionTimestamp") != null) {
                return RuntimeObservation.notFound();
            }
            Map<String, Object> status = optionalObject(resources.pod,
                    "status");
            String phase = optionalString(status, "phase");
            if ("Failed".equals(phase) || "Succeeded".equals(phase)) {
                return RuntimeObservation.notFound();
            }
            String podIp = optionalString(status, "podIP");
            if (!"Running".equals(phase) || !isReady(status)
                    || podIp == null) {
                return RuntimeObservation.starting(handle);
            }
            RuntimeResourceHandle refreshed = handle(resources.pod,
                    resources.secret, name);
            try {
                return RuntimeObservation.ready(refreshed,
                        endpoint(podIp), seed.getProvisionalRuntimeId(),
                        seed.getLeaseId(), seed.getEpoch());
            } catch (RuntimeBrokerException exception) {
                return RuntimeObservation.conflict(handle);
            }
        });
    }

    @Override
    public CompletionStage<Void> drain(RuntimeResourceContext resource) {
        validateRequest(resource.getRequest(), resource.getSeed());
        parseHandle(resource.getHandle(), resourceName(resource.getSeed()));
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public CompletionStage<Void> release(RuntimeResourceContext resource) {
        validateRequest(resource.getRequest(), resource.getSeed());
        String name = resourceName(resource.getSeed());
        HandleIdentity identity = parseHandle(resource.getHandle(), name);
        return resources(name).thenCompose(resources -> {
            if (resources.pod != null) {
                validateResource(resources.pod, name, resource.getSeed(),
                        identity.podUid, "Pod");
            }
            if (resources.secret != null) {
                validateResource(resources.secret, name, resource.getSeed(),
                        identity.secretUid, "Secret");
            }
            CompletionStage<Void> podDelete = resources.pod == null
                    ? CompletableFuture.completedFuture(null)
                    : client.deletePod(namespace, name, identity.podUid,
                            null);
            return podDelete.thenCompose(ignored ->
                    resources.secret == null
                            ? CompletableFuture.completedFuture(null)
                            : client.deleteSecret(namespace, name,
                                    identity.secretUid, null));
        });
    }

    private CompletionStage<Resources> resources(String name) {
        CompletableFuture<Map<String, Object>> secret = client
                .getSecret(namespace, name).toCompletableFuture();
        CompletableFuture<Map<String, Object>> pod = client
                .getPod(namespace, name).toCompletableFuture();
        return secret.thenCombine(pod, Resources::new);
    }

    private RuntimeResourceHandle handle(Map<String, Object> pod,
            Map<String, Object> secret, String name) {
        Map<String, Object> podMetadata = object(pod, "metadata");
        Map<String, Object> secretMetadata = object(secret, "metadata");
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("schemaVersion", 1);
        value.put("kind", kind());
        value.put("clusterUid", clusterUid);
        value.put("namespace", namespace);
        value.put("podName", name);
        value.put("podUid", requiredString(podMetadata, "uid"));
        value.put("podResourceVersion",
                requiredString(podMetadata, "resourceVersion"));
        value.put("secretName", name);
        value.put("secretUid", requiredString(secretMetadata, "uid"));
        value.put("secretResourceVersion",
                requiredString(secretMetadata, "resourceVersion"));
        return new RuntimeResourceHandle(kind(), 1, value);
    }

    private HandleIdentity parseHandle(RuntimeResourceHandle handle,
            String expectedName) {
        if (handle == null || !kind().equals(handle.getKind())
                || handle.getVersion() != 1
                || !handle.getValue().keySet().equals(
                        new java.util.LinkedHashSet<>(HANDLE_FIELDS))) {
            throw conflict("Kubernetes resource handle is invalid.");
        }
        Map<String, Object> value = handle.getValue();
        Number schemaVersion = number(value.get("schemaVersion"));
        if (schemaVersion.longValue() != 1
                || schemaVersion.doubleValue() != 1
                || !kind().equals(value.get("kind"))
                || !clusterUid.equals(value.get("clusterUid"))
                || !namespace.equals(value.get("namespace"))
                || !expectedName.equals(value.get("podName"))
                || !expectedName.equals(value.get("secretName"))) {
            throw conflict("Kubernetes resource handle conflicts.");
        }
        String podUid = requiredString(value, "podUid");
        String secretUid = requiredString(value, "secretUid");
        requiredString(value, "podResourceVersion");
        requiredString(value, "secretResourceVersion");
        return new HandleIdentity(podUid, secretUid);
    }

    private void validateResource(Map<String, Object> resource, String name,
            RuntimeProvisionSeed seed, String expectedUid, String type) {
        if (resource == null) {
            throw unavailable("Kubernetes " + type + " is unavailable.");
        }
        Map<String, Object> metadata = object(resource, "metadata");
        if (!name.equals(requiredString(metadata, "name"))
                || !namespace.equals(requiredString(metadata, "namespace"))) {
            throw conflict("Kubernetes " + type + " identity conflicts.");
        }
        Map<String, Object> labels = object(metadata, "labels");
        Map<String, String> expectedLabels = labels(seed);
        for (Map.Entry<String, String> expected : expectedLabels.entrySet()) {
            if (!expected.getValue().equals(labels.get(expected.getKey()))) {
                throw conflict("Kubernetes " + type
                        + " immutable labels conflict.");
            }
        }
        String uid = requiredString(metadata, "uid");
        requiredString(metadata, "resourceVersion");
        if (expectedUid != null && !expectedUid.equals(uid)) {
            throw conflict("Kubernetes " + type + " UID conflicts.");
        }
    }

    private Map<String, Object> secretBody(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, String name) {
        Map<String, Object> boot = new LinkedHashMap<>();
        boot.put("type", "boot");
        boot.put("version", 1);
        boot.put("runtimeInstanceId", seed.getProvisionalRuntimeId());
        boot.put("provisionRequestId", seed.getProvisionRequestId());
        boot.put("gatewayIncarnation", seed.getGatewayIncarnation());
        boot.put("leaseId", seed.getLeaseId());
        boot.put("epoch", seed.getEpoch());
        boot.put("tenantId", request.getScope().getTenantId());
        boot.put("workspaceId", request.getScope().getWorkspaceId());
        boot.put("workspaceGeneration",
                request.getScope().getWorkspaceGeneration());
        boot.put("workspaceCwd", request.getScope().getCanonicalCwd());
        boot.put("capabilityDigest",
                request.getScope().getCapabilityDigest());
        boot.put("isolationClass",
                request.getScope().getIsolationClass());
        boot.put("token", seed.getToken());
        boot.put("outputRoot", OUTPUT_ROOT);
        boot.put("cliEntry", cliEntry);
        boot.put("listenHostname", "0.0.0.0");
        boot.put("listenPort", containerPort);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("apiVersion", "v1");
        body.put("kind", "Secret");
        body.put("metadata", metadata(name, seed));
        body.put("type", "Opaque");
        body.put("data", Map.of("boot.json", Base64.getEncoder()
                .encodeToString(JsonCodec.encode(boot))));
        return body;
    }

    private Map<String, Object> podBody(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, String name) {
        Map<String, Object> container = new LinkedHashMap<>();
        container.put("name", "runtime");
        container.put("image", image);
        container.put("imagePullPolicy", "IfNotPresent");
        container.put("command", List.of(nodeExecutable, workerEntry));
        container.put("args", List.of("--boot-env"));
        container.put("ports", List.of(Map.of("name", "runtime",
                "containerPort", containerPort, "protocol", "TCP")));
        container.put("env", List.of(Map.of("name", BOOT_ENV,
                "valueFrom", Map.of("secretKeyRef", Map.of("name", name,
                        "key", "boot.json")))));
        List<Map<String, Object>> mounts = new ArrayList<>();
        if (workspaceClaimName != null) {
            mounts.add(Map.of("name", "workspace", "mountPath",
                    request.getScope().getCanonicalCwd()));
        }
        if (!mounts.isEmpty()) {
            container.put("volumeMounts", mounts);
        }
        container.put("startupProbe", probe(60));
        container.put("readinessProbe", probe(3));
        container.put("securityContext", Map.of(
                "allowPrivilegeEscalation", false));

        List<Map<String, Object>> volumes = new ArrayList<>();
        if (workspaceClaimName != null) {
            volumes.add(Map.of("name", "workspace",
                    "persistentVolumeClaim", Map.of("claimName",
                            workspaceClaimName)));
        }

        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("restartPolicy", "Never");
        if (serviceAccountName != null) {
            spec.put("serviceAccountName", serviceAccountName);
        }
        spec.put("automountServiceAccountToken", false);
        spec.put("containers", List.of(container));
        if (!volumes.isEmpty()) {
            spec.put("volumes", volumes);
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("apiVersion", "v1");
        body.put("kind", "Pod");
        body.put("metadata", metadata(name, seed));
        body.put("spec", spec);
        return body;
    }

    private static Map<String, Object> probe(int failureThreshold) {
        return Map.of("tcpSocket", Map.of("port", "runtime"),
                "periodSeconds", 1, "timeoutSeconds", 1,
                "failureThreshold", failureThreshold);
    }

    private Map<String, Object> metadata(String name,
            RuntimeProvisionSeed seed) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("name", name);
        metadata.put("namespace", namespace);
        metadata.put("labels", labels(seed));
        return metadata;
    }

    private Map<String, String> labels(RuntimeProvisionSeed seed) {
        Map<String, String> labels = new LinkedHashMap<>();
        labels.put(MANAGED_BY_LABEL, MANAGED_BY);
        labels.put(PROVISION_LABEL,
                digest(seed.getProvisionRequestId()).substring(0, 32));
        labels.put(TEMPLATE_LABEL,
                digest(templateDigest).substring(0, 32));
        labels.put(RUNTIME_LABEL,
                digest(seed.getProvisionalRuntimeId()).substring(0, 32));
        return labels;
    }

    private void validateRequest(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
        if (request == null || seed == null) {
            throw new IllegalArgumentException(
                    "request and seed are required");
        }
        if (!kind().equals(request.getProvisionerKind())
                || !placementDomain.equals(request.getPlacementDomain())
                || !templateDigest.equals(
                        request.getRuntimeTemplateDigest())) {
            throw conflict("Kubernetes placement identity conflicts.");
        }
        String workspace = request.getScope().getCanonicalCwd();
        if (!workspace.startsWith("/") || workspace.indexOf('\u0000') >= 0
                || !normalizedPosixPath(workspace)
                || !request.getScope().getWorkspaceId().equals(
                        digest(workspace).substring(0, 16))) {
            throw conflict("Kubernetes workspace identity conflicts.");
        }
    }

    private String resourceName(RuntimeProvisionSeed seed) {
        return "qwen-runtime-" + digest(seed.getProvisionRequestId())
                .substring(0, 32);
    }

    private URI endpoint(String podIp) {
        String host = required(podIp, "podIP");
        if (!isIpLiteral(host)) {
            throw conflict("Kubernetes Pod IP is invalid.");
        }
        if (host.contains(":")) {
            host = "[" + host + "]";
        }
        try {
            return BrokerValues.requireOrigin(URI.create("http://" + host
                    + ":" + containerPort), "endpoint");
        } catch (RuntimeException exception) {
            throw conflict("Kubernetes Pod IP is invalid.");
        }
    }

    private static boolean isIpLiteral(String value) {
        if (value.indexOf(':') >= 0) {
            if (!value.matches("[0-9a-fA-F:]+")) {
                return false;
            }
            try {
                return InetAddress.getByName(value) instanceof Inet6Address;
            } catch (UnknownHostException exception) {
                return false;
            }
        }
        String[] octets = value.split("\\.", -1);
        if (octets.length != 4) {
            return false;
        }
        for (String octet : octets) {
            if (octet.isEmpty() || octet.length() > 3
                    || (octet.length() > 1 && octet.startsWith("0"))
                    || !octet.matches("[0-9]+")) {
                return false;
            }
            int number;
            try {
                number = Integer.parseInt(octet);
            } catch (NumberFormatException exception) {
                return false;
            }
            if (number > 255) {
                return false;
            }
        }
        return true;
    }

    private static boolean isReady(Map<String, Object> status) {
        Object rawConditions = status.get("conditions");
        if (!(rawConditions instanceof List)) {
            return false;
        }
        for (Object value : (List<?>) rawConditions) {
            if (value instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> condition =
                        (Map<String, Object>) value;
                if ("Ready".equals(condition.get("type"))
                        && "True".equals(condition.get("status"))) {
                    return true;
                }
            }
        }
        return false;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Map<String, Object> parent,
            String field) {
        Object value = parent.get(field);
        if (!(value instanceof Map)) {
            throw conflict("Kubernetes resource is malformed.");
        }
        return (Map<String, Object>) value;
    }

    private static Map<String, Object> optionalObject(
            Map<String, Object> parent, String field) {
        Object value = parent.get(field);
        if (value == null) {
            return Map.of();
        }
        return object(parent, field);
    }

    private static String requiredString(Map<String, Object> parent,
            String field) {
        Object value = parent.get(field);
        if (!(value instanceof String) || ((String) value).isBlank()) {
            throw conflict("Kubernetes resource is malformed.");
        }
        return (String) value;
    }

    private static String optionalString(Map<String, Object> parent,
            String field) {
        Object value = parent.get(field);
        return value instanceof String && !((String) value).isBlank()
                ? (String) value : null;
    }

    private static Number number(Object value) {
        if (!(value instanceof Number)) {
            throw conflict("Kubernetes resource handle is malformed.");
        }
        return (Number) value;
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }

    private static String optionalDnsLabel(String value, String name) {
        return value == null || value.isBlank() ? null
                : dnsLabel(value, name);
    }

    private static String absoluteContainerPath(String value, String name) {
        String path = required(value, name);
        // A container path is POSIX whatever OS the Broker runs on, so it is
        // checked as a string rather than through the host's Path rules.
        if (!path.startsWith("/") || path.indexOf('\u0000') >= 0
                || !normalizedPosixPath(path)) {
            throw new IllegalArgumentException(
                    name + " must be an absolute normalized path");
        }
        return path;
    }

    private static boolean normalizedPosixPath(String path) {
        if (path.equals("/")) {
            return true;
        }
        for (String segment : path.substring(1).split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".")
                    || segment.equals("..")) {
                return false;
            }
        }
        return true;
    }

    private static String dnsLabel(String value, String name) {
        String label = required(value, name);
        if (label.length() > 63
                || !label.matches("[a-z0-9](?:[-a-z0-9]*[a-z0-9])?")) {
            throw new IllegalArgumentException(
                    name + " must be a Kubernetes DNS label");
        }
        return label;
    }

    private static String valueOrEmpty(String value) {
        return value == null ? "" : value;
    }

    private static String digest(String value) {
        try {
            byte[] hashed = MessageDigest.getInstance("SHA-256").digest(
                    value.getBytes(StandardCharsets.UTF_8));
            StringBuilder encoded = new StringBuilder(hashed.length * 2);
            for (byte next : hashed) {
                encoded.append(Character.forDigit((next >>> 4) & 0xf, 16));
                encoded.append(Character.forDigit(next & 0xf, 16));
            }
            return encoded.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable",
                    exception);
        }
    }

    private static RuntimeBrokerException conflict(String message) {
        return new RuntimeBrokerException(409,
                "runtime_broker_resource_conflict", message, false);
    }

    private static RuntimeBrokerException unavailable(String message) {
        return new RuntimeBrokerException(503,
                "runtime_broker_scheduler_unavailable", message, true);
    }

    private static <T> CompletionStage<T> failed(Throwable error) {
        CompletableFuture<T> failed = new CompletableFuture<>();
        failed.completeExceptionally(error);
        return failed;
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while (current instanceof java.util.concurrent.CompletionException
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static final class Resources {
        private final Map<String, Object> secret;
        private final Map<String, Object> pod;

        Resources(Map<String, Object> secret, Map<String, Object> pod) {
            this.secret = secret;
            this.pod = pod;
        }
    }

    private static final class HandleIdentity {
        private final String podUid;
        private final String secretUid;

        HandleIdentity(String podUid, String secretUid) {
            this.podUid = podUid;
            this.secretUid = secretUid;
        }
    }
}
