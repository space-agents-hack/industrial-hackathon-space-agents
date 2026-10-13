# Industrial agent template

A starting point for an agent that does real work in company systems: it reads a task, calls the
systems through tools, **stops and asks a person before any step that writes**, and records
everything it did. It comes with the web UI to watch and approve, the database, the tests and a
deploy pipeline that several people can push to without breaking production.

It runs out of the box with no API key, using a scripted model that plays the example task
(triaging an engineering change notice against mock PLM, CAD and ERP systems).

## Use it

```bash
gh repo create my-project --private --template clemenjuan/industrial-agent-template --clone
cd my-project
make dev
```

Open http://localhost:3000. The page tells you what to do next, for running it on your machine or
for deploying it, and checks each step as you go. Only Node is needed to get that far.

The reasons behind the design are in `docs/`.
