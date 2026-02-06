/**
 * Platform detection utilities.
 */

import { readFileSync } from "node:fs";
import type { Platform } from "./types.js";

export function getWslVersion(): string | undefined {
	if (process.platform !== "linux") {
		return undefined;
	}
	try {
		const procVersion = readFileSync("/proc/version", { encoding: "utf8" });
		const wslVersionMatch = procVersion.match(/WSL(\d+)/i);
		if (wslVersionMatch?.[1]) {
			return wslVersionMatch[1];
		}
		if (procVersion.toLowerCase().includes("microsoft")) {
			return "1";
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function getPlatform(): Platform {
	switch (process.platform) {
		case "darwin":
			return "macos";
		case "linux":
			return "linux";
		case "win32":
			return "windows";
		default:
			return "unknown";
	}
}
