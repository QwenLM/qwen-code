# Collapsed Home hover popover

[English](web-shell-home-hover-popover.md) | [简体中文](web-shell-home-hover-popover.zh-CN.md)

## Problem and scope

The collapsed navigation rail only labels Home on hover. Users need access to the complete expanded Home content without permanently expanding the sidebar. Expanded sidebars retain the existing Home text tooltip, including while another page is open. Home-only layouts and compact drawers retain their existing behavior.

## Proposed behavior

Reuse the existing sidebar hover surface and shared portal-aware Popover for the complete Home column: branding, New task, custom navigation, projects and sessions, and custom footer. Position it to the right of Home, leaving an 8 px gap from the rail, with the saved secondary-column width and a viewport-constrained height. Keep the shared Popover outline without adding a second border. Render one Home tree at a time. Moving between inline and portal presentation can remount child components, as the existing collapsed session surface already does; parent-owned search and session state remain shared.

Hover uses a temporary Home presentation even when Channels or Live is selected. It must not navigate, persist expansion, create a session, or change the composer draft. Clicking Home keeps the current navigation and expansion behavior. Leaving both trigger and content closes after the existing grace period; focus and nested menus keep the surface usable. Escape and outside interaction dismiss it. Layout, page and collapse changes clear the preview.

## Implementation and decisions

Only Web Shell sidebar presentation, styles, and tests change. Extend the internal sidebar hover surface to accept the existing external Home anchor and complete-column presentation, reusing its focus, nested-overlay and dismissal handling. Preserve the portal container and React 18-compatible refs. No daemon routes, package APIs, dependencies, or other navigation previews are added.

## Validation and acceptance

Focused sidebar unit tests cover collapsed preview, unchanged expanded tooltip, complete content, navigation/collapse preservation and cleanup. Browser E2E covers pointer travel, search and menus, dismissal, draft retention, Home/Channels/Live presentation, custom content, compact-layout regression, and dark/light screenshots with a mock daemon. Screenshots demonstrate UI only, not real Git/backend operations. Run repository build, typecheck and bundle plus focused tests. The global CLI baseline is attempted first; use the browser harness if the installed CLI cannot serve this source UI. No open design questions remain.
