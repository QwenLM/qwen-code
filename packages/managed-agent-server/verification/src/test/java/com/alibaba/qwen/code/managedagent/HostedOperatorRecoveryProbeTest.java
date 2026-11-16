package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

@EnabledOnOs(OS.LINUX)
class HostedOperatorRecoveryProbeTest {
    @TempDir
    private Path temporary;

    @Test
    void cleansOwnedProcessesWhenAnEscapedPidFailsOwnershipValidation() throws Exception {
        Path expected = Files.createDirectory(temporary.resolve("expected"));
        Path different = Files.createDirectory(temporary.resolve("different"));
        List<Process> children = new ArrayList<>();
        try {
            Process tracked = start(expected, children);
            Process registered = start(expected, children);
            Process unverified = start(different, children);
            Files.writeString(expected.resolve("escaped.pid"), Long.toString(unverified.pid()));

            // Bypass Spring setup; close() and all process operations run for real.
            var probe = mock(HostedOperatorRecoveryProbe.class, CALLS_REAL_METHODS);
            ReflectionTestUtils.setField(probe, "sessions", List.of(
                    Map.of("sessionId", "cwd-mismatch", "directory", expected.toString())));
            ReflectionTestUtils.setField(probe, "processes", new LinkedHashSet<>(List.of(tracked.toHandle())));
            ReflectionTestUtils.setField(probe, "escapedProcesses", new HashMap<String, ProcessHandle>());
            ReflectionTestUtils.setField(probe, "local", new Local(
                    Map.of("worker", new Owned(new Registration(registered.toHandle())))));
            assertThat(children).allMatch(Process::isAlive);

            assertThatThrownBy(probe::close).isInstanceOf(AssertionError.class)
                    .hasMessageContaining(expected.toString()).hasMessageContaining(different.toString());
            assertThat(tracked.waitFor(60, TimeUnit.SECONDS)).as("previously tracked process stopped").isTrue();
            assertThat(registered.waitFor(60, TimeUnit.SECONDS)).as("registered worker stopped").isTrue();
            assertThat(unverified.isAlive()).as("unverified PID remains untouched").isTrue();
        } finally {
            children.forEach(Process::destroyForcibly);
            for (Process child : children) {
                assertThat(child.waitFor(60, TimeUnit.SECONDS)).as("fixture process %s stopped", child.pid()).isTrue();
            }
        }
    }

    private static Process start(Path directory, List<Process> children) throws Exception {
        Process child = new ProcessBuilder("/bin/sleep", "120").directory(directory.toFile()).start();
        children.add(child);
        return child;
    }

    private record Registration(ProcessHandle process) { }

    private record Owned(Registration registration) { }

    private record Local(Map<String, Owned> owned) { }
}
