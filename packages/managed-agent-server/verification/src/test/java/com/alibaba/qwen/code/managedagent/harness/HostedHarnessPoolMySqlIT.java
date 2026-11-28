package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.HostedGateTestSupport;
import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.JdbcHarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
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
import java.net.ServerSocket;
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
        var placements = spring.getBean(JdbcHarnessPlacementStore.class);
        // The wired bean is the SdkHarnessBoundary decorator, so asking Spring
        // for the concrete pool type finds nothing; resolve the owner instead.
        pool = (HarnessPoolConnector) HostedGateTestSupport.connectorOwning(
                spring.getBean(HarnessConnector.class));
        pool.refresh();
        assertThat(pool.supportsFencedTitles()).isTrue();
        String tenantA = UUID.randomUUID().toString();
        String tenantB = UUID.randomUUID().toString();
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
        var attachedEvidence = pool.inspectRecovery(tenantA, a1, null);
        assertThat(attachedEvidence).isNotNull();
        var unattachedEvidence = firstClient.getUnattachedStatus(a1, null).getRecovery();
        assertThat(unattachedEvidence.getState()).isEqualTo(attachedEvidence.state());
        assertThat(unattachedEvidence.isNextTurnAllowed()).isEqualTo(attachedEvidence.nextTurnAllowed());
        assertThat(placements.get(tenantA, a1)).isEqualTo(original);
        assertThat(http.send(HttpRequest.newBuilder(first.resolve("/session/" + a1 + "/status"))
                .timeout(Duration.ofSeconds(2)).build(), HttpResponse.BodyHandlers.discarding()).statusCode())
                .isEqualTo(401);
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
        // With no member accepting, a Session the last owner released has no holder: the pool answers its
        // own 503, never the drained owner's not-found that the scanner retired definitions on (#15795).
        HostedHarnessClient secondClient = client(second);
        pool.drainInstance("pool-b", UUID.randomUUID().toString());
        await(() -> "DRAINED".equals(secondClient.readInstance().get("state")), 30);
        assertThat(placements.get(tenantA, a1).state()).isEqualTo("RELEASED");
        Map<String, Object> fire = Map.of("operationId", UUID.randomUUID().toString(), "kind", "fire_run",
                "scheduleId", "asch_" + "0".repeat(32), "occurrenceKey", "manual:pool-released");
        assertThatThrownBy(() -> pool.runAutomationOperation(tenantA, a1, fire))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("harness_pool_unavailable");
                });
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenantA, a1)).isEqualTo("ACTIVE");
    }

    @Test
    @Timeout(120)
    void cleanSuspensionLetsAHealthySuccessorTakeOverBeforeLeaseExpiry() throws Exception {
        Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath();
        assertThat(cli).isRegularFile();
        URI first = startHarness(cli, "pool-a", 150L);
        URI second = startHarness(cli, "pool-b", 60_000L);
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
                "--qwen.managed-agent.wake-dispatch.enabled=true",
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
        var placements = spring.getBean(JdbcHarnessPlacementStore.class);
        pool = (HarnessPoolConnector) HostedGateTestSupport.connectorOwning(
                spring.getBean(HarnessConnector.class));
        pool.refresh();
        String tenant = UUID.randomUUID().toString();
        String session = root(tenant);
        pool.createOrLoad(tenant, session, false);
        var original = placements.get(tenant, session);
        assertThat(original.instanceId()).isEqualTo("pool-a");
        var credentials = new WriterCredentialPolicy(settings);
        String oldGrant = credentials.issue(tenant, WORKSPACE, session,
                original.instanceId(), original.bootId(), original.epoch());

        await(() -> "RELEASED".equals(placements.get(tenant, session).state()), 15);
        assertThat(client(first).readInstance().get("state")).isEqualTo("ACCEPTING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE tenant_id = ?"
                + " AND session_id = ? AND domain = 'hosted_harness_release' AND record_id = 'placement:1'",
                Integer.class, tenant, session)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head WHERE tenant_id = ?"
                + " AND session_id = ? AND state = 'SEALED' AND wake_seal_revision = journal_revision",
                Integer.class, tenant, session)).isEqualTo(1);
        Long oldLease = jdbc.queryForObject("SELECT writer_lease_until FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session);

        pool.createOrLoad(tenant, session, true);
        var successor = placements.get(tenant, session);
        assertThat(successor.instanceId()).isEqualTo("pool-b");
        assertThat(successor.epoch()).isEqualTo(original.epoch() + 1);
        assertThat(oldLease).isGreaterThan(System.currentTimeMillis());
        assertThat(staleAcquire(tenant, session, original.bootId(), oldGrant)
                .path("error").path("code").asText()).isEqualTo("writer_credential_invalid");
        assertThat(client(first).readInstance().get("state")).isEqualTo("ACCEPTING");
        assertThat(client(second).readInstance().get("state")).isEqualTo("ACCEPTING");
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isEqualTo("ACTIVE");
    }

    @Test
    @Timeout(120)
    void aPollingMemberClaimsAReleasedSessionAndItsWriterConsumesTheClaim() throws Exception {
        Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath();
        assertThat(cli).isRegularFile();
        int port;
        try (var socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        String origin = "http://127.0.0.1:" + port;
        URI first = startHarness(cli, "pool-a", null, origin);
        URI second = startHarness(cli, "pool-b", null, origin);
        spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=" + port,
                "--spring.datasource.url=" + required("mysql.url"),
                "--spring.datasource.username=" + required("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.druid.max-active=4", "--spring.datasource.druid.max-wait=5000",
                "--spring.datasource.druid.connect-properties.connectTimeout=5000",
                "--spring.datasource.druid.connect-properties.socketTimeout=10000",
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.session-store.base-url=" + origin,
                "--qwen.managed-agent.session-store.workspace-id=" + WORKSPACE,
                "--qwen.managed-agent.session-store.binding-key=" + BINDING_KEY,
                "--qwen.managed-agent.wake-dispatch.enabled=true",
                "--qwen.managed-agent.harness-pull.enabled=true",
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
        var placements = spring.getBean(JdbcHarnessPlacementStore.class);
        pool = (HarnessPoolConnector) HostedGateTestSupport.connectorOwning(
                spring.getBean(HarnessConnector.class));
        pool.refresh();
        String tenant = UUID.randomUUID().toString();
        String session = root(tenant);
        pool.createOrLoad(tenant, session, false);
        var original = placements.get(tenant, session);
        assertThat(original.instanceId()).isEqualTo("pool-a");
        // Draining releases the idle Session, and a draining Harness has no
        // free slot, so it stops polling: only pool-b can claim.
        HostedHarnessClient firstClient = client(first);
        pool.drainInstance("pool-a", UUID.randomUUID().toString());
        await(() -> "DRAINED".equals(firstClient.readInstance().get("state")), 30);
        assertThat(placements.get(tenant, session).state()).isEqualTo("RELEASED");

        // The pool advertises work-pull/1, so the push path records demand
        // instead of taking the released placement over.
        assertThatThrownBy(() -> pool.createOrLoad(tenant, session, true))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        refusal -> assertThat(refusal.getCode()).isEqualTo("harness_placement_released"));
        // Nothing else retries this Session, so only a poller can place it
        // before the 30-second push fallback; its load's writer acquisition
        // clears both the demand and the reservation.
        await(() -> placements.get(tenant, session).epoch() == original.epoch() + 1
                && jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                        + " AND harness_claim_requested_at IS NULL AND harness_claim_reserved_until IS NULL",
                        Integer.class, tenant, session) == 1, 20);
        var claimed = placements.get(tenant, session);
        assertThat(claimed.instanceId()).isEqualTo("pool-b");
        assertThat(jdbc.queryForObject("SELECT writer_id FROM ma_session_head WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isEqualTo(claimed.bootId());
        HostedHarnessClient secondClient = client(second);
        await(() -> Integer.valueOf(1).equals(
                ((Map<?, ?>) secondClient.readInstance().get("counters")).get("attachedSessions")), 20);
    }

    @Test
    @Timeout(180)
    void refreshReapsAnExpiredCleanSuspensionWithoutOpeningTheSuccessor() throws Exception {
        Path cli = Path.of(required("qwen.cli.entry")).toAbsolutePath();
        assertThat(cli).isRegularFile();
        URI first = startHarness(cli, "pool-a");
        startSingleMemberPool("pool-a", first);
        var store = spring.getBean(JdbcManagedSessionStore.class);
        var placements = spring.getBean(JdbcHarnessPlacementStore.class);
        var credentials = new WriterCredentialPolicy(spring.getBean(ManagedAgentProperties.class));
        pool.refresh();
        String tenant = UUID.randomUUID().toString();
        String session = root(tenant);
        pool.createOrLoad(tenant, session, false);
        var owner = placements.get(tenant, session);
        assertThat(owner.instanceId()).isEqualTo("pool-a");
        String oldGrant = credentials.issue(tenant, WORKSPACE, session,
                owner.instanceId(), owner.bootId(), owner.epoch());
        Process departed = children.removeFirst();
        departed.destroy();
        if (!departed.waitFor(10, TimeUnit.SECONDS)) {
            departed.destroyForcibly();
            assertThat(departed.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
        Long revision = jdbc.queryForObject("SELECT journal_revision FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session);
        Integer generation = jdbc.queryForObject("SELECT writer_generation FROM ma_session_head"
                + " WHERE tenant_id = ? AND session_id = ?", Integer.class, tenant, session);
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 0, activation_phase = 'released',"
                + " activation_head_revision = journal_revision WHERE tenant_id = ? AND session_id = ?", tenant, session);
        store.sealWriter(tenant, session, oldGrant, new ManagedSessionStoreModels.SealWriterRequest(
                WORKSPACE, owner.bootId(), generation, new ManagedSessionStoreModels.WakeStamp(revision, false, 0)));
        pool.close();
        spring.close();

        URI second = startHarness(cli, "pool-b");
        startSingleMemberPool("pool-b", second);
        placements = spring.getBean(JdbcHarnessPlacementStore.class);
        pool.refresh();
        var successor = placements.get(tenant, session);
        assertThat(successor.instanceId()).isEqualTo("pool-b");
        assertThat(successor.epoch()).isEqualTo(owner.epoch() + 1);
        assertThat(pool.attachedSessions()).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE tenant_id = ?"
                + " AND session_id = ? AND domain = 'hosted_harness_release'", Integer.class, tenant, session)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head WHERE tenant_id = ?"
                + " AND session_id = ? AND state = 'SEALED' AND wake_seal_revision = journal_revision",
                Integer.class, tenant, session)).isEqualTo(1);

        pool.createOrLoad(tenant, session, true);
        assertThat(pool.attachedSessions()).hasSize(1);
        assertThat(staleAcquire(tenant, session, owner.bootId(), oldGrant)
                .path("error").path("code").asText()).isEqualTo("writer_credential_invalid");
    }

    private void startSingleMemberPool(String instanceId, URI base) {
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
                "--qwen.managed-agent.wake-dispatch.enabled=true",
                "--qwen.managed-agent.harness.enabled=true", "--qwen.managed-agent.runtime-broker.enabled=false",
                "--qwen.managed-agent.harness.token=" + TOKEN,
                "--qwen.managed-agent.harness.capability-digest=" + DIGEST,
                "--qwen.managed-agent.harness.heartbeat-interval=PT0S",
                "--qwen.managed-agent.harness.pool.enabled=true",
                "--qwen.managed-agent.harness.pool.instances[0].instance-id=" + instanceId,
                "--qwen.managed-agent.harness.pool.instances[0].base-url=" + base);
        jdbc = spring.getBean(JdbcTemplate.class);
        var settings = spring.getBean(ManagedAgentProperties.class);
        settings.getSessionStore().setBaseUrl("http://127.0.0.1:" + spring.getWebServer().getPort());
        pool = (HarnessPoolConnector) HostedGateTestSupport.connectorOwning(
                spring.getBean(HarnessConnector.class));
    }

    private String root(String tenant) {
        String id = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id,"
                + " gmt_create, gmt_modified) VALUES (?, ?, 'qwen-code', 1, 1)", tenant, id);
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, gmt_modified)"
                + " VALUES (?, ?, 'SESSION', '', 1)", tenant, id);
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
        return startHarness(cli, id, null);
    }

    private URI startHarness(Path cli, String id, Long idleSuspendMs) throws Exception {
        return startHarness(cli, id, idleSuspendMs, null);
    }

    private URI startHarness(Path cli, String id, Long idleSuspendMs, String workUrl) throws Exception {
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
        environment.put("QWEN_CODE_SYSTEM_SETTINGS_PATH", dir.resolve("system-settings.json").toString());
        environment.put("QWEN_CODE_SYSTEM_DEFAULTS_PATH", dir.resolve("system-defaults.json").toString());
        if (idleSuspendMs != null) {
            environment.put("QWEN_E2E_IDLE_SUSPEND_MS", idleSuspendMs.toString());
        }
        if (workUrl != null) {
            environment.put("QWEN_MANAGED_HARNESS_WORK_URL", workUrl);
        }
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
