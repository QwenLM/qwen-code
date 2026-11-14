# Reattach the original external Workspace worker

[English](managed-external-reattach.md) | [简体中文](managed-external-reattach.zh-CN.md)

## Problem and proposal

A provider restart can lose its process-local attachment while the persisted external Worker still exists. Observing UNKNOWN must not prove that the Worker is gone or cause a new generation to be provisioned. Resident external Workspaces may explicitly reattach the saved original, carrying its boot document, scope, provider handle and endpoint.

The client adds a reattach operation using the existing authenticated bounded HTTP transport. The generic external provisioner keeps reattachment disabled; only the resident Workspace profile enables it. Responses use the existing observation and ownership validation. A changed endpoint is refused, and the reattach path never enters provisioning.

## Compatibility and validation

This update extends the resident external Workspace proposal. Implementations of the external runtime client SPI must implement the added reattach method; a provider must support the corresponding endpoint before using resident reattachment. Scratch observations retain their existing failure semantics.

Review should cover UNKNOWN followed by READY on the identical endpoint, mismatched original evidence, refusal and timeout, and scratch behavior without reattachment. The retained HTTP, provisioner, boot and ownership regression sources require fresh public-head CI. No local runtime or test pass is claimed.
