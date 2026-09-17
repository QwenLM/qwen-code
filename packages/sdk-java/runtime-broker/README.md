# Qwen Managed Runtime Broker

This module is the Java control-plane half of the Hosted Harness architecture.
It is embedded in the Java product service rather than deployed as a mandatory
standalone service.

The module provides:

- authenticated Harness Session scope resolution;
- asynchronous Runtime warmup and compatible Runtime reuse;
- Runtime Session acquisition and release;
- an in-memory execution ledger with at-most-once dispatch per idempotency key;
- a static provisioner for externally managed Runtime endpoints;
- a local-process provisioner with file boot, active health, idle reclaim,
  epoch fencing, and owned process-tree shutdown;
- the private `/internal/runtime-broker/v1` HTTP contract used by
  `qwen serve --profile hosted-harness`;
- an HTTP transport for the existing Managed Runtime v1/v2 worker protocol.

The in-memory stores are the first implementation slice. Production deployment
must replace them with durable repositories before restart recovery is enabled.
