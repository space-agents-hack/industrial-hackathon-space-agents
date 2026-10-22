# Industrial agent template

A starting point for an agent that does real work in company systems: it reads a task, calls the
systems through tools, **stops and asks a person before any step that writes**, and records
everything it did. It comes with the web UI to watch and approve, the database, the tests and a
deploy pipeline that several people can push to without breaking production.

It runs out of the box with no API key, using a scripted model that plays the example task
(triaging an engineering change notice against mock PLM, CAD and ERP systems).

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
gh repo create my-project --private --template clemenjuan/industrial-agent-template --clone
cd my-project
make dev
```

Open http://localhost:3000. The page tells you what to do next, for running it on your machine or
for deploying it, and checks each step as you go.

The reasons behind the design are in `docs/`.
