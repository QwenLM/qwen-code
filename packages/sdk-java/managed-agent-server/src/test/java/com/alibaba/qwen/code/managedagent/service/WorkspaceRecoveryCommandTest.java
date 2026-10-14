package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
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
        Instant verifiedAt = Instant.now().minusSeconds(60);
        String valid = """
                {"version":1,"recoveryId":"%s","verifiedAt":"%s",\
                "method":"host inspection","actions":"Stopped all writers and disabled restarts",\
                "restartPrevention":true}
                """.formatted(recoveryId, verifiedAt);
        Files.writeString(evidence, valid);
        Files.setPosixFilePermissions(evidence,
                PosixFilePermissions.fromString("rw-------"));
        ObjectMapper mapper = new ObjectMapper();
        Instant preparedAt = verifiedAt.minusSeconds(60);
        assertThat(WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).isEqualTo(valid.getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, verifiedAt.plusSeconds(60), mapper))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                UUID.randomUUID().toString(), preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);

        Files.writeString(evidence, valid.replace("\"version\":1", "\"version\":\"1\""));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.writeString(evidence, valid.replace("\"version\":1", "\"version\":4294967297"));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.writeString(evidence, valid.replace("\"restartPrevention\":true", "\"restartPrevention\":false"));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.writeString(evidence, valid.replace(verifiedAt.toString(),
                Instant.now().plusSeconds(360).toString()));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.writeString(evidence, valid.replace("Stopped all writers and disabled restarts", "x".repeat(8192)));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).hasMessageContaining("8 KiB");
        Files.write(evidence, valid.getBytes(StandardCharsets.UTF_16));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).hasMessageContaining("UTF-8");
        Files.writeString(evidence, valid.replace("\"method\":\"host inspection\"", "\"method\":123"));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.writeString(evidence, valid);
        Files.setPosixFilePermissions(evidence,
                PosixFilePermissions.fromString("rw-r--r--"));
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, evidence,
                recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        Files.setPosixFilePermissions(evidence,
                PosixFilePermissions.fromString("rw-------"));
        Path link = directory.resolve("evidence-link.json");
        Files.createSymbolicLink(link, evidence);
        assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, link,
                recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        Path outside = Files.createTempFile("operator-evidence", ".json");
        try {
            Files.writeString(outside, valid);
            Files.setPosixFilePermissions(outside,
                    PosixFilePermissions.fromString("rw-------"));
            assertThatThrownBy(() -> WorkspaceRecoveryCommand.readEvidence(directory, outside,
                    recoveryId, preparedAt, mapper)).isInstanceOf(IllegalArgumentException.class);
        } finally {
            Files.deleteIfExists(outside);
        }
    }
}
