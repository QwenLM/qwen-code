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
}
