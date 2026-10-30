package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
        assertThatThrownBy(() -> SshConnectionManager.runCommand(List.of(System.getProperty("node.executable", "node"),
                "-e", "process.stdin.pause(); setTimeout(() => {}, 60000)"), new byte[1024 * 1024], Duration.ofMillis(150)))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
    }
}
