# Headless usage statistics notice

[English](2026-11-12-headless-usage-statistics-notice.md) | [简体中文](2026-11-12-headless-usage-statistics-notice.zh-CN.md)

## Problem

Usage statistics are on by default. Interactive sessions disclose them through the privacy notice linked from the auth dialog, but a headless `qwen -p` run renders no dialog, so it uploads usage statistics without any disclosure. No CLI output names the collection host. This gap was confirmed in #17052.

## Decision

At the start of a headless run, right after the session initialization system message, show a one-time notice that names the usage statistics host (`USAGE_STATS_HOSTNAME`, now shared from the core telemetry constants), states that events carry a random per-install ID (the stable pseudonym derived from the local installation ID) while prompts, code, and file contents are not collected, gives the environment-variable and settings opt-outs, notes that opting out also stops the models.dev catalog refresh, and links to the privacy notice.

Follow the existing headless notice convention: in text mode, write the notice to stderr so stdout stays clean for scripts; in JSON and stream-JSON modes, emit a system message with subtype `usage_statistics_notice` and `data.notice`. Skipping JSON modes would hide the disclosure in exactly the automated runs that need it, and consumers that ignore unknown system subtypes are unaffected.

Show it only to users relying on the default: skip it when usage statistics are disabled, or when `QWEN_USAGE_STATISTICS_ENABLED` or `privacy.usageStatisticsEnabled` is set to any value, because an explicit opt-in is already an informed choice. Record that it was shown in `~/.qwen/usage-statistics-notice-shown`, next to the installation ID. A marker that cannot be read or written never suppresses the notice; it is shown again next run. Within one process it is shown at most once, so persistent stream-JSON sessions that run several turns do not repeat it.

## Scope and risks

The notice discloses; it does not ask for consent and does not change what is collected. The models.dev refresh starts during config initialization, slightly before the notice prints; usage statistics are buffered and uploaded on an interval or at exit, after it. Interactive mode is unchanged. Ephemeral environments with an empty home directory see the notice on every run, which is intended, because each is a fresh installation. The text is English-only, like other headless stderr notices.

## Verification

Unit tests cover showing once and writing the marker, once-per-process behavior, skipping when disabled or explicitly configured through either the environment variable or the setting, and showing again when the marker cannot be written. Headless tests cover stderr output in text mode, and a `usage_statistics_notice` system message after `init` in JSON and stream-JSON modes.
