package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspaceRecoveryCommandTest {
    @TempDir
    Path directory;

    @Test
    void acceptsOnlyTheExactPrivateOperatorStatement() throws Exception {
        String recoveryId = UUID.randomUUID().toString();
        Path evidence = directory.resolve("evidence.json");
        String valid = """
                {"version":1,"recoveryId":"%s","verifiedAt":"2026-09-29T03:00:00Z",\
                "method":"host inspection","actions":"Stopped all writers and disabled restarts",\
                "restartPrevention":true}
                """.formatted(recoveryId);
        Files.writeString(evidence, valid);
        Files.setPosixFilePermissions(evidence,
                PosixFilePermissions.fromString("rw-------"));
        ObjectMapper mapper = new ObjectMapper();
        assertThat(WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, mapper)).isEqualTo(valid.getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                UUID.randomUUID().toString(), mapper)).isInstanceOf(IllegalArgumentException.class);

        Files.writeString(evidence, valid.replace("\"version\":1", "\"version\":\"1\""));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.writeString(evidence, valid.replace("\"method\":\"host inspection\"", "\"method\":123"));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.writeString(evidence, valid);
        Files.setPosixFilePermissions(evidence,
                PosixFilePermissions.fromString("rw-r--r--"));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.setPosixFilePermissions(evidence,
                PosixFilePermissions.fromString("rw-------"));
        Path link = directory.resolve("evidence-link.json");
        Files.createSymbolicLink(link, evidence);
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, link,
                recoveryId, mapper)).isInstanceOf(IllegalArgumentException.class);
    }
}
