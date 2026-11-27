# Python control request cleanup

## Baseline

Issue #17494 records the unchanged SDK retaining 16 cancelled requests and their timers, and a failed write later emitting an unhandled timeout warning. The required official CLI attempt timed out during initialization before the target scenario. Further official CLI execution was blocked by automatic approval review, so verification uses the existing local protocol fixture, without CLI execution or network access.

## Behaviors to verify

1. Initialize a query, send multiple independent control requests, and cancel all but one. Each abandoned request releases its timer and future immediately; the remaining request still receives its matching response. Late replies for abandoned requests are ignored.
2. Fail a control write or its drain. The caller receives the original failure, the query remains usable, and no abandoned request later emits an unhandled timeout warning.
3. Cancel a call while its drain is pending. Cleanup must also release the future that the caller has not started awaiting.
4. Let a control timeout expire during a blocked drain, then fail that drain. The original write failure still reaches the caller without an additional unhandled future exception.
5. Existing success, protocol cancellation, timeout, initialization and query-close tests retain their behavior.

## Validation boundary

These tests control protocol timing with the repository's local transport fixture. They establish SDK lifecycle behavior; they do not claim authenticated model or live CLI coverage.
