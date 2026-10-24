# Stakeholders and needs

Sources: Certivity challenge brief (sections 01 to 08), the challenge README, and the kick-off
pitch of 2026-10-24 (Certivity's head of AI). "Brief 07" means section 07 of the brief. No
challenge data (cases, expected answers) is quoted here.

Status of every need: `proposed`, until Clemente or Ramón reviews it.

## Stakeholders

- **S-1 End-user engineer** at a company that makes vehicle parts and sells them in many
  countries. Today reads hundreds of pages to find the few paragraphs that apply (Brief 01, 02).
- **S-2 Certivity as evaluator.** The scoring platform (F2 on regulations, pages and
  requirements) and the expert jury (demo, impact, pitch). Brief 07.
- **S-3 Certivity as potential deployer.** "Would Certivity continue, test or deploy it" is 15%
  of the grade. Their customers are large manufacturers (pitch: car makers, technical services,
  the EU Commission); their product connects to requirements tools such as Polarion and Jama.
- **S-4 Regulators and technical services.** Indirect: they never use our tool, but they test the
  product, and the requirement we cite is what the engineer will be checked against.
- **S-5 Hackathon organisers.** Repository, demo and answers on their platform (CR4).
- **S-6 Our team.** Clemente and Ramón plus several agents, 27 hours, 5 valid uploads per hour
  per challenge, uploads close Sunday 13:00.

## Grading weights (Brief 07), for prioritising

| Criterion | Weight |
|---|---|
| Score on the held-out case (F2, recall as tie-break) | 40% |
| Demo and user interface | 20% |
| Sub-goal result (optional) | 15% |
| Potential impact | 15% |
| Pitch | 10% |

## Certivity's required elements (Brief 05), as CR-

- **CR1** A main-goal output file that passes `validate.py`, uploaded for the held-out case.
- **CR2** Every requirement cites a regulation from `regulations/index.json`, with its version
  label and a page number.
- **CR3** A demo that runs from input (specification or drawing) to requirements without manual
  steps.
- **CR4** Answers, repository and demo submitted on the organisers' platform.

## Needs

**N-1 Completeness.** *As an engineer, I need every requirement that applies to my part, because
one I never see can make the product non-compliant.* S-1, S-4. Source: Brief 04 ("a missed
requirement costs our users more"), F2 scoring.

**N-2 Checkable source.** *I need to open the exact page each requirement comes from and check
it myself.* S-1, S-4. Source: Brief 04 ("cites a version and page that someone can open and
check"), Brief 07 (UI: "every requirement links to its source page").

**N-3 Input as I have it.** *I need to give the product in the form I already have it:
specification, drawings, PDFs, images, Word documents.* S-1. Source: Clemente, 2026-10-24; Brief
04 ("specification and/or exploded view").

**N-4 No noise.** *I need only the regulations that apply, and one obligation per line, because
every extra line is something I read and delete.* S-1, S-2. Source: Brief 04, 07 ("a weak
submission cites many regulations to be safe ... merges several obligations").

**N-5 Actionable wording.** *I need each requirement in engineering terms (a limit, a
condition, a test), not legal text.* S-1. Source: Brief 04, pitch.

**N-6 Stale requirements.** *When a regulation changes, I need to know which of my requirements
change and why.* S-1. Source: Brief 02, sub-goal. Optional (15%).

**N-7 Accepted submission.** *Certivity needs a file in its schema, accepted by `validate.py`, for
the held-out case, before uploads close.* S-2, S-6. Source: CR1, CR2, Brief 08.

**N-8 End to end.** *The jury needs to see input to requirements with no manual step, and be
able to follow it.* S-2. Source: CR3, Brief 07.

**N-9 Deployable at an industrial client.** *Certivity needs something it could give a customer:
confidential inputs stay confidential and can be deleted, a person reviews before anything leaves
the system, and there is a record of what the agent did.* S-3. Source: Brief 07 (impact), pitch
("industrial constraints").

**N-10 Fits their tooling.** *Certivity's customers keep requirements in Polarion or Jama; output
that can be exported there is worth more than a page on our web.* S-3. Source: pitch. Status:
`proposed`, lowest priority; nothing in the grading names it.

**N-11 Submitted.** *The organisers need the repository, demo and answers on their platform.* S-5.
Source: CR4.

**N-12 Shows its weakness.** *The jury wants to see where the solution is weak and how that was
measured.* S-2. Source: Brief 07 ("shows in the pitch where it is weak and how that was
measured").

**N-13 Load a regulation set once, reuse it.** *Certivity needs to load a set of regulations
(an index of regulations and versions) without manual work, and connect it to any customer or
use it for the model.* S-3. Source: Clemente, 2026-10-24 (our product direction, not stated by
Certivity).
