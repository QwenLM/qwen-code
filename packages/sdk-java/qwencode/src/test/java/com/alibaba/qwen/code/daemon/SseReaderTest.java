package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class SseReaderTest {

    @Test
    void parsesCrLfCommentsAndMultiLineData() throws Exception {
        String input = ": heartbeat\r\n\r\nid: 7\r\nevent: update\r\n"
                + "data: {\"first\":\r\ndata: true}\r\n\r\n";
        AtomicInteger activity = new AtomicInteger();
        SseReader reader = new SseReader(new ByteArrayInputStream(
                input.getBytes(StandardCharsets.UTF_8)), 1024,
                activity::incrementAndGet);

        SseReader.Frame frame = reader.next();
        assertEquals(7L, frame.getId());
        assertEquals("update", frame.getEvent());
        assertEquals("{\"first\":\ntrue}", frame.getData());
        assertNull(reader.next());
        assertEquals(1, activity.get());
    }

    @Test
    void parsesBareCarriageReturnLineEndings() throws Exception {
        String input = "id: 7\revent: update\rdata: {}\r\r";
        SseReader reader = new SseReader(new ByteArrayInputStream(
                input.getBytes(StandardCharsets.UTF_8)), 1024, () -> {
                });

        SseReader.Frame frame = reader.next();
        assertEquals(7L, frame.getId());
        assertEquals("update", frame.getEvent());
        assertEquals("{}", frame.getData());
    }

    @Test
    void ignoresLeadingUtf8Bom() throws Exception {
        String input = "\uFEFFid: 7\ndata: {}\n\n";
        SseReader reader = new SseReader(new ByteArrayInputStream(
                input.getBytes(StandardCharsets.UTF_8)), 1024, () -> {
                });

        assertEquals(7L, reader.next().getId());
    }

    @Test
    void rejectsMalformedUtf8() {
        byte[] invalid = new byte[] {'d', 'a', 't', 'a', ':', ' ', (byte) 0xC3,
                (byte) 0x28, '\n', '\n'};
        SseReader reader = new SseReader(new ByteArrayInputStream(invalid),
                1024, () -> { });
        assertThrows(DaemonProtocolException.class, reader::next);
    }

    @Test
    void rejectsUnicodeDigitsInIdAndRetry() {
        for (String input : new String[] {
                "id: \u0661\ndata: {}\n\n",
                "retry: \u0661\n\nid: 1\ndata: {}\n\n"
        }) {
            SseReader reader = new SseReader(new ByteArrayInputStream(
                    input.getBytes(StandardCharsets.UTF_8)), 1024, () -> {
                    });
            assertThrows(DaemonProtocolException.class, reader::next);
        }
    }

    @Test
    void rejectsOversizedFrame() {
        String input = "data: " + "x".repeat(1024) + "\n\n";
        SseReader reader = new SseReader(new ByteArrayInputStream(
                input.getBytes(StandardCharsets.UTF_8)), 128, () -> { });
        assertThrows(DaemonProtocolException.class, reader::next);
    }

    @Test
    void countsBothBytesOfCrLfTowardFrameLimit() {
        SseReader reader = new SseReader(new ByteArrayInputStream(
                "data: x\r\n\r\n".getBytes(StandardCharsets.UTF_8)),
                10, () -> {
                });
        assertThrows(DaemonProtocolException.class, reader::next);
    }

    @Test
    void retainsRetryDirectiveAcrossRetryOnlyFrame() throws Exception {
        SseReader reader = new SseReader(new ByteArrayInputStream(
                "retry: 3000\n\nid: 1\ndata: {}\n\n"
                        .getBytes(StandardCharsets.UTF_8)), 1024, () -> {
                        });

        assertEquals(1L, reader.next().getId());
        assertEquals(3000L, reader.getRetryMillis());
    }
}
