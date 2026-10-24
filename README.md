# Space Agents: from a product case to the UN Regulation requirements it must meet

Our entry to the Industrial Agents Hackathon, Certivity track. An engineer uploads a product case
(specification, exploded view, datasheets, drawings, BOM, CAD) and gets the requirements the
product must fulfil under the UN Regulations, each citing regulation, version, page and paragraph,
as a file Certivity's `validate.py` accepts.

How it is meant to work (`docs/se/` is the specification, ADR-0006 the data model):

1. **Case ingestion.** The files go to a private bucket of the engineer's organisation; the agent
   reads each one into text and images, tagged by file and page (`agent/agent_service/domain/ingest.py`).
2. **Regulation library.** An `index.json` in Certivity's format is imported from the app: every
   PDF is downloaded, checked against its checksum and stored per organisation
   (`docs/regulations-store.md`). Splitting into paragraphs with pages is next.
3. **Requirement writing.** An agent reads the case and the applicable regulations and writes one
   obligation per requirement, citing the paragraph it comes from. **Not built yet (#4).** Until
   it is, the agent's prompt and tools are still the template's example: triaging engineering
   change notices against mock PLM, CAD and ERP systems.
4. **Checks.** Certivity's own `validate.py` and, on the worked example, `score_local.py` run on
   every run output that is a submission, and on any file dropped on the Checks page.
5. **Approval.** A person approves before anything is exported or submitted (SYS-13; not built
   yet).

What it does not do: interpret CAD geometry (STEP and IGES give part names and assembly
structure), OCR (pages without text go to the model as images), or score the held-out case
locally (only Certivity's platform does).

All case and regulation data lives in Supabase, per organisation; none of it is in this repository
(`AGENTS.md`, "Limits"). Work is tracked in GitHub Issues.

It is built on an industrial agent template: the web UI to watch and approve, the database with
row-level security, the tests and a deploy pipeline that several people can push to. With no API
key it runs on a scripted model that plays the template's example task.

## Install

Node 24+, `uv`, the Supabase CLI, the GitHub CLI and Docker. With [Homebrew](https://brew.sh), on
macOS or Linux:

```bash
brew install node uv supabase/tap/supabase gh
gh auth login
```

Docker is only for the local database; without it, use `make setup DB=hosted`. On macOS, Docker
Desktop, running (and `xcode-select --install` if `git` or `make` are missing). On Linux:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and back in
```

On Windows, use WSL2 (Ubuntu) and clone inside it, not under `/mnt/c`.

## Use it

```bash
gh repo clone space-agents-hack/industrial-hackathon-space-agents
cd industrial-hackathon-space-agents
make dev
```

Open http://localhost:3000. The page tells you what to do next, for running it on your machine or
for deploying it, and checks each step as you go.

The map is `docs/architecture.md`, the reasons are in `docs/adr/`, the event playbook is
`docs/hackathon.md`. Contributors read `AGENTS.md` first.
