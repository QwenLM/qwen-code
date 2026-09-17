package com.alibaba.qwen.code.runtimebroker;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;

/** Process fixture that implements the file boot and health handshake. */
public final class FakeRuntimeWorkerMain {
    private static final Set<String> BOOT_FIELDS = Set.of("type", "version",
            "runtimeInstanceId", "gatewayIncarnation", "leaseId", "epoch",
            "tenantId", "workspaceId", "workspaceCwd", "token",
            "outputRoot", "cliEntry");

    private FakeRuntimeWorkerMain() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4 || !"--boot-config".equals(args[0])
                || !"--ready-record".equals(args[2])) {
            System.exit(1);
        }
        Path bootPath = Path.of(args[1]);
        Path readyPath = Path.of(args[3]);
        Map<String, Object> boot = JsonCodec.parseObject(
                Files.readAllBytes(bootPath), "fake worker boot");
        if (!boot.keySet().equals(BOOT_FIELDS)) {
            System.exit(1);
        }
        String token = JsonCodec.requiredString(boot, "token", "boot");
        String leaseId = JsonCodec.requiredString(boot, "leaseId", "boot");
        long epoch = JsonCodec.optionalNonNegativeLong(boot, "epoch", "boot");
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        byte[] expectedAuthorization = ("Bearer " + token).getBytes(
                java.nio.charset.StandardCharsets.UTF_8);
        server.createContext("/health", exchange -> health(exchange,
                expectedAuthorization, leaseId, epoch));
        server.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0),
                "fake-runtime-worker-shutdown"));

        Map<String, Object> ready = new LinkedHashMap<>();
        ready.put("type", "ready");
        ready.put("version", 1);
        ready.put("runtimeInstanceId", boot.get("runtimeInstanceId"));
        ready.put("gatewayIncarnation", boot.get("gatewayIncarnation"));
        ready.put("leaseId", leaseId);
        ready.put("epoch", epoch);
        ready.put("tenantId", boot.get("tenantId"));
        ready.put("workspaceId", boot.get("workspaceId"));
        ready.put("workspaceCwd", boot.get("workspaceCwd"));
        ready.put("url", "http://127.0.0.1:"
                + server.getAddress().getPort());
        Path temporary = readyPath.resolveSibling(".ready.tmp");
        Files.write(temporary, JsonCodec.encode(ready),
                StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        Files.setPosixFilePermissions(temporary,
                PosixFilePermissions.fromString("rw-------"));
        Files.move(temporary, readyPath, StandardCopyOption.ATOMIC_MOVE);
        new CountDownLatch(1).await();
    }

    private static void health(HttpExchange exchange,
            byte[] expectedAuthorization, String leaseId, long epoch)
            throws IOException {
        String authorization = exchange.getRequestHeaders().getFirst(
                "Authorization");
        String suppliedLease = exchange.getRequestHeaders().getFirst(
                "X-Qwen-Managed-Lease-Id");
        String suppliedEpoch = exchange.getRequestHeaders().getFirst(
                "X-Qwen-Managed-Lease-Epoch");
        byte[] actual = authorization == null ? new byte[0]
                : authorization.getBytes(
                        java.nio.charset.StandardCharsets.UTF_8);
        if (!"GET".equals(exchange.getRequestMethod())
                || !MessageDigest.isEqual(expectedAuthorization, actual)
                || !leaseId.equals(suppliedLease)
                || !Long.toString(epoch).equals(suppliedEpoch)) {
            exchange.sendResponseHeaders(401, -1);
            exchange.close();
            return;
        }
        byte[] body = JsonCodec.encode(Map.of("status", "ok"));
        exchange.sendResponseHeaders(200, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }
}
