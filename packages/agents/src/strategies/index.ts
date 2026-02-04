import type { MergeStrategyType } from "../types.js";
import { intersectionExecutor } from "./intersection.js";
import type { MergeExecutor } from "./types.js";
import { unionExecutor } from "./union.js";
import { verificationExecutor } from "./verification.js";

export { intersectionExecutor } from "./intersection.js";
// Re-export types and utilities
export type { MergeExecutor, MergeExecutorOptions, MergeResult } from "./types.js";
export { calculateSimilarity, clusterFindings, rankFindings } from "./types.js";
// Re-export executors
export { unionExecutor } from "./union.js";
export { verificationExecutor } from "./verification.js";

/**
 * Registry of merge strategy executors.
 */
const executors: Record<Exclude<MergeStrategyType, "custom">, MergeExecutor> = {
	union: unionExecutor,
	intersection: intersectionExecutor,
	verification: verificationExecutor,
};

/**
 * Get a merge executor by strategy type.
 * Returns undefined for "custom" (handled externally).
 */
export function getMergeExecutor(strategy: MergeStrategyType): MergeExecutor | undefined {
	if (strategy === "custom") return undefined;
	return executors[strategy];
}
