package com.alibaba.qwen.code.managedagent.preflight;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HarnessBrokerUrlTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    // The expected verdicts are preflight's reading, which is the Harness's
    // own wherever its URL parser keeps the host. The CLI fixture test runs
    // the same rows, narrowed to invalid where its parser refuses an xn--
    // host.
    @Test
    void readsEveryUrlTheWayTheHarnessDoes() throws IOException {
        JsonNode cases = fixtures().get("cases");
        assertTrue(cases.size() > 0);
        for (JsonNode fixture : cases) {
            String url = fixture.get("url").textValue();
            HarnessBrokerUrl.Result read = HarnessBrokerUrl.read(url);
            String verdict = read.verdict().name().toLowerCase(Locale.ROOT)
                    .replace('_', '-');
            String expected = fixture.get("verdict").textValue();
            assertTrue(expected.equals(verdict)
                    || declaredApproximation(expected, read.verdict(), url),
                    url + " ==> expected: <" + expected + "> but was: <"
                            + verdict + ">");
            if (read.verdict() == HarnessBrokerUrl.Verdict.ACCEPTED) {
                assertEquals(fixture.get("hostname").textValue(),
                        read.hostname(), url);
                assertEquals(fixture.get("port").intValue(), read.port(), url);
                assertEquals(url.regionMatches(true, 0, "https:", 0, 6),
                        read.https(), url);
            }
        }
    }

    @Test
    void leavesWhatItCannotReadUnclassified() {
        // An https host with an xn-- label goes through IDNA, which the
        // Harness may accept or refuse; text outside the credentials file's
        // characters never reaches the row.
        for (String url : new String[] {"https://xn--bcher-kva.example:8443",
                "https://xn--a:8443", "https://xn--localhost-:8443",
                "http://127.0.0.1:4182/?x"}) {
            assertEquals(HarnessBrokerUrl.Verdict.UNCLASSIFIED,
                    HarnessBrokerUrl.read(url).verdict(), url);
        }
    }

    @Test
    void refusesAnXnHostEndingInANumberWithoutIdna() {
        // IDNA keeps the label or refuses the URL, so the IPv4 parser always
        // fails on it.
        assertEquals(HarnessBrokerUrl.Verdict.INVALID,
                HarnessBrokerUrl.read("https://xn--bcher-kva.1:8443").verdict());
    }

    @Test
    void allowsOnlyTheDeclaredApproximations() {
        // An https xn-- host stays unclassified only against an accepting
        // verdict, and a scheme read before the host may name the refusal
        // the fixture records for an invalid URL.
        assertTrue(declaredApproximation("accepted",
                HarnessBrokerUrl.Verdict.UNCLASSIFIED, "https://xn--a:8443"));
        assertFalse(declaredApproximation("invalid",
                HarnessBrokerUrl.Verdict.UNCLASSIFIED, "https://xn--a:8443"));
        assertFalse(declaredApproximation("invalid",
                HarnessBrokerUrl.Verdict.PLAIN_OUTSIDE_LOOPBACK,
                "http://xn--a:4182"));
        assertTrue(declaredApproximation("invalid",
                HarnessBrokerUrl.Verdict.NOT_ORIGIN, "ftp://"));
        assertFalse(declaredApproximation("not-origin",
                HarnessBrokerUrl.Verdict.NOT_ORIGIN, "ftp://127.0.0.1:4182"));
        // One negative per remaining decision point, so that loosening any
        // arm fails here rather than in readsEveryUrlTheWayTheHarnessDoes.
        assertFalse(declaredApproximation("accepted",
                HarnessBrokerUrl.Verdict.UNCLASSIFIED, "https://broker.example:8443"));
        assertFalse(declaredApproximation("accepted",
                HarnessBrokerUrl.Verdict.UNCLASSIFIED, "http://xn--a:4182"));
        assertFalse(declaredApproximation("accepted",
                HarnessBrokerUrl.Verdict.NOT_ORIGIN, "http://127.0.0.1:4182"));
        assertFalse(declaredApproximation("invalid",
                HarnessBrokerUrl.Verdict.NOT_ORIGIN, "http://"));
        assertFalse(declaredApproximation("invalid",
                HarnessBrokerUrl.Verdict.ACCEPTED, "https://127.0.0.1:4182"));
        assertFalse(declaredApproximation("accepted",
                HarnessBrokerUrl.Verdict.INVALID, "https://xn--bcher-kva.1:8443"));
    }

    // The two exceptions HarnessBrokerUrl documents, and only those: a
    // non-http(s) scheme read before the host may name another refusal for a
    // URL the Harness finds invalid, and an https xn-- host stays
    // unclassified, since IDNA alone decides whether the Harness takes it.
    // For an xn-- host the fixture records the verdict where the URL parser
    // keeps the label, which is how preflight reads it without IDNA.
    static boolean declaredApproximation(String expected,
            HarnessBrokerUrl.Verdict verdict, String url) {
        boolean idna = url.toLowerCase(Locale.ROOT).contains("xn--");
        return switch (verdict) {
            case NOT_ORIGIN -> expected.equals("invalid")
                    && !url.regionMatches(true, 0, "http", 0, 4);
            case UNCLASSIFIED -> idna && url.regionMatches(true, 0, "https:", 0, 6)
                    && expected.equals("accepted");
            case ACCEPTED, INVALID, PLAIN_OUTSIDE_LOOPBACK -> false;
        };
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve(
                    "packages/cli/src/serve/managed-runtime-broker-url.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("Broker URL fixtures not found");
    }
}
