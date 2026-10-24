# Systems engineering

This folder covers **what** the product must do, **for whom**, and **how we know** it does it.
GitHub Issues cover **who is doing what**. The two are linked by ids and never by copying text.

Status: **draft, not baselined.** Written by Claude on 2026-10-24 and pending review by Clemente
and Ramón (#11).

## Trace chain

| Level | Id | Answers | File |
|---|---|---|---|
| Stakeholder | S- | Who | `stakeholders.md` |
| Need | N- | What they need | `stakeholders.md` |
| System requirement | SYS- | What the system shall do | `requirements.md` |
| Allocation | web, ingest, regs, checks, db, ops | Which part builds it | `requirements.md` |
| Interface | IF- | Where two parts meet | `interfaces.md` |
| Work | #n | Who is doing it, and its status | GitHub Issues |
| Verification | V- | How we know, with evidence | `verification.md` |

Certivity's own required elements are **CR1–CR4**. We never use `R-` or `R1` for our ids, because
Certivity's output requirements are numbered R-001 and up.

## Status values

| Item | Lifecycle |
|---|---|
| Requirement | `proposed` → `agreed` (who, date) → `implemented` (issue closed) → `verified` (V- evidence); or `deleted` (reason) |
| Interface | `proposed` → `agreed` (both owners) → `implemented` → `changed` |
| Owner | A named person, or `UNASSIGNED`. Only Clemente or Ramón assigns owners |

## Change rules

| # | Rule | Why |
|---|---|---|
| 1 | Every SYS- names the N- it serves | If none fits, either a need is missing or the requirement is scope creep |
| 2 | An IF- change needs both owners' agreement on the issue before merge | A change only one side knows about breaks the other side silently |
| 3 | Numbers are either measured or marked `TBD` with what will decide them | No invented targets |
| 4 | Ids are never reused or renumbered | Old commits and issues keep pointing to the right thing |
| 5 | Commits mention the SYS- or IF- id they touch | The trace can be reconstructed from git |

## Issues

Every issue body includes `Traces to: SYS-x` and `Interfaces: IF-x`. To claim an issue, add the
`doing` label. Humans are assignees; agents use an `owner:<agent>` label. See "Working in
parallel" in `AGENTS.md`.

Issues #1–#8 were opened by agents and **have not been verified by a person yet**.
