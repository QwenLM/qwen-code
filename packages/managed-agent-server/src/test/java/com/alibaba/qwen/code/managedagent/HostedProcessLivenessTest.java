package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

import static com.alibaba.qwen.code.managedagent.HostedProcessLiveness.awaitStopped;
import static com.alibaba.qwen.code.managedagent.HostedProcessLiveness.running;
import static com.alibaba.qwen.code.managedagent.HostedProcessLiveness.statRunning;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

// #15065 R1-2: every caller is a Hosted MySQL IT or probe, so these pins keep
// a wrong edit red in the default surefire lane.
class HostedProcessLivenessTest {
    @TempDir
    private Path temporary;

    @Test
    void returnsOnceTheProcessHasExited() throws Exception {
        Process exited = new ProcessBuilder("/bin/sleep", "0").start();
        assertThat(exited.waitFor(60, TimeUnit.SECONDS)).isTrue();
        awaitStopped(exited.toHandle(), Duration.ZERO, "Exited");
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void treatsAnUnreapedZombieAsStopped() throws Exception {
        // The shell backgrounds a child, then execs into a sleep that never reaps it.
        Process parent = new ProcessBuilder("/bin/sh", "-c", "/bin/sleep 0 & exec /bin/sleep 60").start();
        try {
            ProcessHandle zombie = null;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (zombie == null) {
                assertThat(System.nanoTime()).as("zombie child of %s", parent.pid()).isLessThan(deadline);
                zombie = parent.children().filter(HostedProcessLivenessTest::zombie).findFirst().orElse(null);
                Thread.sleep(20);
            }
            assertThat(zombie.isAlive()).as("an unreaped zombie still reads as alive").isTrue();
            awaitStopped(zombie, Duration.ofSeconds(5), "Zombie");
        } finally {
            parent.destroyForcibly();
            assertThat(parent.waitFor(60, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void namesAProcessThatOutlivesTheDeadline() throws Exception {
        Process live = new ProcessBuilder("/bin/sleep", "60").start();
        try {
            assertThatThrownBy(() -> awaitStopped(live.toHandle(), Duration.ofMillis(200), "Producer"))
                    .isInstanceOf(AssertionError.class)
                    .hasMessageContaining("Producer: " + live.pid() + " (parent " + ProcessHandle.current().pid()
                            + ", state S): ")
                    .hasMessageContaining("sleep 60");
        } finally {
            live.destroyForcibly();
            assertThat(live.waitFor(60, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void treatsAReapedProcessAsNotRunningWhenTheStatReadFails() throws Exception {
        ProcessHandle reaped = mock(ProcessHandle.class);
        when(reaped.isAlive()).thenReturn(false);
        Path unreadable = Files.createDirectory(temporary.resolve("unreadable"));
        assertThat(statRunning(reaped, unreadable)).isFalse();
    }

    @Test
    void preservesUnrelatedStatReadFailuresWhileTheProcessIsAlive() throws Exception {
        ProcessHandle alive = mock(ProcessHandle.class);
        when(alive.isAlive()).thenReturn(true);
        Path unreadable = Files.createDirectory(temporary.resolve("unreadable"));
        assertThatThrownBy(() -> statRunning(alive, unreadable)).isInstanceOf(IOException.class);
    }

    @Test
    void readsTheStateAfterTheLastParenthesisOfTheCommand() throws Exception {
        ProcessHandle alive = mock(ProcessHandle.class);
        when(alive.isAlive()).thenReturn(true);
        Path stat = temporary.resolve("stat");
        // Recorded kernel lines.
        Files.writeString(stat, "677557 (sleep) Z 677555 677555 677554 0 -1 4227084 98 0 0 0 0 0 0 0 20 0 1 0"
                + " 45649481 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
        assertThat(statRunning(alive, stat)).as("zombie").isFalse();
        Files.writeString(stat, "677555 (sleep) S 677554 677555 677554 0 -1 4194304 224 0 0 0 0 0 0 0 20 0 1 0"
                + " 45649481 5709824 500 18446744073709551615 94686404997120 94686405017225 140721862394752 0 0 0"
                + " 0 0 0 1 0 0 17 3 0 0 0 0 0 94686405032752 94686405034112 94687052972032 140721862399910"
                + " 140721862399918 140721862399918 140721862402025 0\n");
        assertThat(statRunning(alive, stat)).as("sleeper").isTrue();
        Files.writeString(stat, "677557 (we)ird(name) Z 677555 677555 677554 0 -1 4227084 98 0 0 0 0 0 0 0 20 0 1"
                + " 0 45649481 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
        assertThat(statRunning(alive, stat)).as("zombie with ')' in comm").isFalse();
        Files.writeString(stat, "677555 (x) Z (y) S 677554 677555 677554 0 -1 4194304 224 0 0 0 0 0 0 0 20 0 1 0"
                + " 45649481 5709824 500 18446744073709551615 0 0 0 0 0 0 0 1 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
        assertThat(statRunning(alive, stat)).as("sleeper whose comm spells ') Z ('").isTrue();
    }

    @Test
    void treatsALiveProcessAsRunningWithoutProcfs() {
        ProcessHandle alive = mock(ProcessHandle.class);
        when(alive.isAlive()).thenReturn(true);
        assertThat(running(alive, temporary.resolve("no-procfs"))).isTrue();
    }

    @Test
    void surfacesAnUnrelatedStatFailureOnALiveProcess() throws Exception {
        ProcessHandle alive = mock(ProcessHandle.class);
        when(alive.isAlive()).thenReturn(true);
        when(alive.pid()).thenReturn(4242L);
        // A directory where the stat file belongs fails the read for a reason other than reaping.
        Files.createDirectories(temporary.resolve("proc/4242/stat"));
        assertThatThrownBy(() -> running(alive, temporary.resolve("proc")))
                .isInstanceOf(UncheckedIOException.class).hasCauseInstanceOf(IOException.class);
    }

    @Test
    void readsTheStatOfThatPidUnderTheProcRoot() throws Exception {
        ProcessHandle alive = mock(ProcessHandle.class);
        when(alive.isAlive()).thenReturn(true);
        when(alive.pid()).thenReturn(4242L);
        Path stat = Files.createDirectories(temporary.resolve("proc/4242")).resolve("stat");
        Files.writeString(stat, "4242 (node) Z 4241 4242 4241 0 -1 4227084 98 0 0 0 0 0 0 0 20 0 1 0\n");
        assertThat(running(alive, temporary.resolve("proc"))).as("zombie").isFalse();
        Files.writeString(stat, "4242 (node) S 4241 4242 4241 0 -1 4194304 224 0 0 0 0 0 0 0 20 0 1 0\n");
        assertThat(running(alive, temporary.resolve("proc"))).as("sleeper").isTrue();
    }

    private static boolean zombie(ProcessHandle process) {
        try {
            return Files.readString(Path.of("/proc", Long.toString(process.pid()), "stat")).contains(") Z ");
        } catch (IOException gone) {
            return false;
        }
    }
}
