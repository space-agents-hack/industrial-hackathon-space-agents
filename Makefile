# Everything a person or a coding agent runs, in one place. `make check` is what CI runs.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Local services the app does not use. Leaving them out roughly halves the first start.
SUPABASE_SKIP := edge-runtime,logflare,vector,imgproxy,storage-api,supavisor

.PHONY: help setup dev check check-agent check-web check-db test-integration types eval \
        db-start db-reset db-stop user purge-data

help: ## Show this list
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

setup: ## First run after cloning: install, start the local database, write env files, create the demo user
	@scripts/require-tools.sh
	cd agent && uv sync --locked --all-groups
	cd web && npm ci
	$(MAKE) db-start
	scripts/local-env.sh
	scripts/create-user.sh
	@echo
	@echo "Ready. Run 'make dev' and open http://localhost:3000"

dev: db-start ## Run the agent (port 8000) and the web (port 3000) together; Ctrl-C stops both
	scripts/dev.sh

check: check-agent check-web check-db ## Everything CI checks. Run before every push

check-agent: ## Python: lint, format, types, tests, evals with the scripted model
	cd agent && uv run ruff check . && uv run ruff format --check . && uv run pyright \
		&& uv run pytest -q && uv run python -m evals.ecn_triage

check-web: ## Web: lint, types, tests, build
	cd web && npm run lint && npm run typecheck && npm test && npm run build

check-db: db-start ## Database: apply new migrations locally, RLS tests, SQL lint, agent contract test
	supabase migration up --local
	supabase test db --local
	supabase db lint --local --schema public --level warning --fail-on error
	$(MAKE) test-integration

test-integration: ## The agent's storage code against the local database
	@eval "$$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|SECRET_KEY)=')" \
		&& cd agent && SUPABASE_URL="$$API_URL" SUPABASE_SECRET_KEY="$$SECRET_KEY" uv run pytest -q -m integration

types: ## Regenerate web/lib/database.types.ts after changing the schema
	@# The generator ends with a blank line, which `git diff --check` reports on every regeneration.
	supabase gen types typescript --local | sed -e '$${/^$$/d;}' > web/lib/database.types.ts

eval: ## Run the evals with AGENT_MODEL (a real model spends tokens)
	cd agent && uv run python -m evals.ecn_triage

db-start: ## Start the local Supabase stack if it is not running
	@supabase status >/dev/null 2>&1 || supabase start -x $(SUPABASE_SKIP)

db-reset: ## Wipe the local database, re-apply every migration, re-create the demo user
	supabase db reset --local
	scripts/create-user.sh

db-stop: ## Stop the local Supabase stack
	supabase stop

user: ## Create a user. Local: make user EMAIL=a@b.c  Hosted: see supabase/README.md
	scripts/create-user.sh $(EMAIL)

purge-data: ## Delete challenge material from this machine (data/ and local database rows)
	scripts/purge-challenge-data.sh
