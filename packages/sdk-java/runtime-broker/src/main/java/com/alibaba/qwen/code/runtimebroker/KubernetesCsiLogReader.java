package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Private native log qualification input; a snapshot never authorizes holder release. */
public final class KubernetesCsiLogReader {
    private final KubernetesRuntimeClient api;
    private final Source source;

    public record Source(String podName, String podUid, String nodeName, String nodeUid,
            String daemonSetUid, String containerId, String imageId) {
        public Source {
            KubernetesHttpRuntimeClient.dnsSubdomain(podName);
            KubernetesHttpRuntimeClient.dnsSubdomain(nodeName);
            if (!podName.startsWith("csi-plugin-") || !uuid(podUid) || !uuid(nodeUid) || !uuid(daemonSetUid)
                    || containerId == null || !containerId.matches("containerd://[0-9a-f]{64}")
                    || imageId == null || imageId.length() > 512 || !imageId.matches("[^\\s]*sha256:[0-9a-f]{64}")) {
                throw new IllegalArgumentException("Invalid CSI log source");
            }
        }
    }

    public static final class Snapshot {
        private final Source source;
        private final String content;
        private final String sha256;

        private Snapshot(Source source, String content) {
            this.source = source;
            this.content = content;
            try {
                this.sha256 = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                        .digest(content.getBytes(StandardCharsets.UTF_8)));
            } catch (NoSuchAlgorithmException impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        public Source source() {
            return source;
        }

        public String content() {
            return content;
        }

        public String sha256() {
            return sha256;
        }

        @Override
        public String toString() {
            return "CSI log snapshot sha256=" + sha256;
        }
    }

    public KubernetesCsiLogReader(KubernetesRuntimeClient api, Source source) {
        this.api = Objects.requireNonNull(api);
        this.source = Objects.requireNonNull(source);
    }

    public CompletionStage<Snapshot> read(Snapshot previous) {
        if (previous != null && !source.equals(previous.source())) {
            return CompletableFuture.failedFuture(unavailable());
        }
        try {
            return verifySource().thenCompose(ignored -> api.readCsiPodLog(source.podName()))
                    .thenApply(content -> {
                        if (content == null || content.isEmpty() || content.length() > 1024 * 1024
                                || content.getBytes(StandardCharsets.UTF_8).length > 1024 * 1024
                                || !new String(content.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8).equals(content)
                                || !content.endsWith("\n") || content.indexOf('\r') >= 0
                                || content.indexOf('\u0000') >= 0
                                || (previous != null && !content.startsWith(previous.content()))) {
                            throw unavailable();
                        }
                        for (String line : content.split("\n")) {
                            int space = line.indexOf(' ');
                            if (space < 20 || !line.substring(0, space).matches(
                                    "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
                                            + "(?:\\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})")) {
                                throw unavailable();
                            }
                            Instant.parse(line.substring(0, space));
                        }
                        return new Snapshot(source, content);
                    }).thenCompose(snapshot -> verifySource().thenApply(ignored -> snapshot))
                    .exceptionallyCompose(error -> CompletableFuture.failedFuture(unavailable()));
        } catch (RuntimeException error) {
            return CompletableFuture.failedFuture(unavailable());
        }
    }

    private CompletionStage<Void> verifySource() {
        var pod = api.get("pods", "kube-system", source.podName()).toCompletableFuture();
        var node = api.getCluster("nodes", source.nodeName()).toCompletableFuture();
        return CompletableFuture.allOf(pod, node).thenAccept(ignored -> {
            identity(pod.join(), "Pod", source.podName(), "kube-system", source.podUid());
            identity(node.join(), "Node", source.nodeName(), null, source.nodeUid());
            var spec = map(pod.join().get("spec"));
            require(source.nodeName().equals(spec.get("nodeName")));
            var owners = list(map(pod.join().get("metadata")).get("ownerReferences"));
            require(owners.size() == 1);
            var owner = map(owners.getFirst());
            require("apps/v1".equals(owner.get("apiVersion")) && "DaemonSet".equals(owner.get("kind"))
                    && "csi-plugin".equals(owner.get("name")) && source.daemonSetUid().equals(owner.get("uid"))
                    && Boolean.TRUE.equals(owner.get("controller")));
            var status = map(pod.join().get("status"));
            require("Running".equals(status.get("phase")));
            var containers = list(status.get("containerStatuses")).stream().map(KubernetesCsiLogReader::map)
                    .filter(value -> "csi-plugin".equals(value.get("name"))).toList();
            require(containers.size() == 1);
            var container = containers.getFirst();
            require(source.containerId().equals(container.get("containerID"))
                    && source.imageId().equals(container.get("imageID"))
                    && Long.valueOf(0).equals(BrokerValues.exactLong(container.get("restartCount")))
                    && Boolean.TRUE.equals(container.get("ready"))
                    && map(container.get("state")).keySet().equals(java.util.Set.of("running")));
            var ready = list(map(node.join().get("status")).get("conditions")).stream()
                    .map(KubernetesCsiLogReader::map).filter(value -> "Ready".equals(value.get("type"))).toList();
            require(ready.size() == 1 && "True".equals(ready.getFirst().get("status")));
        });
    }

    private static void identity(Map<String, Object> object, String kind, String name, String namespace, String uid) {
        require(object != null && "v1".equals(object.get("apiVersion")) && kind.equals(object.get("kind")));
        var metadata = map(object.get("metadata"));
        require(uid.equals(metadata.get("uid")) && name.equals(metadata.get("name"))
                && Objects.equals(namespace, metadata.get("namespace"))
                && !metadata.containsKey("deletionTimestamp") && !metadata.containsKey("deletionGracePeriodSeconds"));
    }

    private static Map<?, ?> map(Object value) {
        if (!(value instanceof Map<?, ?> map)) {
            throw unavailable();
        }
        return map;
    }

    private static List<?> list(Object value) {
        if (!(value instanceof List<?> list)) {
            throw unavailable();
        }
        return list;
    }

    private static boolean uuid(String value) {
        if (value == null) {
            return false;
        }
        try {
            return UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw unavailable();
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_csi_log_unavailable", "Workspace CSI logs are unavailable.", false);
    }
}
