package com.alibaba.qwen.code.daemon;

/**
 * A lifecycle settle that the Hosted Harness answered but Java could not
 * process — the response body failed to decode, or the receipt's identity
 * did not match the request. The settle DID reach the Harness, so callers
 * must not treat a later failure of the same attempt as "the settle never
 * happened". Distinct from the pre-send protocol refusal, which throws
 * {@link DaemonProtocolException} before any request left the process.
 */
public class HostedHarnessSettleAnsweredException extends DaemonException {
    public HostedHarnessSettleAnsweredException(String message,
            Throwable cause) {
        super(message, cause);
    }
}
