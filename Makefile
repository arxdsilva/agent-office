# agent-office — every human, CI and agent command goes through here.
.DEFAULT_GOAL := help
SHELL := /bin/bash
PORT ?= 4317
TOKEN_FILE ?= $(HOME)/.agent-office/token
API := http://127.0.0.1:$(PORT)
# Terminals inside VS Code/Cursor export ELECTRON_RUN_AS_NODE=1, which would start Electron as plain Node.
ELECTRON_ENV := env -u ELECTRON_RUN_AS_NODE
# Local packaging is unsigned unless signing secrets are present.
UNSIGNED := CSC_IDENTITY_AUTO_DISCOVERY=$${CSC_IDENTITY_AUTO_DISCOVERY:-$$([ -n "$$CSC_LINK" ] && echo true || echo false)}
# Headless Linux (CI) needs a virtual display for Electron.
XVFB := $(shell [ "$$(uname)" = Linux ] && [ -z "$$DISPLAY" ] && command -v xvfb-run >/dev/null && echo "xvfb-run -a")

.PHONY: help install dev dev-mock build package package-dist icons assets assets-draft assets-test asset-previews screenshots perf test test-e2e test-ui coverage typecheck arch fmt fmt-check check install-hook uninstall-hook hook-status token demo-event demo-message release clean

help: ## List available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	pnpm install --frozen-lockfile

dev: ## Run the desktop app with hot reload (Claude Code adapter on)
	$(ELECTRON_ENV) pnpm dev

dev-mock: ## Same as dev, plus simulated agents
	$(ELECTRON_ENV) pnpm dev:mock

build: ## Build main, preload and renderer into packages/desktop/out
	pnpm build

package: build ## Unpacked app for this OS (fast smoke test) → packages/desktop/dist
	$(UNSIGNED) pnpm package

package-dist: build ## Installers for this OS (.dmg/.zip, .exe, .AppImage/.deb) → packages/desktop/dist
	$(UNSIGNED) pnpm package:dist

icons: ## Render app and tray icons from build/*.svg
	pnpm icons

assets: ## Build all 3D assets with Blender (final quality bake) → packages/web/public/assets
	node assets/build.mjs --quality final

assets-draft: ## Fast asset build for iteration (low bake samples, small lightmaps)
	node assets/build.mjs --quality draft

assets-test: ## Run the Blender-side asset tests (naming, counts, loops, budgets)
	node assets/build.mjs --test

asset-previews: ## Render Eevee preview stills of every module → assets/previews
	node assets/build.mjs --previews

screenshots: ## Capture in-app screenshots from fixed camera bookmarks → docs/screenshots (needs make build)
	$(ELECTRON_ENV) node scripts/screenshots.mjs

perf: ## Measure FPS with 150 mock agents (needs make build)
	$(ELECTRON_ENV) node scripts/perf.mjs

test: ## Run unit tests
	pnpm test

test-e2e: ## Run backend end-to-end tests (real HTTP server + hook script)
	pnpm test:e2e

test-ui: ## Drive the built app with Playwright (run `make build` first)
	$(ELECTRON_ENV) $(XVFB) pnpm test:ui

coverage: ## Run unit tests with the 70% per-package thresholds
	pnpm coverage

typecheck: ## Type-check every package and the scripts
	pnpm typecheck

arch: ## Enforce the hexagonal dependency rules (dependency-cruiser)
	pnpm arch

fmt: ## Format all files
	pnpm format

fmt-check: ## Fail if any file is not formatted
	pnpm format:check

check: fmt-check typecheck arch coverage test-e2e build ## Everything CI runs (plus test-ui in its own job)

install-hook: ## Dev only: add the hook to ~/.claude/settings.json without the app (asks first)
	pnpm exec tsx scripts/hook-install.ts install

uninstall-hook: ## Dev only: remove the hook from ~/.claude/settings.json
	pnpm exec tsx scripts/hook-install.ts uninstall

hook-status: ## Show whether the hook is installed
	pnpm exec tsx scripts/hook-install.ts status

token: ## Print the token file path (never the token)
	@echo $(TOKEN_FILE)

demo-event: ## POST a sample tool event to the running app
	curl -s -X POST $(API)/api/events \
	  -H "authorization: Bearer $$(cat $(TOKEN_FILE))" -H 'content-type: application/json' \
	  -d '{"agentId":"demo","name":"Demo","provider":"custom","topic":"Demo topic","status":"tool","tool":"Bash","text":"running make demo-event"}'
	@echo

demo-message: ## Send "hello from make" to the first agent
	@id=$$(curl -s $(API)/api/agents | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(a[0]?encodeURIComponent(a[0].id):"")})'); \
	test -n "$$id" || { echo "no agents running"; exit 1; }; \
	curl -s -X POST $(API)/api/agents/$$id/messages \
	  -H "authorization: Bearer $$(cat $(TOKEN_FILE))" -H 'content-type: application/json' \
	  -d '{"text":"hello from make"}'; echo

release: ## Bump the app version (VERSION=x.y.z) and print the tag commands to run
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=x.y.z"; exit 1; }
	cd packages/desktop && npm pkg set version=$(VERSION)
	@echo "Version set to $(VERSION). Commit it, then run:"
	@echo "  git tag v$(VERSION) && git push origin main v$(VERSION)"

clean: ## Remove dependencies and build output
	rm -rf node_modules packages/*/node_modules packages/desktop/out packages/desktop/dist coverage packages/desktop/test-results packages/desktop/playwright-report
