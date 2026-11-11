package com.alibaba.qwen.code.managedagent.architecture;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Ratchets production class size in {@code persistence} and
 * {@code runtime-broker} so the decomposed stores and the broker facade cannot
 * regrow into god classes. This is the class-size gate the structure review
 * left as an open question; it is introduced now that the store decomposition
 * (#16090, #16142) and the broker extraction cluster have landed.
 *
 * <p>Four rules are enforced against the source tree:
 * <ol>
 *   <li>no class exceeds {@link #GLOBAL_MAX_LINES}, the agreed size ceiling;</li>
 *   <li>no pinned class exceeds its ceiling in
 *       {@code class-size-ratchet.properties};</li>
 *   <li>every class at or above {@link #LARGE_CLASS_THRESHOLD} lines is pinned,
 *       so a class cannot silently grow into a large one;</li>
 *   <li>every pin maps to an existing class (no stale pins).</li>
 * </ol>
 *
 * <p>Ratchet discipline: ceilings only ever go down. When a class shrinks,
 * lower its ceiling; when a class is deleted or renamed, remove its entry;
 * {@link #GLOBAL_MAX_LINES} lowers as the remaining large classes are split.
 * See {@code docs/design/2026-11-04-managed-agent-class-size-ratchet.md}.
 */
class ClassSizeRatchetTest {
    private static final int LARGE_CLASS_THRESHOLD = 800;
    private static final int GLOBAL_MAX_LINES = 2894;
    private static final String PIN_RESOURCE = "/class-size-ratchet.properties";
    private static final List<String> SOURCE_ROOTS =
            List.of("persistence/src/main/java", "runtime-broker/src/main/java");

    @Test
    void productionClassesStayWithinTheirSizeRatchet() throws IOException {
        Map<String, Integer> ceilings = loadPin();
        Map<String, Integer> sizes = measureProductionClasses();
        List<String> violations = new ArrayList<>();

        for (Map.Entry<String, Integer> entry : sizes.entrySet()) {
            String name = entry.getKey();
            int lines = entry.getValue();
            if (lines > GLOBAL_MAX_LINES) {
                violations.add(name + " has " + lines + " lines, above the global ceiling "
                        + GLOBAL_MAX_LINES + " (the ceiling only ratchets down)");
            }
            Integer ceiling = ceilings.get(name);
            if (ceiling != null && lines > ceiling) {
                violations.add(name + " grew to " + lines + " lines, above its ratchet ceiling "
                        + ceiling + " (ceilings only go down; split the class instead)");
            }
            if (ceiling == null && lines >= LARGE_CLASS_THRESHOLD) {
                violations.add(name + " reached " + lines + " lines (>= " + LARGE_CLASS_THRESHOLD
                        + ") but is not pinned; add it to class-size-ratchet.properties"
                        + " at its current size");
            }
        }
        for (String pinned : ceilings.keySet()) {
            if (!sizes.containsKey(pinned)) {
                violations.add("stale ratchet pin " + pinned
                        + " no longer maps to a production class; remove it");
            }
        }

        assertThat(violations).as("class-size ratchet violations").isEmpty();
    }

    private Map<String, Integer> loadPin() throws IOException {
        Properties properties = new Properties();
        try (InputStream in = getClass().getResourceAsStream(PIN_RESOURCE)) {
            assertThat(in).as("ratchet pin resource %s", PIN_RESOURCE).isNotNull();
            properties.load(in);
        }
        Map<String, Integer> ceilings = new TreeMap<>();
        for (String name : properties.stringPropertyNames()) {
            ceilings.put(name, Integer.parseInt(properties.getProperty(name).trim()));
        }
        assertThat(ceilings).as("ratchet pin must not be empty").isNotEmpty();
        return ceilings;
    }

    private Map<String, Integer> measureProductionClasses() throws IOException {
        Path moduleRoot = VerificationFixtures.moduleRoot();
        Map<String, Integer> sizes = new TreeMap<>();
        for (String root : SOURCE_ROOTS) {
            Path sourceRoot = moduleRoot.resolve(root);
            assertThat(sourceRoot).as("source root %s", sourceRoot).isDirectory();
            try (Stream<Path> files = Files.walk(sourceRoot)) {
                files.filter(ClassSizeRatchetTest::isProductionClass).forEach(path -> {
                    String relative = sourceRoot.relativize(path).toString();
                    String name = relative
                            .substring(0, relative.length() - ".java".length())
                            .replace(File.separatorChar, '.');
                    sizes.put(name, countLines(path));
                });
            }
        }
        assertThat(sizes).as("measured production classes").isNotEmpty();
        return sizes;
    }

    private static boolean isProductionClass(Path path) {
        String fileName = path.getFileName().toString();
        return fileName.endsWith(".java")
                && !fileName.equals("package-info.java")
                && !fileName.equals("module-info.java");
    }

    private static int countLines(Path path) {
        try {
            int lines = 0;
            for (byte b : Files.readAllBytes(path)) {
                if (b == '\n') {
                    lines++;
                }
            }
            return lines;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
