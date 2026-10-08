package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Child JVM exits only after the parent releases it, or is killed at a durable boundary. */
public final class O4FaultProcess {
    private O4FaultProcess() {}
    public static void main(String[] args) throws Exception {
        String mode = args[0];
        var source = new DriverManagerDataSource(args[1], args[2],
                System.getenv().getOrDefault("QWEN_O4_MYSQL_PASSWORD", ""));
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var retention = new ToolPublicationRetentionStore(jdbc, manager);
        Path root = Path.of(args[6]);
        var objects = new O4FileObjects(root) {
            @Override public void putIfAbsent(String key, byte[] bytes) {
                super.putIfAbsent(key, bytes);
                pause();
            }
            @Override public void deleteIfPresent(String key) {
                super.deleteIfPresent(key);
                pause();
            }
            @Override public InputStream open(String key) {
                return new FilterInputStream(super.open(key)) {
                    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                        pause();
                        return in.read(bytes, offset, length);
                    }
                };
            }
            private void pause() {
                try {
                    Files.writeString(root.resolve("ready"), mode);
                    long deadline = System.nanoTime() + Duration.ofMillis(
                            Long.getLong("qwen.o4.pause-timeout-millis", 300_000)).toNanos();
                    var parent = ProcessHandle.current().parent();
                    while (!Files.exists(root.resolve("resume"))) {
                        if (System.nanoTime() >= deadline || parent.isPresent() && !parent.get().isAlive()) {
                            throw new IllegalStateException("O4 child pause ended without resume");
                        }
                        Thread.sleep(20);
                    }
                } catch (IOException | InterruptedException error) { throw new IllegalStateException(error); }
            }
        };
        var key = new ObjectMapper().createObjectNode().put("tenantId", args[3])
                .put("workspaceId", "workspace-1").put("sessionId", args[4]);
        if ("put".equals(mode)) {
            retention.put(key, args[5], "pub-1", "exact/one", new byte[] {7}, objects);
        } else if ("delete".equals(mode)) {
            var props = new ManagedAgentProperties();
            props.getToolPublication().setGcEnabled(true);
            props.getToolPublication().setDeletionGrace(Duration.ZERO);
            new ToolPublicationCollector(jdbc, manager, retention, objects, props).runOnce();
        } else if ("read".equals(mode)) {
            try (var input = retention.open(args[5], "pub-1", "exact/one", objects)) {
                try {
                    int count = input.read(new byte[1]);
                    Files.writeString(root.resolve("result"), "returned:" + count);
                } catch (ApiException error) { Files.writeString(root.resolve("result"), error.getCode()); }
            }
        } else { throw new IllegalArgumentException("Unknown fault mode"); }
    }
}
