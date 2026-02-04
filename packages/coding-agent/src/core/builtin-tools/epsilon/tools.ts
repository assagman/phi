/**
 * Epsilon tools — task management operations.
 *
 * Tools: 10 total
 *   Tasks:   epsilon_task_create/list/update/delete/get (5)
 *   Bulk:    epsilon_task_create_bulk/update_bulk/delete_bulk (3)
 *   Info:    epsilon_info (1)
 *   Version: epsilon_version (1)
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "agent";
import {
	createTask,
	deleteTask,
	getDbLocation,
	getTask,
	getVersionInfo,
	type ListTasksOptions,
	listTasks,
	TASK_STATUS_ICONS,
	type Task,
	updateTask,
} from "./db.js";

// ============ Schemas (explicit types, no nested unions) ============
const TaskStatusSchema = Type.Union([
	Type.Literal("todo"),
	Type.Literal("in_progress"),
	Type.Literal("blocked"),
	Type.Literal("done"),
	Type.Literal("cancelled"),
]);

const TaskPrioritySchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

const TaskCreateSchema = Type.Object({
	title: Type.String({ description: "Task title" }),
	description: Type.Optional(Type.String({ description: "Task description" })),
	status: Type.Optional(TaskStatusSchema),
	priority: Type.Optional(TaskPrioritySchema),
	tags: Type.Optional(Type.Array(Type.String())),
	parent_id: Type.Optional(Type.Number({ description: "Parent task ID for subtasks" })),
});

// List schema - simplified to avoid nested anyOf
const TaskListSchema = Type.Object({
	status: Type.Optional(Type.Array(TaskStatusSchema, { description: "Filter by status(es)" })),
	priority: Type.Optional(TaskPrioritySchema),
	tags: Type.Optional(Type.Array(Type.String())),
	parent_id: Type.Optional(Type.Number({ description: "Filter by parent task ID" })),
	limit: Type.Optional(Type.Number()),
});

const TaskUpdateSchema = Type.Object({
	id: Type.Number({ description: "Task ID to update" }),
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	status: Type.Optional(TaskStatusSchema),
	priority: Type.Optional(TaskPrioritySchema),
	tags: Type.Optional(Type.Array(Type.String())),
	parent_id: Type.Optional(Type.Number({ description: "New parent task ID, or omit to keep current" })),
});

const TaskDeleteSchema = Type.Object({
	id: Type.Number({ description: "Task ID to delete" }),
});

const TaskGetSchema = Type.Object({
	id: Type.Number({ description: "Task ID to retrieve" }),
});

// ============ Bulk Operation Schemas ============

const TaskCreateBulkSchema = Type.Object({
	tasks: Type.Array(TaskCreateSchema, {
		description: "Array of tasks to create",
		minItems: 1,
		maxItems: 50,
	}),
});

const TaskUpdateBulkSchema = Type.Object({
	updates: Type.Array(
		Type.Object({
			id: Type.Number({ description: "Task ID to update" }),
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			status: Type.Optional(TaskStatusSchema),
			priority: Type.Optional(TaskPrioritySchema),
			tags: Type.Optional(Type.Array(Type.String())),
			parent_id: Type.Optional(Type.Number({ description: "New parent task ID" })),
		}),
		{
			description: "Array of task updates",
			minItems: 1,
			maxItems: 50,
		},
	),
});

const TaskDeleteBulkSchema = Type.Object({
	ids: Type.Array(Type.Number({ description: "Task ID to delete" }), {
		description: "Array of task IDs to delete",
		minItems: 1,
		maxItems: 50,
	}),
});

const InfoSchema = Type.Object({});
const VersionSchema = Type.Object({});

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

// ============ Helpers ============

function formatTask(task: Task): string {
	const date = new Date(task.created_at).toISOString().split("T")[0];
	const tagsStr = task.tags.length > 0 ? ` [${task.tags.join(", ")}]` : "";
	const parentStr = task.parent_id ? ` (subtask of #${task.parent_id})` : "";
	const statusIcon = TASK_STATUS_ICONS[task.status];
	return `${statusIcon} #${task.id} [${task.priority}] ${task.title}${tagsStr}${parentStr}\n  ${task.status} | ${date}${task.description ? `\n  ${task.description}` : ""}`;
}

// ============ Task Tools ============

export const epsilonTaskCreate = createTool(
	"epsilon_task_create",
	"Create Task",
	"Create a new task. Priority: low/medium/high/critical. Status: todo/in_progress/blocked/done/cancelled.",
	TaskCreateSchema,
	(input) => {
		const id = createTask(input);
		const task = getTask(id);
		return `Created task #${id}:\n${task ? formatTask(task) : ""}`;
	},
);

export const epsilonTaskList = createTool(
	"epsilon_task_list",
	"List Tasks",
	"List tasks with optional filters. Filter by status, priority, tags, or parent_id.",
	TaskListSchema,
	(options) => {
		const tasks = listTasks(options as ListTasksOptions);
		if (tasks.length === 0) return "No tasks found matching criteria";
		return `Found ${tasks.length} tasks:\n\n${tasks.map(formatTask).join("\n\n")}`;
	},
);

export const epsilonTaskUpdate = createTool(
	"epsilon_task_update",
	"Update Task",
	"Update an existing task. Only provided fields will be updated.",
	TaskUpdateSchema,
	({ id, ...updates }) => {
		const updated = updateTask(id, updates);
		if (!updated) return `Task #${id} not found`;
		const task = getTask(id);
		return `Updated task #${id}:\n${task ? formatTask(task) : ""}`;
	},
);

export const epsilonTaskDelete = createTool(
	"epsilon_task_delete",
	"Delete Task",
	"Delete a task by ID. Also deletes subtasks.",
	TaskDeleteSchema,
	({ id }) => {
		const deleted = deleteTask(id);
		return deleted ? `Deleted task #${id}` : `Task #${id} not found`;
	},
);

export const epsilonTaskGet = createTool(
	"epsilon_task_get",
	"Get Task",
	"Get a single task by ID with full details.",
	TaskGetSchema,
	({ id }) => {
		const task = getTask(id);
		if (!task) return `Task #${id} not found`;
		return formatTask(task);
	},
);

// ============ Bulk Task Tools ============

export const epsilonTaskCreateBulk = createTool(
	"epsilon_task_create_bulk",
	"Create Tasks (Bulk)",
	"Create multiple tasks in a single operation. More reliable than calling epsilon_task_create multiple times. Supports up to 50 tasks.",
	TaskCreateBulkSchema,
	({ tasks }) => {
		const results: string[] = [];
		const createdIds: number[] = [];

		for (const taskInput of tasks) {
			try {
				const id = createTask(taskInput);
				createdIds.push(id);
				const task = getTask(id);
				results.push(`Created #${id}: ${task?.title ?? "unknown"}`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				results.push(`Error creating "${taskInput.title}": ${msg}`);
			}
		}

		return `Created ${createdIds.length}/${tasks.length} tasks:\n${results.join("\n")}`;
	},
);

export const epsilonTaskUpdateBulk = createTool(
	"epsilon_task_update_bulk",
	"Update Tasks (Bulk)",
	"Update multiple tasks in a single operation. More reliable than calling epsilon_task_update multiple times. Supports up to 50 updates.",
	TaskUpdateBulkSchema,
	({ updates }) => {
		const results: string[] = [];
		let successCount = 0;

		for (const { id, ...updateData } of updates) {
			try {
				const updated = updateTask(id, updateData);
				if (updated) {
					successCount++;
					const task = getTask(id);
					results.push(`Updated #${id}: ${task?.title ?? "unknown"}`);
				} else {
					results.push(`Task #${id} not found`);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				results.push(`Error updating #${id}: ${msg}`);
			}
		}

		return `Updated ${successCount}/${updates.length} tasks:\n${results.join("\n")}`;
	},
);

export const epsilonTaskDeleteBulk = createTool(
	"epsilon_task_delete_bulk",
	"Delete Tasks (Bulk)",
	"Delete multiple tasks by ID in a single operation. Also deletes subtasks. Supports up to 50 IDs.",
	TaskDeleteBulkSchema,
	({ ids }) => {
		const results: string[] = [];
		let successCount = 0;

		for (const id of ids) {
			const deleted = deleteTask(id);
			if (deleted) {
				successCount++;
				results.push(`Deleted #${id}`);
			} else {
				results.push(`Task #${id} not found`);
			}
		}

		return `Deleted ${successCount}/${ids.length} tasks:\n${results.join("\n")}`;
	},
);

// ============ Info & Version ============

export const epsilonInfo = createTool(
	"epsilon_info",
	"Task DB Info",
	"Get information about the epsilon task database location.",
	InfoSchema,
	() => `Database location: ${getDbLocation()}`,
);

export const epsilonVersion = createTool(
	"epsilon_version",
	"Task DB Version",
	"Reports the epsilon DB version info.",
	VersionSchema,
	() => {
		const info = getVersionInfo();
		const currentStr = info.current === null ? "unversioned" : String(info.current);
		const status = info.match ? "✓ Up to date" : `⚠ MISMATCH (${info.current} → ${info.shipped})`;
		return `Task DB Version: shipped=${info.shipped}, current=${currentStr}, ${status}`;
	},
);

// ============ Export All Tools ============

export const epsilonTools: AgentTool<any>[] = [
	epsilonTaskCreate,
	epsilonTaskList,
	epsilonTaskUpdate,
	epsilonTaskDelete,
	epsilonTaskGet,
	epsilonTaskCreateBulk,
	epsilonTaskUpdateBulk,
	epsilonTaskDeleteBulk,
	epsilonInfo,
	epsilonVersion,
];
