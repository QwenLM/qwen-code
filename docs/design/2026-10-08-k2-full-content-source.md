# K2: one admitted source for a complete file read

[English](2026-10-08-k2-full-content-source.md) | [简体中文](2026-10-08-k2-full-content-source.zh-CN.md)

Status: ordinary-source component implemented and locally verified, 2026-10-08.
Baseline
`0b15333a1390ed4ce723aa8f7175422cac955425` in
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526).
This component extends the
[native file execution design](2026-10-07-k2-native-file-execution.md).
It does not enable private file admission or qualify complete K2.

## 1. Problem and current behavior

`read_file` first stats a pathname, then separately classifies and reads it.
Text, SVG, notebook, image, audio, video and native PDF consumers can reopen
that pathname. PDF page counting, text extraction and image rendering also
receive the pathname. A file replaced after admission can therefore supply
different metadata, classification and content. The existing bounded text
handle option forces text classification and cannot serve all formats.

The mount owner now joins admitted observations, but the actual file tool does
not yet borrow that owner. This component supplies a real complete-read
consumer and an ordinary producer before implementing the private backend.
All existing private worker and public selector refusals remain.

## 2. Producer and ownership

Add an internal callback operation to `FileSystemService`. Its request contains
the logical path, cancellation signal and required media delivery choice
(`inline` or `omni`). The actual ReadFile invocation supplies that choice from
its Config and enters this operation before cache lookup or other file I/O.
The callback covers classification, content processing, PDF vision bridge,
cache bookkeeping, memory freshness and final ToolResult construction.

The source is a closed discriminated union of a pathname and a borrowed
descriptor with metadata captured from that descriptor. Standard filesystem
is the actual producer of both branches: Omni and platforms other than Linux
or Darwin use the existing pathname pipeline. For inline reads on Linux and
Darwin it opens one nonblocking read descriptor, stats it and retains it until
the complete callback finishes. Every exit closes the
owned descriptor once. Acquisition errors preserve normal in-band file errors;
an owner or close failure remains observable and is never a retry by pathname.
The caller invalidates cached read rights if owner completion fails or a late
cancellation prevents the result from returning.

ACP does not implement this callback operation. Its existing text delegation
and capability fallback remain on the existing pipeline. Do not inherit a
Standard producer into ACP or bypass an installed producer based on Config.

The later private Linux backend must produce only the descriptor branch and
reject Omni before file I/O. It must retain original mount admission around
the whole callback and permanently block its owner on identity uncertainty.
This component's Standard descriptor is not a private mount authority.

## 3. Classification, bytes and text

The logical path continues to determine extension, MIME, display and telemetry.
Descriptor metadata determines type/size and cache identity. Image and unknown
binary sniffing use positional samples from that descriptor. Descriptor errors
must not silently become successful extension-only classification.

All descriptor byte reads use explicit positions, handle short reads, check
cancellation and stop at the captured size. Growth does not expand the read.
Preserve existing SVG, media, base64, PDF and image-decoder ceilings. No input
copy into a temporary pathname is allowed.

Keeping one inode is not an immutable snapshot of same-inode concurrent writes.
Captured extent limits the parent byte/text readers; it is not an enforced
input-length bound on the inherited native helper descriptor. Private backend
writer exclusion and helper qualification remain separate gates.

For small text, reuse the existing complete-buffer encoding decoder and range
selection, preserving BOM, UTF-16/32, GBK, line endings and exact line count.
Large text uses the existing positional UTF-8 scanner. Do not change the
separate security-boundary streaming reader's scan-budget contract. Never
reopen the pathname to recover line counts or freshness metadata.

Notebook formatting gains an actual string-input consumer. Image overview
gains an actual Buffer-input consumer using the same preparation and rendering
logic as its pathname entry. Raw image/GIF, audio/video and native PDF base64
use the same borrowed source. The existing pathname entries remain available
to their other callers.

## 4. PDF helper lifetime

PDF utilities continue accepting string sources for their real legacy callers,
including web fetch. Descriptor calls pass the original descriptor through
child stdio and address the child's own fd path: `/proc/self/fd/3` on Linux or
`/dev/fd/3` on Darwin. Windows descriptor calls refuse; they do not fall back.
Parent-fd paths and copied input files are excluded. Both classification and
parent byte reads remain positional; repeated real Poppler calls must verify
seek behavior because duplicated descriptors can share an offset.

The descriptor runner retains its ChildProcess, bounds stdout/stderr, owns
availability probes, and joins the actual `close` event after success, error,
abort, timeout or output overflow. Capturing an exit code or callback alone is
not the join. Cancellation reaches page count, extraction and rendering.
Rendered output remains in a uniquely owned temporary directory, and output
read/cleanup completes before the callback returns. Descriptor output retains
the directory fd and verifies its named identity around consumption and cleanup.
Linux opens leaves relative to that fd; Darwin uses the owned temporary name
with identity checks. Leaves refuse symlinks and nonregular files. Uncertain
directory ownership or cleanup failure is observable. These ordinary temporary
directory checks are not a qualified private scratch owner or an atomic
pathname-cleanup guarantee.

These choices follow the documented [Node 22 child stdio and close behavior](https://nodejs.org/download/release/v22.14.0/docs/api/child_process.html)
and [Linux fd paths](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html).
Direct child close does not prove descendant termination, CSI NodeUnpublish or
safe volume reuse. The private backend must qualify helper families and owned
temporary-output cleanup, including sticky blockers, before admitting PDF.

## 5. Affected components and validation

The affected layers are FileSystemService and ReadFile invocation; file type,
byte and text utilities; notebook and image input adapters; PDF helpers; and
their collocated tests. Existing read-many-files bounded text handling remains
a separate consumer with its original security contract.

Validation replaces a pathname after opening and checks the original content
and metadata across all formats. It covers encoding/ranges, short reads,
growth, cancellation, acquisition/close errors, PDF inherited fd and delayed
close, output limits and cleanup. Regression checks cover ACP, ordinary Omni,
Windows pathname selection, unchanged text errors and private entry refusals.
Use the global CLI baseline first, then independent script verification where
deterministic admission races cannot be driven through a model prompt.

Build, typecheck, bundle, focused package tests, two full self-audits and native
review remain required. Real Linux/CSI/Poppler coverage must be reported
separately from Darwin fixtures or controlled helper programs.

Independent local verification completed 40 bounded built-entry observations:
28 content/source/lifecycle/compatibility groups and 12 real inherited-fd,
child-close and output-ownership groups. It observed actual child PIDs and
owned descriptors and cleaned them before releasing the frozen inputs. Media
forwarding, controlled transport/platform/error adapters and controlled helper
programs are identified separately. The 21-observation baseline retains its
four utility/assertion failures and corrected reruns; it is not 21 passing
product scenarios. These reports do not qualify real Poppler, Linux/CSI or K2.
The required native review cannot dispatch its generated workflow on this
host; no independent review verdict or approval is claimed.

## 6. Acceptance and remaining K2 work

This component is accepted only when the actual ReadFile caller uses the real
producer and all descriptor consumers preserve original bytes until joined
completion without pathname recovery. Both languages must record matching
implementation and verification status. No optional seam with no caller counts
as completion.

The private directory-fd backend, retained raw file history, closed three-tool
factory, SQL/native/Hosted chain, complete writer census and drain, physical
writer/descendant termination, per-target NodeUnpublish, atomic RELEASED and
safe handoff remain required by the parent design. Public selection and fresh
full cloud acceptance remain closed. This source component alone cannot
satisfy those gates.
