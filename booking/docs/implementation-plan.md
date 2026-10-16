# Implementation plan (initial response)

This is the planning response produced before application code was written. It is kept for traceability; where the built system differs, `architecture.md` and `assumptions.md` are authoritative.

## 0. Repository assessment

The repository (`agents-in-sdlc`) is GitHub's _Copilot Workshops_ content repo: Markdown lessons under `docs/`, an Astro/Starlight site under `website/`, `.github/` skills/agents and a Pages workflow. It contained no booking code. Because `docs/` is the _content source of the published workshop site_, nothing was added there. The system lives in the new, self-contained `booking/` directory (own `package.json`, docs, CI workflow `.github/workflows/booking-ci.yml`). No existing file was modified or overwritten.

## 1. Understanding of the problem

Schedules live in several unsynchronised places (the manager's sheet, each masseuse's memory and chats, WhatsApp threads). Nothing atomically decides "this masseuse is taken at this time", so double promises, missed assignments, unrecorded replacements and untrustworthy hours follow. The fix is one transactional authority (PostgreSQL) behind one booking engine used by every channel.

## 2. MVP scope

As listed in the brief (§15). Deferred: payments, loyalty, packages, commissions, AI chatbot, native apps, marketing automation, BI, accounting integration. The schema leaves room (`services.price_myr`, extensible `source`, generic `resources`, `application_settings`).

## 3–4. Architecture and diagram

See `architecture.md`.

## 5. Entities

See `data-model.md`.

## 6. Conflict prevention

Exclusion constraints on `appointment_assignments(staff_id, occupied)` and `appointments(room_id, occupied)`, slot holds as real rows in the same exclusion domain, per-staff advisory locks for leave/hours triggers, idempotency keys. See ADR-0002.

## 7–8. WhatsApp and replacement design

See `whatsapp-integration.md` and `architecture.md` §Replacement.

## 9. Security and privacy risks

See `privacy-security-checklist.md`.

## 10. Cost comparison

See `cost-comparison.md`.

## 11. Milestones

M1 foundation → M2 booking engine + concurrency tests → M3 UI → M4 WhatsApp → M5 replacement + KPI → M6 hardening + docs. Each milestone was committed separately.

## 12. Assumptions and decisions needing business input

See `assumptions.md` (the "Needs your decision" section).
