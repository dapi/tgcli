.PHONY: install install-cli install-global build test start

# Local developer install from current repository checkout.
install: install-cli

install-cli:
	bash scripts/install-cli.sh

# Global install/update from npm + skill setup.
install-global:
	bash install.sh

start:
	npm start

build:
	npm run build

test:
	npm test
