PYTHON ?= python3
RUFF ?= ruff

.PHONY: test test-browser lint format check-public serve refresh

test: test-browser

test-browser:
	npm test

lint:
	$(RUFF) check scripts tests
	$(RUFF) format --check scripts tests
	npm run format:check

format:
	$(RUFF) check --fix scripts tests
	$(RUFF) format scripts tests
	npm run format

serve:
	$(PYTHON) scripts/server.py

refresh:
	$(PYTHON) scripts/refresh.py

check-public:
	$(PYTHON) scripts/check_public.py
