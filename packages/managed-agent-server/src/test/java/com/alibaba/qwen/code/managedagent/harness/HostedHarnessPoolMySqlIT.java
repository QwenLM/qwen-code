package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.persistence.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HostedHarnessPoolMySqlIT {
    private static final String TOKEN = "hosted-pool-local-fixture-token";
    private static final String BINDING_KEY = "pool-binding-key-0123456789abcdef0123456789abcdef";
    private static final String WORKSPACE = "hosted-pool-fixture-workspace";
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private static final Pattern LISTENING = Pattern.compile("listening on http://127\\.0\\.0\\.1:(\\d+)");
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final List<Process> children = new ArrayList<>();
    private final List<HostedHarnessClient> clients = new ArrayList<>();
    @TempDir
    private Path temporary;
    private ServletWebServerApplicationContext spring;
    private HarnessPoolConnector pool;
    private JdbcTemplate jdbc;

    @Test
    @Timeout(120)
    void realProcessesKeepTenantPlacementAndReleaseIdleOwnersWithoutCancellingSessions() throws Exception {
        Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath();
        assertThat(cli).isRegularFile();
        URI first = startHarness(cli, "pool-a");
        URI second = startHarness(cli, "pool-b");
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + required("mysql.url"),
                "--spring.datasource.username=" + required("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.druid.max-active=4", "--spring.datasource.druid.max-wait=5000",
                "--spring.datasource.druid.connect-properties.connectTimeout=5000",
                "--spring.datasource.druid.connect-properties.socketTimeout=10000",
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.workspace-id=" + WORKSPACE,
                "--qwen.managed-agent.session-store.binding-key=" + BINDING_KEY,
                "--qwen.managed-agent.harness.enabled=true", "--qwen.managed-agent.runtime-broker.enabled=false",
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.harness.heartbeat-interval=PT0S",
                "--qwen.managed-agent.harness.pool.enabled=true",
                "--qwen.managed-agent.harness.pool.instances[0].instance-id=pool-a",
                "--qwen.managed-agent.harness.pool.instances[0].base-url=" + first,
                "--qwen.managed-agent.harness.pool.instances[1].instance-id=pool-b",
                "--qwen.managed-agent.harness.pool.instances[1].base-url=" + second);
        jdbc = spring.getBean(JdbcTemplate.class);
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        var settings = spring.getBean(ManagedAgentProperties.class);
        settings.getSessionStore().setBaseUrl("http://127.0.0.1:" + spring.getWebServer().getPort());
        var placements = spring.getBean(HarnessPlacementStore.class);
        pool = spring.getBean(HarnessPoolConnector.class);
        pool.refresh();
        assertThat(pool.supportsFencedTitles()).isTrue();
        String tenantA = "pool-a-" + UUID.randomUUID();
        String tenantB = "pool-b-" + UUID.randomUUID();
        String a1 = root(tenantA);
        String b1 = root(tenantB);
        String b2 = root(tenantB);
        String a2 = root(tenantA);
        var attachedA = pool.createOrLoad(tenantA, a1, false);
        pool.createOrLoad(tenantB, b1, false);
        pool.createOrLoad(tenantB, b2, false);
        pool.createOrLoad(tenantA, a2, false);
        var original = placements.get(tenantA, a1);
        assertThat(original.instanceId()).isEqualTo("pool-a");
        assertThat(Set.of(placements.get(tenantA, a1).instanceId(), placements.get(tenantA, a2).instanceId()))
                .containsExactlyInAnyOrder("pool-a", "pool-b");
        assertThat(Set.of(placements.get(tenantB, b1).instanceId(), placements.get(tenantB, b2).instanceId()))
                .containsExactlyInAnyOrder("pool-a", "pool-b");
        assertThat(pool.createOrLoad(tenantA, a1, true)).isEqualTo(attachedA);
        assertThat(placements.get(tenantA, a1)).isEqualTo(original);
        assertThat(pool.attachedSessions()).hasSize(4);
        assertThatThrownBy(() -> pool.createOrLoad(tenantB, a1, true)).hasMessageContaining("Session does not exist");
        assertThat(placements.get(tenantB, a1)).isNull();
        var credentials = new WriterCredentialPolicy(settings);
        String oldGrant = credentials.issue(tenantA, WORKSPACE, a1, original.instanceId(), original.bootId(), original.epoch());
        HostedHarnessClient firstClient = client(first);
        assertThat(firstClient.readInstance().get("state")).isEqualTo("ACCEPTING");
        pool.drainInstance("pool-a", UUID.randomUUID().toString());
        await(() -> "DRAINED".equals(firstClient.readInstance().get("state")), 30);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE tenant_id IN (?, ?)"
                + " AND domain = 'hosted_harness_release'", Integer.class, tenantA, tenantB)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_session_head WHERE tenant_id = ? AND session_id = ?"
                + " AND head_kind = 'MANAGED_SESSION'", String.class, tenantA, a1)).isEqualTo("SEALED");
        assertThat(staleAcquire(tenantA, a1, original.bootId(), oldGrant).path("error").path("code").asText())
                .isEqualTo("harness_placement_released");
        pool.refresh();
        var recovered = pool.createOrLoad(tenantA, a1, true);
        var successor = placements.get(tenantA, a1);
        assertThat(successor.epoch()).isEqualTo(original.epoch() + 1);
        assertThat(successor.instanceId()).isEqualTo("pool-b");
        assertThat(recovered.bootId()).isNotEqualTo(original.bootId());
        assertThat(staleAcquire(tenantA, a1, original.bootId(), oldGrant).path("error").path("code").asText())
                .isEqualTo("writer_credential_invalid");
        assertThat(client(second).readInstance().get("state")).isEqualTo("ACCEPTING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id IN (?, ?) AND status = 'ACTIVE'",
                Integer.class, tenantA, tenantB)).isEqualTo(4);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE tenant_id IN (?, ?)",
                Integer.class, tenantA, tenantB)).isZero();
    }

    private String root(String tenant) {
        String id = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, tenant_key, session_key, session_scope_key,"
                + " gmt_create, gmt_modified) VALUES (?, ?, 'qwen-code', ?, ?, ?, 1, 1)", tenant, id,
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(id),
                ManagedSessionStore.sessionScopeKey(tenant, id));
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, gmt_modified)"
                + " VALUES (?, ?, 'SESSION', X'', 1)", tenant, id);
        return id;
    }

    private JsonNode staleAcquire(String tenant, String session, String boot, String grant) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + spring.getWebServer().getPort()
                + "/internal/managed-session-store/v1/sessions/" + session + "/writers:acquire"))
                .timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json")
                .header("X-Qwen-Tenant-Id", tenant).header("X-Qwen-Managed-Writer-Token", grant)
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(
                        Map.of("workspaceId", WORKSPACE, "writerId", boot, "leaseMillis", 60_000)))).build();
        var response = http.send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("Old writer grant must be rejected").isIn(403, 409);
        return json.readTree(response.body());
    }

    private HostedHarnessClient client(URI base) {
        var client = HostedHarnessClient.builder().baseUri(base).bearerToken(TOKEN).capabilityDigest(DIGEST)
                .connectTimeout(Duration.ofSeconds(3)).requestTimeout(Duration.ofSeconds(10))
                .heartbeatInterval(Duration.ZERO).build();
        clients.add(client);
        return client;
    }

    private URI startHarness(Path cli, String id) throws Exception {
        Path dir = Files.createDirectories(temporary.resolve(id));
        Path config = Files.createDirectory(dir.resolve(".qwen"));
        String model = "pool-idle-fixture";
        Files.writeString(config.resolve("settings.json"), json.writeValueAsString(Map.of(
                "security", Map.of("auth", Map.of("selectedType", "openai")),
                "model", Map.of("name", model), "telemetry", Map.of("enabled", false),
                "modelProviders", Map.of("openai", List.of(Map.of("id", model,
                        "envKey", "OPENAI_API_KEY", "baseUrl", "http://127.0.0.1:9/v1"))))));
        Path log = dir.resolve("process.log");
        var builder = new ProcessBuilder(System.getProperty("qwen.node", "node"), cli.toString(), "serve",
                "--profile", "hosted-harness", "--http-bridge", "--no-web", "--hostname", "127.0.0.1",
                "--port", "0", "--workspace", dir.toString()).directory(dir.toFile()).redirectErrorStream(true)
                .redirectOutput(log.toFile());
        var environment = builder.environment();
        environment.clear();
        if (System.getenv("PATH") != null) {
            environment.put("PATH", System.getenv("PATH"));
        }
        environment.putAll(Map.of("HOME", dir.toString(), "QWEN_HOME", config.toString(),
                "QWEN_RUNTIME_DIR", dir.resolve("runtime").toString(), "OPENAI_API_KEY", "test-fixture-key",
                "OPENAI_MODEL", model, "OPENAI_BASE_URL", "http://127.0.0.1:9/v1", "QWEN_SERVER_TOKEN", TOKEN,
                "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", DIGEST, "QWEN_HOSTED_HARNESS_INSTANCE_ID", id,
                "QWEN_CODE_MODELS_DEV_REFRESH", "off"));
        Process process = builder.start();
        children.add(process);
        URI[] base = new URI[1];
        await(() -> {
            try {
                String logs = Files.readString(log);
                assertThat(process.isAlive()).as("Harness exited: %s", logs).isTrue();
                var match = LISTENING.matcher(logs);
                if (!match.find()) {
                    return false;
                }
                base[0] = URI.create("http://127.0.0.1:" + match.group(1));
                return http.send(HttpRequest.newBuilder(base[0].resolve("/capabilities"))
                        .timeout(Duration.ofSeconds(2)).header("Authorization", "Bearer " + TOKEN).build(),
                        HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
            } catch (IOException unavailable) {
                return false;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
        }, 30);
        return base[0];
    }

    private static void await(BooleanSupplier done, int seconds) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (!done.getAsBoolean()) {
            assertThat(System.nanoTime()).as("Timed out waiting for the real process").isLessThan(end);
            Thread.sleep(100);
        }
    }

    @AfterEach
    void cleanup() throws Exception {
        if (pool != null) {
            pool.close();
        }
        clients.forEach(HostedHarnessClient::close);
        for (var child : children) {
            child.descendants().forEach(ProcessHandle::destroyForcibly);
            child.destroy();
            if (!child.waitFor(5, TimeUnit.SECONDS)) {
                child.destroyForcibly();
            }
            assertThat(child.waitFor(5, TimeUnit.SECONDS)).isTrue();
        }
        if (spring != null) {
            spring.close();
        }
    }

    private static String required(String key) {
        String value = System.getProperty(key);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Required integration prerequisite: -D" + key);
        }
        return value;
    }
}
