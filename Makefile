# HR Screening Voice Agent Makefile

.PHONY: setup lint format test test-int build run clean

setup:
	@echo "Installing dependencies..."
	npm install

lint:
	@echo "Running linters..."
	npx eslint .

format:
	@echo "Formatting code..."
	npx prettier --write .

test:
	@echo "Running unit tests..."
	npm test

test-int:
	@echo "Running integration tests..."
	# Replace with actual integration test command when available
	npm test

build:
	@echo "Building artifacts..."
	# Replace with build steps if applicable
	@echo "Nothing to build for Node.js backend"

run:
	@echo "Starting local dev server..."
	npm run dev

clean:
	@echo "Cleaning workspace..."
	rm -rf node_modules
