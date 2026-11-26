# Hosted Harness transport for private services

[English](2026-11-26-hosted-harness-transport.md) | [简体中文](2026-11-26-hosted-harness-transport.zh-CN.md)

## Deployment

A control plane and a Hosted Harness in different Pods may share a private network operated by one team. With the default settings the Harness listens on loopback and uses HTTPS for a remote Runtime Broker. A plaintext Service deployment currently needs an inbound proxy to reach the Harness and an outbound proxy to give the Broker a loopback address. Operators who accept plaintext on this network should be able to connect the services directly. [Issue #18409](https://github.com/QwenLM/qwen-code/issues/18409)

## Startup arguments

| Process and connection          | Argument (default `true`)                         | Effect of `false`                                                                                                                          |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Node, inbound Harness listener  | `--hosted-harness-require-loopback`               | Bind the address explicitly chosen by `--hostname`, including a Pod IP or `0.0.0.0`. The default address remains `127.0.0.1`.              |
| Node, outbound Harness → Broker | `--managed-runtime-broker-require-tls`            | Accept a canonical remote HTTP Broker origin at startup and when a workspace tool calls it.                                                |
| Java, outbound MA → Harness     | `--qwen.managed-agent.harness.require-remote-tls` | Allow remote HTTP for the single Harness or a Harness pool member. Remote HTTPS pool members still use the configured mutual TLS identity. |

Each process reads its own arguments. The Node CLI accepts the literal values `true` and `false`. An unexpected non-loopback resolution of `localhost` remains a startup error. The Harness requires a configured bearer token and capability digest on every bind. HTTPS still authenticates certificates. A caller that selects remote HTTP accepts that the network between the workloads can read or change requests, including service credentials.

The bundled `managed-local` deployment requires loopback HTTP for all Harness endpoints, including pool members.

## Implementation and verification

The serve command passes both values to Hosted Harness profile validation. The Broker client consumes its setting again when constructing the actual tool request. Other clients that share the URL parser use its strict default. Java uses its Harness transport policy during startup, preflight and pool discovery. Java preflight can inspect a shared credentials file but cannot observe a remote Node process's arguments.

Run the packaged CLI with both arguments omitted, with each set to `false` independently, and with both set to `false`. Check that the default rejects a wildcard bind and a remote HTTP Broker, that an unauthenticated request is denied, and that a credentialed tool turn receives the Broker's result over HTTP. Exercise the Java application argument with single and pooled endpoints, including a pool member discovered after startup. [Deployment example](../../packages/managed-agent-server/README.md#private-service-connections)
