/**
 * Synchronous `which` — find an executable in PATH.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export function whichSync(command: string): string | null {
	// If absolute path, check directly
	if (command.startsWith("/")) {
		try {
			const stat = statSync(command);
			if (stat.isFile()) return command;
		} catch {
			return null;
		}
		return null;
	}

	const pathDirs = (process.env.PATH || "").split(":");
	for (const dir of pathDirs) {
		if (!dir) continue;
		const full = join(dir, command);
		try {
			if (existsSync(full) && statSync(full).isFile()) {
				return full;
			}
		} catch {}
	}
	return null;
}
