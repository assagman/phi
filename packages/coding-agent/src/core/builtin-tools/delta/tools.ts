/**
 * Delta tools — Unified memory API.
 *
 * Tools:
 * - delta_remember(content, tags, importance, context)
 * - delta_remember_bulk(memories[])
 * - delta_search(query, tags, importance, limit, since, sessionOnly)
 * - delta_forget(id)
 * - delta_forget_bulk(ids[])
 * - delta_info()
 * - delta_version()
 * - delta_schema()
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "agent";
import {
	forget,
	getDatabaseSchema,
	getDbLocation,
	getVersionInfo,
	type Importance,
	remember,
	type SearchOptions,
	search,
} from "./db.js";

// ============ Tool Factory Helper ============

function createTool<T extends TSchema>(
	name: string,
	label: string,
	description: string,
	parameters: T,
	handler: (params: Static<T>) => string,
): AgentTool<T> {
	return {
		name,
		label,
		description,
		parameters,
		execute: async (_toolCallId, params) => {
			try {
				const output = handler(params);
				return { content: [{ type: "text", text: output }], details: undefined };
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error: ${msg}` }], details: undefined };
			}
		},
	};
}

// ============ Tool Schemas ============

const ImportanceEnum = Type.Union([
	Type.Literal("low"),
	Type.Literal("normal"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

const RememberSchema = Type.Object({
	content: Type.String({ description: "Memory content to store" }),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Classification tags (e.g., decision, preference, bug, workflow)",
		}),
	),
	importance: Type.Optional(ImportanceEnum),
	context: Type.Optional(Type.String({ description: "Additional context or metadata" })),
});

const SearchSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "FTS5 full-text search query (searches content/tags/context)" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (OR semantics — any match)" })),
	importance: Type.Optional(ImportanceEnum),
	limit: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
	since: Type.Optional(Type.Number({ description: "Only memories created after this timestamp (ms)" })),
	sessionOnly: Type.Optional(Type.Boolean({ description: "Only memories from current session (default: false)" })),
});

const ForgetSchema = Type.Object({
	id: Type.Number({ description: "Memory ID to delete" }),
});

// ============ Bulk Operation Schemas ============

const RememberBulkSchema = Type.Object({
	memories: Type.Array(
		Type.Object({
			content: Type.String({ description: "Memory content to store" }),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Classification tags (e.g., decision, preference, bug, workflow)",
				}),
			),
			importance: Type.Optional(ImportanceEnum),
			context: Type.Optional(Type.String({ description: "Additional context or metadata" })),
		}),
		{
			description: "Array of memories to store",
			minItems: 1,
			maxItems: 50,
		},
	),
});

const ForgetBulkSchema = Type.Object({
	ids: Type.Array(Type.Number({ description: "Memory ID to delete" }), {
		description: "Array of memory IDs to delete",
		minItems: 1,
		maxItems: 50,
	}),
});

// ============ Tool Definitions ============

export const deltaRemember = createTool(
	"delta_remember",
	"Remember",
	"Store a new memory. Use after making decisions, discovering bugs, learning patterns, or finding important information. Supports tags for classification and importance levels (low/normal/high/critical).",
	RememberSchema,
	(input) => {
		const id = remember(input.content, {
			tags: input.tags,
			importance: input.importance as Importance | undefined,
			context: input.context,
		});

		const tagsStr = input.tags && input.tags.length > 0 ? ` {${input.tags.join(", ")}}` : "";
		const impStr = input.importance ? ` [${input.importance}]` : "";
		return `✓ Stored memory #${id}${impStr}${tagsStr}`;
	},
);

export const deltaSearch = createTool(
	"delta_search",
	"Search",
	"Search memories using full-text search and/or structured filters. Returns matching memories with ID, content, tags, importance, and timestamps. Use to recall past decisions, find patterns, or check previous context.",
	SearchSchema,
	(input) => {
		const opts: SearchOptions = {
			query: input.query,
			tags: input.tags,
			importance: input.importance as Importance | undefined,
			limit: input.limit,
			since: input.since,
			sessionOnly: input.sessionOnly,
		};

		const results = search(opts);

		if (results.length === 0) {
			return "No memories found matching your query.";
		}

		const lines: string[] = [];
		lines.push(`Found ${results.length} ${results.length === 1 ? "memory" : "memories"}:\n`);

		for (const mem of results) {
			const impBadge = mem.importance !== "normal" ? ` [${mem.importance.toUpperCase()}]` : "";
			const tagStr = mem.tags.length > 0 ? ` {${mem.tags.join(", ")}}` : "";
			const sessionStr = mem.session_id ? "" : " (archived)";
			const date = new Date(mem.created_at).toISOString().split("T")[0];

			lines.push(`## Memory #${mem.id}${impBadge}${tagStr}${sessionStr}`);
			lines.push(`Created: ${date}`);
			if (mem.context) {
				lines.push(`Context: ${mem.context}`);
			}
			lines.push("");
			lines.push(mem.content);
			lines.push("");
			lines.push("---");
			lines.push("");
		}

		return lines.join("\n");
	},
);

export const deltaForget = createTool(
	"delta_forget",
	"Forget",
	"Delete a memory by ID. Use to remove outdated, incorrect, or no-longer-relevant memories. Returns success status.",
	ForgetSchema,
	(input) => {
		const deleted = forget(input.id);
		if (deleted) {
			return `✓ Deleted memory #${input.id}`;
		}
		return `✗ Memory #${input.id} not found`;
	},
);

// ============ Bulk Operation Tools ============

export const deltaRememberBulk = createTool(
	"delta_remember_bulk",
	"Remember (Bulk)",
	"Store multiple memories in a single operation. More reliable than calling delta_remember multiple times. Supports up to 50 memories.",
	RememberBulkSchema,
	({ memories }) => {
		const results: string[] = [];
		const createdIds: number[] = [];

		for (const mem of memories) {
			try {
				const id = remember(mem.content, {
					tags: mem.tags,
					importance: mem.importance as Importance | undefined,
					context: mem.context,
				});
				createdIds.push(id);
				const tagsStr = mem.tags && mem.tags.length > 0 ? ` {${mem.tags.join(", ")}}` : "";
				const impStr = mem.importance ? ` [${mem.importance}]` : "";
				results.push(`✓ Stored #${id}${impStr}${tagsStr}`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				results.push(`✗ Error: ${msg}`);
			}
		}

		return `Stored ${createdIds.length}/${memories.length} memories:\n${results.join("\n")}`;
	},
);

export const deltaForgetBulk = createTool(
	"delta_forget_bulk",
	"Forget (Bulk)",
	"Delete multiple memories by ID in a single operation. More reliable than calling delta_forget multiple times. Supports up to 50 IDs.",
	ForgetBulkSchema,
	({ ids }) => {
		const results: string[] = [];
		let successCount = 0;

		for (const id of ids) {
			const deleted = forget(id);
			if (deleted) {
				successCount++;
				results.push(`✓ Deleted #${id}`);
			} else {
				results.push(`✗ Memory #${id} not found`);
			}
		}

		return `Deleted ${successCount}/${ids.length} memories:\n${results.join("\n")}`;
	},
);

export const deltaInfo = createTool(
	"delta_info",
	"Memory Info",
	"Show Delta database location and basic statistics. Use to check where memories are stored or verify database status.",
	Type.Object({}),
	() => {
		const dbPath = getDbLocation();
		const versionInfo = getVersionInfo();
		const memories = search({ limit: 1000 });
		const total = memories.length;

		const byCriticality = {
			critical: memories.filter((m) => m.importance === "critical").length,
			high: memories.filter((m) => m.importance === "high").length,
			normal: memories.filter((m) => m.importance === "normal").length,
			low: memories.filter((m) => m.importance === "low").length,
		};

		const lines: string[] = [];
		lines.push("# Delta Memory Database");
		lines.push("");
		lines.push(`**Location**: \`${dbPath}\``);
		lines.push(
			`**Schema Version**: ${versionInfo.current} ${versionInfo.match ? "✓" : `(shipped: ${versionInfo.shipped})`}`,
		);
		lines.push("");
		lines.push(`**Total Memories**: ${total}`);
		if (total > 0) {
			lines.push(`- Critical: ${byCriticality.critical}`);
			lines.push(`- High: ${byCriticality.high}`);
			lines.push(`- Normal: ${byCriticality.normal}`);
			lines.push(`- Low: ${byCriticality.low}`);
		}

		return lines.join("\n");
	},
);

export const deltaVersion = createTool(
	"delta_version",
	"Schema Version",
	"Show Delta schema version information. Use to check for schema mismatches or verify migrations.",
	Type.Object({}),
	() => {
		const info = getVersionInfo();
		const lines: string[] = [];
		lines.push("# Delta Schema Version");
		lines.push("");
		lines.push(`**Current**: ${info.current ?? "unknown"}`);
		lines.push(`**Shipped**: ${info.shipped}`);
		lines.push(`**Status**: ${info.match ? "✓ Up to date" : "⚠ Version mismatch"}`);

		if (!info.match) {
			lines.push("");
			lines.push("_Note: Schema version mismatch may indicate incomplete migration or outdated extension._");
		}

		return lines.join("\n");
	},
);

export const deltaSchema = createTool(
	"delta_schema",
	"DB Schema",
	"Dump the full database schema (tables, indexes, triggers). Use for debugging or understanding the storage structure.",
	Type.Object({}),
	() => {
		const schema = getDatabaseSchema();
		return `# Delta Database Schema\n\n\`\`\`sql\n${schema}\n\`\`\``;
	},
);

// ============ Export All Tools ============

export const deltaTools: AgentTool<any>[] = [
	deltaRemember,
	deltaSearch,
	deltaForget,
	deltaRememberBulk,
	deltaForgetBulk,
	deltaInfo,
	deltaVersion,
	deltaSchema,
];
