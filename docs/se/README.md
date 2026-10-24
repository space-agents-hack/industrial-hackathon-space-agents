# Systems engineering: how the product is specified and tracked

This folder says **what** the product must do, **for whom**, and **how we will know** it does it.
GitHub Issues say **who is doing what now**. The two are linked by ids, never by copying text
between them (two copies drift).

Status of everything in this folder: **draft, not baselined.** It was written by Claude on
2026-10-24 from the Certivity brief, the challenge README and the kick-off pitch, and has not yet
been reviewed by Clemente or Ramón. Until a person reviews an item, its status says `proposed`.

## The chain

```
Stakeholder (who)  ->  Need N-x (what they need, in their words)
                   ->  System requirement SYS-x (what our product shall do, verifiable)
                   ->  Allocation (which part builds it: web, case agent, regulation pipeline, db, ops)
                   ->  Interface IF-x (where two parts meet, if more than one is involved)
                   ->  Issue #n (the work, its owner, its status)
                   ->  Verification V-x (the test, score or demo that proves it, with evidence)
```

| File | Holds |
|---|---|
| `stakeholders.md` | Stakeholders and their needs (N-) |
| `requirements.md` | System requirements (SYS-), each traced up to needs and down to issues |
| `interfaces.md` | Interface control: every IF-, its producer, consumer, owner and format |
| `verification.md` | How each SYS- is verified, and the evidence once it is |

## Ids, and why these letters

- `N-` stakeholder need, `SYS-` system requirement, `IF-` interface, `V-` verification.
- **Never `R-` or `R1`.** Certivity's output requirements are `R-001`, `R-002`... and the brief's
  required elements are `R1` to `R4`. We refer to the brief's as **`CR1` to `CR4`**. Three
  different things called "R" is the silent failure SOUL.md warns about.
- Ids are never reused. A dropped requirement keeps its id with status `deleted` and the reason.

## Statuses

- Requirement: `proposed` (written, nobody reviewed it), `agreed` (Clemente or Ramón accepted it,
  with name and date), `implemented` (issue closed), `verified` (V- has evidence), `deleted`.
- Interface: `proposed`, `agreed` (both owners), `implemented`, `changed` (see change rule).
- An **owner** is a named person, or `UNASSIGNED`. Nobody, human or agent, fills an owner field
  for someone else. Assigning owners is Clemente's and Ramón's decision.

## Rules for changing these files

1. A new or changed SYS- names the N- it serves. If it serves none, either a need is missing
   (add it, and say who it comes from) or the requirement is scope creep.
2. Changing an IF- needs the owners of both sides to agree, on the issue, before merge. An
   interface change that only one side knows about is how a parallel team breaks at 03:00.
3. Numbers in requirements are measured or marked `TBD` with what will decide them. No invented
   targets.
4. A commit that implements or verifies a requirement mentions its SYS- id.

## How Issues fit in

See "Working in parallel" in `AGENTS.md`. In short: every issue body has `Traces to: SYS-x` and
`Interfaces: IF-x` lines, owners are assignees (humans) or `owner:<agent>` labels (agents), and
the `doing` label claims an issue.

Issues #1 to #8 were opened by agents before this structure existed and **have not been verified
by a person yet**. Treat their content as a draft until Clemente or Ramón confirms it.
Reviewing this folder and assigning owners is issue #11.
