# Everything a person or a coding agent runs, in one place. `make check` is what CI runs.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Local services the app does not use. Leaving them out roughly halves the first start.
SUPABASE_SKIP := edge-runtime,logflare,vector,imgproxy,supavisor

# Which database local development uses. `local` runs Supabase in Docker on this machine.
# `hosted` uses the Supabase project in the cloud and needs no Docker.
DB ?= local
# After setup, the env file is the record of that choice.
USES_LOCAL_DB := $(shell grep -q '^SUPABASE_URL=http://127.0.0.1' agent/.env 2>/dev/null && echo yes)

.PHONY: help setup dev check check-repo check-agent check-web check-db check-db-run test-integration types \
        eval certivity-load regulations-index regulations-search db-start db-reset db-stop user purge-data

help: ## Show this list
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

dev: ## The one command: shows the setup steps on a fresh clone, runs everything once set up
	@scripts/dev.sh

setup: ## First run after cloning. Local database in Docker by default; DB=hosted needs no Docker
	@scripts/require-tools.sh $(DB)
	@scripts/name-project.sh
	cd agent && uv sync --locked --all-groups
	cd web && npm ci
ifeq ($(DB),hosted)
	scripts/hosted-env.sh
else
	$(MAKE) db-start
	scripts/local-env.sh
	scripts/create-user.sh --platform-admin
endif
	@echo
	@echo "Ready. Run 'make dev' and open http://localhost:3000"

check: check-repo check-agent check-web check-db ## Everything CI checks. Run before every push

check-repo: ## Shell scripts, workflows, and the migration rules against origin/main
	uvx --quiet --from shellcheck-py shellcheck -x scripts/*.sh
	@# With shellcheck, as in CI: without it actionlint skips the scripts inside workflows.
	uvx --quiet --from actionlint-py actionlint -shellcheck="$$(uvx --quiet --from shellcheck-py python -c 'import shutil; print(shutil.which("shellcheck"))')"
	@git fetch --quiet origin main 2>/dev/null || true
	scripts/check-migrations.sh origin/main

check-agent: ## Python: lint, format, types, tests, evals with the scripted model
	cd agent && uv run ruff check . && uv run ruff format --check . && uv run pyright \
		&& uv run pytest -q && uv run python -m evals.requirements_writer

check-web: ## Web: lint, types, tests, build
	cd web && npm run lint && npm run typecheck && npm test && npm run build

check-db: ## Database: new migrations, RLS tests, SQL lint, agent contract test. Needs Docker
	@if docker info >/dev/null 2>&1; then \
		$(MAKE) check-db-run; \
	else \
		echo; \
		echo "SKIPPED: the database checks need Docker and it is not running."; \
		echo "SQL and RLS were NOT tested on this machine. CI runs them on every push and"; \
		echo "blocks the release if they fail."; \
	fi

check-db-run: db-start
	supabase migration up --local
	supabase test db --local
	supabase db lint --local --schema public --level warning --fail-on error
	$(MAKE) test-integration

test-integration: ## The agent's storage code against the local database
	@eval "$$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|SECRET_KEY)=')" \
		&& cd agent && SUPABASE_URL="$$API_URL" SUPABASE_SECRET_KEY="$$SECRET_KEY" uv run pytest -q -m integration

types: ## Regenerate web/lib/database.types.ts after changing the schema
	@# The generator ends with a blank line, which `git diff --check` reports on every regeneration.
	supabase gen types typescript $(if $(USES_LOCAL_DB),--local,--linked) | sed -e '$${/^$$/d;}' > web/lib/database.types.ts

eval: ## Run the evals with AGENT_MODEL (a real model spends tokens)
	cd agent && uv run python -m evals.requirements_writer

# Certivity's data is licensed for the hackathon only, so it goes to the database, not to git.
# Writes to whatever agent/.env points at: the local stack, or the hosted project if you set it so.
CERTIVITY ?= ../industrial-ai-hackathon
certivity-load: ## Load Certivity's index and answer files into the database (CERTIVITY=path)
	cd agent && uv run python -m agent_service.domain.load_certivity "$(abspath $(CERTIVITY))"

regulations-index: ## Vectors and scope summaries for the regulation library (ORG=uuid if several)
	cd agent && uv run python -m agent_service.domain.index_regulations $(if $(ORG),--org $(ORG)) index

regulations-search: ## Query the regulation library: Q="text" [MODE=hybrid|text|vector] [K=10]
	cd agent && uv run python -m agent_service.domain.index_regulations $(if $(ORG),--org $(ORG)) \
		search "$(Q)" --mode $(or $(MODE),hybrid) --k $(or $(K),10)

db-start: ## Start the local Supabase stack if it is not running
	@supabase status >/dev/null 2>&1 || supabase start -x $(SUPABASE_SKIP)

db-reset: ## Wipe the local database, re-apply every migration, re-create the demo user
	supabase db reset --local
	scripts/create-user.sh --platform-admin

db-stop: ## Stop the local Supabase stack
	supabase stop

user: ## Create a user. Local: make user EMAIL=a@b.c [ROLE=member]  Hosted: see supabase/README.md
	scripts/create-user.sh $(EMAIL) --role $(or $(ROLE),admin)

purge-data: ## Delete challenge material from this machine (data/ and local database rows)
	scripts/purge-challenge-data.sh
