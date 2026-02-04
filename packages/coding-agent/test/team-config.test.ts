import { describe, expect, test } from "bun:test";
import {
	getAvailablePresets,
	getPresetTemplate,
	loadCustomTeams,
	type ParsedModelString,
	parseModelString,
	validateModelAgainstRegistry,
} from "../src/core/team-config.js";

describe("parseModelString", () => {
	test("parses provider:model format", () => {
		const result = parseModelString("anthropic:claude-3-5-sonnet-20241022");
		expect(result).toEqual({
			provider: "anthropic",
			modelId: "claude-3-5-sonnet-20241022",
			thinking: undefined,
		});
	});

	test("parses provider:model:thinking format", () => {
		const result = parseModelString("openai:gpt-4o:medium");
		expect(result).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
			thinking: "medium",
		});
	});

	test("parses all valid thinking levels", () => {
		const levels = ["off", "low", "medium", "high"] as const;
		for (const level of levels) {
			const result = parseModelString(`anthropic:claude:${level}`);
			expect(result?.thinking).toBe(level);
		}
	});

	test("returns null for invalid thinking level", () => {
		const result = parseModelString("anthropic:claude:ultra");
		expect(result).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(parseModelString("")).toBeNull();
	});

	test("returns null for missing provider", () => {
		expect(parseModelString(":model-id")).toBeNull();
	});

	test("returns null for missing model", () => {
		expect(parseModelString("provider:")).toBeNull();
	});

	test("returns null for single segment", () => {
		expect(parseModelString("just-a-model")).toBeNull();
	});

	test("returns null for too many segments", () => {
		expect(parseModelString("a:b:c:d")).toBeNull();
	});

	test("handles complex model IDs with hyphens", () => {
		const result = parseModelString("google:gemini-2.0-flash-thinking-exp-01-21");
		expect(result).toEqual({
			provider: "google",
			modelId: "gemini-2.0-flash-thinking-exp-01-21",
			thinking: undefined,
		});
	});
});

describe("validateModelAgainstRegistry", () => {
	const mockRegistry = {
		find: (provider: string, modelId: string) => {
			if (provider === "anthropic" && modelId === "claude-3-5-sonnet-20241022") {
				return { id: modelId, provider } as any;
			}
			return undefined;
		},
	};

	test("returns undefined for valid model", () => {
		const parsed: ParsedModelString = {
			provider: "anthropic",
			modelId: "claude-3-5-sonnet-20241022",
		};
		const error = validateModelAgainstRegistry(parsed, mockRegistry);
		expect(error).toBeUndefined();
	});

	test("returns error for unknown model", () => {
		const parsed: ParsedModelString = {
			provider: "anthropic",
			modelId: "nonexistent-model",
		};
		const error = validateModelAgainstRegistry(parsed, mockRegistry);
		expect(error).toBe("Model not found: anthropic:nonexistent-model");
	});

	test("returns error for unknown provider", () => {
		const parsed: ParsedModelString = {
			provider: "unknown",
			modelId: "some-model",
		};
		const error = validateModelAgainstRegistry(parsed, mockRegistry);
		expect(error).toBe("Model not found: unknown:some-model");
	});
});

describe("getAvailablePresets", () => {
	test("returns all built-in presets", () => {
		const presets = getAvailablePresets();
		expect(presets).toContain("code-reviewer");
		expect(presets).toContain("security-auditor");
		expect(presets).toContain("perf-analyzer");
		expect(presets).toContain("merge-synthesizer");
		expect(presets.length).toBe(4);
	});
});

describe("getPresetTemplate", () => {
	test("returns template for known preset", () => {
		const template = getPresetTemplate("code-reviewer");
		expect(template).toBeDefined();
		expect(template?.name).toBe("code-reviewer");
		expect(template?.systemPrompt).toBeTruthy();
	});

	test("returns undefined for unknown preset", () => {
		const template = getPresetTemplate("nonexistent");
		expect(template).toBeUndefined();
	});
});

describe("loadCustomTeams", () => {
	test("returns empty teams when no config files exist", () => {
		// Use a path that definitely won't have config files
		const result = loadCustomTeams("/tmp/nonexistent-path-for-test");
		expect(result.teams).toEqual([]);
		expect(result.errors).toEqual([]);
	});
});
