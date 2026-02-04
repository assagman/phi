/**
 * Centralized logging utility for Pi coding agent.
 *
 * Logs to ~/.local/share/phi/logs/ with separate files per category:
 * - coop.log - coop tool and lead analyzer
 * - team.log - team execution
 * - agent.log - agent loop events
 * - tools.log - tool executions
 * - session.log - session lifecycle
 * - ui.log - TUI events
 *
 * Control via environment:
 * - DEBUG_PHI=1 - Enable all debug logging
 * - DEBUG_PHI=coop,team - Enable specific categories
 * - Errors are always logged
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Log categories
export type LogCategory = "coop" | "team" | "agent" | "tools" | "session" | "ui" | "config" | "extensions";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_DIR = join(homedir(), ".local", "share", "phi", "logs");

// Parse DEBUG_PHI env var
const DEBUG_PHI = process.env.DEBUG_PHI || "";
const DEBUG_ALL = DEBUG_PHI === "1" || DEBUG_PHI === "true" || DEBUG_PHI === "*";
const DEBUG_CATEGORIES = new Set(DEBUG_PHI.split(",").map((s) => s.trim().toLowerCase()));

// Ensure log directory exists
let logDirReady = false;
function ensureLogDir(): void {
	if (logDirReady) return;
	try {
		if (!existsSync(LOG_DIR)) {
			mkdirSync(LOG_DIR, { recursive: true });
		}
		logDirReady = true;
	} catch {
		// Silently fail if we can't create log dir
	}
}

function shouldLog(category: LogCategory, level: LogLevel): boolean {
	// Always log errors and warnings
	if (level === "error" || level === "warn") return true;
	// Check debug settings
	if (DEBUG_ALL) return true;
	if (DEBUG_CATEGORIES.has(category)) return true;
	return false;
}

function formatTimestamp(): string {
	return new Date().toISOString();
}

function formatMessage(
	level: LogLevel,
	category: LogCategory,
	message: string,
	data?: Record<string, unknown>,
): string {
	const timestamp = formatTimestamp();
	const dataStr = data ? ` ${JSON.stringify(data)}` : "";
	return `${timestamp} [${level.toUpperCase()}] [${category}] ${message}${dataStr}\n`;
}

function writeLog(category: LogCategory, level: LogLevel, message: string, data?: Record<string, unknown>): void {
	if (!shouldLog(category, level)) return;

	ensureLogDir();
	if (!logDirReady) return;

	try {
		const logFile = join(LOG_DIR, `${category}.log`);
		const formatted = formatMessage(level, category, message, data);
		appendFileSync(logFile, formatted);
	} catch {
		// Silently fail if we can't write
	}
}

/**
 * Create a logger for a specific category
 */
export function createLogger(category: LogCategory) {
	return {
		debug: (message: string, data?: Record<string, unknown>) => writeLog(category, "debug", message, data),
		info: (message: string, data?: Record<string, unknown>) => writeLog(category, "info", message, data),
		warn: (message: string, data?: Record<string, unknown>) => writeLog(category, "warn", message, data),
		error: (message: string, data?: Record<string, unknown>) => writeLog(category, "error", message, data),
	};
}

// Pre-created loggers for convenience
export const coopLog = createLogger("coop");
export const teamLog = createLogger("team");
export const agentLog = createLogger("agent");
export const toolsLog = createLogger("tools");
export const sessionLog = createLogger("session");
export const uiLog = createLogger("ui");
export const configLog = createLogger("config");
export const extensionsLog = createLogger("extensions");

/**
 * Log directory path for external reference
 */
export const LOG_DIRECTORY = LOG_DIR;

/**
 * Check if debug logging is enabled for a category
 */
export function isDebugEnabled(category?: LogCategory): boolean {
	if (DEBUG_ALL) return true;
	if (category && DEBUG_CATEGORIES.has(category)) return true;
	return false;
}
