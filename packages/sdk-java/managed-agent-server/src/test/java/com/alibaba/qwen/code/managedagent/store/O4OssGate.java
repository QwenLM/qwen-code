package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ToolPublicationConfiguration;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.common.auth.DefaultCredentialProvider;
import com.aliyun.oss.common.auth.DefaultCredentials;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Opt-in real OSS gates, including inherited real SQL/process gates. No credential values are logged. */
public class O4OssGate extends O4MySqlGate {
    @BeforeAll
    static void requireOssEnvironment() {
        if (!Boolean.getBoolean("qwen.o4.required")) {
            org.junit.jupiter.api.Assumptions.assumeTrue(System.getProperty("qwen.o4.oss.test-bucket") != null,
                    "O4 OSS not configured");
        }
        bucket();
        required("qwen.o4.oss.region");
        for (String name : List.of("OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET",
                "OSS_DELETE_DENIED_ACCESS_KEY_ID", "OSS_DELETE_DENIED_ACCESS_KEY_SECRET")) { secret(name); }
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) { throw new IllegalArgumentException("Missing " + name); }
        return value;
    }
    private static String secret(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) { throw new IllegalArgumentException("Missing environment credential " + name); }
        return value;
    }
    private static String bucket() {
        String value = required("qwen.o4.oss.test-bucket");
        if (!value.matches("[a-z0-9-]*o4-test[a-z0-9-]*")) {
            throw new IllegalArgumentException("Use a dedicated private, never-versioned bucket named with o4-test");
        }
        return value;
    }
    private static OSS client() throws Exception {
        secret("OSS_ACCESS_KEY_ID");
        secret("OSS_ACCESS_KEY_SECRET");
        return new ToolPublicationConfiguration().toolPublicationOss(properties());
    }
    private static ManagedAgentProperties properties() {
        var props = new ManagedAgentProperties();
        props.getToolPublication().setOssRegion(required("qwen.o4.oss.region"));
        props.getToolPublication().setOssEndpoint("https://oss-" + required("qwen.o4.oss.region") + ".aliyuncs.com");
        props.getToolPublication().setOssBucket(bucket());
        props.getToolPublication().setServiceBaseUrl("https://o4-test.invalid");
        return props;
    }
    private static OSS deniedClient() {
        var credentials = new DefaultCredentials(secret("OSS_DELETE_DENIED_ACCESS_KEY_ID"),
                secret("OSS_DELETE_DENIED_ACCESS_KEY_SECRET"), System.getenv("OSS_DELETE_DENIED_SESSION_TOKEN"));
        return ToolPublicationConfiguration.buildOss(properties(), new DefaultCredentialProvider(credentials));
    }

    @Test
    void realDeleteLostResponseRetriesAndConfirmsMissingObject() throws Exception {
        try (var real = new OssFixture(client())) {
            String objectKey = ownedPrefix() + "one";
            var uncertain = new ToolPublicationObjectStore() {
                private boolean first = true;
                @Override public void putIfAbsent(String key, byte[] bytes) { real.putIfAbsent(key, bytes); }
                @Override public InputStream open(String key) { return real.open(key); }
                @Override public void requireUnversioned() { real.requireUnversioned(); }
                @Override public void deleteIfPresent(String key) {
                    real.deleteIfPresent(key);
                    if (first) { first = false; throw new IllegalStateException("discarded real DELETE response"); }
                }
            };
            retention.put(key, scope, "pub-1", objectKey, new byte[] {7}, real);
            addObject("one", objectKey, null);
            retire();
            var gc = collector(uncertain);
            assertThatThrownBy(gc::runOnce).isInstanceOf(IllegalStateException.class);
            assertThat(held()).isEqualTo(3000);
            assertThat(real.client.doesObjectExist(bucket(), objectKey)).isFalse();
            retryNow();
            assertThat(gc.runOnce()).isTrue();
            real.deleteIfPresent(objectKey);
            assertThat(state()).isEqualTo("COLLECTED");
            assertThat(held()).isZero();
        }
    }

    @Test
    void realPermissionFailurePreservesQuotaUntilAuthorizedRetry() throws Exception {
        try (var restricted = new OssFixture(deniedClient()); var real = new OssFixture(client())) {
            String objectKey = ownedPrefix() + "denied";
            retention.put(key, scope, "pub-1", objectKey, new byte[] {7}, real);
            addObject("one", objectKey, null);
            retire();
            assertThatThrownBy(() -> collector(restricted).runOnce()).isInstanceOfSatisfying(OSSException.class,
                    error -> assertThat(error.getErrorCode()).isEqualTo("AccessDenied"));
            assertThat(real.client.doesObjectExist(bucket(), objectKey)).isTrue();
            assertThat(held()).isEqualTo(3000);
            assertThat(state()).isEqualTo("DELETING");
            retryNow();
            assertThat(collector(real).runOnce()).isTrue();
            assertThat(held()).isZero();
        }
    }

    @Override
    @ParameterizedTest
    @ValueSource(longs = {100L * 1024 * 1024, 1024L * 1024 * 1024})
    @Timeout(value = 1800)
    void largeCatalogCollectionUsesBoundedPages(long bytes) throws Exception {
        try (var objects = new OssFixture(client())) {
            String prefix = ownedPrefix();
            collectCapacity(objects, bytes, prefix);
            List<String> keys = jdbc.queryForList("SELECT object_key FROM qwen_tool_publication_object"
                    + " WHERE scope_key = ? AND object_key IS NOT NULL", String.class, scope);
            for (String objectKey : keys) { assertThat(objects.client.doesObjectExist(bucket(), objectKey)).isFalse(); }
        }
    }

    private String ownedPrefix() throws java.io.IOException {
        String prefix = "o4-tests/" + UUID.randomUUID() + "/";
        Files.writeString(root.resolve("oss-prefix"), prefix);
        System.out.println("O4 OSS owned prefix: " + prefix);
        return prefix;
    }

    private static final class OssFixture implements ToolPublicationObjectStore, AutoCloseable {
        private final OSS client;
        private final AliyunToolPublicationObjectStore objects;
        private final Set<String> keys = new HashSet<>();
        private OssFixture(OSS client) {
            this.client = client;
            try { objects = new AliyunToolPublicationObjectStore(client, bucket()); }
            catch (RuntimeException error) { client.shutdown(); throw error; }
        }
        @Override public void putIfAbsent(String key, byte[] bytes) {
            keys.add(key);
            objects.putIfAbsent(key, bytes);
        }
        @Override public InputStream open(String key) { return objects.open(key); }
        @Override public void deleteIfPresent(String key) { objects.deleteIfPresent(key); keys.remove(key); }
        @Override public void requireUnversioned() { objects.requireUnversioned(); }
        @Override public void close() {
            RuntimeException failure = null;
            try {
                for (String key : keys) {
                    try { objects.deleteIfPresent(key); }
                    catch (RuntimeException error) {
                        if (failure == null) { failure = error; }
                        else { failure.addSuppressed(error); }
                    }
                }
            } finally { client.shutdown(); }
            if (failure != null) { throw failure; }
        }
    }
}
