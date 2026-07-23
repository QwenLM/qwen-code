package com.alibaba.qwen.code.daemon;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

final class SseReader {
    private final BufferedInputStream input;
    private final int maximumFrameBytes;
    private Long retryMillis;

    SseReader(InputStream input, int maximumFrameBytes, Runnable activity) {
        this.input = new BufferedInputStream(new ActivityInputStream(input, activity));
        this.maximumFrameBytes = maximumFrameBytes;
    }

    Frame next() throws IOException {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        String event = null;
        Long id = null;
        boolean hasData = false;
        int frameBytes = 0;
        while (true) {
            byte[] line = readLine();
            if (line == null) {
                return null;
            }
            frameBytes += line.length + 1;
            if (frameBytes > maximumFrameBytes) {
                throw new DaemonProtocolException("SSE frame exceeds "
                        + maximumFrameBytes + " bytes");
            }
            String decoded = decode(line);
            if (decoded.isEmpty()) {
                if (!hasData) {
                    event = null;
                    id = null;
                    frameBytes = 0;
                    continue;
                }
                String payload = decode(data.toByteArray());
                if (payload.endsWith("\n")) {
                    payload = payload.substring(0, payload.length() - 1);
                }
                return new Frame(event, id, payload);
            }
            if (decoded.charAt(0) == ':') {
                continue;
            }
            int colon = decoded.indexOf(':');
            String field = colon < 0 ? decoded : decoded.substring(0, colon);
            String value = colon < 0 ? "" : decoded.substring(colon + 1);
            if (value.startsWith(" ")) {
                value = value.substring(1);
            }
            switch (field) {
                case "data":
                    if (hasData) {
                        data.write('\n');
                    }
                    data.write(value.getBytes(StandardCharsets.UTF_8));
                    hasData = true;
                    break;
                case "event":
                    if (value.isEmpty()) {
                        throw new DaemonProtocolException("SSE event name must not be empty");
                    }
                    event = value;
                    break;
                case "id":
                    id = parseId(value);
                    break;
                case "retry":
                    Long parsedRetry = parseRetry(value);
                    if (parsedRetry != null) {
                        retryMillis = parsedRetry;
                    }
                    break;
                default:
                    break;
            }
        }
    }

    private static final class ActivityInputStream extends FilterInputStream {
        private final Runnable activity;

        ActivityInputStream(InputStream input, Runnable activity) {
            super(input);
            this.activity = activity;
        }

        @Override
        public int read() throws IOException {
            int result = super.read();
            if (result >= 0) {
                activity.run();
            }
            return result;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) throws IOException {
            int result = super.read(bytes, offset, length);
            if (result > 0) {
                activity.run();
            }
            return result;
        }
    }

    private byte[] readLine() throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        while (true) {
            int next = input.read();
            if (next < 0) {
                return null;
            }
            if (next == '\n') {
                byte[] bytes = line.toByteArray();
                if (bytes.length > 0 && bytes[bytes.length - 1] == '\r') {
                    byte[] withoutCarriageReturn = new byte[bytes.length - 1];
                    System.arraycopy(bytes, 0, withoutCarriageReturn, 0,
                            withoutCarriageReturn.length);
                    return withoutCarriageReturn;
                }
                return bytes;
            }
            line.write(next);
            if (line.size() > maximumFrameBytes) {
                throw new DaemonProtocolException("SSE line exceeds "
                        + maximumFrameBytes + " bytes");
            }
        }
    }

    private static String decode(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new DaemonProtocolException("SSE contains invalid UTF-8", e);
        }
    }

    private static Long parseId(String value) {
        if (value.isEmpty() || !value.chars().allMatch(Character::isDigit)) {
            throw new DaemonProtocolException("SSE id must be a positive integer");
        }
        try {
            long id = Long.parseLong(value);
            if (id <= 0) {
                throw new DaemonProtocolException("SSE id must be positive");
            }
            return id;
        } catch (NumberFormatException e) {
            throw new DaemonProtocolException("SSE id is outside the long range", e);
        }
    }

    Long getRetryMillis() {
        return retryMillis;
    }

    private static Long parseRetry(String value) {
        if (value.isEmpty()) {
            return null;
        }
        if (!value.chars().allMatch(Character::isDigit)) {
            throw new DaemonProtocolException("SSE retry must be a non-negative integer");
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            throw new DaemonProtocolException("SSE retry is outside the long range", e);
        }
    }

    static final class Frame {
        private final String event;
        private final Long id;
        private final String data;

        Frame(String event, Long id, String data) {
            this.event = event;
            this.id = id;
            this.data = data;
        }

        String getEvent() {
            return event;
        }

        Long getId() {
            return id;
        }

        String getData() {
            return data;
        }
    }
}
