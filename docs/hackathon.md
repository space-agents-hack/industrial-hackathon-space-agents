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
      the laptop they will bring. Deploying needs none of it: it happens in GitHub.
- [ ] Per person: local database in Docker (pull the images at home), or `make setup DB=hosted`
      with no Docker (needs an invitation to the Supabase organisation).
- [ ] Decide who owns the Vercel and Supabase accounts for the weekend. Their tokens go into
      GitHub, and the Vercel token's owner becomes the deploy author.
- [ ] Decide roles for the first three hours: who talks to the challenge owner, who wires the
      systems, who owns the demo story.

## The first hour

The goal is a deployed, working run on our own URL before writing any challenge code. If the
pipeline is broken we want to know at 12:15, not at 14:45 on Sunday.

1. `gh repo create <name> --private --template clemenjuan/industrial-agent-template --clone`
2. `make setup`, then `make dev`: the example run works locally.
3. Setup page, "Deploy to production": Connect GitHub (Create, Install), paste the Vercel and
   Supabase tokens, press Create production. Wait for green.
4. Open the production URL, run the example, approve the step.
5. Admin › Deployment: set the event's model and its key, apply, run the example again with the
   real model.

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

## Sunday: the held-out upload, then the demo

Two deadlines, and the first one decides 40% of the grade:

- **Certivity uploads close at 13:00** (brief, section 08). Held-out inputs arrive at 08:00.
- For the held-out case **the last valid upload counts, not the best**. An upload at 12:55 that
  scores worse than the one at 11:00 replaces it. 5 valid uploads per hour per challenge.
- Organisers' code freeze is 15:00; finalists pitch from 15:00.

### Held-out upload procedure

Clemente and Ramón both upload (Clemente, 2026-10-24). Say so on #7 before each held-out
upload, because the last valid one counts and two people uploading close together can replace a
better file. Every upload is logged on issue #7: time, file sha256, commit, model, and the
platform's scores once they appear.

| When, Sunday | What |
|---|---|
| 08:00 | Held-out released: `git pull` in the Certivity repo, or unzip the second package if it comes as a zip (brief 06, 08); then `fetch_regulations.py`. If it came by `git pull` upstream, Actions > Deploy > Run workflow reloads the answer and index files into production; if by zip, `make certivity-load` with `agent/.env` pointing at the hosted project |
| by 08:45 | First valid held-out upload with whatever the pipeline produces. A floor, in case all else fails |
| 08:45 to 11:00 | Improve and upload. Keep every uploaded file with its score; mark the best |
| 11:00 | **Pipeline freeze.** No more changes to code or prompts that generate the submission |
| 11:30 | Last improvement upload |
| 12:00 | Scores for all uploads are in (they are computed in the background, not instantly). Pick the best file by platform score |
| by 12:15 | **Final upload.** If the last upload is not the best, re-upload the best file unchanged. Check it was accepted |
| 12:15 to 13:00 | Nobody uploads to the held-out case. The margin is for a slow platform or a rejected file, not for one more try |

Why so early: if the final upload were at 12:50 and its score arrived worse, there would be no
time to put the best file back, and the worse file would count.

One quota for everything: the 5 valid uploads per hour cover every goal and case of the
challenge, dev and held-out, main goal and sub-goal (Clemente, 2026-10-24). So nobody uploads
the dev case on Sunday morning, and each sub-goal upload takes a slot from the main goal's hour.

### Demo freeze

| When, Sunday | What |
|---|---|
| 13:00 | Full run-through of the demo on production, timed, with the real model |
| 14:00 | Last push. After this nobody pushes without both of us agreeing |
| 14:30 | Decide: real model or `AGENT_MODEL=scripted` for the stage |

`AGENT_MODEL=scripted` plays a fixed run with no network. It only helps if `scripted.py` was
rewritten for our challenge, so do that before the pipeline freeze. Say on stage that it is a
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
