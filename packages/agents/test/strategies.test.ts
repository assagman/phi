import { describe, expect, it } from "vitest";
import type { Finding } from "../src/index.js";
import { calculateSimilarity, clusterFindings, rankFindings } from "../src/strategies/index.js";
import { intersectionExecutor } from "../src/strategies/intersection.js";
import { unionExecutor } from "../src/strategies/union.js";

// Helper to create test findings
function createFinding(overrides: Partial<Finding> = {}): Finding {
	return {
		id: "test-1",
		agentName: "test-agent",
		severity: "medium",
		category: "bug",
		title: "Test Finding",
		description: "Test description",
		...overrides,
	};
}

describe("calculateSimilarity", () => {
	it("should return 1.0 for identical findings", () => {
		const f1 = createFinding({ file: "test.ts", line: 10, title: "Bug in function" });
		const f2 = createFinding({ file: "test.ts", line: 10, title: "Bug in function" });

		expect(calculateSimilarity(f1, f2)).toBe(1);
	});

	it("should return high similarity for same file and line", () => {
		const f1 = createFinding({ file: "test.ts", line: 10, title: "First finding" });
		const f2 = createFinding({ file: "test.ts", line: 10, title: "Second finding" });

		const similarity = calculateSimilarity(f1, f2);
		expect(similarity).toBeGreaterThan(0.4);
	});

	it("should return lower similarity for different files", () => {
		const f1 = createFinding({ file: "a.ts", line: 10, title: "Finding" });
		const f2 = createFinding({ file: "b.ts", line: 10, title: "Finding" });

		const similarity = calculateSimilarity(f1, f2);
		expect(similarity).toBeLessThan(0.8);
	});

	it("should return lower similarity for different lines", () => {
		const f1 = createFinding({ file: "test.ts", line: 10, title: "Finding" });
		const f2 = createFinding({ file: "test.ts", line: 100, title: "Finding" });

		const similarity = calculateSimilarity(f1, f2);
		expect(similarity).toBeLessThan(0.8);
	});

	it("should handle missing file/line gracefully", () => {
		const f1 = createFinding({ title: "General finding" });
		const f2 = createFinding({ title: "General finding" });

		const similarity = calculateSimilarity(f1, f2);
		expect(similarity).toBeGreaterThanOrEqual(0);
		expect(similarity).toBeLessThanOrEqual(1);
	});
});

describe("clusterFindings", () => {
	it("should cluster identical findings", () => {
		const findings: Finding[] = [
			createFinding({ id: "1", agentName: "agent-a", file: "test.ts", line: 10, title: "Bug" }),
			createFinding({ id: "2", agentName: "agent-b", file: "test.ts", line: 10, title: "Bug" }),
		];

		const clusters = clusterFindings(findings, 0.6);

		expect(clusters).toHaveLength(1);
		expect(clusters[0].agreementCount).toBe(2);
		expect(clusters[0].related).toHaveLength(1);
	});

	it("should separate distinct findings", () => {
		const findings: Finding[] = [
			createFinding({ id: "1", agentName: "agent-a", file: "a.ts", line: 10, title: "Issue A" }),
			createFinding({ id: "2", agentName: "agent-b", file: "b.ts", line: 100, title: "Different Issue B" }),
		];

		const clusters = clusterFindings(findings, 0.6);

		expect(clusters).toHaveLength(2);
		expect(clusters[0].agreementCount).toBe(1);
		expect(clusters[1].agreementCount).toBe(1);
	});

	it("should handle empty findings", () => {
		const clusters = clusterFindings([], 0.6);
		expect(clusters).toHaveLength(0);
	});

	it("should handle single finding", () => {
		const findings: Finding[] = [createFinding({ id: "1" })];

		const clusters = clusterFindings(findings, 0.6);

		expect(clusters).toHaveLength(1);
		expect(clusters[0].agreementCount).toBe(1);
		expect(clusters[0].related).toHaveLength(0);
	});
});

describe("rankFindings", () => {
	it("should rank critical findings first", () => {
		const findings: Finding[] = [
			createFinding({ id: "1", severity: "low", title: "Low" }),
			createFinding({ id: "2", severity: "critical", title: "Critical" }),
			createFinding({ id: "3", severity: "medium", title: "Medium" }),
		];

		const ranked = rankFindings(findings);

		expect(ranked[0].severity).toBe("critical");
		expect(ranked[1].severity).toBe("medium");
		expect(ranked[2].severity).toBe("low");
	});

	it("should use confidence as secondary sort", () => {
		const findings: Finding[] = [
			createFinding({ id: "1", severity: "high", confidence: 0.5 }),
			createFinding({ id: "2", severity: "high", confidence: 0.9 }),
			createFinding({ id: "3", severity: "high", confidence: 0.7 }),
		];

		const ranked = rankFindings(findings);

		expect(ranked[0].confidence).toBe(0.9);
		expect(ranked[1].confidence).toBe(0.7);
		expect(ranked[2].confidence).toBe(0.5);
	});
});

describe("unionExecutor", () => {
	it("should include all findings", async () => {
		const findings: Finding[] = [
			createFinding({ id: "1", agentName: "agent-a" }),
			createFinding({ id: "2", agentName: "agent-b" }),
			createFinding({ id: "3", agentName: "agent-c" }),
		];

		const result = await unionExecutor.execute(findings, {});

		expect(result.findings).toHaveLength(3);
	});

	it("should rank findings by severity", async () => {
		const findings: Finding[] = [
			createFinding({ id: "1", severity: "low" }),
			createFinding({ id: "2", severity: "critical" }),
		];

		const result = await unionExecutor.execute(findings, {});

		expect(result.findings[0].severity).toBe("critical");
		expect(result.findings[1].severity).toBe("low");
	});

	it("should cluster similar findings", async () => {
		const findings: Finding[] = [
			createFinding({ id: "1", agentName: "agent-a", file: "x.ts", line: 5, title: "Same issue" }),
			createFinding({ id: "2", agentName: "agent-b", file: "x.ts", line: 5, title: "Same issue" }),
		];

		const result = await unionExecutor.execute(findings, {});

		expect(result.clusters.length).toBeGreaterThan(0);
		expect(result.clusters[0].agreementCount).toBe(2);
	});
});

describe("intersectionExecutor", () => {
	it("should only include findings with agreement", async () => {
		const findings: Finding[] = [
			// Two agents agree on this
			createFinding({ id: "1", agentName: "agent-a", file: "x.ts", line: 5, title: "Agreed" }),
			createFinding({ id: "2", agentName: "agent-b", file: "x.ts", line: 5, title: "Agreed" }),
			// Only one agent found this
			createFinding({ id: "3", agentName: "agent-a", file: "y.ts", line: 100, title: "Unique" }),
		];

		const result = await intersectionExecutor.execute(findings, {});

		// Should only include the agreed-upon finding
		expect(result.findings.length).toBeLessThan(3);
		const hasAgreed = result.findings.some((f) => f.title === "Agreed");
		expect(hasAgreed).toBe(true);
	});

	it("should return empty for no agreement", async () => {
		const findings: Finding[] = [
			createFinding({ id: "1", agentName: "agent-a", file: "a.ts", line: 1, title: "Unique A" }),
			createFinding({ id: "2", agentName: "agent-b", file: "b.ts", line: 100, title: "Unique B" }),
		];

		const result = await intersectionExecutor.execute(findings, {});

		expect(result.findings).toHaveLength(0);
	});
});
