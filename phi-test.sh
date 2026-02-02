#!/usr/bin/env bash
set -euo pipefail

bun packages/coding-agent/src/cli.ts "$@"
