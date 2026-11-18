package com.alibaba.acp.sdk.session.event.consumer;

import com.alibaba.acp.sdk.protocol.agent.request.ReadTextFileRequest;
import com.alibaba.acp.sdk.protocol.agent.request.ReadTextFileRequest.ReadTextFileRequestParams;
import com.alibaba.acp.sdk.session.event.consumer.exception.EventConsumeException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static com.alibaba.acp.sdk.protocol.jsonrpc.Error.ErrorCode.RESOURCE_NOT_FOUND;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FileEventSimpleConsumerTest {
    @TempDir
    Path temporary;

    private final FileEventSimpleConsumer consumer = new FileEventSimpleConsumer();

    @Test
    void returnsTextNewlinesForWholeFileReads() throws Exception {
        Path file = write("alpha\nbeta\n");

        assertEquals("alpha\nbeta\n", read(file, null, null));
    }

    @Test
    void returnsOnlyTheRequestedLineRange() throws Exception {
        Path file = write("alpha\nbeta\ngamma\n");

        assertEquals("beta\n", read(file, 2, 1));
    }

    @Test
    void keepsBlankLinesWhenNormalizingCrLfInput() throws Exception {
        Path file = write("alpha\r\n\r\nbeta\r\n");

        assertEquals("alpha\n\nbeta\n", read(file, null, null));
    }

    @Test
    void preservesTheConfiguredCharset() throws Exception {
        Path file = temporary.resolve("latin1.txt");
        Files.write(file, "caf\u00e9\n".getBytes(StandardCharsets.ISO_8859_1));
        consumer.setCharset(StandardCharsets.ISO_8859_1);

        assertEquals("caf\u00e9\n", read(file, null, null));
    }

    @Test
    void returnsAnEmptyStringForAnEmptyFile() throws Exception {
        assertEquals("", read(write(""), null, null));
    }

    @Test
    void retainsTheDefaultLineLimit() throws Exception {
        StringBuilder input = new StringBuilder();
        for (int line = 1; line <= 1001; line++) {
            input.append("line-").append(line).append('\n');
        }

        String result = read(write(input.toString()), null, null);

        assertTrue(result.contains("line-1000"));
        assertFalse(result.contains("line-1001"));
    }

    @Test
    void preservesTheMissingFileError() {
        Path missing = temporary.resolve("missing.txt");

        EventConsumeException failure = assertThrows(EventConsumeException.class, () -> read(missing, null, null));

        assertEquals(RESOURCE_NOT_FOUND.getCode(), failure.getError().getCode());
        assertEquals(missing.toString(), failure.getError().getData());
    }

    private Path write(String content) throws Exception {
        Path file = temporary.resolve("content.txt");
        Files.write(file, content.getBytes(StandardCharsets.UTF_8));
        return file;
    }

    private String read(Path file, Integer line, Integer limit) {
        ReadTextFileRequestParams params = new ReadTextFileRequestParams();
        params.setPath(file.toString());
        params.setLine(line);
        params.setLimit(limit);
        return consumer.onReadTextFileRequest(new ReadTextFileRequest(params)).getContent();
    }
}
