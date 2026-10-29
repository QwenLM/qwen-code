package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.support.JdbcTransactionManager;

import javax.sql.DataSource;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.AdditionalAnswers.delegatesTo;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class ResidentWorkspaceRetirementProcessMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final byte[] REPLY = "{\"kind\":\"Status\",\"status\":\"Success\"}".getBytes(StandardCharsets.UTF_8);

    enum Cut { BEFORE_SEND, WAITING_REPLY, BEFORE_SAVE }

    @TempDir
    private Path directory;

    @ParameterizedTest
    @EnumSource(Cut.class)
    @Timeout(90)
    void killedMaintenanceProcessRetainsUnknownAndNeverResendsTheOriginalVersion(Cut cut) throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var fixture = new ResidentRetirementFixture(database.source());
            fixture.ready();
            fixture.store().begin(fixture.request);
            var reservation = fixture.storage.inspect(fixture.mapping.registration());
            var deletes = new AtomicInteger();
            var received = new AtomicReference<byte[]>();
            var target = new AtomicReference<String>();
            var requested = new CountDownLatch(1);
            var releaseReply = new CountDownLatch(1);
            var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            var executor = Executors.newVirtualThreadPerTaskExecutor();
            server.setExecutor(executor);
            server.createContext("/", exchange -> {
                try {
                    if ("DELETE".equals(exchange.getRequestMethod())) {
                        deletes.incrementAndGet();
                        target.set(exchange.getRequestURI().getPath());
                        received.set(exchange.getRequestBody().readAllBytes());
                        requested.countDown();
                        if (!releaseReply.await(40, TimeUnit.SECONDS)) {
                            return;
                        }
                        exchange.sendResponseHeaders(202, REPLY.length);
                        exchange.getResponseBody().write(REPLY);
                    } else {
                        String[] path = exchange.getRequestURI().getPath().split("/");
                        var object = fixture.objects.get(path[path.length - 2]);
                        boolean found = object != null && path[path.length - 1].equals(map(object.get("metadata")).get("name"));
                        byte[] body = JSON.writeValueAsBytes(found ? object : Map.of());
                        exchange.sendResponseHeaders(found ? 200 : 404, body.length);
                        exchange.getResponseBody().write(body);
                    }
                } catch (InterruptedException failure) {
                    Thread.currentThread().interrupt();
                } finally {
                    exchange.close();
                }
            });
            Process child = null;
            try {
                server.start();
                Path input = directory.resolve("input.json");
                JSON.writeValue(input.toFile(), Map.of("mapping", fixture.mapping, "request", fixture.request,
                        "cut", cut.name(),
                        "origin", "http://127.0.0.1:" + server.getAddress().getPort()));
                Files.writeString(directory.resolve("token"), "process-token");
                Path log = directory.resolve("child.log");
                var command = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                        "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                        ResidentWorkspaceRetirementProcessMySqlIT.class.getName(), input.toString());
                command.environment().put("RETIREMENT_TEST_MYSQL_URL", database.url());
                command.environment().put("RETIREMENT_TEST_MYSQL_USER", System.getProperty("mysql.user"));
                command.environment().put("RETIREMENT_TEST_MYSQL_PASSWORD", System.getProperty("mysql.password", ""));
                child = command.redirectErrorStream(true).redirectOutput(log.toFile()).start();
                if (cut == Cut.BEFORE_SEND) {
                    await(child, log, () -> Files.exists(directory.resolve("before-send")));
                    kill(child);
                } else {
                    await(child, log, () -> requested.getCount() == 0);
                    if (cut == Cut.BEFORE_SAVE) {
                        try (var connection = database.source().getConnection()) {
                            connection.setAutoCommit(false);
                            try (var lock = connection.prepareStatement("SELECT operation_key FROM ma_operation"
                                    + " WHERE operation_kind = 'WORKSPACE_RETIREMENT' FOR UPDATE");
                                    var row = lock.executeQuery()) {
                                assertThat(row.next()).isTrue();
                                releaseReply.countDown();
                                await(child, log, () -> Files.exists(directory.resolve("reply-returned")));
                                var reply = JSON.readTree(directory.resolve("reply.json").toFile());
                                assertThat(reply.path("status").asInt()).isEqualTo(202);
                                assertThat(Base64.getDecoder().decode(reply.path("body").asText())).isEqualTo(REPLY);
                                kill(child);
                            } finally {
                                connection.rollback();
                            }
                        }
                    } else {
                        kill(child);
                    }
                }
                var restarted = store(database.source(), fixture.mapping);
                var status = restarted.inspect(fixture.request);
                assertThat(status.state()).isEqualTo("DRAINING");
                assertThat(status.attempts()).hasSize(1);
                assertThat(status.attempts().getFirst().ordinal()).isEqualTo(1);
                assertThat(status.attempts().getFirst().resourceVersion()).isEqualTo("10");
                assertThat(status.attempts().getFirst().state()).isEqualTo("UNKNOWN");
                assertThat(status.attempts().getFirst().httpStatus()).isNull();
                assertThat(status.attempts().getFirst().responseSha256()).isNull();
                var attempt = fixture.attempts().getFirst();
                assertThat(attempt).doesNotContainKeys("responseBase64", "httpStatus");
                byte[] persisted = Base64.getDecoder().decode((String) attempt.get("requestBase64"));
                var options = JSON.readTree(persisted);
                var placement = map(fixture.original.getResourceHandle().getValue().get("placement"));
                assertThat(options.path("preconditions").path("uid").asText()).isEqualTo(placement.get("podUid"));
                assertThat(options.path("preconditions").path("resourceVersion").asText()).isEqualTo("10");
                assertThat(options.path("gracePeriodSeconds").asInt()).isEqualTo(30);
                assertThat(options.path("propagationPolicy").asText()).isEqualTo("Background");
                assertThat(deletes.get()).isEqualTo(cut == Cut.BEFORE_SEND ? 0 : 1);
                if (cut != Cut.BEFORE_SEND) {
                    assertThat(received.get()).isEqualTo(persisted);
                    assertThat(target.get()).isEqualTo("/api/v1/namespaces/runtime/pods/" + placement.get("podName"));
                }
                var unusedApi = mock(KubernetesHttpRuntimeClient.class);
                assertThat(restarted.deletePod(fixture.request, "10", unusedApi)).isEqualTo(status);
                assertThat(restarted.inspect(fixture.request)).isEqualTo(status);
                verifyNoInteractions(unusedApi);
                assertThat(fixture.storage.inspect(fixture.mapping.registration())).isEqualTo(reservation);
                assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot WHERE request_key = ?",
                        String.class, fixture.runtimeRequest.requestKey())).isEqualTo(fixture.original.getBindingId());
                assertThat(fixture.bindings.findById(fixture.original.getBindingId()).getState())
                        .isEqualTo(RuntimeBindingRecord.State.DRAINING);
                assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_workspace", String.class)).isEqualTo("DRAINING");
            } finally {
                if (child != null && child.isAlive()) {
                    kill(child);
                }
                releaseReply.countDown();
                server.stop(0);
                executor.shutdownNow();
            }
        }
    }

    public static void main(String[] arguments) throws Exception {
        Path input = Path.of(arguments[0]);
        Path directory = input.getParent();
        var snapshot = JSON.readTree(input.toFile());
        var mapping = JSON.treeToValue(snapshot.path("mapping"), ResidentWorkspace.class);
        var request = JSON.treeToValue(snapshot.path("request"), ResidentWorkspaceRetirementStore.Request.class);
        var source = new DriverManagerDataSource(System.getenv("RETIREMENT_TEST_MYSQL_URL"),
                System.getenv("RETIREMENT_TEST_MYSQL_USER"), System.getenv("RETIREMENT_TEST_MYSQL_PASSWORD"));
        var constructor = KubernetesHttpRuntimeClient.class.getDeclaredConstructor(URI.class, Path.class,
                HttpClient.class, Duration.class);
        constructor.setAccessible(true);
        var real = constructor.newInstance(URI.create(snapshot.path("origin").asText()), directory.resolve("token"),
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build(), Duration.ofSeconds(30));
        var api = mock(KubernetesHttpRuntimeClient.class, delegatesTo(real));
        Cut cut = Cut.valueOf(snapshot.path("cut").asText());
        doAnswer(call -> {
            if (cut == Cut.BEFORE_SEND) {
                Files.createFile(directory.resolve("before-send"));
                new CountDownLatch(1).await();
            }
            return real.deletePod(call.getArgument(0), call.getArgument(1), call.getArgument(2)).thenApply(reply -> {
                if (cut == Cut.BEFORE_SAVE) {
                    try {
                        JSON.writeValue(directory.resolve("reply.json").toFile(), Map.of("status", reply.status(),
                                "body", Base64.getEncoder().encodeToString(reply.body())));
                        Files.createFile(directory.resolve("reply-returned"));
                    } catch (java.io.IOException failure) {
                        throw new java.io.UncheckedIOException(failure);
                    }
                }
                return reply;
            });
        }).when(api).deletePod(anyString(), anyString(), any(byte[].class));
        store(source, mapping).deletePod(request, "10", api);
        throw new AssertionError("Maintenance process unexpectedly reached the end before being killed");
    }

    private static ResidentWorkspaceRetirementStore store(DataSource source, ResidentWorkspace mapping) {
        return new ResidentWorkspaceRetirementStore(new JdbcTemplate(source), new JdbcTransactionManager(source),
                new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])), List.of(mapping), JSON);
    }

    private static void await(Process child, Path log, BooleanSupplier ready) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (!ready.getAsBoolean()) {
            assertThat(child.isAlive()).as("Maintenance process exited: %s", Files.readString(log)).isTrue();
            assertThat(System.nanoTime()).as("Maintenance process did not reach crash boundary: %s", Files.readString(log))
                    .isLessThan(deadline);
            Thread.sleep(20);
        }
    }

    private static void kill(Process child) throws Exception {
        child.destroyForcibly();
        assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(child.exitValue()).isNotZero();
    }
}
