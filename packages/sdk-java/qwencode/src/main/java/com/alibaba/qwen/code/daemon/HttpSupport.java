package com.alibaba.qwen.code.daemon;

import java.io.ByteArrayOutputStream;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

final class HttpSupport {
    static final int MAXIMUM_ERROR_BYTES = 64 * 1024;
    static final int MAXIMUM_JSON_BYTES = 1024 * 1024;

    private HttpSupport() {
    }

    static HttpResponse.BodyHandler<Body> bodyHandler() {
        return responseInfo -> {
            boolean success = responseInfo.statusCode() >= 200
                    && responseInfo.statusCode() < 300;
            return new BoundedBodySubscriber(
                    success ? MAXIMUM_JSON_BYTES : MAXIMUM_ERROR_BYTES);
        };
    }

    static Response consume(HttpResponse<Body> response, String operation) {
        boolean success = response.statusCode() >= 200
                && response.statusCode() < 300;
        List<String> contentEncodings = response.headers()
                .allValues("Content-Encoding");
        if (contentEncodings.size() > 1
                || (contentEncodings.size() == 1
                        && !"identity".equalsIgnoreCase(
                                contentEncodings.get(0).trim()))) {
            String diagnostic = operation
                    + " response used unsupported Content-Encoding: "
                    + String.join(", ", contentEncodings);
            if (!success) {
                return new Response(response.statusCode(),
                        "Response body unavailable: " + diagnostic);
            }
            throw new DaemonProtocolException(
                    diagnostic);
        }
        Body body = response.body();
        byte[] bytes = body.getBytes();
        if (body.isOverflow()) {
            if (success) {
                throw new DaemonProtocolException("JSON response exceeds "
                        + MAXIMUM_JSON_BYTES + " bytes");
            }
            bytes = appendTruncationSuffix(bytes);
        }
        return new Response(response.statusCode(),
                success ? decode(bytes, operation + " response")
                        : decodeError(bytes));
    }

    static String readError(java.io.InputStream input,
            String operation) {
        try {
            byte[] bytes = input.readNBytes(MAXIMUM_ERROR_BYTES + 1);
            if (bytes.length > MAXIMUM_ERROR_BYTES) {
                byte[] prefix = new byte[MAXIMUM_ERROR_BYTES];
                System.arraycopy(bytes, 0, prefix, 0, prefix.length);
                bytes = appendTruncationSuffix(prefix);
            }
            return decodeError(bytes);
        } catch (java.io.IOException e) {
            throw new DaemonTransportException(operation
                    + " response body could not be read", e);
        }
    }

    private static byte[] appendTruncationSuffix(byte[] bytes) {
        byte[] suffix = "... (truncated)".getBytes(StandardCharsets.UTF_8);
        int prefixLength = Math.max(0, MAXIMUM_ERROR_BYTES - suffix.length);
        prefixLength = Math.min(prefixLength, bytes.length);
        byte[] result = new byte[prefixLength + suffix.length];
        System.arraycopy(bytes, 0, result, 0, prefixLength);
        System.arraycopy(suffix, 0, result, prefixLength, suffix.length);
        return result;
    }

    private static String decode(byte[] bytes, String context) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new DaemonProtocolException(context + " contains invalid UTF-8", e);
        }
    }

    private static String decodeError(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }

    static final class Body {
        private final byte[] bytes;
        private final boolean overflow;

        Body(byte[] bytes, boolean overflow) {
            this.bytes = bytes;
            this.overflow = overflow;
        }

        byte[] getBytes() {
            return bytes;
        }

        boolean isOverflow() {
            return overflow;
        }
    }

    private static final class BoundedBodySubscriber
            implements HttpResponse.BodySubscriber<Body> {
        private final int limit;
        private final ByteArrayOutputStream output = new ByteArrayOutputStream();
        private final CompletableFuture<Body> body = new CompletableFuture<>();
        private Flow.Subscription subscription;

        BoundedBodySubscriber(int limit) {
            this.limit = limit;
        }

        @Override
        public CompletionStage<Body> getBody() {
            return body;
        }

        @Override
        public void onSubscribe(Flow.Subscription newSubscription) {
            if (subscription != null) {
                newSubscription.cancel();
                return;
            }
            subscription = newSubscription;
            newSubscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            if (body.isDone()) {
                return;
            }
            for (ByteBuffer buffer : buffers) {
                int remainingCapacity = limit - output.size();
                if (buffer.remaining() > remainingCapacity) {
                    copy(buffer, remainingCapacity);
                    subscription.cancel();
                    body.complete(new Body(output.toByteArray(), true));
                    return;
                }
                copy(buffer, buffer.remaining());
            }
        }

        @Override
        public void onError(Throwable throwable) {
            body.completeExceptionally(throwable);
        }

        @Override
        public void onComplete() {
            body.complete(new Body(output.toByteArray(), false));
        }

        private void copy(ByteBuffer buffer, int count) {
            if (count <= 0) {
                return;
            }
            byte[] bytes = new byte[count];
            buffer.get(bytes);
            output.write(bytes, 0, bytes.length);
        }
    }

    static final class Response {
        private final int statusCode;
        private final String body;

        Response(int statusCode, String body) {
            this.statusCode = statusCode;
            this.body = body;
        }

        int getStatusCode() {
            return statusCode;
        }

        String getBody() {
            return body;
        }

        boolean isSuccess() {
            return statusCode >= 200 && statusCode < 300;
        }
    }
}
