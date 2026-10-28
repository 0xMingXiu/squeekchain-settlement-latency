#!/usr/bin/env bash
# Loads sepolia-env.sh (official values + local defaults), then .env.local if present, and runs the given command.
set -a; . "$(dirname "$0")/sepolia-env.sh"
[ -f "$(dirname "$0")/.env.local" ] && . "$(dirname "$0")/.env.local"
set +a; exec "$@"
