# Stakeholders and needs

All `proposed` until Clemente or Ramón reviews them (#11). Sources: Certivity brief (sections
01–08, written "Brief 07"), challenge README, kick-off pitch of 2026-10-24. No challenge data is
quoted here.

## Stakeholders

| Id | Stakeholder | Interest | Relation |
|---|---|---|---|
| S-1 | End-user engineer at a parts maker | Every applicable requirement, without reading hundreds of pages | User |
| S-2 | Certivity as evaluator (platform + jury) | F2 score, demo, impact, pitch | Judge |
| S-3 | Certivity as potential deployer | Something they could give their customers (car makers, technical services) | Customer |
| S-4 | Regulators, technical services | Product tested against the cited version and page | Indirect |
| S-5 | Hackathon organisers | Repository, demo, answers (CR4) | Judge |
| S-6 | Our team (Clemente, Ramón, agents) | 27 h, 5 uploads/h, uploads close Sunday 13:00 | Builder |

## Grading weights (Brief 07)

| Criterion | Weight |
|---|---|
| Held-out score (F2, recall breaks ties) | 40% |
| Demo and user interface | 20% |
| Sub-goal (optional) | 15% |
| Potential impact | 15% |
| Pitch | 10% |

## Certivity's required elements (Brief 05)

These are written CR-, never R-, because Certivity's output requirements use the ids R-001 and up.

| Id | Required element | Verified by |
|---|---|---|
| CR1 | Main-goal file passes `validate.py`, uploaded for the held-out case | Platform |
| CR2 | Every requirement cites a regulation from `index.json`, with version label and page | Platform |
| CR3 | Demo runs from input to requirements with no manual step | Pitch |
| CR4 | Answers, repository and demo on the organisers' platform | Organisers |

## Needs

| Id | Need | From | Source | Weight |
|---|---|---|---|---|
| N-1 | Completeness: every requirement that applies, since a missed one can mean a non-compliant product | S-1, S-4 | Brief 04, F2 | 40% |
| N-2 | Checkable source: open the exact page each requirement comes from | S-1, S-4 | Brief 04, 07 | 20% |
| N-3 | Input as I have it: spec, drawings, PDFs, images, Word, CAD | S-1 | Clemente | 20% |
| N-4 | No noise: only applicable regulations, one obligation per line | S-1, S-2 | Brief 04, 07 | 40% |
| N-5 | Actionable wording: a limit, a condition, a test, rather than legal text | S-1 | Brief 04 | 40% |
| N-6 | Stale requirements: which ones a regulation change affects, and why | S-1 | Sub-goal | 15% |
| N-7 | Accepted submission: valid file for the held-out case, before 13:00 | S-2, S-6 | CR1, CR2 | 40% |
| N-8 | End to end: input to requirements, no manual step, easy to follow | S-2 | CR3 | 20% |
| N-9 | Deployable: confidential inputs, a person approves before export, a record of the run | S-3 | Brief 07 | 15% |
| N-10 | Fits their tooling: export to Polarion or Jama | S-3 | Pitch | not graded |
| N-11 | Submitted on the organisers' platform | S-5 | CR4 | gate |
| N-12 | Shows its weakness, with how it was measured | S-2 | Brief 07 | 10% |
| N-13 | Reusable regulation set: load an index once, use it for any customer or model | S-3 | Clemente | 15% |
| N-14 | More markets: regulations for other countries and industries, not only the 56 UN Regulations given | S-3 | Pitch (85+ markets), Clemente | future |

"Weight" is the grading criterion a need feeds into, which helps prioritise. It is not a score.
N-3, N-13 and N-14 come from Clemente's product direction, not from Certivity's grading.
