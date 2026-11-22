package com.alibaba.qwen.code.runtimebroker.host;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.times;

class WorkspaceFileProcessTest {
    @TempDir
    Path temp;

    @Test
    void refusesLegacyHelpWithoutEverExecutingTheRequestedOperation() throws Exception {
        Path entry = temp.resolve("legacy.mjs");
        Files.writeString(entry, """
                import fs from 'node:fs';
                if (process.argv.includes('--help')) console.log('Usage: qwen');
                else { fs.writeFileSync(new URL('./unexpected', import.meta.url), 'executed'); console.log('{}'); }
                """);
        assertThatThrownBy(() -> WorkspaceFileProcess.read(System.getProperty("node.executable", "node"),
                entry.toString(), Map.of("files", Map.of("operation", "read"))))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
        assertThat(temp.resolve("unexpected")).doesNotExist();
        Files.writeString(entry, """
                if (process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFiles:1}}));
                else { for await (const bytes of process.stdin) {} console.log('not json'); }
                """);
        assertThatThrownBy(() -> WorkspaceFileProcess.read(System.getProperty("node.executable", "node"),
                entry.toString(), Map.of("files", Map.of("operation", "read"))))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
    }

    @Test
    void acceptsOnlyTheVersionedHandshakeBeforeSendingJsonOnStdin() throws Exception {
        Path entry = temp.resolve("new ' cli.mjs");
        Files.writeString(entry, """
                if (process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFiles:1}}));
                else {
                  let input=''; for await (const bytes of process.stdin) input+=bytes;
                  const request=JSON.parse(input);
                  console.log(JSON.stringify({protocolVersion:1,ok:true,result:{files:request.files}}));
                }
                """);
        var files = Map.of("protocolVersion", 1, "operation", "query", "directory", ".");
        var result = WorkspaceFileProcess.read(System.getProperty("node.executable", "node"), entry.toString(), Map.of("files", files));
        assertThat(result.get("files")).isEqualTo(JsonCodec.parseObject(JsonCodec.encode(files), "files"));
        try (var entries = Files.list(temp)) {
            assertThat(entries).hasSize(1);
        }
    }

    @Test
    void uploadRequiresIndependentCapabilityAndUsesItsBoundedIngressFlag() throws Exception {
        Path entry = temp.resolve("upload.mjs");
        Files.writeString(entry, """
                import fs from 'node:fs';
                if (process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFiles:1}}));
                else { fs.writeFileSync(new URL('./unexpected', import.meta.url), 'executed'); }
                """);
        var request = Map.<String, Object>of("files", Map.of("operation", "upload", "data", "a".repeat(100000)));
        assertThatThrownBy(() -> WorkspaceFileProcess.upload(System.getProperty("node.executable", "node"), entry.toString(), request))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
        assertThat(temp.resolve("unexpected")).doesNotExist();
        Files.writeString(entry, """
                if (process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFiles:1,workspaceFileUpload:1}}));
                else {
                  if (!process.argv.includes('--workspace-file-upload')) process.exit(8);
                  let input=''; for await (const bytes of process.stdin) input+=bytes;
                  console.log(JSON.stringify({protocolVersion:1,ok:true,result:{received:input.length}}));
                }
                """);
        assertThat(((Number) WorkspaceFileProcess.upload(System.getProperty("node.executable", "node"), entry.toString(), request).get("received")).intValue())
                .isEqualTo(JsonCodec.encode(request).length);
    }

    @Test
    void outputFailuresAfterUploadInvocationAreUnknownAndCannotReleaseStorageAsUnsupported() throws Exception {
        Path entry = temp.resolve("unknown.mjs");
        for (String output : List.of("console.log('not json')", "process.exit(7)", "console.log('{}')")) {
            Files.writeString(entry, """
                    import fs from 'node:fs';
                    if (process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFileUpload:1}}));
                    else {
                      for await (const bytes of process.stdin) {}
                      fs.writeFileSync(new URL('./invoked', import.meta.url), 'effect');
                    """ + output + "\n}\n");
            assertThatThrownBy(() -> WorkspaceFileProcess.upload(System.getProperty("node.executable", "node"),
                    entry.toString(), Map.of("files", Map.of("operation", "upload"))))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                        assertThat(error.getCode()).isEqualTo("workspace_upload_pending");
                        assertThat(error.getStatusCode()).isEqualTo(503);
                    });
            assertThat(temp.resolve("invoked")).hasContent("effect");
        }
    }

    @Test
    void commandDeadlineAlsoBoundsAChildThatNeverReadsTheUploadPipe() {
        long start = System.nanoTime();
        assertThatThrownBy(() -> HostCommandRunner.run(List.of(System.getProperty("node.executable", "node"),
                "-e", "process.stdin.pause(); setTimeout(() => {}, 60000)"), new byte[1024 * 1024], Duration.ofMillis(150)))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
    }

    @Test
    void reusesSuccessfulHelpAcrossReadsAndUploadsButStillRunsEachOperation() throws Exception {
        Path entry = temp.resolve("cached.mjs");
        Files.writeString(entry, """
                import fs from 'node:fs';
                if (process.argv.includes('--help')) {
                  fs.appendFileSync(new URL('./probes', import.meta.url), 'p');
                  console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFiles:1,workspaceFileUpload:1}}));
                } else {
                  for await (const bytes of process.stdin) {}
                  fs.appendFileSync(new URL('./operations', import.meta.url), 'o');
                  console.log(JSON.stringify({protocolVersion:1,ok:true,result:{}}));
                }
                """);
        String node = nodePath();
        WorkspaceFileProcess.read(node, entry.toString(), Map.of());
        WorkspaceFileProcess.upload(node, entry.toString(), Map.of());
        WorkspaceFileProcess.upload(node, entry.toString(), Map.of());
        assertThat(temp.resolve("probes")).hasContent("p");
        assertThat(temp.resolve("operations")).hasContent("ooo");
    }

    @Test
    void invalidatesReplacedCliAndDoesNotInferUploadSupportFromReadSupport() throws Exception {
        Path entry = temp.resolve("replace.mjs");
        Files.writeString(entry, """
                if (process.argv.includes('--help')) console.log(JSON.stringify({protocolVersion:1,capabilities:{workspaceFiles:1}}));
                else { for await (const bytes of process.stdin) {} console.log(JSON.stringify({protocolVersion:1,ok:true,result:{}})); }
                """);
        String node = nodePath();
        WorkspaceFileProcess.read(node, entry.toString(), Map.of());
        assertThatThrownBy(() -> WorkspaceFileProcess.upload(node, entry.toString(), Map.of()))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
        FileTime modified = Files.getLastModifiedTime(entry);
        Path replacement = temp.resolve("replacement.mjs");
        Files.writeString(replacement, """
                import fs from 'node:fs';
                if (process.argv.includes('--help')) console.log('legacy help');
                else fs.writeFileSync(new URL('./unexpected', import.meta.url), 'executed');
                """);
        Files.setLastModifiedTime(replacement, modified);
        Files.move(replacement, entry, StandardCopyOption.REPLACE_EXISTING);
        assertThatThrownBy(() -> WorkspaceFileProcess.read(node, entry.toString(), Map.of()))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_files_unsupported"));
        assertThat(temp.resolve("unexpected")).doesNotExist();
    }

    @Test
    void reprobesChangedNodeAndRelativePathsAndRetriesFailedHandshakes() throws Exception {
        Path node = Files.writeString(temp.resolve("node"), "node-version-one");
        Path entry = Files.writeString(temp.resolve("entry"), "entry");
        var help = new HostCommandRunner.Result(0, JsonCodec.encode(Map.of("protocolVersion", 1,
                "capabilities", Map.of("workspaceFiles", 1))));
        var result = new HostCommandRunner.Result(0, JsonCodec.encode(Map.of("protocolVersion", 1, "ok", true, "result", Map.of())));
        var probes = new java.util.concurrent.atomic.AtomicInteger();
        try (var runner = mockStatic(HostCommandRunner.class)) {
            runner.when(() -> HostCommandRunner.run(any(), any(), any())).thenAnswer(call -> {
                List<String> command = call.getArgument(0);
                if (!command.contains("--help")) {
                    return result;
                }
                return probes.incrementAndGet() == 1 ? new HostCommandRunner.Result(1, new byte[0]) : help;
            });
            assertThatThrownBy(() -> WorkspaceFileProcess.read(node.toString(), entry.toString(), Map.of()))
                    .isInstanceOf(RuntimeBrokerException.class);
            WorkspaceFileProcess.read(node.toString(), entry.toString(), Map.of());
            WorkspaceFileProcess.read(node.toString(), entry.toString(), Map.of());
            assertThat(probes.get()).isEqualTo(2);
            Files.writeString(node, "node-version-two-updated");
            WorkspaceFileProcess.read(node.toString(), entry.toString(), Map.of());
            assertThat(probes.get()).isEqualTo(3);
            WorkspaceFileProcess.read("node", entry.toString(), Map.of());
            WorkspaceFileProcess.read("node", entry.toString(), Map.of());
            assertThat(probes.get()).isEqualTo(5);
            runner.verify(() -> HostCommandRunner.run(any(), any(), any()), times(10));
        }
    }

    private static String nodePath() {
        var result = HostCommandRunner.run(List.of(System.getProperty("node.executable", "node"),
                "-p", "process.execPath"), new byte[]{'\n'}, Duration.ofSeconds(5));
        assertThat(result.exitCode()).isZero();
        return new String(result.stdout(), java.nio.charset.StandardCharsets.UTF_8).strip();
    }
}
