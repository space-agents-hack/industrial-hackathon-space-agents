# Hackathon playbook

How to use this template at an event. Times marked *(organisers)* are from the Industrial Agents
Hackathon page (Munich, 24 to 25 October 2026) as read on 2026-10-13; check them again before the
day. Everything else is our own plan and can change.

## What we know and do not know

- Hacking runs Saturday 12:00 to Sunday 15:00 *(organisers)*: 27 hours.
- Track briefings are Saturday 10:00; track judging Sunday 15:30; finals 17:30 *(organisers)*.
- The three challenges are not published before the briefing. One track is with Synera.
- No judging criteria are published. The organisers' own description of an industrial agent is:
  reads a task, calls the company's systems, asks a person before the risky step, writes the
  result back. This template is built around that shape, which is a bet, not a rule.
- The terms say challenge material is the partner's, is confidential, and must not be kept after
  the event. They say nothing for or against starting from a template.

## The week before

- [ ] One full drill from an empty repository to a deployed run with an approval, timed. Fix what
      was slow in the template, not in the drill.
- [ ] Everyone has `uv`, Node 24 and the Supabase CLI installed, and has run `make setup` once on
      the laptop they will bring. Whoever runs `scripts/bootstrap.sh` also needs `gh` and the
      Vercel CLI, signed in.
- [ ] Decide per person: a private database in Docker, or the hosted one with no Docker
      (`README.md`, "What you need"). Whoever chooses Docker pulls the images at home, not on the
      venue's network. Whoever chooses hosted needs an invitation to the Supabase organisation.
- [ ] Decide who owns the Vercel and Supabase accounts for the weekend. That person runs
      `scripts/bootstrap.sh` and their git identity becomes the deploy author.
- [ ] Decide roles for the first three hours: who talks to the challenge owner, who wires the
      systems, who owns the demo story.

## The first hour

The goal is a deployed, working run on our own URL before writing any challenge code. If the
pipeline is broken we want to know at 12:15, not at 14:45 on Sunday.

1. `gh repo create <name> --private --template clemenjuan/industrial-agent-template --clone`
2. `make setup`, then `make dev`: the example run works locally.
3. Create the Supabase project, run `scripts/bootstrap.sh`, push. Wait for green.
4. Open the production URL, run the example, approve the step.
5. Set `AGENT_MODEL` to the event's model and its key in the agent's Vercel project, re-run the
   workflow, run the example again with the real model.

Only then start on the challenge.

## Building

- Put the partner's data in `data/`. It is git-ignored. Never paste it into a prompt file, a test
  or a document that is committed.
- Work inside `agent/agent_service/domain/`. Start with `systems.py` against the real data or API,
  with tests; then the tools; then the prompt. A wrong number in `systems.py` is wrong in every
  answer and no model will catch it.
- Pick the one step that changes something in the partner's system and make it the approval. That
  moment is the demo.
- Push small and often: `git pull --rebase`, `make check`, `git push`. If `main` goes red, fixing
  it comes first (`docs/deploy.md`).
- When the prompt or a tool description changes, run `make eval` with the real model and add a
  case for whatever went wrong.

## The freeze (our plan)

Code freeze is Sunday 15:00 *(organisers)*. Ours is earlier, on purpose:

| When, Sunday | What |
|---|---|
| 12:00 | Feature freeze. From here only fixes and the demo |
| 13:00 | Full run-through of the demo on production, timed, with the real model |
| 14:00 | Last push. After this nobody pushes without both of us agreeing |
| 14:30 | Decide: real model or `AGENT_MODEL=scripted` for the stage |

`AGENT_MODEL=scripted` plays a fixed run with no network. It only helps if `scripted.py` was
rewritten for our challenge, so do that before the feature freeze. Say on stage that it is a
recorded path if we use it.

## The demo

Show, in this order: the task as the user types it; the trace filling in live, with the real
systems being called; the agent stopping and asking; a person approving; the result written back.
Then one slide of what it does **not** do. A jury that sees the boundary believes the rest.

Do not present a number we did not measure.

## Afterwards

- [ ] `make purge-data`, and work through the list it prints (hosted database, Vercel, provider
      logs, downloads, transcripts).
- [ ] Write down what the template made slow. Port each fix back to the template repository.
