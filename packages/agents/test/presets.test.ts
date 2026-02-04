import { getModel } from "ai";
import { describe, expect, it } from "vitest";
import {
	codeReviewerTemplate,
	createPreset,
	mergeSynthesizerTemplate,
	perfAnalyzerTemplate,
	securityAuditorTemplate,
} from "../src/index.js";

describe("Preset Templates", () => {
	describe("codeReviewerTemplate", () => {
		it("should have required fields", () => {
			expect(codeReviewerTemplate.name).toBe("code-reviewer");
			expect(codeReviewerTemplate.description).toBeDefined();
			expect(codeReviewerTemplate.systemPrompt).toContain("code reviewer");
			expect(codeReviewerTemplate.thinkingLevel).toBe("medium");
			expect(codeReviewerTemplate.temperature).toBe(0.3);
		});

		it("should include output format instructions", () => {
			expect(codeReviewerTemplate.systemPrompt).toContain("### Finding:");
			expect(codeReviewerTemplate.systemPrompt).toContain("**Severity:**");
			expect(codeReviewerTemplate.systemPrompt).toContain("**Category:**");
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

	describe("mergeSynthesizerTemplate", () => {
		it("should have required fields", () => {
			expect(mergeSynthesizerTemplate.name).toBe("merge-synthesizer");
			expect(mergeSynthesizerTemplate.description).toBeDefined();
			expect(mergeSynthesizerTemplate.systemPrompt).toContain("verify");
		});
	});
});

describe("createPreset", () => {
	it("should create preset from template and model", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const preset = createPreset(codeReviewerTemplate, model);

		expect(preset.name).toBe(codeReviewerTemplate.name);
		expect(preset.description).toBe(codeReviewerTemplate.description);
		expect(preset.model).toBe(model);
		expect(preset.systemPrompt).toBe(codeReviewerTemplate.systemPrompt);
		expect(preset.thinkingLevel).toBe(codeReviewerTemplate.thinkingLevel);
		expect(preset.temperature).toBe(codeReviewerTemplate.temperature);
	});

	it("should allow overrides", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const preset = createPreset(codeReviewerTemplate, model, {
			thinkingLevel: "high",
			temperature: 0.5,
		});

		expect(preset.thinkingLevel).toBe("high");
		expect(preset.temperature).toBe(0.5);
		// Other fields unchanged
		expect(preset.name).toBe(codeReviewerTemplate.name);
		expect(preset.systemPrompt).toBe(codeReviewerTemplate.systemPrompt);
	});

	it("should work with different models", () => {
		const openaiModel = getModel("openai", "gpt-4o-mini");
		const anthropicModel = getModel("anthropic", "claude-3-5-sonnet-20241022");

		const preset1 = createPreset(codeReviewerTemplate, openaiModel);
		const preset2 = createPreset(codeReviewerTemplate, anthropicModel);

		expect(preset1.model.provider).toBe("openai");
		expect(preset2.model.provider).toBe("anthropic");
	});
});
