package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Real SQL gates plus controlled storage/process faults; OSS is a separate required gate. */
@Timeout(value = 240)
public class O4MySqlIT extends ToolPublicationCollectorTest {
    protected O4MySqlDatabase database;
    @TempDir Path root;

    @Override protected javax.sql.DataSource dataSource() {
        database = new O4MySqlDatabase();
        return database.source();
    }
    @AfterEach void dropDatabase() { if (database != null) { database.close(); } }

    @Test
    void writerReallyWaitsOnRetirementTransactionAndThenIsRejected() throws Exception {
        var locked = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var entered = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var deleting = executor.submit(() -> tx.executeWithoutResult(status -> {
                ToolPublicationRetentionStore.lockDeletion(jdbc, tenant, session);
                locked.countDown();
                try { assertThat(release.await(10, TimeUnit.SECONDS)).isTrue(); }
                catch (InterruptedException error) { throw new IllegalStateException(error); }
                ToolPublicationRetentionStore.retire(jdbc, tenant, session, "delete-contended");
            }));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();
            var writer = executor.submit(() -> {
                entered.countDown();
                return tx.execute(status -> new ManagedSessionStore(jdbc).acquireWriter(tenant, session,
                        "a".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "late", 60000L)));
            });
            assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
            try { assertThatThrownBy(() -> writer.get(200, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class); }
            finally { release.countDown(); }
            deleting.get(10, TimeUnit.SECONDS);
            assertThatThrownBy(() -> writer.get(10, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(com.alibaba.qwen.code.managedagent.api.ApiException.class);
        }
    }

    @Test
    void killedPutAndSuccessfulRetryKeepTheOriginalAttemptUnresolved() throws Exception {
        Process child = child("put");
        try {
            ready(child);
            child.destroyForcibly();
            assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
            var objects = new O4FileObjects(root);
            retention.put(key, scope, "pub-1", "exact/one", new byte[] {7}, objects);
            assertThat(jdbc.queryForList("SELECT state FROM qwen_output_put_attempt WHERE scope_key = ?",
                    String.class, scope)).containsExactlyInAnyOrder("IN_FLIGHT", "RETURNED");
            retire();
            assertThat(collector(objects).runOnce()).isFalse();
            assertThat(blocker()).isEqualTo("put_unresolved");
            assertThat(held()).isEqualTo(3000);
            assertThat(Files.exists(root.resolve("exact/one"))).isTrue();
        } finally { stop(child); }
    }

    @Test
    void killedDeleteAfterPhysicalSuccessRetriesMissingKeyAndReleasesOnce() throws Exception {
        var objects = new O4FileObjects(root);
        for (String slot : java.util.List.of("one", "two", "three")) {
            objects.putIfAbsent("exact/" + slot, new byte[] {7});
            addObject(slot, "exact/" + slot, null);
        }
        retire();
        Process child = child("delete");
        try {
            ready(child);
            assertThat(Files.exists(root.resolve("exact/one"))).isFalse();
            assertThat(Files.exists(root.resolve("exact/two"))).isTrue();
            assertThat(Files.exists(root.resolve("exact/three"))).isTrue();
            child.destroyForcibly();
            assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(state()).isEqualTo("DELETING");
            assertThat(held()).isEqualTo(3000);
            var replacement = collector(objects);
            assertThat(replacement.runOnce()).isFalse();
            retryNow();
            assertThat(replacement.runOnce()).isTrue();
            assertThat(state()).isEqualTo("COLLECTED");
            assertThat(Files.exists(root.resolve("exact/two"))).isFalse();
            assertThat(Files.exists(root.resolve("exact/three"))).isFalse();
            assertThat(held()).isZero();
            assertThat(replacement.runOnce()).isFalse();
            assertThat(jdbc.queryForObject("SELECT gc_generation FROM qwen_tool_publication WHERE scope_key = ?",
                    Long.class, scope)).isEqualTo(2);
        } finally { stop(child); }
    }

    @Test
    void stoppedProcessResumesAfterRealLeaseDeadlineWithoutReturningBytes() throws Exception {
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        if (Boolean.getBoolean("qwen.o4.required")) { assertThat(windows).as("POSIX process stop gate requires macOS/Linux").isFalse(); }
        else { org.junit.jupiter.api.Assumptions.assumeFalse(windows, "POSIX process stop gate requires macOS/Linux"); }
        new O4FileObjects(root).putIfAbsent("exact/one", new byte[] {7});
        Process child = child("read");
        try {
            ready(child);
            signal(child, "-STOP");
            long expires = jdbc.queryForObject("SELECT expires_at FROM qwen_output_read_lease WHERE tenant_key = ?",
                    Long.class, ToolPublicationRetentionStore.hash(tenant));
            while (ToolPublicationRetentionStore.now(jdbc) <= expires + 1000) { Thread.sleep(1000); }
            Files.writeString(root.resolve("resume"), "resume");
            signal(child, "-CONT");
            assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
            assertThat(child.exitValue()).isZero();
            assertThat(Files.readString(root.resolve("result"))).isEqualTo("tool_output_read_expired");
        } finally { stop(child); }
    }

    @Test
    void delayedUnknownPutRemainsProtectedAfterSuccessfulRetryAndLateArrival() throws Exception {
        var late = new CountDownLatch(1);
        var arrival = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<?>>();
        try (var executor = Executors.newSingleThreadExecutor()) {
            var objects = new O4FileObjects(root) {
                private boolean first = true;
                @Override public void putIfAbsent(String objectKey, byte[] bytes) {
                    if (first) {
                        first = false;
                        arrival.set(executor.submit(() -> {
                            try { late.await(); }
                            catch (InterruptedException error) { throw new IllegalStateException(error); }
                            super.putIfAbsent(objectKey, bytes);
                        }));
                        throw new IllegalStateException("PUT response lost while request is still running");
                    }
                    super.putIfAbsent(objectKey, bytes);
                }
            };
            try {
                assertThatThrownBy(() -> retention.put(key, scope, "pub-1", "exact/one", new byte[] {7}, objects))
                        .isInstanceOf(IllegalStateException.class);
                retention.put(key, scope, "pub-1", "exact/one", new byte[] {7}, objects);
                retire();
                assertThat(collector(objects).runOnce()).isFalse();
            } finally { late.countDown(); }
        }
        arrival.get().get(10, TimeUnit.SECONDS);
        assertThat(blocker()).isEqualTo("put_unresolved");
        assertThat(held()).isEqualTo(3000);
        assertThat(Files.exists(root.resolve("exact/one"))).isTrue();
    }

    @ParameterizedTest
    @ValueSource(longs = {100L * 1024 * 1024, 1024L * 1024 * 1024})
    void largeCatalogCollectionUsesBoundedPages(long bytes) throws Exception {
        collectCapacity(new O4FileObjects(root), bytes, "capacity/");
        try (var files = Files.walk(root.resolve("capacity"))) {
            assertThat(files.filter(Files::isRegularFile).count()).isEqualTo(1);
        }
    }

    /** Already-admitted catalog fixture, not an end-to-end O2 Shell execution. */
    protected void collectCapacity(ToolPublicationObjectStore objects, long total, String prefix) throws Exception {
        byte[] segment = new byte[1024 * 1024];
        String digest = java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(segment));
        long stored = 0;
        int count = 0;
        objects.putIfAbsent(prefix + "outside", new byte[] {9});
        while (stored < total) {
            String slot = "segment-" + String.format("%04d", count++);
            String objectKey = prefix + slot;
            retention.put(key, scope, "pub-1", objectKey, segment, objects);
            try (var input = objects.open(objectKey)) {
                assertThat(input.transferTo(java.io.OutputStream.nullOutputStream())).isEqualTo(segment.length);
            }
            jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key, resource_id,"
                            + " resource_kind, byte_length, sha256, object_key, state, operation_id, created_at)"
                            + " VALUES (?, 'pub-1', ?, ?, 'managed-tool-result-content', ?, ?, ?, 'VERIFIED', 'op', CURRENT_TIMESTAMP(6))",
                    scope, slot, slot, segment.length, digest, objectKey);
            stored += segment.length;
        }
        for (String name : java.util.List.of("manifest", "pages", "outcome")) { addObject("z-" + name, null, new byte[] {1}); }
        jdbc.update("UPDATE qwen_tool_publication SET capture_used_bytes = ?, capture_held_bytes = ?,"
                        + " producer_used_bytes = 3, producer_held_bytes = 1000 WHERE scope_key = ?", total, total, scope);
        assertThat(jdbc.queryForObject("SELECT SUM(byte_length) FROM qwen_tool_publication_object WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(total + 3);
        retire();
        var gc = collector(objects);
        int pages = 0;
        while (!"COLLECTED".equals(state())) {
            assertThat(gc.runOnce()).isTrue();
            pages++;
            assertThat(pages).isLessThanOrEqualTo((count + 3 + 99) / 100);
            if (!"COLLECTED".equals(state())) { assertThat(held()).isEqualTo(total + 2000); }
        }
        assertThat(pages).isEqualTo((count + 3 + 99) / 100);
        assertThat(held()).isZero();
        assertThat(jdbc.queryForObject("SELECT collected_bytes FROM qwen_tool_publication WHERE scope_key = ?",
                Long.class, scope)).isEqualTo(total + 3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_object WHERE scope_key = ?"
                + " AND (state <> 'COLLECTED' OR inline_bytes IS NOT NULL)", Long.class, scope)).isZero();
        try (var input = objects.open(prefix + "outside")) { assertThat(input.read()).isEqualTo(9); }
        System.out.println("O4 capacity: bytes=" + total + ", catalogObjects=" + (count + 3) + ", pages=" + pages);
    }

    private Process child(String mode) throws IOException {
        String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        return new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Xmx128m", "-cp", classpath, O4FaultProcess.class.getName(), mode,
                database.url(), database.user(), tenant, session, scope, root.toString())
                .redirectErrorStream(true).redirectOutput(root.resolve("child.log").toFile()).start();
    }
    private void ready(Process child) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
        while (!Files.exists(root.resolve("ready")) && child.isAlive() && System.nanoTime() < deadline) { Thread.sleep(20); }
        assertThat(Files.exists(root.resolve("ready"))).as("child reached durable boundary").isTrue();
    }
    private static void signal(Process child, String signal) throws Exception {
        Process command = new ProcessBuilder("kill", signal, Long.toString(child.pid())).start();
        assertThat(command.waitFor(5, TimeUnit.SECONDS)).isTrue();
        assertThat(command.exitValue()).isZero();
    }
    private static void stop(Process child) throws InterruptedException {
        child.destroyForcibly();
        assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
    }
}
