package com.alibaba.qwen.code.managedagent.api;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The committed route twin of {@link SurfaceRegistry} that the TypeScript
 * capability parity matrix reads (issue #15075). The file is a copy, so this
 * suite is what keeps the copy honest: a registry change fails the build
 * until the file is re-captured, and the capture is one test run, not a hand
 * edit.
 */
class ManagedSurfaceCaptureTest {

    private static Path committed() {
        return Path.of(ManagedSurfaceCapture.FILE);
    }

    @Test
    void committedSurfaceMatchesTheRegistry() throws IOException {
        assertThat(committed()).exists();
        assertThat(Files.readString(committed(), StandardCharsets.UTF_8))
                .isEqualTo(ManagedSurfaceCapture.render());
    }

    /** Re-capture: {@code mvn -Dtest=ManagedSurfaceCaptureTest#capture test}. */
    @Test
    void capture() throws IOException {
        Path file = committed();
        Files.createDirectories(file.getParent());
        Files.writeString(file, ManagedSurfaceCapture.render(),
                StandardCharsets.UTF_8);
        assertThat(Files.readString(file, StandardCharsets.UTF_8))
                .isEqualTo(ManagedSurfaceCapture.render());
    }
}
