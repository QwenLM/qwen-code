package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Git version floor of decision 12 (#13753 I1), against stub
 * executables only. It lives apart from the suites that need a real Git,
 * because those skip when the floor refuses the host's Git: a broken
 * comparison would otherwise hide its own witness.
 */
@DisabledOnOs(value = OS.WINDOWS, disabledReason = "Child Workspaces are not supported on Windows")
class ChildWorktreeGitVersionTest {
    @TempDir
    Path temp;

    @Test
    void theFloorIsTwoFortyAndARefusalNamesItsCause() throws Exception {
        for (String version : List.of("2.40.0", "2.45.2", "3.0.0")) {
            ChildWorktreeGit stub = stub("echo 'git version " + version + "'");
            try {
                assertThat(stub.requireSupportedVersion()).isEqualTo("git version " + version);
            } finally {
                stub.close();
            }
        }
        for (String version : List.of("2.39.5", "1.99.0")) {
            ChildWorktreeGit stub = stub("echo 'git version " + version + "'");
            try {
                assertThatThrownBy(stub::requireSupportedVersion).isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("2.40 or later").hasMessageContaining(version);
            } finally {
                stub.close();
            }
        }
        ChildWorktreeGit failing = stub("echo 'git version 2.45.0'\nexit 1");
        try {
            assertThatThrownBy(failing::requireSupportedVersion).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("exit 1");
        } finally {
            failing.close();
        }
        ChildWorktreeGit broken = stub("echo 'no such libexec' >&2\nexit 127");
        try {
            assertThatThrownBy(broken::requireSupportedVersion).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("exit 127").hasMessageContaining("no such libexec");
        } finally {
            broken.close();
        }
    }

    private ChildWorktreeGit stub(String body) throws IOException {
        Path script = Files.createTempFile(temp, "git", null);
        Files.writeString(script, "#!/bin/sh\n" + body + "\n");
        assumeTrue(script.toFile().setExecutable(true));
        return new ChildWorktreeGit(script.toString(), Duration.ofSeconds(5));
    }
}
