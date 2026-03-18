.PHONY: setup install dev-engine dev-cli db-up db-down build format lint clean help

# Default target
all: help

help:
	@echo "Cerebro Development Makefile"
	@echo "----------------------------"
	@echo "Commands:"
	@echo "  make setup        - Install dependencies and start database"
	@echo "  make install      - Install all bun dependencies"
	@echo "  make db-up        - Start PostgreSQL + pgvector container"
	@echo "  make db-down      - Stop PostgreSQL container"
	@echo "  make dev-engine   - Run the Engine API locally (Port 8080)"
	@echo "  make dev-cli      - Run the Developer CLI locally"
	@echo "  make build        - Build all packages via Turborepo"
	@echo "  make format       - Format codebase with Biome"
	@echo "  make lint         - Lint codebase with Biome"
	@echo "  make clean        - Remove all node_modules and turbo caches"

setup: install db-up

install:
	bun install

db-up:
	docker compose up -d

db-down:
	docker compose down

dev-engine:
	cd apps/engine && bun run dev

dev-cli:
	cd apps/cli && bun run dev

build:
	bun run build

format:
	bunx @biomejs/biome format --write .

lint:
	bunx @biomejs/biome lint .

clean:
	find . -name "node_modules" -type d -prune -exec rm -rf '{}' +
	find . -name ".turbo" -type d -prune -exec rm -rf '{}' +
	find . -name "dist" -type d -prune -exec rm -rf '{}' +
