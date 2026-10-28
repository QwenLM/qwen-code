package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

import static com.alibaba.qwen.code.managedagent.HostedProcessLiveness.awaitStopped;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

// #15065 R1-2: the producer drain's only caller is a Hosted MySQL IT, so
// these pins keep a wrong edit red in the default surefire lane.
class HostedProcessLivenessTest {
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

    private static boolean zombie(ProcessHandle process) {
        try {
            return Files.readString(Path.of("/proc", Long.toString(process.pid()), "stat")).contains(") Z ");
        } catch (java.io.IOException gone) {
            return false;
        }
    }
}
