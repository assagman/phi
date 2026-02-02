#!/usr/bin/env bun
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: bun src/cli.ts [args...]
 */
process.title = "pi";

import { main } from "./main.js";

main(process.argv.slice(2));
