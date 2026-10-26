package com.alibaba.qwen.code.managedagent.preflight;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HarnessBrokerUrlTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    // The expected verdicts are what the Harness's own reader returns
    // (managed-runtime-broker-url.test.ts runs the same cases).
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
                "https://xn--a:8443", "http://127.0.0.1:4182/?x"}) {
            assertEquals(HarnessBrokerUrl.Verdict.UNCLASSIFIED,
                    HarnessBrokerUrl.read(url).verdict(), url);
        }
    }

    @Test
    void refusesAnXnHostEndingInANumberWithoutIdna() {
        // IDNA keeps the label or refuses the URL, so the IPv4 parser always
        // fails on it; the fixture's approximation would also take a WARN.
        assertEquals(HarnessBrokerUrl.Verdict.INVALID,
                HarnessBrokerUrl.read("https://xn--bcher-kva.1:8443").verdict());
    }

    // The two exceptions HarnessBrokerUrl documents, and only those: a
    // scheme or path read before the host, or an xn-- host read without
    // IDNA, may name another refusal for a URL the Harness finds invalid,
    // and an https xn-- host stays unclassified whatever the Harness says.
    private static boolean declaredApproximation(String expected,
            HarnessBrokerUrl.Verdict verdict, String url) {
        boolean idna = url.toLowerCase(Locale.ROOT).contains("xn--");
        return switch (verdict) {
            case NOT_ORIGIN -> expected.equals("invalid");
            case PLAIN_OUTSIDE_LOOPBACK -> idna && expected.equals("invalid");
            case UNCLASSIFIED -> idna && url.regionMatches(true, 0, "https:", 0, 6)
                    && (expected.equals("accepted") || expected.equals("invalid"));
            case ACCEPTED, INVALID -> false;
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
