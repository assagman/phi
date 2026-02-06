import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "agent";
import type { PermissionCheckResult, PermissionPromptFn, PermissionPromptResult } from "permission";
import {
	extractPathsFromCommand,
	isOutsideCwd,
	PermissionDb,
	PermissionManager,
	wrapToolRegistryWithPermissions,
	wrapToolsWithPermissions,
} from "permission";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../src/core/tools/bash.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createWriteTool } from "../src/core/tools/write.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function asTools(...tools: AgentTool<any>[]): AgentTool[] {
	return tools as AgentTool[];
}

function expectGranted(result: PermissionCheckResult) {
	expect(result.status).toBe("granted");
	if (result.status !== "granted") throw new Error("unreachable");
	return result;
}

function expectDenied(result: PermissionCheckResult) {
	expect(result.status).toBe("denied");
	if (result.status !== "denied") throw new Error("unreachable");
	return result;
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function createMockPromptFn(response: PermissionPromptResult): PermissionPromptFn {
	return vi.fn(async () => response);
}

/** Create a test PermissionDb with a unique file in the test dir */
function createTestDb(testDir: string): PermissionDb {
	const dbPath = join(testDir, `permissions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	return new PermissionDb(dbPath);
}

function createMgr(opts: {
	cwd: string;
	testDir: string;
	preAllowedDirs?: string[];
	promptFn?: PermissionPromptFn;
	legacyJsonPath?: string;
}): { mgr: PermissionManager; db: PermissionDb } {
	const db = createTestDb(opts.testDir);
	const mgr = new PermissionManager({
		cwd: opts.cwd,
		db,
		preAllowedDirs: opts.preAllowedDirs ?? [],
		promptFn: opts.promptFn,
		legacyJsonPath: opts.legacyJsonPath,
	});
	return { mgr, db };
}

// ============================================================================
// PermissionManager — Core Logic
// ============================================================================

describe("PermissionManager", () => {
	let testDir: string;
	let workspace: string;
	let outsideDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspace = join(testDir, "workspace");
		outsideDir = join(testDir, "outside");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// ── CWD containment ─────────────────────────────────────────────────

	describe("isWithinCwd", () => {
		it("should allow paths inside CWD", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			expect(mgr.isWithinCwd(join(workspace, "src", "index.ts"))).toBe(true);
			db.close();
		});

		it("should allow the CWD itself", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			expect(mgr.isWithinCwd(workspace)).toBe(true);
			db.close();
		});

		it("should deny paths outside CWD", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			expect(mgr.isWithinCwd(outsideDir)).toBe(false);
			db.close();
		});

		it("should deny paths that share a prefix but are not children", () => {
			const extraDir = join(testDir, "workspace-extra");
			mkdirSync(extraDir, { recursive: true });
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			expect(mgr.isWithinCwd(extraDir)).toBe(false);
			db.close();
		});

		it("should normalize .. traversals", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			expect(mgr.isWithinCwd(join(workspace, "src", "..", "index.ts"))).toBe(true);
			expect(mgr.isWithinCwd(join(workspace, "..", "outside"))).toBe(false);
			db.close();
		});

		it("should detect symlink escapes via realpath", () => {
			const targetOutside = join(outsideDir, "secret");
			mkdirSync(targetOutside, { recursive: true });
			const symlinkInside = join(workspace, "link-to-outside");
			symlinkSync(targetOutside, symlinkInside);

			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			expect(mgr.isWithinCwd(symlinkInside)).toBe(false);
			db.close();
		});
	});

	// ── checkDirectory ──────────────────────────────────────────────────

	describe("checkDirectory", () => {
		it("should grant paths inside CWD", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const result = expectGranted(mgr.checkDirectory(join(workspace, "src")));
			expect(result.scope).toBe("session");
			db.close();
		});

		it("should deny paths outside CWD with no grants", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			expectDenied(mgr.checkDirectory(outsideDir));
			db.close();
		});

		it("should grant pre-allowed directories", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir, preAllowedDirs: [outsideDir] });
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("persistent");
			db.close();
		});

		it("should grant subdirectories of pre-allowed dirs", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir, preAllowedDirs: [outsideDir] });
			const subDir = join(outsideDir, "deep", "nested");
			mkdirSync(subDir, { recursive: true });
			expectGranted(mgr.checkDirectory(subDir));
			db.close();
		});

		it("should NOT grant sibling of pre-allowed dir", () => {
			const allowed = join(testDir, "allowed");
			const sibling = join(testDir, "allowed-extra");
			mkdirSync(allowed, { recursive: true });
			mkdirSync(sibling, { recursive: true });
			const { mgr, db } = createMgr({ cwd: workspace, testDir, preAllowedDirs: [allowed] });
			expectDenied(mgr.checkDirectory(sibling));
			db.close();
		});

		it("should support action-level checking (fs_read vs fs_write)", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "session", "fs_read");

			expectGranted(mgr.checkDirectory(outsideDir, "fs_read"));
			expectDenied(mgr.checkDirectory(outsideDir, "fs_write"));
			db.close();
		});
	});

	// ── Grant scopes ────────────────────────────────────────────────────

	describe("grant scopes", () => {
		it("once grants should be found by checkDirectory", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "once");
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("once");
			db.close();
		});

		it("once grants should be cleared by clearOnceGrants", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "once");
			mgr.clearOnceGrants();
			expectDenied(mgr.checkDirectory(outsideDir));
			db.close();
		});

		it("session grants should be found by checkDirectory", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "session");
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("session");
			db.close();
		});

		it("session grants should survive clearOnceGrants", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "session");
			mgr.clearOnceGrants();
			expectGranted(mgr.checkDirectory(outsideDir));
			db.close();
		});

		it("session grants should be cleared by clearSessionGrants", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "session");
			mgr.clearSessionGrants();
			expectDenied(mgr.checkDirectory(outsideDir));
			db.close();
		});

		it("clearSessionGrants should also clear once grants", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "once");
			mgr.clearSessionGrants();
			expectDenied(mgr.checkDirectory(outsideDir));
			db.close();
		});

		it("persistent grants should be found by checkDirectory", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "persistent");
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("persistent");
			db.close();
		});

		it("persistent grants should survive clearSessionGrants", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "persistent");
			mgr.clearSessionGrants();
			expectGranted(mgr.checkDirectory(outsideDir));
			db.close();
		});
	});

	// ── SQLite Persistence ──────────────────────────────────────────────

	describe("SQLite persistence", () => {
		it("persistent grants should be stored in SQLite", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "persistent");

			const grants = db.findAllActiveGrants();
			expect(grants.length).toBeGreaterThanOrEqual(1);
			const match = grants.find((g) => g.resource === realpathSync(outsideDir));
			expect(match).toBeDefined();
			expect(match?.scope).toBe("persistent");
			db.close();
		});

		it("once grants should NOT be stored in SQLite", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "once");

			const grants = db.findAllActiveGrants();
			const match = grants.find((g) => g.resource === realpathSync(outsideDir));
			expect(match).toBeUndefined();
			db.close();
		});

		it("session grants should NOT be stored in SQLite", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "session");

			const grants = db.findAllActiveGrants();
			const match = grants.find((g) => g.resource === realpathSync(outsideDir));
			expect(match).toBeUndefined();
			db.close();
		});

		it("revokePersistent should revoke in SQLite", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "persistent");
			mgr.revokePersistent("directory", outsideDir);

			expectDenied(mgr.checkDirectory(outsideDir));
			const grants = db.findAllActiveGrants();
			const match = grants.find((g) => g.resource === realpathSync(outsideDir));
			expect(match).toBeUndefined();
			db.close();
		});

		it("getPersistentGrants should return all active persistent grants", () => {
			const dir2 = join(testDir, "dir2");
			mkdirSync(dir2, { recursive: true });
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "persistent");
			mgr.grant("directory", dir2, "persistent");
			mgr.grant("directory", join(testDir, "session-only"), "session");

			const grants = mgr.getPersistentGrants();
			expect(grants.length).toBe(2);
			expect(grants.map((g) => g.resource).sort()).toEqual([realpathSync(outsideDir), realpathSync(dir2)].sort());
			db.close();
		});
	});

	// ── Audit Logging ───────────────────────────────────────────────────

	describe("audit logging", () => {
		it("should log grant events", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			mgr.grant("directory", outsideDir, "persistent", "fs_read", "read");

			const audit = db.getAuditLog(10);
			const grantEvent = audit.find((e) => e.event === "grant");
			expect(grantEvent).toBeDefined();
			expect(grantEvent?.type).toBe("directory");
			expect(grantEvent?.action).toBe("fs_read");
			expect(grantEvent?.toolName).toBe("read");
			db.close();
		});

		it("should log check events for outside-CWD paths", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir, preAllowedDirs: [outsideDir] });
			mgr.checkDirectory(outsideDir);

			const audit = db.getAuditLog(10);
			const checkEvent = audit.find((e) => e.event === "check");
			expect(checkEvent).toBeDefined();
			expect(checkEvent?.result).toBe("granted");
			expect(checkEvent?.reason).toBe("pre_allowed");
			db.close();
		});

		it("should log deny events from prompt rejection", async () => {
			const promptFn = createMockPromptFn({ action: "deny", userMessage: "nope" });
			const { mgr, db } = createMgr({ cwd: workspace, testDir, promptFn });
			await mgr.requestDirectory(outsideDir, "read");

			const audit = db.getAuditLog(10);
			const denyEvent = audit.find((e) => e.event === "deny");
			expect(denyEvent).toBeDefined();
			expect(denyEvent?.result).toBe("denied");
			expect(denyEvent?.userMessage).toBe("nope");
			db.close();
		});
	});

	// ── requestDirectory + prompt ───────────────────────────────────────

	describe("requestDirectory", () => {
		it("should return granted without prompting for paths inside CWD", async () => {
			const promptFn = vi.fn();
			const { mgr, db } = createMgr({ cwd: workspace, testDir, promptFn });
			const result = await mgr.requestDirectory(join(workspace, "src"), "read");
			expect(result.status).toBe("granted");
			expect(promptFn).not.toHaveBeenCalled();
			db.close();
		});

		it("should return granted without prompting for pre-allowed dirs", async () => {
			const promptFn = vi.fn();
			const { mgr, db } = createMgr({ cwd: workspace, testDir, preAllowedDirs: [outsideDir], promptFn });
			const result = await mgr.requestDirectory(outsideDir, "read");
			expect(result.status).toBe("granted");
			expect(promptFn).not.toHaveBeenCalled();
			db.close();
		});

		it("should prompt when no grant exists", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "session" });
			const { mgr, db } = createMgr({ cwd: workspace, testDir, promptFn });
			const result = await mgr.requestDirectory(outsideDir, "read");
			expect(result.status).toBe("granted");
			expect(promptFn).toHaveBeenCalledOnce();
			db.close();
		});

		it("should deny when no promptFn is set", async () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const result = await mgr.requestDirectory(outsideDir, "read");
			expect(result.status).toBe("denied");
			db.close();
		});

		it("should pass rejection with user message", async () => {
			const promptFn = createMockPromptFn({ action: "deny", userMessage: "Try /workspace/data instead" });
			const { mgr, db } = createMgr({ cwd: workspace, testDir, promptFn });
			const result = expectDenied(await mgr.requestDirectory(outsideDir, "read"));
			expect(result.userMessage).toBe("Try /workspace/data instead");
			db.close();
		});

		it("should support action parameter in requestDirectory", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "session" });
			const { mgr, db } = createMgr({ cwd: workspace, testDir, promptFn });
			await mgr.requestDirectory(outsideDir, "write", "fs_write");

			expectGranted(mgr.checkDirectory(outsideDir, "fs_write"));
			expectDenied(mgr.checkDirectory(outsideDir, "fs_read"));
			db.close();
		});
	});

	// ── JSON Migration ──────────────────────────────────────────────────

	describe("JSON migration", () => {
		it("should migrate legacy permissions.json to SQLite", () => {
			const jsonPath = join(testDir, "permissions.json");
			// Legacy JSON stored realpath-resolved paths (grant() resolved them)
			const resolvedOutside = realpathSync(outsideDir);
			const legacyData = {
				grants: [
					{
						type: "directory",
						resource: resolvedOutside,
						scope: "persistent",
						grantedAt: new Date().toISOString(),
					},
				],
			};
			writeFileSync(jsonPath, JSON.stringify(legacyData), "utf-8");

			const { mgr, db } = createMgr({ cwd: workspace, testDir, legacyJsonPath: jsonPath });

			// Grant should be accessible
			expectGranted(mgr.checkDirectory(outsideDir));

			// JSON should be renamed to .bak
			expect(existsSync(jsonPath)).toBe(false);
			expect(existsSync(`${jsonPath}.bak`)).toBe(true);

			// Audit should log migration
			const audit = db.getAuditLog(10);
			const migrationEvent = audit.find((e) => e.event === "migration");
			expect(migrationEvent).toBeDefined();
			db.close();
		});

		it("should handle corrupted legacy JSON gracefully", () => {
			const jsonPath = join(testDir, "permissions.json");
			writeFileSync(jsonPath, "NOT JSON{{{", "utf-8");

			const { mgr, db } = createMgr({ cwd: workspace, testDir, legacyJsonPath: jsonPath });
			expectDenied(mgr.checkDirectory(outsideDir));
			db.close();
		});

		it("should handle missing legacy JSON gracefully", () => {
			const jsonPath = join(testDir, "nonexistent.json");
			const { mgr, db } = createMgr({ cwd: workspace, testDir, legacyJsonPath: jsonPath });
			expectDenied(mgr.checkDirectory(outsideDir));
			db.close();
		});
	});

	// ── Cross-session isolation ─────────────────────────────────────────

	describe("cross-session isolation", () => {
		it("once grants from one session should not appear in a new session", () => {
			const db1 = createTestDb(testDir);
			const mgr1 = new PermissionManager({ cwd: workspace, db: db1, preAllowedDirs: [] });
			mgr1.grant("directory", outsideDir, "once");
			db1.close();

			const db2 = createTestDb(testDir);
			const mgr2 = new PermissionManager({ cwd: workspace, db: db2, preAllowedDirs: [] });
			expectDenied(mgr2.checkDirectory(outsideDir));
			db2.close();
		});

		it("session grants from one session should not appear in a new session", () => {
			const db1 = createTestDb(testDir);
			const mgr1 = new PermissionManager({ cwd: workspace, db: db1, preAllowedDirs: [] });
			mgr1.grant("directory", outsideDir, "session");
			db1.close();

			const db2 = createTestDb(testDir);
			const mgr2 = new PermissionManager({ cwd: workspace, db: db2, preAllowedDirs: [] });
			expectDenied(mgr2.checkDirectory(outsideDir));
			db2.close();
		});

		it("persistent grants should appear in a new session", () => {
			// Use the SAME db path for both sessions to test cross-session persistence
			const sharedDbPath = join(testDir, "shared-permissions.db");
			const db1 = new PermissionDb(sharedDbPath);
			const mgr1 = new PermissionManager({ cwd: workspace, db: db1, preAllowedDirs: [] });
			mgr1.grant("directory", outsideDir, "persistent");
			db1.close();

			const db2 = new PermissionDb(sharedDbPath);
			const mgr2 = new PermissionManager({ cwd: workspace, db: db2, preAllowedDirs: [] });
			expectGranted(mgr2.checkDirectory(outsideDir));
			db2.close();
		});
	});
});

// ============================================================================
// bash-path-extractor
// ============================================================================

describe("extractPathsFromCommand", () => {
	const cwd = "/home/user/project";

	it("should extract absolute paths", () => {
		const paths = extractPathsFromCommand("cat /etc/passwd", cwd);
		// /etc/passwd has no file extension, treated as directory-like
		expect(paths).toContain("/etc/passwd");
	});

	it("should extract tilde paths", () => {
		const paths = extractPathsFromCommand("cat ~/.ssh/id_rsa", cwd);
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.some((p) => p.includes(".ssh"))).toBe(true);
	});

	it("should extract relative escape paths", () => {
		const paths = extractPathsFromCommand("cat ../../etc/passwd", cwd);
		expect(paths.length).toBeGreaterThan(0);
	});

	it("should skip paths inside CWD", () => {
		const paths = extractPathsFromCommand("cat /home/user/project/src/index.ts", cwd);
		expect(paths).toHaveLength(0);
	});

	it("should skip /dev/null", () => {
		const paths = extractPathsFromCommand("echo test > /dev/null", cwd);
		expect(paths).toHaveLength(0);
	});

	it("should skip URLs", () => {
		const paths = extractPathsFromCommand("curl https://example.com/path/to/file", cwd);
		expect(paths).toHaveLength(0);
	});

	it("should extract cd targets", () => {
		const paths = extractPathsFromCommand("cd /tmp && ls", cwd);
		expect(paths).toContain("/tmp");
	});

	it("should extract redirect targets", () => {
		const paths = extractPathsFromCommand("echo x > /tmp/output.txt", cwd);
		expect(paths).toContain("/tmp");
	});

	it("should handle pipe chains", () => {
		const paths = extractPathsFromCommand("cat /etc/hosts | grep localhost", cwd);
		expect(paths).toContain("/etc/hosts");
	});

	it("should deduplicate paths", () => {
		const paths = extractPathsFromCommand("cat /etc/hosts && cat /etc/passwd", cwd);
		const unique = new Set(paths);
		expect(paths.length).toBe(unique.size);
	});

	it("should handle quoted paths", () => {
		const paths = extractPathsFromCommand('cat "/etc/hosts"', cwd);
		expect(paths).toContain("/etc/hosts");
	});

	describe("isOutsideCwd", () => {
		it("should return true for outside paths", () => {
			expect(isOutsideCwd("/etc", "/home/user/project")).toBe(true);
		});

		it("should return false for CWD itself", () => {
			expect(isOutsideCwd("/home/user/project", "/home/user/project")).toBe(false);
		});

		it("should return false for paths inside CWD", () => {
			expect(isOutsideCwd("/home/user/project/src", "/home/user/project")).toBe(false);
		});
	});
});

// ============================================================================
// wrap-tools — Tool Middleware
// ============================================================================

describe("wrapToolsWithPermissions", () => {
	let testDir: string;
	let workspace: string;
	let outsideDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `wrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspace = join(testDir, "workspace");
		outsideDir = join(testDir, "outside");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool wrapping", () => {
		it("should allow reading files inside CWD", async () => {
			const file = join(workspace, "test.txt");
			writeFileSync(file, "hello");
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t1", { path: file });
			expect(getTextOutput(result)).toContain("hello");
			db.close();
		});

		it("should deny reading files outside CWD without grant", async () => {
			const file = join(outsideDir, "secret.txt");
			writeFileSync(file, "secret");
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t2", { path: file });
			expect(getTextOutput(result)).toContain("Permission denied");
			db.close();
		});

		it("should allow reading outside CWD after session grant", async () => {
			const file = join(outsideDir, "data.txt");
			writeFileSync(file, "data");
			const promptFn = createMockPromptFn({ action: "allow", scope: "session" });
			const { mgr, db } = createMgr({ cwd: workspace, testDir, promptFn });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t3", { path: file });
			expect(getTextOutput(result)).toContain("data");
			db.close();
		});
	});

	describe("write tool wrapping", () => {
		it("should allow writing files inside CWD", async () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createWriteTool(workspace)), mgr);

			const result = await wrapped.execute("t6", { path: join(workspace, "out.txt"), content: "ok" });
			expect(getTextOutput(result)).toContain("Successfully wrote");
			db.close();
		});

		it("should deny writing files outside CWD without grant", async () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createWriteTool(workspace)), mgr);

			const result = await wrapped.execute("t7", { path: join(outsideDir, "out.txt"), content: "bad" });
			expect(getTextOutput(result)).toContain("Permission denied");
			expect(existsSync(join(outsideDir, "out.txt"))).toBe(false);
			db.close();
		});
	});

	describe("bash tool wrapping", () => {
		it("should be wrapped (extracts paths from commands)", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const original = createBashTool(workspace);
			const [wrapped] = wrapToolsWithPermissions(asTools(original), mgr);

			// Bash IS now wrapped (unlike before when it was passed through)
			expect(wrapped).not.toBe(original);
			expect(wrapped.name).toBe("bash");
			db.close();
		});

		it("should deny bash commands accessing outside-CWD paths", async () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createBashTool(workspace)), mgr);

			const result = await wrapped.execute("t-bash", { command: "cat /etc/passwd" });
			expect(getTextOutput(result)).toContain("Permission denied");
			db.close();
		});

		it("should allow bash commands within CWD", async () => {
			writeFileSync(join(workspace, "hello.txt"), "hello from bash");
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createBashTool(workspace)), mgr);

			const result = await wrapped.execute("t-bash2", { command: "cat hello.txt" });
			expect(getTextOutput(result)).toContain("hello from bash");
			db.close();
		});
	});

	describe("ls tool wrapping", () => {
		it("should allow listing inside CWD", async () => {
			writeFileSync(join(workspace, "file.txt"), "x");
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createLsTool(workspace)), mgr);

			const result = await wrapped.execute("t10", { path: workspace });
			expect(getTextOutput(result)).toContain("file.txt");
			db.close();
		});

		it("should deny listing outside CWD without grant", async () => {
			writeFileSync(join(outsideDir, "secret.txt"), "x");
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const [wrapped] = wrapToolsWithPermissions(asTools(createLsTool(workspace)), mgr);

			const result = await wrapped.execute("t11", { path: outsideDir });
			expect(getTextOutput(result)).toContain("Permission denied");
			db.close();
		});
	});

	describe("non-filesystem tools", () => {
		it("should pass through unknown tools unwrapped", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const customTool: AgentTool<any> = {
				name: "custom_tool",
				label: "custom",
				description: "custom tool",
				parameters: {} as any,
				execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined })),
			};
			const [wrapped] = wrapToolsWithPermissions([customTool], mgr);
			expect(wrapped).toBe(customTool);
			db.close();
		});
	});

	describe("wrapToolRegistryWithPermissions", () => {
		it("should wrap all registry entries", () => {
			const { mgr, db } = createMgr({ cwd: workspace, testDir });
			const registry = new Map<string, AgentTool>();
			registry.set("read", createReadTool(workspace) as unknown as AgentTool);
			registry.set("bash", createBashTool(workspace) as unknown as AgentTool);

			const wrapped = wrapToolRegistryWithPermissions(registry, mgr);

			expect(wrapped.size).toBe(2);
			expect(wrapped.get("read")).not.toBe(registry.get("read"));
			// bash is NOW wrapped too (path extraction)
			expect(wrapped.get("bash")).not.toBe(registry.get("bash"));
			db.close();
		});
	});
});
