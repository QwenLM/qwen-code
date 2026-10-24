package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class HostedOperatorRecoveryProbeRaceTest {
    @TempDir
    private Path temporary;

    @Test
    void treatsAReapedProcessAsNotRunningWhenTheStatReadFails() throws Exception {
        ProcessHandle reaped = mock(ProcessHandle.class);
        when(reaped.isAlive()).thenReturn(false);
        Path unreadable = Files.createDirectory(temporary.resolve("unreadable"));
        assertThat(HostedOperatorRecoveryProbe.statRunning(reaped, unreadable)).isFalse();
    }

    @Test
    void preservesUnrelatedStatReadFailuresWhileTheProcessIsAlive() throws Exception {
        ProcessHandle alive = mock(ProcessHandle.class);
        when(alive.isAlive()).thenReturn(true);
        Path unreadable = Files.createDirectory(temporary.resolve("unreadable"));
        assertThatThrownBy(() -> HostedOperatorRecoveryProbe.statRunning(alive, unreadable))
                .isInstanceOf(IOException.class);
    }

    @Test
    void readsTheStateAfterTheLastParenthesisOfTheCommand() throws Exception {
        ProcessHandle alive = mock(ProcessHandle.class);
        when(alive.isAlive()).thenReturn(true);
        Path stat = temporary.resolve("stat");
        // Recorded kernel lines; HostedProcessLiveness relies on the same judgment.
        Files.writeString(stat, "677557 (sleep) Z 677555 677555 677554 0 -1 4227084 98 0 0 0 0 0 0 0 20 0 1 0"
                + " 45649481 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
        assertThat(HostedOperatorRecoveryProbe.statRunning(alive, stat)).as("zombie").isFalse();
        Files.writeString(stat, "677555 (sleep) S 677554 677555 677554 0 -1 4194304 224 0 0 0 0 0 0 0 20 0 1 0"
                + " 45649481 5709824 500 18446744073709551615 94686404997120 94686405017225 140721862394752 0 0 0"
                + " 0 0 0 1 0 0 17 3 0 0 0 0 0 94686405032752 94686405034112 94687052972032 140721862399910"
                + " 140721862399918 140721862399918 140721862402025 0\n");
        assertThat(HostedOperatorRecoveryProbe.statRunning(alive, stat)).as("sleeper").isTrue();
        Files.writeString(stat, "677557 (we)ird(name) Z 677555 677555 677554 0 -1 4227084 98 0 0 0 0 0 0 0 20 0 1"
                + " 0 45649481 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
        assertThat(HostedOperatorRecoveryProbe.statRunning(alive, stat)).as("zombie with ')' in comm").isFalse();
        Files.writeString(stat, "677555 (x) Z (y) S 677554 677555 677554 0 -1 4194304 224 0 0 0 0 0 0 0 20 0 1 0"
                + " 45649481 5709824 500 18446744073709551615 0 0 0 0 0 0 0 1 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
        assertThat(HostedOperatorRecoveryProbe.statRunning(alive, stat)).as("sleeper whose comm spells ') Z ('")
                .isTrue();
    }
}
