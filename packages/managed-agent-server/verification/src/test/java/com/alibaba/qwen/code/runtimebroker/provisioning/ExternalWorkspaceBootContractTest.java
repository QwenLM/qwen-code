package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Cross-language contract test for the boot document the {@code external-workspace}
 * provisioner mints (#15512 step 3a).
 *
 * <p>The authority is the <em>shipped</em> worker parser: the Java side writes the
 * actual {@code provision} boot document and a rotated-equivalent
 * {@code registration.json} descriptor into a private directory, and the existing
 * {@code readManagedRuntimeContainerBoot} (TypeScript, via {@code tsx}) admits or
 * refuses it. No CLI, worker or registration-write change is made — the shipped
 * {@code boot-v2 + storage} contract is exercised as it stands.
 *
 * <p>The always-on Java mirror checks the same closed shape, so a skipped
 * cross-language run still fails when the document drifts.
 */
class ExternalWorkspaceBootContractTest {
    private static final String TENANT = "tenant-a";
    private static final String ALIAS = "workspace-a";
    private static final String PROVIDER = "provider-a";
    private static final String PHYSICAL = "physical-a";
    private static final String ALIAS_PATH = "/external/workspace-a";
    /** The sixteen managed-context/1 boot keys, sorted, as the worker checks them. */
    private static final List<String> CONTEXT_KEYS = List.of("capabilityDigest", "epoch",
            "isolationClass", "leaseId", "managedContext", "mountRoot", "provisionRequestId",
            "runtimeIncarnation", "runtimeInstanceId", "storageId", "tenantId", "token", "type",
            "version", "workspaceGeneration", "workspaceId");

    @TempDir
    Path temporary;

    private static RuntimeScope scope(String mountRoot) {
        return new RuntimeScope(TENANT, ALIAS, "1", mountRoot,
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
    }

    private static Map<String, Object> mintedBoot(String mountRoot) throws Exception {
        ExternalStorageRegistry registry = (tenant, alias) -> Optional.of(
                new ExternalStorageRegistry.RegisteredExternalStorage(PROVIDER, PHYSICAL, 1,
                        ALIAS, ALIAS_PATH, mountRoot));
        var client = new CapturingClient();
        try (var provisioner = new ExternalWorkspaceProvisioner(client, registry, PROVIDER,
                Duration.ofSeconds(5))) {
            RuntimeProvisionRequest request = provisioner.createRequest(scope(mountRoot),
                    "isolation-a");
            RuntimeProvisionSeed seed = new RuntimeProvisionSeed("request-a", "runtime-a",
                    "incarnation-a", "lease-a", 1, "token-a");
            var handle = provisioner.ensureResource(request, seed, null)
                    .toCompletableFuture().get(20, TimeUnit.SECONDS);
            client.provisionResponse = Map.of("protocolVersion", 1,
                    "handle", handle.getValue().get("provider"),
                    "endpoint", "http://127.0.0.1:43190");
            provisioner.provision(request, seed).toCompletableFuture().get(20, TimeUnit.SECONDS);
            return client.boot();
        }
    }

    @Test
    void theMintedBootKeepsTheShippedManagedContextShape() throws Exception {
        Map<String, Object> boot = mintedBoot("/mnt/external/workspace-a");

        List<String> keys = new ArrayList<>(boot.keySet());
        keys.sort(String::compareTo);
        List<String> expected = new ArrayList<>(CONTEXT_KEYS);
        expected.add("storage");
        expected.sort(String::compareTo);
        assertEquals(expected, keys, "closed key set: managed-context/1 plus storage");
        assertTrue(boot.get("storage") instanceof Map<?, ?>);
        @SuppressWarnings("unchecked")
        Map<String, Object> storage = (Map<String, Object>) boot.get("storage");
        assertEquals(Set.of("kind", "physicalKey", "aliasPath", "mountRoot",
                "registrationRevision"), storage.keySet());
        assertEquals("external", storage.get("kind"));
        assertEquals(boot.get("mountRoot"), storage.get("mountRoot"),
                "the worker requires the context mount root to equal the storage one");
        assertEquals("session", boot.get("isolationClass"));
        assertEquals(WorkspaceExecutionProfile.CAPABILITY_DIGEST, boot.get("capabilityDigest"));
    }

    @Test
    @Timeout(120)
    @DisabledOnOs(OS.WINDOWS)
    void theShippedWorkerParserAdmitsTheMintedBoot() throws Exception {
        Path repoRoot = VerificationFixtures.repositoryRoot();
        Assumptions.assumeTrue(Files.isRegularFile(repoRoot.resolve(
                        "packages/cli/src/serve/managed-runtime-attestation-worker.ts")),
                "needs the qwen-code checkout this module lives in");
        Assumptions.assumeTrue(Files.isDirectory(repoRoot.resolve("node_modules/tsx")),
                "needs the repository root dev install (node_modules/tsx) to run the worker parser");

        Path directory = Files.createDirectory(temporary.toRealPath().resolve("boot"));
        // The worker admits the boot only from an owner-only private directory, and
        // its mount root must already be private (it creates a missing one as 0700).
        privateDirectory(directory, Set.of(PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        Path mountRoot = Files.createDirectory(directory.resolve("workspace"));
        privateDirectory(mountRoot, Set.of(PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        Map<String, Object> boot = mintedBoot(mountRoot.toString());
        Path bootFile = writeBoot(directory, boot);
        writeDescriptor(directory, PHYSICAL);

        Run admitted = runParser(repoRoot, bootFile);
        assertEquals(0, admitted.exitCode(), admitted.stderr());
        assertTrue(admitted.stdout().contains("\"version\":2"), admitted.stdout());
        assertTrue(admitted.stdout().contains(mountRoot.toString()), admitted.stdout());
        assertTrue(admitted.stdout().contains("\"kind\":\"external\""), admitted.stdout());

        // Negative control: a descriptor for another physical key must be refused,
        // which proves the run above compared something instead of accepting bytes.
        writeDescriptor(directory, "physical-other");
        Run refused = runParser(repoRoot, bootFile);
        assertNotEquals(0, refused.exitCode(), "a foreign registration must be refused");
        assertTrue(refused.stderr().contains("boot payload is invalid"), refused.stderr());
    }

    private static void privateDirectory(Path directory, Set<PosixFilePermission> permissions)
            throws IOException {
        Files.setPosixFilePermissions(directory, permissions);
    }

    private static Path writeBoot(Path directory, Map<String, Object> boot) throws IOException {
        Path file = directory.resolve("boot.json");
        Files.writeString(file, new com.fasterxml.jackson.databind.ObjectMapper()
                .writeValueAsString(boot), StandardCharsets.UTF_8);
        Files.setPosixFilePermissions(file, Set.of(PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE));
        return file;
    }

    /** The adapter-authored descriptor: closed keys, no boot discriminator. */
    private static void writeDescriptor(Path directory, String physicalKey) throws IOException {
        Path file = directory.resolve("registration.json");
        Files.writeString(file, new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(
                        Map.of("providerId", PROVIDER, "physicalKey", physicalKey,
                                "aliasPath", ALIAS_PATH, "mountRoot",
                                directory.resolve("workspace").toString(),
                                "registrationRevision", 1)),
                StandardCharsets.UTF_8);
        Files.setPosixFilePermissions(file, Set.of(PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE));
    }

    private record Run(int exitCode, String stdout, String stderr) {
    }

    /**
     * Runs the shipped parser through the repository's TypeScript loader. The
     * fixture calls the parser directly; no repository script is added.
     */
    private Run runParser(Path repoRoot, Path bootFile) throws Exception {
        String parser = repoRoot.resolve(
                "packages/cli/src/serve/managed-runtime-attestation-worker.ts").toUri().toString();
        String script = "const worker = await import(process.env.QWEN_WORKER_PARSER);"
                + "const boot = await worker.readManagedRuntimeContainerBoot(process.env.BOOT_PATH);"
                + "process.stdout.write(JSON.stringify({version: boot.version,"
                + " mountRoot: boot.mountRoot, storage: boot.storage}));";
        Path stdout = Files.createTempFile(temporary, "parser-out", ".txt");
        Path stderr = Files.createTempFile(temporary, "parser-err", ".txt");
        ProcessBuilder builder = new ProcessBuilder("node", "--import", "tsx",
                "--input-type=module", "-e", script)
                .directory(repoRoot.toFile())
                .redirectOutput(stdout.toFile())
                .redirectError(stderr.toFile());
        builder.environment().put("QWEN_WORKER_PARSER", parser);
        builder.environment().put("BOOT_PATH", bootFile.toString());
        Process process = builder.start();
        assertTrue(process.waitFor(90, TimeUnit.SECONDS), "worker parser timed out");
        return new Run(process.exitValue(), Files.readString(stdout),
                Files.readString(stderr));
    }

    private static final class CapturingClient implements ExternalRuntimeClient {
        private final List<Map<String, Object>> provisions = new ArrayList<>();
        private Map<String, Object> provisionResponse = Map.of("protocolVersion", 1,
                "handle", Map.of("requestId", "request-a"),
                "endpoint", "http://127.0.0.1:43190");

        @Override
        public CompletionStage<Map<String, Object>> provision(Map<String, Object> request) {
            provisions.add(request);
            return CompletableFuture.completedFuture(provisionResponse);
        }

        @Override
        public CompletionStage<Map<String, Object>> observe(Map<String, Object> request) {
            return CompletableFuture.completedFuture(Map.of("protocolVersion", 1,
                    "state", "RUNNING", "endpoint", "http://127.0.0.1:43190"));
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> boot() {
            Map<String, Object> body = new LinkedHashMap<>(provisions.get(0));
            return (Map<String, Object>) body.get("boot");
        }
    }
}
