package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class KubernetesCsiLogReaderTest {
    private static final String POD_UID = "12345678-1234-5678-9abc-123456789abc";
    private static final String NODE_UID = "23456789-2345-6789-abcd-23456789abcd";
    private static final String DAEMON_UID = "34567890-3456-7890-abcd-34567890abcd";
    private static final String CID = "containerd://" + "b".repeat(64);
    private static final String IMAGE = "docker-pullable://qualified-plugin@sha256:" + "c".repeat(64);
    private static final String FIRST = "2026-10-01T16:32:00.000Z plugin original baseline\n";
    private static final String NEXT = "2026-10-01T16:40:42.007Z diagnostic ordinary unpublish text\n";
    private static final KubernetesCsiLogReader.Source SOURCE = new KubernetesCsiLogReader.Source(
            "csi-plugin-original", POD_UID, "cn-beijing.10.135.59.43", NODE_UID, DAEMON_UID, CID, IMAGE);

    @Test
    void retainsExactNativeBytesAndRequiresThePreviousCompletePrefix() throws Exception {
        var api = new Api();
        var reader = new KubernetesCsiLogReader(api, SOURCE);
        var first = reader.read(null).toCompletableFuture().join();
        assertEquals(FIRST, first.content());
        assertEquals(SOURCE, first.source());
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(FIRST.getBytes(StandardCharsets.UTF_8))), first.sha256());
        api.logs = FIRST + NEXT;
        var second = reader.read(first).toCompletableFuture().join();
        assertEquals(FIRST + NEXT, second.content());
        assertEquals(4, api.podReads.get());
        assertEquals(4, api.nodeReads.get());
        assertEquals(2, api.logReads.get());
        assertFalse(second.toString().contains("unpublish"));
        api.logs = NEXT;
        assertClosed(reader.read(second));
        api.logs = FIRST + "changed\n";
        assertClosed(reader.read(second));
    }

    @Test
    void refusesOriginalSourceReplacementBeforeOrAfterTheNativeRead() {
        for (String mutation : List.of("pod", "node", "container", "image", "restart", "daemon", "deleting", "unready")) {
            for (boolean after : List.of(false, true)) {
                var api = new Api();
                api.mutation = mutation;
                api.mutateAfterLog = after;
                assertClosed(new KubernetesCsiLogReader(api, SOURCE).read(null));
                assertEquals(after ? 1 : 0, api.logReads.get(), mutation + " after=" + after);
            }
        }
    }

    @Test
    void acceptsNativeRfc3339OffsetWithoutRewritingBytesOrDigest() throws Exception {
        var api = new Api();
        api.logs = "2026-10-02T00:33:35.462444611+08:00 original CSI line\n";
        var snapshot = new KubernetesCsiLogReader(api, SOURCE).read(null).toCompletableFuture().join();
        assertEquals(api.logs, snapshot.content());
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(api.logs.getBytes(StandardCharsets.UTF_8))), snapshot.sha256());
    }

    @Test
    void refusesEmptyPartialWrappedMalformedAndOversizedSnapshots() {
        for (String logs : List.of("", FIRST.stripTrailing(), FIRST + "wrapped continuation\n",
                "invalid-original-timestamp text\n", FIRST + "2026-99-01T16:40:42Z invalid date\n",
                FIRST + "2026-10-01T16:40:42Z CR\r\n", FIRST + "2026-10-01T16:40:42Z NUL\u0000\n",
                FIRST + "2026-10-01T16:40:42Z \ud800\n",
                FIRST + "x".repeat(1024 * 1024))) {
            var api = new Api();
            api.logs = logs;
            assertClosed(new KubernetesCsiLogReader(api, SOURCE).read(null));
        }
        var api = new Api();
        api.logs = FIRST + "2026-10-01T16:40:42Z " + "界".repeat(400_000) + "\n";
        assertClosed(new KubernetesCsiLogReader(api, SOURCE).read(null));
    }

    @Test
    void refusesForeignSnapshotAndUnknownReadWithoutAnyReleaseProof() {
        var api = new Api();
        var previous = new KubernetesCsiLogReader(api, SOURCE).read(null).toCompletableFuture().join();
        var foreign = new KubernetesCsiLogReader.Source("csi-plugin-foreign", POD_UID, SOURCE.nodeName(),
                NODE_UID, DAEMON_UID, CID, IMAGE);
        int reads = api.logReads.get();
        assertClosed(new KubernetesCsiLogReader(api, foreign).read(previous));
        assertEquals(reads, api.logReads.get());
        api.failLogs = true;
        assertClosed(new KubernetesCsiLogReader(api, SOURCE).read(previous));
    }

    private static void assertClosed(CompletionStage<?> result) {
        var failure = assertThrows(CompletionException.class, () -> result.toCompletableFuture().join());
        assertTrue(failure.getCause() instanceof RuntimeBrokerException);
        var refused = (RuntimeBrokerException) failure.getCause();
        assertEquals("workspace_csi_log_unavailable", refused.getCode());
        assertFalse(refused.isRetryable());
        assertFalse(refused.toString().contains("diagnostic"));
    }

    private static final class Api implements KubernetesRuntimeClient {
        private final AtomicInteger podReads = new AtomicInteger();
        private final AtomicInteger nodeReads = new AtomicInteger();
        private final AtomicInteger logReads = new AtomicInteger();
        private String logs = FIRST;
        private String mutation = "";
        private boolean mutateAfterLog;
        private boolean failLogs;

        private boolean mutates(String field) {
            return field.equals(mutation) && (!mutateAfterLog || logReads.get() > 0);
        }

        @Override
        public CompletionStage<Map<String, Object>> get(String resource, String namespace, String name) {
            assertEquals("pods", resource);
            assertEquals("kube-system", namespace);
            assertEquals(SOURCE.podName(), name);
            podReads.incrementAndGet();
            var metadata = new java.util.LinkedHashMap<String, Object>(Map.of("name", name, "namespace", namespace,
                    "uid", mutates("pod") ? NODE_UID : POD_UID, "ownerReferences", List.of(Map.of(
                            "apiVersion", "apps/v1", "kind", "DaemonSet", "name", "csi-plugin", "controller", true,
                            "uid", mutates("daemon") ? POD_UID : DAEMON_UID))));
            if (mutates("deleting")) {
                metadata.put("deletionTimestamp", "2026-10-01T16:40:42Z");
            }
            return CompletableFuture.completedFuture(Map.of("apiVersion", "v1", "kind", "Pod", "metadata", metadata,
                    "spec", Map.of("nodeName", SOURCE.nodeName()), "status", Map.of("phase", "Running", "containerStatuses",
                            List.of(Map.of("name", "csi-plugin", "containerID", mutates("container") ? IMAGE : CID,
                                    "imageID", mutates("image") ? CID : IMAGE, "restartCount", mutates("restart") ? 1 : 0,
                                    "ready", true, "state", Map.of("running", Map.of()))))));
        }

        @Override
        public CompletionStage<Map<String, Object>> getCluster(String resource, String name) {
            assertEquals("nodes", resource);
            assertEquals(SOURCE.nodeName(), name);
            nodeReads.incrementAndGet();
            return CompletableFuture.completedFuture(Map.of("apiVersion", "v1", "kind", "Node",
                    "metadata", Map.of("name", name, "uid", mutates("node") ? POD_UID : NODE_UID),
                    "status", Map.of("conditions", List.of(Map.of("type", "Ready", "status", mutates("unready") ? "False" : "True")))));
        }

        @Override
        public CompletionStage<String> readCsiPodLog(String name) {
            assertEquals(SOURCE.podName(), name);
            logReads.incrementAndGet();
            return failLogs ? CompletableFuture.failedFuture(new IllegalStateException("diagnostic-sensitive-log"))
                    : CompletableFuture.completedFuture(logs);
        }

        @Override
        public CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body) {
            throw new AssertionError("Read-only collector must not create resources");
        }
    }
}
