/**
 * Debug logger for agents package.
 * Writes to XDG-compliant location: ~/.local/state/phi/agents-debug.log
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_NAME = "phi";

function getStateDir(): string {
	// XDG_STATE_HOME or fallback to ~/.local/state
	const xdgState = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdgState, APP_NAME);
}

function getDebugLogPath(): string {
	return join(getStateDir(), "agents-debug.log");
}

let initialized = false;

function ensureDir(): void {
	if (initialized) return;
	try {
		mkdirSync(getStateDir(), { recursive: true, mode: 0o700 });
		// Create log file with restrictive permissions if it doesn't exist
		const logPath = getDebugLogPath();
		if (!existsSync(logPath)) {
			writeFileSync(logPath, "", { mode: 0o600 });
		} else {
			// Ensure existing file has correct permissions
			chmodSync(logPath, 0o600);
		}
		initialized = true;
	} catch {
		// Ignore errors
	}
}

/**
 * Escape control characters and newlines to prevent log injection.
 */
function escapeLogMessage(msg: string): string {
	return msg.replace(/[\x00-\x1f\x7f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * Log a debug message to the agents debug log file.
 * Only logs if DEBUG_AGENTS=1 environment variable is set.
 */
export function debugLog(component: string, message: string, data?: Record<string, unknown>): void {
	if (!process.env.DEBUG_AGENTS) return;

	ensureDir();

	const timestamp = new Date().toISOString();
	const safeMessage = escapeLogMessage(message);
	const safeComponent = escapeLogMessage(component);
	const dataStr = data ? ` ${JSON.stringify(data)}` : "";
	const line = `${timestamp} [${safeComponent}] ${safeMessage}${dataStr}\n`;

	try {
		appendFileSync(getDebugLogPath(), line);
	} catch {
		// Ignore write errors
	}
}
