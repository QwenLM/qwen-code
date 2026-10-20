package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
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
}
