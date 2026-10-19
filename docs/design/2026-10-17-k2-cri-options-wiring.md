# K2 CRI runtime options wiring

[English](2026-10-17-k2-cri-options-wiring.md) | [简体中文](2026-10-17-k2-cri-options-wiring.zh-CN.md)

Status: implementation candidate for #13395 and Draft PR #13526.

## Problem

The previously generated handler selected the custom `io.containerd.qwen-k2.v1` runtime
type. In pinned upstream containerd v2.3.4, CRI chooses its options protobuf
from the runtime type, independently of `runtime_path`. A custom type produces
generic `runtimeoptions.v1.Options` with TOML ConfigBody, while the K2 Info,
bootstrap and Create consumers require the exact runc Options protobuf.
Handwritten runc protobuf fixtures and compilation miss this producer mismatch.

## Change

Keep the RuntimeClass and handler name `qwen-k2-runc-v1`. Select the builtin
`io.containerd.runc.v2` runtime type so CRI produces runc Options directly;
retain the literal `/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1` override and all
fixed BinaryName/Root/SystemdCgroup values. Both real container metadata readers
must expect the builtin Runtime.Name. Keep the custom shim manager's name:
it identifies the dedicated implementation, not CRI's options format.

The pinned upstream sandbox and worker launch paths both pass the configured
runtime path override to the task service, whose shim manager resolves that
path. This static trace is not a target daemon launch test. The builtin name
alone never proves the custom shim ran: preserve the original held creator,
actual executable path/hash, protected shim configuration, task boundaries,
birth pairing and exact original/consumed input checks. [Effective configuration checks](2026-10-17-k2-effective-runtime-config.md)
consume selected live handler settings including that override through the
original connection. Target compatibility and full installation qualification
remain unverified.

Update the renderer, both metadata readers, their existing expected fixtures,
and the complete bilingual birth/deployment documentation. Do not convert
generic options, relax the runc decoder, change the creation contract/source/7,
or rewrite saved metadata/history. New generator/binary identities need fresh
artifacts and qualification; old histories retain their original bytes.

## Verification and limits

Reproduce the mismatch with ordinary inert options data against the pinned
upstream producer before changing the implementation. Afterward verify the
exact handler's options type and fixed values, and statically trace both
metadata readers and the launch override. Compile actual Linux source/shim/
assembler for amd64/arm64 without executing outputs. Run root build/typecheck
and bundle, and two full increment self-audit passes.

The existing image renderer and runtime lifecycle suites are not rerun through
another executor. Ordinary protobuf data checks cannot establish actual CRI
launch, shim Info/bootstrap/Create compatibility on the target vendor build,
loaded policy, installation trust, physical release or safe volume reuse.
