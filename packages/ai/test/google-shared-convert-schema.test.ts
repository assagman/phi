import { describe, expect, test } from "vitest";
import { convertSchema } from "../src/providers/google-shared.js";

describe("convertSchema", () => {
	// -------------------------------------------------------------------
	// Guard clause: null, undefined, primitives
	// -------------------------------------------------------------------

	test("returns null as-is", () => {
		expect(convertSchema(null as any)).toBeNull();
	});

	test("returns undefined as-is", () => {
		expect(convertSchema(undefined as any)).toBeUndefined();
	});

	test("returns primitive string as-is", () => {
		expect(convertSchema("hello" as any)).toBe("hello");
	});

	test("returns empty object as-is", () => {
		expect(convertSchema({})).toEqual({});
	});

	// -------------------------------------------------------------------
	// const stripping
	// -------------------------------------------------------------------

	test("strips standalone const field", () => {
		const input = { const: "only_value", type: "string" };
		expect(convertSchema(input)).toEqual({ type: "string" });
	});

	test("strips const with no type field", () => {
		const input = { const: "x" };
		expect(convertSchema(input)).toEqual({});
	});

	test("strips const and preserves other fields", () => {
		const input = { const: "x", type: "string", description: "a field" };
		expect(convertSchema(input)).toEqual({ type: "string", description: "a field" });
	});

	// -------------------------------------------------------------------
	// anyOf: all-const → enum
	// -------------------------------------------------------------------

	test("converts anyOf with const items to enum", () => {
		const input = {
			anyOf: [
				{ const: "red", type: "string" },
				{ const: "green", type: "string" },
				{ const: "blue", type: "string" },
			],
		};
		expect(convertSchema(input)).toEqual({
			type: "string",
			format: "enum",
			enum: ["red", "green", "blue"],
		});
	});

	test("converts single-item anyOf with const to enum", () => {
		const input = {
			anyOf: [{ const: "only", type: "string" }],
		};
		expect(convertSchema(input)).toEqual({
			type: "string",
			format: "enum",
			enum: ["only"],
		});
	});

	test("defaults type to string when const items lack type", () => {
		const input = {
			anyOf: [{ const: "a" }, { const: "b" }],
		};
		expect(convertSchema(input)).toEqual({
			type: "string",
			format: "enum",
			enum: ["a", "b"],
		});
	});

	test("preserves integer type for integer const values", () => {
		// Google SDK example 2: {type:INTEGER, format:enum, enum:["101", "201", "301"]}
		const input = {
			anyOf: [
				{ const: 1, type: "integer" },
				{ const: 2, type: "integer" },
			],
		};
		expect(convertSchema(input)).toEqual({
			type: "integer",
			format: "enum",
			enum: ["1", "2"],
		});
	});

	test("preserves number type for number const values", () => {
		const input = {
			anyOf: [
				{ const: 1.5, type: "number" },
				{ const: 2.5, type: "number" },
			],
		};
		expect(convertSchema(input)).toEqual({
			type: "number",
			format: "enum",
			enum: ["1.5", "2.5"],
		});
	});

	test("infers integer type from const values when items lack type", () => {
		const input = {
			anyOf: [{ const: 101 }, { const: 201 }, { const: 301 }],
		};
		expect(convertSchema(input)).toEqual({
			type: "integer",
			format: "enum",
			enum: ["101", "201", "301"],
		});
	});

	test("infers number type from const values when items lack type and values are floats", () => {
		const input = {
			anyOf: [{ const: 1.5 }, { const: 2.5 }],
		};
		expect(convertSchema(input)).toEqual({
			type: "number",
			format: "enum",
			enum: ["1.5", "2.5"],
		});
	});

	test("falls back to string for mixed-type const values", () => {
		const input = {
			anyOf: [
				{ const: "a", type: "string" },
				{ const: 1, type: "integer" },
			],
		};
		expect(convertSchema(input)).toEqual({
			type: "string",
			format: "enum",
			enum: ["a", "1"],
		});
	});

	test("preserves description on parent when converting anyOf to enum", () => {
		const input = {
			description: "Pick a color",
			anyOf: [
				{ const: "red", type: "string" },
				{ const: "blue", type: "string" },
			],
		};
		expect(convertSchema(input)).toEqual({
			description: "Pick a color",
			type: "string",
			format: "enum",
			enum: ["red", "blue"],
		});
	});

	test("strips const from anyOf parent when both const and anyOf present", () => {
		// Edge: node has both const and anyOf (malformed but possible)
		const input = {
			const: "stale",
			anyOf: [
				{ const: "a", type: "string" },
				{ const: "b", type: "string" },
			],
		};
		const result = convertSchema(input);
		expect(result).not.toHaveProperty("const");
		expect(result).toEqual({ type: "string", format: "enum", enum: ["a", "b"] });
	});

	// -------------------------------------------------------------------
	// anyOf: empty
	// -------------------------------------------------------------------

	test("passes empty anyOf through with recursive map", () => {
		const input = { anyOf: [] as Record<string, unknown>[] };
		// flattened.length === 0 → else branch → map returns []
		expect(convertSchema(input)).toEqual({ anyOf: [] });
	});

	// -------------------------------------------------------------------
	// anyOf: mixed schemas → keep anyOf, recurse children
	// -------------------------------------------------------------------

	test("keeps mixed anyOf (const union + array) and sanitizes children", () => {
		// Type.Union([TaskStatusEnum, Type.Array(TaskStatusEnum)])
		const input = {
			anyOf: [
				{
					anyOf: [
						{ const: "todo", type: "string" },
						{ const: "done", type: "string" },
					],
				},
				{
					type: "array",
					items: {
						anyOf: [
							{ const: "todo", type: "string" },
							{ const: "done", type: "string" },
						],
					},
				},
			],
		};
		expect(convertSchema(input)).toEqual({
			anyOf: [
				{ type: "string", format: "enum", enum: ["todo", "done"] },
				{
					type: "array",
					items: { type: "string", format: "enum", enum: ["todo", "done"] },
				},
			],
		});
	});

	test("handles nullable union (Type.Union([Type.Number(), Type.Null()]))", () => {
		const input = {
			anyOf: [{ type: "number" }, { type: "null" }],
		};
		expect(convertSchema(input)).toEqual({
			anyOf: [{ type: "number" }, { type: "null" }],
		});
	});

	test("strips const in mixed anyOf branches without collapsing", () => {
		// anyOf with one const item and one non-const item — not all const
		const input = {
			anyOf: [{ const: "x", type: "string" }, { type: "number" }],
		};
		expect(convertSchema(input)).toEqual({
			anyOf: [{ type: "string" }, { type: "number" }],
		});
	});

	// -------------------------------------------------------------------
	// flattenAnyOf: nested anyOf handling
	// -------------------------------------------------------------------

	test("flattens nested anyOf-of-const (union of union)", () => {
		const input = {
			anyOf: [
				{
					anyOf: [
						{ const: "a", type: "string" },
						{ const: "b", type: "string" },
					],
				},
				{ anyOf: [{ const: "c", type: "string" }] },
			],
		};
		expect(convertSchema(input)).toEqual({
			type: "string",
			format: "enum",
			enum: ["a", "b", "c"],
		});
	});

	test("does not flatten inner anyOf when inner items are mixed (not all const)", () => {
		// Inner anyOf has const + non-const → kept as-is, recursed
		const input = {
			anyOf: [
				{
					anyOf: [{ const: "a", type: "string" }, { type: "number" }],
				},
			],
		};
		// Inner anyOf is mixed → not flattened → outer not all-const → recurse
		// Inner: mixed anyOf → recurse each: strip const from first, number stays
		expect(convertSchema(input)).toEqual({
			anyOf: [
				{
					anyOf: [{ type: "string" }, { type: "number" }],
				},
			],
		});
	});

	test("flattens mix of inner anyOf-of-const and bare const items", () => {
		const input = {
			anyOf: [{ anyOf: [{ const: "a", type: "string" }] }, { const: "b", type: "string" }],
		};
		// flatten: inner all-const → spread "a", then bare "b" → all const → enum
		expect(convertSchema(input)).toEqual({
			type: "string",
			format: "enum",
			enum: ["a", "b"],
		});
	});

	// -------------------------------------------------------------------
	// Recursion: properties
	// -------------------------------------------------------------------

	test("recurses into object properties", () => {
		const input = {
			type: "object",
			properties: {
				name: { type: "string" },
				priority: {
					anyOf: [
						{ const: "low", type: "string" },
						{ const: "high", type: "string" },
					],
				},
			},
		};
		expect(convertSchema(input)).toEqual({
			type: "object",
			properties: {
				name: { type: "string" },
				priority: { type: "string", format: "enum", enum: ["low", "high"] },
			},
		});
	});

	// -------------------------------------------------------------------
	// Recursion: items
	// -------------------------------------------------------------------

	test("recurses into array items (single schema)", () => {
		const input = {
			type: "array",
			items: {
				anyOf: [
					{ const: "a", type: "string" },
					{ const: "b", type: "string" },
				],
			},
		};
		expect(convertSchema(input)).toEqual({
			type: "array",
			items: { type: "string", format: "enum", enum: ["a", "b"] },
		});
	});

	test("does not recurse into tuple-style items array", () => {
		const input = {
			type: "array",
			items: [{ anyOf: [{ const: "a", type: "string" }] }, { type: "number" }],
		};
		// items is an array → !Array.isArray guard skips recursion → items unchanged
		expect(convertSchema(input)).toEqual(input);
	});

	// -------------------------------------------------------------------
	// Deep nesting
	// -------------------------------------------------------------------

	test("recurses through deeply nested object → array → object → anyOf", () => {
		const input = {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					items: {
						type: "object",
						properties: {
							status: {
								anyOf: [
									{ const: "open", type: "string" },
									{ const: "closed", type: "string" },
								],
							},
						},
					},
				},
			},
		};
		expect(convertSchema(input)).toEqual({
			type: "object",
			properties: {
				tasks: {
					type: "array",
					items: {
						type: "object",
						properties: {
							status: { type: "string", format: "enum", enum: ["open", "closed"] },
						},
					},
				},
			},
		});
	});

	// -------------------------------------------------------------------
	// Passthrough / identity
	// -------------------------------------------------------------------

	test("passes through clean schema unchanged", () => {
		const input = {
			type: "object",
			properties: {
				name: { type: "string", description: "A name" },
				count: { type: "number" },
			},
			required: ["name"],
		};
		expect(convertSchema(input)).toEqual(input);
	});

	test("passes through schema with existing enum", () => {
		const input = {
			type: "string",
			enum: ["a", "b", "c"],
		};
		expect(convertSchema(input)).toEqual(input);
	});

	test("does not mutate the original input", () => {
		const input = {
			type: "object",
			properties: {
				color: {
					anyOf: [
						{ const: "red", type: "string" },
						{ const: "blue", type: "string" },
					],
				},
			},
		};
		const inputCopy = JSON.parse(JSON.stringify(input));
		convertSchema(input);
		expect(input).toEqual(inputCopy);
	});

	// -------------------------------------------------------------------
	// Integration: realistic epsilon-style tool schema
	// -------------------------------------------------------------------

	test("converts full epsilon task_list-style schema", () => {
		// Realistic schema from epsilon/tools.js — task_list parameters
		const TaskStatusEnum = {
			anyOf: [
				{ const: "todo", type: "string" },
				{ const: "in_progress", type: "string" },
				{ const: "blocked", type: "string" },
				{ const: "done", type: "string" },
				{ const: "cancelled", type: "string" },
			],
		};
		const TaskPriorityEnum = {
			anyOf: [
				{ const: "low", type: "string" },
				{ const: "medium", type: "string" },
				{ const: "high", type: "string" },
				{ const: "critical", type: "string" },
			],
		};
		const input = {
			type: "object",
			properties: {
				status: {
					description: "Filter by status (single or array)",
					anyOf: [
						TaskStatusEnum,
						{
							type: "array",
							items: TaskStatusEnum,
						},
					],
				},
				priority: TaskPriorityEnum,
				tags: {
					type: "array",
					items: { type: "string" },
				},
				parent_id: {
					description: "Filter by parent (null = root tasks only)",
					anyOf: [{ type: "number" }, { type: "null" }],
				},
				limit: { type: "number" },
			},
		};

		expect(convertSchema(input)).toEqual({
			type: "object",
			properties: {
				status: {
					description: "Filter by status (single or array)",
					anyOf: [
						{ type: "string", format: "enum", enum: ["todo", "in_progress", "blocked", "done", "cancelled"] },
						{
							type: "array",
							items: {
								type: "string",
								format: "enum",
								enum: ["todo", "in_progress", "blocked", "done", "cancelled"],
							},
						},
					],
				},
				priority: { type: "string", format: "enum", enum: ["low", "medium", "high", "critical"] },
				tags: {
					type: "array",
					items: { type: "string" },
				},
				parent_id: {
					description: "Filter by parent (null = root tasks only)",
					anyOf: [{ type: "number" }, { type: "null" }],
				},
				limit: { type: "number" },
			},
		});
	});
});
