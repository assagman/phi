# ─────────────────────────────────────────────────────────
# Phi Monorepo Makefile
# Usage: make [target]   |   make help
# ─────────────────────────────────────────────────────────

BUN       := bun
PKG_DIR   := packages
PACKAGES  := ai agent agents tui coding-agent
CA_DIR    := $(PKG_DIR)/coding-agent

# Bare repo root (resolved via git)
BARE_ROOT := $(shell git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)

# ─── Default ────────────────────────────────────────────

.DEFAULT_GOAL := help

# ═══════════════════════════════════════════════════════
#  Core
# ═══════════════════════════════════════════════════════

install: ## Install all dependencies
	$(BUN) install

check: ## Lint, format (auto-fix), and typecheck
	$(BUN) run check

build: ## Build all packages (ordered by deps)
	$(BUN) run build

test: ## Run all workspace tests
	$(BUN) test --workspaces

clean: ## Remove dist/ from all packages
	$(BUN) run clean

dev: ## Start dev watchers for all packages
	$(BUN) run dev

# ═══════════════════════════════════════════════════════
#  Composite Pipelines
# ═══════════════════════════════════════════════════════

install-build: install build ## Install + build

all: check build ## Check then build

rebuild: clean build ## Clean then build

ci: check build test ## Full CI: check + build + test

verify: check build ## Verify before commit (check + build)
	@echo "✓ Ready to commit"

# ═══════════════════════════════════════════════════════
#  Linking & Running
# ═══════════════════════════════════════════════════════

link: build ## Link phi binary globally (from this worktree)
	cd $(CA_DIR) && $(BUN) link
	@echo "✓ phi linked from $$(pwd)/$(CA_DIR)"

unlink: ## Unlink phi binary globally
	cd $(CA_DIR) && $(BUN) unlink 2>/dev/null || true
	@echo "✓ phi unlinked"

relink: unlink link ## Unlink then re-link (switch worktree)

run: build ## Build and run phi from this worktree (no link needed)
	$(BUN) run $(CA_DIR)/dist/cli.js

run-fast: ## Run phi from this worktree without building
	$(BUN) run $(CA_DIR)/dist/cli.js

link-skills: ## Symlink delta/epsilon CLIs to ~/.local/bin
	cd $(CA_DIR) && $(BUN) run link-skills

which: ## Show where phi binary currently points
	@echo "Binary:  $$(which phi 2>/dev/null || echo 'not found')"
	@echo "Target:  $$(readlink $$(which phi) 2>/dev/null || echo 'n/a')"
	@echo "Resolves: $$(readlink -f $$(which phi) 2>/dev/null || echo 'n/a')"

# ═══════════════════════════════════════════════════════
#  Worktree Management
# ═══════════════════════════════════════════════════════

wt-list: ## List all worktrees
	cd $(BARE_ROOT) && git worktree list

wt-new: ## Create new worktree: make wt-new NAME=feat/my-feature
	@if [ -z "$(NAME)" ]; then echo "Usage: make wt-new NAME=feat/my-feature"; exit 1; fi
	cd $(BARE_ROOT) && git fetch origin main
	cd $(BARE_ROOT) && git worktree add -b $(NAME) $(NAME) main
	@echo "✓ Worktree created at $(BARE_ROOT)/$(NAME)"
	@echo "  cd $(BARE_ROOT)/$(NAME) && make install"

wt-rm: ## Remove a worktree: make wt-rm NAME=feat/my-feature
	@if [ -z "$(NAME)" ]; then echo "Usage: make wt-rm NAME=feat/my-feature"; exit 1; fi
	cd $(BARE_ROOT) && git worktree remove $(NAME)
	@echo "✓ Worktree removed: $(NAME)"

wt-prune: ## Prune stale worktree references
	cd $(BARE_ROOT) && git worktree prune -v

# ═══════════════════════════════════════════════════════
#  Per-package: Build
# ═══════════════════════════════════════════════════════

build-ai: ## Build ai package
	$(BUN) run --filter ai build

build-agent: ## Build agent package
	$(BUN) run --filter agent build

build-agents: ## Build agents package
	$(BUN) run --filter agents build

build-tui: ## Build tui package
	$(BUN) run --filter tui build

build-coding-agent: ## Build coding-agent package
	$(BUN) run --filter coding-agent build

# ═══════════════════════════════════════════════════════
#  Per-package: Test
# ═══════════════════════════════════════════════════════

test-ai: ## Test ai package
	cd $(PKG_DIR)/ai && $(BUN) test

test-agent: ## Test agent package
	cd $(PKG_DIR)/agent && $(BUN) test

test-agents: ## Test agents package
	cd $(PKG_DIR)/agents && $(BUN) test

test-tui: ## Test tui package
	cd $(PKG_DIR)/tui && $(BUN) test

test-coding-agent: ## Test coding-agent package
	cd $(CA_DIR) && $(BUN) test

# ═══════════════════════════════════════════════════════
#  Per-package: Clean
# ═══════════════════════════════════════════════════════

clean-ai: ## Clean ai package
	$(BUN) run --filter ai clean

clean-agent: ## Clean agent package
	$(BUN) run --filter agent clean

clean-agents: ## Clean agents package
	$(BUN) run --filter agents clean

clean-tui: ## Clean tui package
	$(BUN) run --filter tui clean

clean-coding-agent: ## Clean coding-agent package
	$(BUN) run --filter coding-agent clean

# ═══════════════════════════════════════════════════════
#  Per-package: Dev
# ═══════════════════════════════════════════════════════

dev-ai: ## Dev watch for ai package
	$(BUN) run --filter ai dev

dev-agent: ## Dev watch for agent package
	$(BUN) run --filter agent dev

dev-agents: ## Dev watch for agents package
	$(BUN) run --filter agents dev

dev-tui: ## Dev watch for tui package
	$(BUN) run --filter tui dev

# ═══════════════════════════════════════════════════════
#  AI & Coding-agent Specific
# ═══════════════════════════════════════════════════════

generate-models: ## Regenerate model definitions (ai package)
	cd $(PKG_DIR)/ai && $(BUN) run generate-models

build-binary: ## Build standalone binary (coding-agent)
	cd $(CA_DIR) && $(BUN) run build:binary

# ═══════════════════════════════════════════════════════
#  Setup
# ═══════════════════════════════════════════════════════

setup: install link link-skills ## Full setup: install + link binary + link skills
	@echo "✓ Setup complete"

# ═══════════════════════════════════════════════════════
#  Info & Utility
# ═══════════════════════════════════════════════════════

loc: ## Count lines of source code
	@find $(PKG_DIR) -path '*/src/*.ts' -not -path '*/node_modules/*' | xargs wc -l | tail -1 | awk '{print $$1, "lines of TypeScript"}'

info: ## Show project info (branch, worktree, link target)
	@echo "Branch:    $$(git branch --show-current)"
	@echo "Worktree:  $$(pwd)"
	@echo "Bare root: $(BARE_ROOT)"
	@echo "Phi link:  $$(readlink -f $$(which phi) 2>/dev/null || echo 'not linked')"
	@echo "Node:      $$(node -v)"
	@echo "Bun:       $$($(BUN) -v)"

help: ## Show this help
	@echo "Usage: make [target]"
	@echo ""
	@awk 'BEGIN {FS = ":.*?## "} \
		/^# ═/ { gsub(/[═ ]/, "", $$0); section=$$0; next } \
		/^[a-zA-Z_-]+:.*?## / { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ═══════════════════════════════════════════════════════
#  Phony
# ═══════════════════════════════════════════════════════

.PHONY: install check build test clean dev \
        install-build all rebuild ci verify \
        link unlink relink run run-fast link-skills which \
        wt-list wt-new wt-rm wt-prune \
        $(foreach p,$(PACKAGES),build-$(p) test-$(p) clean-$(p)) \
        dev-ai dev-agent dev-agents dev-tui \
        generate-models build-binary \
        setup loc info help
