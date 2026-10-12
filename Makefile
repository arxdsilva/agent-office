# agent-office — every human, CI and agent command goes through here.
.DEFAULT_GOAL := help
SHELL := /bin/bash
PORT ?= 4317
TOKEN_FILE ?= $(HOME)/.agent-office/token
API := http://127.0.0.1:$(PORT)

.PHONY: help install dev dev-mock build start test test-e2e test-ui coverage typecheck fmt fmt-check check install-hook uninstall-hook token demo-event demo-message clean

help: ## List available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	pnpm install --frozen-lockfile

dev: ## Run server (:4317) and web (:5173) with the Claude Code adapter
	pnpm dev

dev-mock: ## Same as dev, plus simulated agents
	pnpm dev:mock

build: ## Build the web client into packages/web/dist
	pnpm build

start: ## Serve the built client and API from one process on :4317
	pnpm start

test: ## Run unit tests
	pnpm test

test-e2e: ## Run server end-to-end tests (real HTTP + WebSocket)
	pnpm test:e2e

test-ui: ## Run the Playwright UI smoke test (needs `make build`)
	pnpm test:ui

coverage: ## Run unit tests with the 70% coverage thresholds
	pnpm coverage

typecheck: ## Type-check every package
	pnpm typecheck

fmt: ## Format all files
	pnpm format

fmt-check: ## Fail if any file is not formatted
	pnpm format:check

check: fmt-check typecheck coverage test-e2e build ## Everything CI runs

install-hook: ## Add the agent-office hook to ~/.claude/settings.json (asks first)
	node scripts/hook-install.mjs install

uninstall-hook: ## Remove the agent-office hook from ~/.claude/settings.json
	node scripts/hook-install.mjs uninstall

token: ## Print the token file path (never the token)
	@echo $(TOKEN_FILE)

demo-event: ## POST a sample tool event to the running server
	curl -s -X POST $(API)/api/events \
	  -H "authorization: Bearer $$(cat $(TOKEN_FILE))" -H 'content-type: application/json' \
	  -d '{"agentId":"demo","name":"Demo","provider":"custom","topic":"Demo topic","status":"tool","tool":"Bash","text":"running make demo-event"}'
	@echo

demo-message: ## Send "hello from make" to the first agent
	@id=$$(curl -s $(API)/api/agents | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(a[0]?encodeURIComponent(a[0].id):"")})'); \
	test -n "$$id" || { echo "no agents running"; exit 1; }; \
	curl -s -X POST $(API)/api/agents/$$id/messages \
	  -H "authorization: Bearer $$(cat $(TOKEN_FILE))" -H 'content-type: application/json' \
	  -H "origin: $(API)" -d '{"text":"hello from make"}'; echo

clean: ## Remove dependencies and build output
	rm -rf node_modules packages/*/node_modules packages/web/dist coverage packages/web/test-results packages/web/playwright-report
