/**
 * Tests for AgentTaskTracker class.
 * Verifies epsilon task state parsing, progress tracking, and edge cases.
 */

import { describe, expect, it } from "bun:test";

// We test the parsing logic directly using the same regex patterns as AgentTaskTracker.
// This ensures the patterns work correctly without needing to export the class.

describe("Epsilon Task Output Parsing", () => {
	describe("Single Task Create Format", () => {
		it("should match single task create header", () => {
			const text = "Created task #1:\n✓ #1 [medium] My Task Title [tag]\n  todo | 2026-02-04";
			const match = text.match(/Created\s+task\s+#(\d+):/i);
			expect(match).not.toBeNull();
			expect(match![1]).toBe("1");
		});

		it("should extract title from task detail line", () => {
			const text = "Created task #1:\n✓ #1 [medium] My Task Title [tag]\n  todo | 2026-02-04";
			const titleMatch = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(titleMatch).not.toBeNull();
			expect(titleMatch![1].trim()).toBe("My Task Title");
		});

		it("should extract status from status line", () => {
			const text = "Created task #1:\n✓ #1 [medium] My Task Title\n  in_progress | 2026-02-04";
			const lines = text.split("\n");
			const statusLine = lines.find((l) => /^\s+(todo|planned|in_progress|blocked|done|cancelled)\s*\|/i.test(l));
			expect(statusLine).not.toBeUndefined();
			const status = statusLine!.match(/^\s+(todo|planned|in_progress|blocked|done|cancelled)/i)?.[1]?.toLowerCase();
			expect(status).toBe("in_progress");
		});

		it("should handle title with special characters", () => {
			const text = "Created task #42:\n✓ #42 [high] Fix bug: memory leak [urgent]\n  todo | 2026-02-04";
			const titleMatch = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(titleMatch).not.toBeNull();
			expect(titleMatch![1].trim()).toBe("Fix bug: memory leak");
		});
	});

	describe("Bulk Task Create Format", () => {
		it("should match bulk create lines", () => {
			const text = "Created 3/3 tasks:\nCreated #1: First Task\nCreated #2: Second Task\nCreated #3: Third Task";
			const matches = [...text.matchAll(/Created\s+#(\d+):\s+([^\n]+)/gi)];
			expect(matches.length).toBe(3);
			expect(matches[0][1]).toBe("1");
			expect(matches[0][2]).toBe("First Task");
			expect(matches[1][1]).toBe("2");
			expect(matches[2][1]).toBe("3");
		});

		it("should not match the summary line", () => {
			const text = "Created 3/3 tasks:\nCreated #1: First Task";
			// The summary "Created 3/3 tasks:" should not match the bulk pattern
			const matches = [...text.matchAll(/Created\s+#(\d+):\s+([^\n]+)/gi)];
			expect(matches.length).toBe(1);
			expect(matches[0][1]).toBe("1");
		});
	});

	describe("Single Task Update Format", () => {
		it("should match single task update header", () => {
			const text = "Updated task #5:\n✓ #5 [high] Updated Title\n  done | 2026-02-04";
			const match = text.match(/Updated\s+task\s+#(\d+):/i);
			expect(match).not.toBeNull();
			expect(match![1]).toBe("5");
		});

		it("should extract new status from update", () => {
			const text = "Updated task #5:\n✓ #5 [high] My Task\n  done | 2026-02-04";
			const lines = text.split("\n");
			const statusLine = lines.find((l) => /^\s+(todo|planned|in_progress|blocked|done|cancelled)\s*\|/i.test(l));
			const status = statusLine!.match(/^\s+(todo|planned|in_progress|blocked|done|cancelled)/i)?.[1]?.toLowerCase();
			expect(status).toBe("done");
		});

		it("should handle cancelled status", () => {
			const text = "Updated task #10:\n✗ #10 [low] Cancelled Task\n  cancelled | 2026-02-04";
			const lines = text.split("\n");
			const statusLine = lines.find((l) => /^\s+(todo|planned|in_progress|blocked|done|cancelled)\s*\|/i.test(l));
			const status = statusLine!.match(/^\s+(todo|planned|in_progress|blocked|done|cancelled)/i)?.[1]?.toLowerCase();
			expect(status).toBe("cancelled");
		});
	});

	describe("Bulk Task Update Format", () => {
		it("should match bulk update lines", () => {
			const text = "Updated 2/2 tasks:\nUpdated #1: First Updated\nUpdated #2: Second Updated";
			const matches = [...text.matchAll(/Updated\s+#(\d+):\s+([^\n]+)/gi)];
			expect(matches.length).toBe(2);
			expect(matches[0][1]).toBe("1");
			expect(matches[0][2]).toBe("First Updated");
		});
	});

	describe("Task Delete Format", () => {
		it("should match single delete with 'task' word", () => {
			const text = "Deleted task #7";
			const matches = [...text.matchAll(/Deleted(?:\s+task)?\s+#(\d+)/gi)];
			expect(matches.length).toBe(1);
			expect(matches[0][1]).toBe("7");
		});

		it("should match single delete without 'task' word", () => {
			const text = "Deleted #7";
			const matches = [...text.matchAll(/Deleted(?:\s+task)?\s+#(\d+)/gi)];
			expect(matches.length).toBe(1);
			expect(matches[0][1]).toBe("7");
		});

		it("should match bulk delete lines", () => {
			const text = "Deleted 3/3 tasks:\nDeleted #1\nDeleted #2\nDeleted #3";
			const matches = [...text.matchAll(/Deleted(?:\s+task)?\s+#(\d+)/gi)];
			expect(matches.length).toBe(3);
		});
	});

	describe("Status Icon Patterns", () => {
		it("should match todo icon (○)", () => {
			const text = "○ #1 [medium] Pending Task";
			const match = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(match).not.toBeNull();
		});

		it("should match planned icon (▣)", () => {
			const text = "▣ #1 [medium] Planned Task";
			const match = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(match).not.toBeNull();
		});

		it("should match in_progress icon (◐)", () => {
			const text = "◐ #1 [medium] In Progress Task";
			const match = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(match).not.toBeNull();
		});

		it("should match blocked icon (⊘)", () => {
			const text = "⊘ #1 [medium] Blocked Task";
			const match = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(match).not.toBeNull();
		});

		it("should match done icon (✓)", () => {
			const text = "✓ #1 [medium] Done Task";
			const match = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(match).not.toBeNull();
		});

		it("should match error icon (✗)", () => {
			const text = "✗ #1 [medium] Cancelled Task";
			const match = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(match).not.toBeNull();
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty result text", () => {
			const text = "";
			const match = text.match(/Created\s+task\s+#(\d+):/i);
			expect(match).toBeNull();
		});

		it("should handle malformed output", () => {
			const text = "Something went wrong";
			const createMatch = text.match(/Created\s+task\s+#(\d+):/i);
			const updateMatch = text.match(/Updated\s+task\s+#(\d+):/i);
			const deleteMatch = text.match(/Deleted(?:\s+task)?\s+#(\d+)/gi);
			expect(createMatch).toBeNull();
			expect(updateMatch).toBeNull();
			expect(deleteMatch).toBeNull();
		});

		it("should handle task not found response", () => {
			const text = "Task #999 not found";
			const createMatch = text.match(/Created\s+task\s+#(\d+):/i);
			expect(createMatch).toBeNull();
		});

		it("should handle high task IDs", () => {
			const text = "Created task #999999:\n✓ #999999 [low] Big ID Task\n  todo | 2026-02-04";
			const match = text.match(/Created\s+task\s+#(\d+):/i);
			expect(match).not.toBeNull();
			expect(match![1]).toBe("999999");
		});

		it("should handle title with brackets", () => {
			// Title with brackets should stop at the tag bracket
			const text = "✓ #1 [medium] Task [with] brackets [tag1, tag2]";
			const titleMatch = text.match(/[○▣◐⊘✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
			expect(titleMatch).not.toBeNull();
			expect(titleMatch![1].trim()).toBe("Task");
		});
	});
});

describe("AgentTaskInfo Calculation", () => {
	// Type for task status (matches TaskStatus in types.ts)
	type TaskStatus = "todo" | "planned" | "in_progress" | "blocked" | "done" | "cancelled";
	type TaskEntry = { title: string; status: TaskStatus };

	// These tests verify the getTaskInfo logic

	it("should count total tasks correctly", () => {
		// Simulating task map with explicit type
		const tasks = new Map<number, TaskEntry>([
			[1, { title: "Task 1", status: "todo" }],
			[2, { title: "Task 2", status: "in_progress" }],
			[3, { title: "Task 3", status: "done" }],
		]);

		let total = 0;
		let completed = 0;
		for (const task of tasks.values()) {
			total++;
			if (task.status === "done" || task.status === "cancelled") {
				completed++;
			}
		}

		expect(total).toBe(3);
		expect(completed).toBe(1);
	});

	it("should find active task title", () => {
		const tasks = new Map<number, TaskEntry>([
			[1, { title: "Task 1", status: "done" }],
			[2, { title: "Active Task", status: "in_progress" }],
			[3, { title: "Task 3", status: "todo" }],
		]);

		let activeTaskTitle: string | undefined;
		for (const task of tasks.values()) {
			if (task.status === "in_progress" && !activeTaskTitle) {
				activeTaskTitle = task.title;
			}
		}

		expect(activeTaskTitle).toBe("Active Task");
	});

	it("should return first in_progress task as active", () => {
		const tasks = new Map<number, TaskEntry>([
			[1, { title: "First Active", status: "in_progress" }],
			[2, { title: "Second Active", status: "in_progress" }],
		]);

		let activeTaskTitle: string | undefined;
		for (const task of tasks.values()) {
			if (task.status === "in_progress" && !activeTaskTitle) {
				activeTaskTitle = task.title;
			}
		}

		expect(activeTaskTitle).toBe("First Active");
	});

	it("should count cancelled as completed", () => {
		const tasks = new Map<number, TaskEntry>([
			[1, { title: "Done", status: "done" }],
			[2, { title: "Cancelled", status: "cancelled" }],
			[3, { title: "Todo", status: "todo" }],
		]);

		let completed = 0;
		for (const task of tasks.values()) {
			if (task.status === "done" || task.status === "cancelled") {
				completed++;
			}
		}

		expect(completed).toBe(2);
	});
});
