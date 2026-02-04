/**
 * Team Execution Storage — SQLite-backed persistence for team execution state.
 *
 * Ensures all team/agent findings and merge results survive runtime issues.
 * Storage: ~/.local/share/phi/team-executions/<session-id>/team.db
 *
 * Tables:
 * - team_executions: Top-level execution tracking
 * - agent_results: Per-agent findings and messages
 * - merge_snapshots: Merge phase checkpoints
 *
 * Uses bun:sqlite for zero external dependencies.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentMessage } from "agent";
import type { AgentResult, Finding, FindingCluster, TeamResult } from "../types.js";

// ============ Constants ============

export const DB_VERSION = 1;
const LOCAL_SHARE = join(homedir(), ".local", "share", "phi", "team-executions");

// ============ Types ============

export type ExecutionStatus = "pending" | "running" | "merging" | "completed" | "failed" | "aborted";
export type AgentStatus = "pending" | "running" | "completed" | "failed" | "retrying";
export type MergePhase = "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing" | "completed";

export interface TeamExecution {
	id: number;
	sessionId: string;
	teamName: string;
	task: string;
	status: ExecutionStatus;
	agentCount: number;
	startedAt: number;
	completedAt: number | null;
	error: string | null;
}

export interface StoredAgentResult {
	id: number;
	executionId: number;
	agentName: string;
	status: AgentStatus;
	findings: Finding[];
	messages: AgentMessage[];
	usage: { inputTokens: number; outputTokens: number } | null;
	durationMs: number;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface MergeSnapshot {
	id: number;
	executionId: number;
	phase: MergePhase;
	inputData: unknown;
	outputData: unknown;
	createdAt: number;
}

export interface CreateExecutionInput {
	sessionId: string;
	teamName: string;
	task: string;
	agentCount: number;
}

export interface UpdateAgentResultInput {
	status?: AgentStatus;
	findings?: Finding[];
	messages?: AgentMessage[];
	usage?: { inputTokens: number; outputTokens: number };
	durationMs?: number;
	error?: string;
}

// ============ Database Path Helpers ============

function validatePath(basePath: string, targetPath: string): void {
	const resolvedTarget = resolve(targetPath);
	const resolvedBase = resolve(basePath);
	const rel = relative(resolvedBase, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Invalid database path: path traversal detected");
	}
}

function getDbPath(sessionId: string): string {
	// Use hash-based directory name for collision resistance
	const hash = createHash("sha256").update(sessionId).digest("hex").substring(0, 16);
	const sanitizedPrefix = sessionId
		.replace(/[^a-zA-Z0-9_.-]/g, "_")
		.substring(0, 20)
		.replace(/_+$/, "");
	const dirName = sanitizedPrefix ? `${sanitizedPrefix}_${hash}` : hash;

	const dirPath = join(LOCAL_SHARE, dirName);
	validatePath(LOCAL_SHARE, dirPath);

	if (!existsSync(LOCAL_SHARE)) {
		mkdirSync(LOCAL_SHARE, { recursive: true });
	}
	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, { recursive: true });
	}

	return join(dirPath, "team.db");
}

function openDatabase(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	return db;
}

function ensureSchemaVersion(db: Database, targetVersion: number): { current: number; isFresh: boolean } {
	const tableCount = (
		db
			.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.get() as { count: number }
	).count;
	const isFresh = tableCount === 0;

	db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);

	if (isFresh) {
		db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)").run(targetVersion);
		return { current: targetVersion, isFresh: true };
	}

	const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
	return { current: row?.version ?? 0, isFresh: false };
}

// ============ Schema ============

function initSchema(db: Database): void {
	ensureSchemaVersion(db, DB_VERSION);

	db.exec(`
    -- Team execution tracking
    CREATE TABLE IF NOT EXISTS team_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      agent_count INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_team_executions_session ON team_executions(session_id);
    CREATE INDEX IF NOT EXISTS idx_team_executions_status ON team_executions(status);
    CREATE INDEX IF NOT EXISTS idx_team_executions_started ON team_executions(started_at DESC);

    -- Agent results (one per agent per execution)
    CREATE TABLE IF NOT EXISTS agent_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      findings TEXT NOT NULL DEFAULT '[]',
      messages TEXT NOT NULL DEFAULT '[]',
      usage TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (execution_id) REFERENCES team_executions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_results_execution ON agent_results(execution_id);
    CREATE INDEX IF NOT EXISTS idx_agent_results_agent ON agent_results(agent_name);
    CREATE INDEX IF NOT EXISTS idx_agent_results_status ON agent_results(status);

    -- Merge phase snapshots (for recovery/debugging)
    CREATE TABLE IF NOT EXISTS merge_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER NOT NULL,
      phase TEXT NOT NULL,
      input_data TEXT NOT NULL,
      output_data TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (execution_id) REFERENCES team_executions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_merge_snapshots_execution ON merge_snapshots(execution_id);
    CREATE INDEX IF NOT EXISTS idx_merge_snapshots_phase ON merge_snapshots(phase);
  `);
}

// ============ Storage Class ============

/**
 * Storage for team execution state.
 * Provides persistence for agent results and merge phases.
 */
export class TeamExecutionStorage {
	private db: Database | null = null;
	private sessionId: string;
	private dbPath: string;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
		this.dbPath = getDbPath(sessionId);
	}

	private getDb(): Database {
		if (!this.db) {
			this.db = openDatabase(this.dbPath);
			initSchema(this.db);
		}
		return this.db;
	}

	// ============ Team Execution Methods ============

	/**
	 * Create a new team execution record.
	 */
	createExecution(input: CreateExecutionInput): number {
		const db = this.getDb();
		const now = Date.now();

		const row = db
			.prepare(
				`INSERT INTO team_executions (session_id, team_name, task, status, agent_count, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)
         RETURNING id`,
			)
			.get(input.sessionId, input.teamName, input.task, input.agentCount, now) as { id: number };

		return row.id;
	}

	/**
	 * Update execution status.
	 */
	updateExecutionStatus(executionId: number, status: ExecutionStatus, error?: string): void {
		const db = this.getDb();
		const now = status === "completed" || status === "failed" || status === "aborted" ? Date.now() : null;

		db.prepare(
			`UPDATE team_executions 
       SET status = ?, completed_at = COALESCE(?, completed_at), error = COALESCE(?, error)
       WHERE id = ?`,
		).run(status, now, error ?? null, executionId);
	}

	/**
	 * Get execution by ID.
	 */
	getExecution(executionId: number): TeamExecution | null {
		const db = this.getDb();
		const row = db
			.prepare(
				`SELECT id, session_id, team_name, task, status, agent_count, started_at, completed_at, error
         FROM team_executions WHERE id = ?`,
			)
			.get(executionId) as RawExecutionRow | undefined;

		if (!row) return null;
		return this.parseExecutionRow(row);
	}

	/**
	 * Get latest execution for a team in current session.
	 */
	getLatestExecution(teamName: string): TeamExecution | null {
		const db = this.getDb();
		const row = db
			.prepare(
				`SELECT id, session_id, team_name, task, status, agent_count, started_at, completed_at, error
         FROM team_executions 
         WHERE session_id = ? AND team_name = ?
         ORDER BY started_at DESC LIMIT 1`,
			)
			.get(this.sessionId, teamName) as RawExecutionRow | undefined;

		if (!row) return null;
		return this.parseExecutionRow(row);
	}

	/**
	 * Get incomplete executions (for recovery).
	 */
	getIncompleteExecutions(): TeamExecution[] {
		const db = this.getDb();
		const rows = db
			.prepare(
				`SELECT id, session_id, team_name, task, status, agent_count, started_at, completed_at, error
         FROM team_executions 
         WHERE session_id = ? AND status IN ('pending', 'running', 'merging')
         ORDER BY started_at DESC`,
			)
			.all(this.sessionId) as RawExecutionRow[];

		return rows.map((row) => this.parseExecutionRow(row));
	}

	// ============ Agent Result Methods ============

	/**
	 * Create agent result record (called when agent starts).
	 */
	createAgentResult(executionId: number, agentName: string): number {
		const db = this.getDb();
		const now = Date.now();

		const row = db
			.prepare(
				`INSERT INTO agent_results (execution_id, agent_name, status, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?)
         RETURNING id`,
			)
			.get(executionId, agentName, now, now) as { id: number };

		return row.id;
	}

	/**
	 * Update agent result (called on progress or completion).
	 */
	updateAgentResult(agentResultId: number, input: UpdateAgentResultInput): void {
		const db = this.getDb();
		const updates: string[] = ["updated_at = ?"];
		const params: (string | number | null)[] = [Date.now()];

		if (input.status !== undefined) {
			updates.push("status = ?");
			params.push(input.status);
		}
		if (input.findings !== undefined) {
			updates.push("findings = ?");
			params.push(JSON.stringify(input.findings));
		}
		if (input.messages !== undefined) {
			updates.push("messages = ?");
			params.push(JSON.stringify(input.messages));
		}
		if (input.usage !== undefined) {
			updates.push("usage = ?");
			params.push(JSON.stringify(input.usage));
		}
		if (input.durationMs !== undefined) {
			updates.push("duration_ms = ?");
			params.push(input.durationMs);
		}
		if (input.error !== undefined) {
			updates.push("error = ?");
			params.push(input.error);
		}

		params.push(agentResultId);
		db.prepare(`UPDATE agent_results SET ${updates.join(", ")} WHERE id = ?`).run(...params);
	}

	/**
	 * Get agent result by ID.
	 */
	getAgentResult(agentResultId: number): StoredAgentResult | null {
		const db = this.getDb();
		const row = db
			.prepare(
				`SELECT id, execution_id, agent_name, status, findings, messages, usage, duration_ms, error, created_at, updated_at
         FROM agent_results WHERE id = ?`,
			)
			.get(agentResultId) as RawAgentResultRow | undefined;

		if (!row) return null;
		return this.parseAgentResultRow(row);
	}

	/**
	 * Get all agent results for an execution.
	 */
	getAgentResultsForExecution(executionId: number): StoredAgentResult[] {
		const db = this.getDb();
		const rows = db
			.prepare(
				`SELECT id, execution_id, agent_name, status, findings, messages, usage, duration_ms, error, created_at, updated_at
         FROM agent_results WHERE execution_id = ?
         ORDER BY created_at ASC`,
			)
			.all(executionId) as RawAgentResultRow[];

		return rows.map((row) => this.parseAgentResultRow(row));
	}

	/**
	 * Convenience: persist findings incrementally during agent execution.
	 * Appends to existing findings rather than replacing.
	 */
	appendFindings(agentResultId: number, newFindings: Finding[]): void {
		const db = this.getDb();
		const existing = db.prepare("SELECT findings FROM agent_results WHERE id = ?").get(agentResultId) as
			| { findings: string }
			| undefined;

		if (!existing) return;

		const current: Finding[] = JSON.parse(existing.findings);
		const merged = [...current, ...newFindings];

		db.prepare("UPDATE agent_results SET findings = ?, updated_at = ? WHERE id = ?").run(
			JSON.stringify(merged),
			Date.now(),
			agentResultId,
		);
	}

	// ============ Merge Snapshot Methods ============

	/**
	 * Create a merge phase snapshot.
	 */
	createMergeSnapshot(executionId: number, phase: MergePhase, inputData: unknown): number {
		const db = this.getDb();
		const now = Date.now();

		const row = db
			.prepare(
				`INSERT INTO merge_snapshots (execution_id, phase, input_data, created_at)
         VALUES (?, ?, ?, ?)
         RETURNING id`,
			)
			.get(executionId, phase, JSON.stringify(inputData), now) as { id: number };

		return row.id;
	}

	/**
	 * Update merge snapshot with output.
	 */
	updateMergeSnapshot(snapshotId: number, outputData: unknown): void {
		const db = this.getDb();
		db.prepare("UPDATE merge_snapshots SET output_data = ? WHERE id = ?").run(JSON.stringify(outputData), snapshotId);
	}

	/**
	 * Get latest merge snapshot for an execution.
	 */
	getLatestMergeSnapshot(executionId: number): MergeSnapshot | null {
		const db = this.getDb();
		const row = db
			.prepare(
				`SELECT id, execution_id, phase, input_data, output_data, created_at
         FROM merge_snapshots WHERE execution_id = ?
         ORDER BY created_at DESC LIMIT 1`,
			)
			.get(executionId) as RawMergeSnapshotRow | undefined;

		if (!row) return null;
		return this.parseMergeSnapshotRow(row);
	}

	/**
	 * Get all merge snapshots for an execution.
	 */
	getMergeSnapshots(executionId: number): MergeSnapshot[] {
		const db = this.getDb();
		const rows = db
			.prepare(
				`SELECT id, execution_id, phase, input_data, output_data, created_at
         FROM merge_snapshots WHERE execution_id = ?
         ORDER BY created_at ASC`,
			)
			.all(executionId) as RawMergeSnapshotRow[];

		return rows.map((row) => this.parseMergeSnapshotRow(row));
	}

	// ============ Recovery & Full State ============

	/**
	 * Get complete team result from storage (for recovery or inspection).
	 */
	getCompleteTeamResult(executionId: number): TeamResult | null {
		const execution = this.getExecution(executionId);
		if (!execution) return null;

		const agentResults = this.getAgentResultsForExecution(executionId);
		const snapshots = this.getMergeSnapshots(executionId);

		// Find the final merge snapshot (synthesizing or completed phase)
		const finalSnapshot = snapshots.find((s) => s.phase === "completed" || s.phase === "synthesizing");

		// Convert stored agent results to AgentResult format
		const convertedResults: AgentResult[] = agentResults.map((ar) => ({
			agentName: ar.agentName,
			success: ar.status === "completed",
			error: ar.error ?? undefined,
			findings: ar.findings,
			messages: ar.messages,
			durationMs: ar.durationMs,
			usage: ar.usage ?? undefined,
		}));

		// Extract findings and clusters from merge output if available
		let findings: Finding[] = [];
		let clusters: FindingCluster[] = [];
		let summary: string | undefined;

		if (finalSnapshot?.outputData) {
			const output = finalSnapshot.outputData as {
				findings?: Finding[];
				clusters?: FindingCluster[];
				summary?: string;
			};
			findings = output.findings ?? [];
			clusters = output.clusters ?? [];
			summary = output.summary;
		} else {
			// Fallback: aggregate all agent findings
			findings = agentResults.flatMap((ar) => ar.findings);
		}

		// Calculate total usage
		let inputTokens = 0;
		let outputTokens = 0;
		let hasUsage = false;

		for (const ar of agentResults) {
			if (ar.usage) {
				hasUsage = true;
				inputTokens += ar.usage.inputTokens;
				outputTokens += ar.usage.outputTokens;
			}
		}

		return {
			teamName: execution.teamName,
			success: execution.status === "completed",
			error: execution.error ?? undefined,
			agentResults: convertedResults,
			findings,
			clusters,
			summary,
			durationMs: execution.completedAt
				? execution.completedAt - execution.startedAt
				: Date.now() - execution.startedAt,
			totalUsage: hasUsage ? { inputTokens, outputTokens } : undefined,
		};
	}

	/**
	 * Save final team result (called at end of successful execution).
	 */
	saveTeamResult(executionId: number, result: TeamResult): void {
		// Update execution status
		this.updateExecutionStatus(executionId, result.success ? "completed" : "failed", result.error);

		// Save final merge state as snapshot
		this.createMergeSnapshot(executionId, "completed", {});
		const snapshots = this.getMergeSnapshots(executionId);
		const lastSnapshot = snapshots[snapshots.length - 1];
		if (lastSnapshot) {
			this.updateMergeSnapshot(lastSnapshot.id, {
				findings: result.findings,
				clusters: result.clusters,
				summary: result.summary,
			});
		}
	}

	// ============ Cleanup ============

	/**
	 * Delete old executions, keeping the most recent N per team.
	 */
	pruneOldExecutions(keepPerTeam: number): number {
		const db = this.getDb();

		// Get unique team names
		const teams = db
			.prepare("SELECT DISTINCT team_name FROM team_executions WHERE session_id = ?")
			.all(this.sessionId) as Array<{ team_name: string }>;

		let totalDeleted = 0;

		for (const { team_name } of teams) {
			const result = db
				.prepare(
					`DELETE FROM team_executions 
           WHERE session_id = ? AND team_name = ? AND id NOT IN (
             SELECT id FROM team_executions 
             WHERE session_id = ? AND team_name = ?
             ORDER BY started_at DESC 
             LIMIT ?
           )`,
				)
				.run(this.sessionId, team_name, this.sessionId, team_name, keepPerTeam);
			totalDeleted += result.changes;
		}

		return totalDeleted;
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	/**
	 * Get the database file location.
	 */
	getLocation(): string {
		return this.dbPath;
	}

	// ============ Internal Helpers ============

	private parseExecutionRow(row: RawExecutionRow): TeamExecution {
		return {
			id: row.id,
			sessionId: row.session_id,
			teamName: row.team_name,
			task: row.task,
			status: row.status as ExecutionStatus,
			agentCount: row.agent_count,
			startedAt: row.started_at,
			completedAt: row.completed_at,
			error: row.error,
		};
	}

	private parseAgentResultRow(row: RawAgentResultRow): StoredAgentResult {
		return {
			id: row.id,
			executionId: row.execution_id,
			agentName: row.agent_name,
			status: row.status as AgentStatus,
			findings: JSON.parse(row.findings),
			messages: JSON.parse(row.messages),
			usage: row.usage ? JSON.parse(row.usage) : null,
			durationMs: row.duration_ms,
			error: row.error,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private parseMergeSnapshotRow(row: RawMergeSnapshotRow): MergeSnapshot {
		return {
			id: row.id,
			executionId: row.execution_id,
			phase: row.phase as MergePhase,
			inputData: JSON.parse(row.input_data),
			outputData: row.output_data ? JSON.parse(row.output_data) : null,
			createdAt: row.created_at,
		};
	}
}

// ============ Raw Row Types ============

interface RawExecutionRow {
	id: number;
	session_id: string;
	team_name: string;
	task: string;
	status: string;
	agent_count: number;
	started_at: number;
	completed_at: number | null;
	error: string | null;
}

interface RawAgentResultRow {
	id: number;
	execution_id: number;
	agent_name: string;
	status: string;
	findings: string;
	messages: string;
	usage: string | null;
	duration_ms: number;
	error: string | null;
	created_at: number;
	updated_at: number;
}

interface RawMergeSnapshotRow {
	id: number;
	execution_id: number;
	phase: string;
	input_data: string;
	output_data: string | null;
	created_at: number;
}
