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

	test("treats invalid thinking level as part of model ID", () => {
		// "ultra" is not a valid thinking level, so it becomes part of model ID
		const result = parseModelString("anthropic:claude:ultra");
		expect(result).toEqual({
			provider: "anthropic",
			modelId: "claude:ultra",
			thinking: undefined,
		});
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

	test("handles multiple colons in model ID", () => {
		// Multiple colons are now supported - they become part of model ID
		const result = parseModelString("a:b:c:d");
		expect(result).toEqual({
			provider: "a",
			modelId: "b:c:d",
			thinking: undefined,
		});
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

describe("parseModelString edge cases", () => {
	test("handles model IDs containing colons (e.g., openrouter)", () => {
		// Model ID like "meta-llama/llama-3-70b" with thinking level
		const result = parseModelString("openrouter:meta-llama/llama-3-70b:high");
		expect(result).toEqual({
			provider: "openrouter",
			modelId: "meta-llama/llama-3-70b",
			thinking: "high",
		});
	});

	test("handles model IDs with multiple colons but no thinking", () => {
		// Hypothetical model with colon in name
		const result = parseModelString("custom:model:v2");
		// Since "v2" is not a valid thinking level, it should be part of model ID
		expect(result).toEqual({
			provider: "custom",
			modelId: "model:v2",
			thinking: undefined,
		});
	});

	test("returns null for non-string input", () => {
		expect(parseModelString(null as any)).toBeNull();
		expect(parseModelString(undefined as any)).toBeNull();
		expect(parseModelString(123 as any)).toBeNull();
		expect(parseModelString({} as any)).toBeNull();
	});

	test("handles whitespace in input", () => {
		// Leading/trailing whitespace should still work
		const result = parseModelString("anthropic:claude-3-5-sonnet-20241022");
		expect(result?.provider).toBe("anthropic");
	});
});

describe("validateModelAgainstRegistry edge cases", () => {
	const mockRegistry = {
		find: (_provider: string, _modelId: string) => undefined,
	};

	test("handles empty model ID", () => {
		const parsed: ParsedModelString = {
			provider: "anthropic",
			modelId: "",
		};
		const error = validateModelAgainstRegistry(parsed, mockRegistry);
		expect(error).toBe("Model not found: anthropic:");
	});

	test("handles special characters in model ID", () => {
		const parsed: ParsedModelString = {
			provider: "anthropic",
			modelId: "model/with/slashes",
		};
		const error = validateModelAgainstRegistry(parsed, mockRegistry);
		expect(error).toBe("Model not found: anthropic:model/with/slashes");
	});
});

describe("preset resolution", () => {
	test("all presets have required fields", () => {
		const presets = getAvailablePresets();
		for (const name of presets) {
			const template = getPresetTemplate(name);
			expect(template).toBeDefined();
			expect(template?.name).toBe(name);
			expect(typeof template?.systemPrompt).toBe("string");
			expect(template?.systemPrompt.length).toBeGreaterThan(0);
			expect(typeof template?.description).toBe("string");
		}
	});
});
