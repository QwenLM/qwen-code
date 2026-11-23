# On-demand PDF previews in Web Shell

[English](web-shell-pdf-range-preview.md) | [简体中文](web-shell-pdf-range-preview.zh-CN.md)

## Problem

On `main` at `ac4ae44c`, opening a workspace PDF waits for the full file to
be read into a Blob before passing it to the browser's PDF viewer. A 20 MiB
file needs 80 sequential 256 KiB byte reads and two metadata requests. The
first visible page therefore depends on the last byte arriving.

## Design

- The Web Shell artifact panel selects an on-demand preview for workspace PDFs
  from 4 MiB through 100 MiB. Small workspace PDFs and PDF attachments use the
  native viewer. The 100 MiB ceiling is the existing workspace preview limit.
- The on-demand viewer loads the PDF.js legacy build and its worker when
  opened to support Web Shell's browser version range. It loads the JBIG2 and
  OpenJPEG decoders when the document uses those image formats. It reads the
  file size from `stat`, lets PDF.js request the ranges it needs, and uses
  `readFileBytes` with at most 256 KiB per call. Background prefetch is
  disabled. The amount needed for the first page depends on the PDF's layout.
- The existing authenticated, workspace-scoped actions perform every read.
  The viewer checks the returned offset and byte count, and uses the file size
  and modification time to detect changes. Switching files or closing the
  preview disposes of the document and ignores late results.
- The preview renders one page at a time on a canvas and reads more data when
  the user navigates to a page that needs it. Users can open the full native
  preview for search, printing, or documents that require external CMaps or
  other resources. The full viewer also offers the original file for download.

The artifact panel and the lazy PDF.js viewer are implemented in
`packages/web-shell`. Both preview paths use the existing daemon file API.

## Acceptance

- Open the same 20 MiB PDF from Files in a browser connected to a real daemon.
  Compare the production Web Shell from `ac4ae44c` and the candidate with the
  same browser, fixture and network conditions. Report click-to-first-page
  time, PDF bytes and HTTP response bytes received at that point.
- Confirm actual first-page content is visible while bytes used only by
  later pages are withheld. Opening a later page should fetch the ranges it
  needs and display that page when the data is released.
- Check small workspace PDFs, attachments, the full preview and download.
  Exercise a changed file and a closed preview with a read pending.
