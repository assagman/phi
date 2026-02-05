import { getModel } from "ai";
import { describe, expect, it } from "vitest";
import {
	createPreset,
	explorerTemplate,
	perfAnalyzerTemplate,
	plannerTemplate,
	reviewerTemplate,
	securityAuditorTemplate,
} from "../src/index.js";

describe("Preset Templates", () => {
	describe("reviewerTemplate", () => {
		it("should have required fields", () => {
			expect(reviewerTemplate.name).toBe("reviewer");
			expect(reviewerTemplate.description).toBeDefined();
			expect(reviewerTemplate.systemPrompt).toContain("code reviewer");
			expect(reviewerTemplate.thinkingLevel).toBe("high");
			expect(reviewerTemplate.temperature).toBe(0.2);
		});

		it("should include output format instructions", () => {
			expect(reviewerTemplate.systemPrompt).toContain("## Critical");
			expect(reviewerTemplate.systemPrompt).toContain("## Warnings");
			expect(reviewerTemplate.systemPrompt).toContain("## Summary");
		});

		it("should include git-diff awareness", () => {
			expect(reviewerTemplate.systemPrompt).toContain("git diff");
		});
	});

	describe("explorerTemplate", () => {
		it("should have required fields", () => {
			expect(explorerTemplate.name).toBe("explorer");
			expect(explorerTemplate.description).toBeDefined();
			expect(explorerTemplate.systemPrompt).toContain("explorer");
			expect(explorerTemplate.thinkingLevel).toBe("low");
			expect(explorerTemplate.temperature).toBe(0.1);
		});

		it("should include structured output format", () => {
			expect(explorerTemplate.systemPrompt).toContain("### Files");
			expect(explorerTemplate.systemPrompt).toContain("### Key Code");
			expect(explorerTemplate.systemPrompt).toContain("### Structure");
		});
	});

	describe("plannerTemplate", () => {
		it("should have required fields", () => {
			expect(plannerTemplate.name).toBe("planner");
			expect(plannerTemplate.description).toBeDefined();
			expect(plannerTemplate.systemPrompt).toContain("planner");
			expect(plannerTemplate.thinkingLevel).toBe("high");
			expect(plannerTemplate.temperature).toBe(0.2);
		});

		it("should include plan structure", () => {
			expect(plannerTemplate.systemPrompt).toContain("## Goal");
			expect(plannerTemplate.systemPrompt).toContain("## Plan");
			expect(plannerTemplate.systemPrompt).toContain("## Risks");
			expect(plannerTemplate.systemPrompt).toContain("## Verification");
		});
	});

	describe("securityAuditorTemplate", () => {
		it("should have required fields", () => {
			expect(securityAuditorTemplate.name).toBe("security-auditor");
			expect(securityAuditorTemplate.description).toBeDefined();
			expect(securityAuditorTemplate.systemPrompt).toContain("security");
		});

		it("should include security-specific guidance", () => {
			expect(securityAuditorTemplate.systemPrompt).toContain("OWASP");
		});
	});

	describe("perfAnalyzerTemplate", () => {
		it("should have required fields", () => {
			expect(perfAnalyzerTemplate.name).toBe("perf-analyzer");
			expect(perfAnalyzerTemplate.description).toBeDefined();
			expect(perfAnalyzerTemplate.systemPrompt).toContain("performance");
		});

		it("should include performance categories", () => {
			expect(perfAnalyzerTemplate.systemPrompt).toContain("complexity");
		});
	});
});

describe("createPreset", () => {
	it("should create preset from template and model", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const preset = createPreset(reviewerTemplate, model);

		expect(preset.name).toBe(reviewerTemplate.name);
		expect(preset.description).toBe(reviewerTemplate.description);
		expect(preset.model).toBe(model);
		expect(preset.systemPrompt).toBe(reviewerTemplate.systemPrompt);
		expect(preset.thinkingLevel).toBe(reviewerTemplate.thinkingLevel);
		expect(preset.temperature).toBe(reviewerTemplate.temperature);
	});

	it("should allow overrides", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const preset = createPreset(reviewerTemplate, model, {
			thinkingLevel: "high",
			temperature: 0.5,
		});

		expect(preset.thinkingLevel).toBe("high");
		expect(preset.temperature).toBe(0.5);
		// Other fields unchanged
		expect(preset.name).toBe(reviewerTemplate.name);
		expect(preset.systemPrompt).toBe(reviewerTemplate.systemPrompt);
	});

	it("should work with different models", () => {
		const openaiModel = getModel("openai", "gpt-4o-mini");
		const anthropicModel = getModel("anthropic", "claude-3-5-sonnet-20241022");

		const preset1 = createPreset(reviewerTemplate, openaiModel);
		const preset2 = createPreset(reviewerTemplate, anthropicModel);

		expect(preset1.model.provider).toBe("openai");
		expect(preset2.model.provider).toBe("anthropic");
	});
});
