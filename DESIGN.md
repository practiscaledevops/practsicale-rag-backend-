---
version: alpha
name: PractiScale Brain
description: An operational knowledge back office aligned with the PractiScale assistant.
colors:
  background: "#FFFFFF"
  foreground: "#111315"
  accent: "#10A388"
  accentText: "#0A7C6A"
  accentSoft: "#E6F7F1"
  navigation: "#161616"
  border: "#EAECEC"
typography:
  sans:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
omitted:
  - section: spacing
    reason: Existing Tailwind utilities and shared component geometry remain authoritative.
  - section: rounded
    reason: Existing shared Button, Table, Input and Dialog primitives own their geometry.
---

# PractiScale Brain design context

## Overview
This is a working knowledge console for PractiScale administrators. Its purpose is to inspect, correct and trace the company's evidence. Preserve the existing white workspace, dark navigation rail, green state accents and dense readable tables. The assistant and back office share this identity. Reliability and legible evidence take priority over decorative changes.

The interface is English and uses the business time zone Asia/Karachi unless a user supplies another supported zone. Date-only call dates remain calendar dates; import timestamps are separate. No Japan-specific product behavior is in scope.

## Runtime ownership
`src/app/globals.css` is the canonical token source; `tailwind.config.ts` maps it to utilities. This document records existing intent, not a second generated token system. Color changes belong in that shared source, never in page-local literals. Inter is the existing application font. The task introduces no new colors, typefaces, or motion.

## Layout and components
Use the existing PageHeader, Button, SearchInput, FilterTabs, TableCard/Table, Alert, EmptyState, Bulk and ConfirmDialog primitives. Tables scroll within their card on narrow screens; controls wrap and remain reachable. Preserve native table semantics and visible keyboard focus.

## Interaction and content
Search and page controls must state their actual scope. A page count is not a complete database count. Preserve filters in navigation, distinguish no matches from load failure, and provide a retry. Use short action labels and explicit busy states. A live badge only describes successful checks; it must not imply missing records are zero.

## Verification
Typecheck, lint, regression tests and production builds accompany changes. Verify document paging, a search beyond the former row cutoff, clear-search, no results, and narrow-screen scrolling in the browser. The behavioral owners are documented in `UX-CONTRACT.md`.
