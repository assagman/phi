import { getModel } from "ai";
import { describe, expect, it } from "vitest";
import { committerTemplate, createPreset, explorerTemplate, plannerTemplate, reviewerTemplate } from "../src/index.js";

describe("Preset Templates", () => {
	describe("committerTemplate", () => {
		it("should have required fields", () => {
			expect(committerTemplate.name).toBe("committer");
			expect(committerTemplate.description).toBeDefined();
			expect(committerTemplate.systemPrompt).toContain("commit");
			expect(committerTemplate.model).toBe("kimi-for-coding/k2p5");
			expect(committerTemplate.thinkingLevel).toBe("medium");
			expect(committerTemplate.temperature).toBe(0.3);
		});

		it("should include commit workflow", () => {
			expect(committerTemplate.systemPrompt).toContain("git log --oneline");
			expect(committerTemplate.systemPrompt).toContain("git status");
		});
	});

	describe("reviewerTemplate", () => {
		it("should have required fields", () => {
			expect(reviewerTemplate.name).toBe("reviewer");
			expect(reviewerTemplate.description).toBeDefined();
			expect(reviewerTemplate.systemPrompt).toContain("code reviewer");
			expect(reviewerTemplate.model).toBe("openai-codex/gpt-5.2");
			expect(reviewerTemplate.thinkingLevel).toBe("high");
			expect(reviewerTemplate.temperature).toBe(0.6);
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
			expect(explorerTemplate.model).toBe("kimi-for-coding/k2p5");
			expect(explorerTemplate.thinkingLevel).toBe("medium");
			expect(explorerTemplate.temperature).toBe(0.6);
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
			expect(plannerTemplate.model).toBe("openai-codex/gpt-5.2");
			expect(plannerTemplate.thinkingLevel).toBe("high");
			expect(plannerTemplate.temperature).toBe(0.3);
		});

		it("should include plan structure", () => {
			expect(plannerTemplate.systemPrompt).toContain("## Goal");
			expect(plannerTemplate.systemPrompt).toContain("## Plan");
			expect(plannerTemplate.systemPrompt).toContain("## Risks");
			expect(plannerTemplate.systemPrompt).toContain("## Verification");
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
