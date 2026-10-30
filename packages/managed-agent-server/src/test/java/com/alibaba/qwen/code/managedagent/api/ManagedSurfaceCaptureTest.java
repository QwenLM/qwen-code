package com.alibaba.qwen.code.managedagent.api;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The committed route twin of {@link SurfaceRegistry} that the TypeScript
 * capability parity matrix reads (issue #15075). The file is a copy, so this
 * suite is what keeps the copy honest: a registry change fails the build
 * until the twin is re-captured.
 *
 * <p>Verification never writes. Re-capture is an explicit opt-in through
 * {@code -Dcapability.parity.capture=true}, because a test that rewrites its
 * own baseline on an ordinary run turns a second run green against data the
 * first run edited:
 *
 * <pre>
 * mvn -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true test
 * </pre>
 */
class ManagedSurfaceCaptureTest {
    private static final String CAPTURE_PROPERTY =
            "capability.parity.capture";

    private static Path committed() {
        return Path.of(ManagedSurfaceCapture.FILE);
    }

    @Test
    void committedSurfaceMatchesTheRegistry() throws IOException {
        assertThat(committed()).exists();
        String rendered = ManagedSurfaceCapture.render();
        if (Boolean.getBoolean(CAPTURE_PROPERTY)) {
            Files.writeString(committed(), rendered, StandardCharsets.UTF_8);
        }
        try {
            assertThat(Files.readString(committed(), StandardCharsets.UTF_8))
                    .isEqualTo(rendered);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        } catch (AssertionError error) {
            throw new AssertionError(error.getMessage()
                    + "\nRe-capture with -D" + CAPTURE_PROPERTY + "=true"
                    + " only when the registry change is intended.", error);
        }
    }
}
