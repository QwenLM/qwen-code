package com.alibaba.qwen.code.runtimebroker;

import java.net.http.HttpClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Child JVM that leaves one durable local Runtime available for adoption. */
public final class LocalProcessProvisionerFixtureMain {
    private LocalProcessProvisionerFixtureMain() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            throw new IllegalArgumentException(
                    "state, workspace, and cli paths are required");
        }
        Path state = Path.of(args[0]);
        Path workspace = Path.of(args[1]);
        Path cli = Path.of(args[2]);
        List<String> command = List.of(javaExecutable().toString(), "-cp",
                System.getProperty("java.class.path"),
                FakeRuntimeWorkerMain.class.getName());
        LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(state, command, cli,
                        Map.of(), 1, Duration.ofSeconds(5),
                        Duration.ofSeconds(1), Duration.ofSeconds(1),
                        Duration.ofSeconds(1), HttpClient.newBuilder()
                                .version(HttpClient.Version.HTTP_1_1)
                                .connectTimeout(Duration.ofSeconds(1))
                                .followRedirects(HttpClient.Redirect.NEVER)
                                .build(), Executors.newCachedThreadPool(
                                        runnable -> {
                                            Thread thread = new Thread(runnable,
                                                    "local-runtime-fixture");
                                            thread.setDaemon(true);
                                            return thread;
                                        }));
        RuntimeProvisionRequest request = request(provisioner, workspace);
        RuntimeProvisionSeed seed = seed();
        RuntimeResourceHandle handle = provisioner.ensureResource(request,
                seed, null).toCompletableFuture().get(5, TimeUnit.SECONDS);
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (System.nanoTime() < deadline) {
            RuntimeObservation observation = provisioner.reconcile(request,
                    seed, handle, null).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);
            if (observation.getOutcome()
                    == RuntimeObservation.Outcome.READY) {
                System.out.println("P3_LOCAL_RUNTIME_PID="
                        + handle.getValue().get("pid"));
                provisioner.close();
                return;
            }
            Thread.sleep(25);
        }
        throw new IllegalStateException("Runtime did not become ready");
    }

    static RuntimeProvisionRequest request(
            LocalProcessRuntimeProvisioner provisioner, Path workspace) {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                "generation", workspace.toString(), "capability",
                "workspace");
        return new RuntimeProvisionRequest(scope, null, provisioner.kind(),
                provisioner.placementDomain(),
                provisioner.runtimeTemplateDigest());
    }

    static RuntimeProvisionSeed seed() {
        return new RuntimeProvisionSeed("cross-process:1", "cross-process",
                "cross-process:1", "cross-process-lease", 1,
                "cross-process-token");
    }

    private static Path javaExecutable() {
        return Path.of(System.getProperty("java.home"), "bin", "java")
                .toAbsolutePath();
    }
}
