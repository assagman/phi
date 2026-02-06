import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../src/core/permissions/permission-manager.js";
import type {
	PermissionCheckResult,
	PermissionPromptFn,
	PermissionPromptResult,
	PersistedPermissions,
} from "../src/core/permissions/types.js";
import { wrapToolRegistryWithPermissions, wrapToolsWithPermissions } from "../src/core/permissions/wrap-tools.js";
import { createBashTool } from "../src/core/tools/bash.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createWriteTool } from "../src/core/tools/write.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Cast concrete tools to base AgentTool[] for wrapping */
function asTools(...tools: AgentTool<any>[]): AgentTool[] {
	return tools as AgentTool[];
}

/** Expect a granted result and return it narrowed */
function expectGranted(result: PermissionCheckResult) {
	expect(result.status).toBe("granted");
	if (result.status !== "granted") throw new Error("unreachable");
	return result;
}

/** Expect a denied result and return it narrowed */
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

// ============================================================================
// PermissionManager — Core Logic
// ============================================================================

describe("PermissionManager", () => {
	let testDir: string;
	let workspace: string;
	let outsideDir: string;
	let persistPath: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspace = join(testDir, "workspace");
		outsideDir = join(testDir, "outside");
		persistPath = join(testDir, "permissions.json");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// ── CWD containment ─────────────────────────────────────────────────

	describe("isWithinCwd", () => {
		it("should allow paths inside CWD", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expect(mgr.isWithinCwd(join(workspace, "src", "index.ts"))).toBe(true);
		});

		it("should allow the CWD itself", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expect(mgr.isWithinCwd(workspace)).toBe(true);
		});

		it("should deny paths outside CWD", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expect(mgr.isWithinCwd(outsideDir)).toBe(false);
		});

		it("should deny paths that share a prefix but are not children", () => {
			const extraDir = join(testDir, "workspace-extra");
			mkdirSync(extraDir, { recursive: true });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expect(mgr.isWithinCwd(extraDir)).toBe(false);
		});

		it("should normalize .. traversals", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expect(mgr.isWithinCwd(join(workspace, "src", "..", "index.ts"))).toBe(true);
			expect(mgr.isWithinCwd(join(workspace, "..", "outside"))).toBe(false);
		});

		it("should detect symlink escapes via realpath", () => {
			const targetOutside = join(outsideDir, "secret");
			mkdirSync(targetOutside, { recursive: true });
			const symlinkInside = join(workspace, "link-to-outside");
			symlinkSync(targetOutside, symlinkInside);

			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expect(mgr.isWithinCwd(symlinkInside)).toBe(false);
		});
	});

	// ── checkDirectory ──────────────────────────────────────────────────

	describe("checkDirectory", () => {
		it("should grant paths inside CWD", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const result = expectGranted(mgr.checkDirectory(join(workspace, "src")));
			expect(result.scope).toBe("session");
		});

		it("should deny paths outside CWD with no grants", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectDenied(mgr.checkDirectory(outsideDir));
		});

		it("should grant pre-allowed directories", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [outsideDir] });
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("persistent");
		});

		it("should grant subdirectories of pre-allowed dirs", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [outsideDir] });
			const subDir = join(outsideDir, "deep", "nested");
			mkdirSync(subDir, { recursive: true });
			expectGranted(mgr.checkDirectory(subDir));
		});

		it("should NOT grant sibling of pre-allowed dir", () => {
			const allowed = join(testDir, "allowed");
			const sibling = join(testDir, "allowed-extra");
			mkdirSync(allowed, { recursive: true });
			mkdirSync(sibling, { recursive: true });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [allowed] });
			expectDenied(mgr.checkDirectory(sibling));
		});
	});

	// ── Grant scopes ────────────────────────────────────────────────────

	describe("grant scopes", () => {
		it("once grants should be found by checkDirectory", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "once");
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("once");
		});

		it("once grants should be cleared by clearOnceGrants", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "once");
			mgr.clearOnceGrants();
			expectDenied(mgr.checkDirectory(outsideDir));
		});

		it("session grants should be found by checkDirectory", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "session");
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("session");
		});

		it("session grants should survive clearOnceGrants", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "session");
			mgr.clearOnceGrants();
			expectGranted(mgr.checkDirectory(outsideDir));
		});

		it("session grants should be cleared by clearSessionGrants", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "session");
			mgr.clearSessionGrants();
			expectDenied(mgr.checkDirectory(outsideDir));
		});

		it("clearSessionGrants should also clear once grants", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "once");
			mgr.clearSessionGrants();
			expectDenied(mgr.checkDirectory(outsideDir));
		});

		it("persistent grants should be found by checkDirectory", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "persistent");
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("persistent");
		});

		it("persistent grants should survive clearSessionGrants", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "persistent");
			mgr.clearSessionGrants();
			expectGranted(mgr.checkDirectory(outsideDir));
		});
	});

	// ── Grant priority order ────────────────────────────────────────────

	describe("grant priority", () => {
		it("should check pre-allowed before persistent", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [outsideDir] });
			mgr.grant("directory", outsideDir, "persistent");
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("persistent");
		});
	});

	// ── Persistence ─────────────────────────────────────────────────────

	describe("persistence", () => {
		it("should write persistent grants to disk", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "persistent");
			expect(existsSync(persistPath)).toBe(true);
			const data = JSON.parse(readFileSync(persistPath, "utf-8")) as PersistedPermissions;
			expect(data.grants).toHaveLength(1);
			// grant() resolves paths via safeRealpath (on macOS /var -> /private/var)
			expect(data.grants[0].resource).toBe(realpathSync(outsideDir));
			expect(data.grants[0].scope).toBe("persistent");
		});

		it("should NOT write once grants to disk", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "once");
			expect(existsSync(persistPath)).toBe(false);
		});

		it("should NOT write session grants to disk", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "session");
			expect(existsSync(persistPath)).toBe(false);
		});

		it("should load persistent grants on construction", () => {
			const data: PersistedPermissions = {
				grants: [
					{
						type: "directory",
						resource: outsideDir,
						scope: "persistent",
						grantedAt: new Date().toISOString(),
					},
				],
			};
			writeFileSync(persistPath, JSON.stringify(data), "utf-8");

			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectGranted(mgr.checkDirectory(outsideDir));
		});

		it("should NOT load non-persistent grants from disk", () => {
			const data: PersistedPermissions = {
				grants: [
					{
						type: "directory",
						resource: outsideDir,
						scope: "once" as any,
						grantedAt: new Date().toISOString(),
					},
					{
						type: "directory",
						resource: join(testDir, "other"),
						scope: "session" as any,
						grantedAt: new Date().toISOString(),
					},
				],
			};
			writeFileSync(persistPath, JSON.stringify(data), "utf-8");

			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectDenied(mgr.checkDirectory(outsideDir));
		});

		it("should handle corrupted permissions file gracefully", () => {
			writeFileSync(persistPath, "NOT JSON{{{", "utf-8");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectDenied(mgr.checkDirectory(outsideDir));
		});

		it("should handle missing permissions file", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectDenied(mgr.checkDirectory(outsideDir));
		});

		it("should revoke persistent grants and update disk", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr.grant("directory", outsideDir, "persistent");
			expectGranted(mgr.checkDirectory(outsideDir));

			mgr.revokePersistent("directory", outsideDir);
			expectDenied(mgr.checkDirectory(outsideDir));

			const data = JSON.parse(readFileSync(persistPath, "utf-8")) as PersistedPermissions;
			expect(data.grants).toHaveLength(0);
		});

		it("getPersistentGrants should return all persistent grants", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const dir2 = join(testDir, "dir2");
			mkdirSync(dir2, { recursive: true });
			mgr.grant("directory", outsideDir, "persistent");
			mgr.grant("directory", dir2, "persistent");
			mgr.grant("directory", join(testDir, "session-only"), "session");
			mgr.grant("directory", join(testDir, "once-only"), "once");

			const grants = mgr.getPersistentGrants();
			expect(grants).toHaveLength(2);
			expect(grants.map((g) => g.resource).sort()).toEqual([realpathSync(outsideDir), realpathSync(dir2)].sort());
		});
	});

	// ── requestDirectory + prompt ───────────────────────────────────────

	describe("requestDirectory", () => {
		it("should return granted without prompting for paths inside CWD", async () => {
			const promptFn = vi.fn();
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			const result = await mgr.requestDirectory(join(workspace, "src"), "read");
			expect(result.status).toBe("granted");
			expect(promptFn).not.toHaveBeenCalled();
		});

		it("should return granted without prompting for pre-allowed dirs", async () => {
			const promptFn = vi.fn();
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [outsideDir], promptFn });
			const result = await mgr.requestDirectory(outsideDir, "read");
			expect(result.status).toBe("granted");
			expect(promptFn).not.toHaveBeenCalled();
		});

		it("should prompt when no grant exists", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "session" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			const result = await mgr.requestDirectory(outsideDir, "read");
			expect(result.status).toBe("granted");
			expect(promptFn).toHaveBeenCalledOnce();
		});

		it("should not prompt again after once grant (same turn)", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "once" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });

			await mgr.requestDirectory(outsideDir, "read");
			await mgr.requestDirectory(outsideDir, "write");

			expect(promptFn).toHaveBeenCalledOnce();
		});

		it("should prompt again after clearOnceGrants", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "once" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });

			await mgr.requestDirectory(outsideDir, "read");
			mgr.clearOnceGrants();
			await mgr.requestDirectory(outsideDir, "read");

			expect(promptFn).toHaveBeenCalledTimes(2);
		});

		it("should deny when no promptFn is set", async () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const result = await mgr.requestDirectory(outsideDir, "read");
			expect(result.status).toBe("denied");
		});

		it("should pass rejection with user message", async () => {
			const promptFn = createMockPromptFn({ action: "deny", userMessage: "Try /workspace/data instead" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			const result = expectDenied(await mgr.requestDirectory(outsideDir, "read"));
			expect(result.userMessage).toBe("Try /workspace/data instead");
		});

		it("should pass rejection without user message", async () => {
			const promptFn = createMockPromptFn({ action: "deny" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			const result = expectDenied(await mgr.requestDirectory(outsideDir, "read"));
			expect(result.userMessage).toBeUndefined();
		});

		it("should pass correct request details to promptFn", async () => {
			const promptFn = createMockPromptFn({ action: "deny" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			await mgr.requestDirectory(outsideDir, "edit");

			const realOutsideDir = realpathSync(outsideDir);
			expect(promptFn).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "directory",
					detail: { path: realOutsideDir },
					toolName: "edit",
					description: expect.stringContaining(realOutsideDir),
				}),
			);
		});

		it("prompt allow-once should create once grant (not persistent)", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "once" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			await mgr.requestDirectory(outsideDir, "read");

			expect(existsSync(persistPath)).toBe(false);
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("once");
		});

		it("prompt allow-session should create session grant (not persistent)", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "session" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			await mgr.requestDirectory(outsideDir, "read");

			expect(existsSync(persistPath)).toBe(false);
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("session");
		});

		it("prompt allow-always should create persistent grant (on disk)", async () => {
			const promptFn = createMockPromptFn({ action: "allow", scope: "persistent" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			await mgr.requestDirectory(outsideDir, "read");

			expect(existsSync(persistPath)).toBe(true);
			const result = expectGranted(mgr.checkDirectory(outsideDir));
			expect(result.scope).toBe("persistent");
		});
	});

	// ── Pre-allowed dirs edge cases ─────────────────────────────────────

	describe("pre-allowed dirs", () => {
		it("should handle tilde expansion in pre-allowed dirs", () => {
			const mgr = new PermissionManager({
				cwd: workspace,
				persistPath,
				preAllowedDirs: ["~/some-unlikely-test-path-xyz"],
			});
			// CWD goes through safeRealpath (on macOS /var -> /private/var)
			expect(mgr.cwd).toBe(realpathSync(resolve(workspace)));
		});

		it("should handle empty pre-allowed dirs array", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectDenied(mgr.checkDirectory(outsideDir));
		});
	});

	// ── Cross-session isolation ─────────────────────────────────────────

	describe("cross-session isolation", () => {
		it("once grants from one PermissionManager should not appear in a new one", () => {
			const mgr1 = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr1.grant("directory", outsideDir, "once");

			const mgr2 = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectDenied(mgr2.checkDirectory(outsideDir));
		});

		it("session grants from one PermissionManager should not appear in a new one", () => {
			const mgr1 = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr1.grant("directory", outsideDir, "session");

			const mgr2 = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectDenied(mgr2.checkDirectory(outsideDir));
		});

		it("persistent grants should appear in a new PermissionManager", () => {
			const mgr1 = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			mgr1.grant("directory", outsideDir, "persistent");

			const mgr2 = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			expectGranted(mgr2.checkDirectory(outsideDir));
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
	let persistPath: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `wrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspace = join(testDir, "workspace");
		outsideDir = join(testDir, "outside");
		persistPath = join(testDir, "permissions.json");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// ── Read tool ───────────────────────────────────────────────────────

	describe("read tool wrapping", () => {
		it("should allow reading files inside CWD", async () => {
			const file = join(workspace, "test.txt");
			writeFileSync(file, "hello");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t1", { path: file });
			expect(getTextOutput(result)).toContain("hello");
		});

		it("should deny reading files outside CWD without grant", async () => {
			const file = join(outsideDir, "secret.txt");
			writeFileSync(file, "secret");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t2", { path: file });
			expect(getTextOutput(result)).toContain("Permission denied");
		});

		it("should allow reading outside CWD after session grant", async () => {
			const file = join(outsideDir, "data.txt");
			writeFileSync(file, "data");
			const promptFn = createMockPromptFn({ action: "allow", scope: "session" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t3", { path: file });
			expect(getTextOutput(result)).toContain("data");
		});

		it("should include user message in denial", async () => {
			const file = join(outsideDir, "nope.txt");
			writeFileSync(file, "nope");
			const promptFn = createMockPromptFn({ action: "deny", userMessage: "Use workspace/data.txt" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t4", { path: file });
			expect(getTextOutput(result)).toContain("Use workspace/data.txt");
		});

		it("should check dirname for file paths (directory-level grants)", async () => {
			const subDir = join(outsideDir, "sub");
			mkdirSync(subDir, { recursive: true });
			const file1 = join(subDir, "a.txt");
			const file2 = join(subDir, "b.txt");
			writeFileSync(file1, "aaa");
			writeFileSync(file2, "bbb");

			const promptFn = createMockPromptFn({ action: "allow", scope: "session" });
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [], promptFn });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			await wrapped.execute("t5a", { path: file1 });
			const result = await wrapped.execute("t5b", { path: file2 });
			expect(getTextOutput(result)).toContain("bbb");
			expect(promptFn).toHaveBeenCalledOnce();
		});
	});

	// ── Write tool ──────────────────────────────────────────────────────

	describe("write tool wrapping", () => {
		it("should allow writing files inside CWD", async () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createWriteTool(workspace)), mgr);

			const result = await wrapped.execute("t6", { path: join(workspace, "out.txt"), content: "ok" });
			expect(getTextOutput(result)).toContain("Successfully wrote");
		});

		it("should deny writing files outside CWD without grant", async () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createWriteTool(workspace)), mgr);

			const result = await wrapped.execute("t7", { path: join(outsideDir, "out.txt"), content: "bad" });
			expect(getTextOutput(result)).toContain("Permission denied");
			expect(existsSync(join(outsideDir, "out.txt"))).toBe(false);
		});
	});

	// ── Edit tool ───────────────────────────────────────────────────────

	describe("edit tool wrapping", () => {
		it("should allow editing files inside CWD", async () => {
			const file = join(workspace, "edit-me.txt");
			writeFileSync(file, "old text");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createEditTool(workspace)), mgr);

			const result = await wrapped.execute("t8", { path: file, oldText: "old text", newText: "new text" });
			expect(getTextOutput(result)).toContain("Successfully replaced");
		});

		it("should deny editing files outside CWD without grant", async () => {
			const file = join(outsideDir, "edit-me.txt");
			writeFileSync(file, "old text");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createEditTool(workspace)), mgr);

			const result = await wrapped.execute("t9", { path: file, oldText: "old text", newText: "hacked" });
			expect(getTextOutput(result)).toContain("Permission denied");
			expect(readFileSync(file, "utf-8")).toBe("old text");
		});
	});

	// ── Ls tool ─────────────────────────────────────────────────────────

	describe("ls tool wrapping", () => {
		it("should allow listing inside CWD", async () => {
			writeFileSync(join(workspace, "file.txt"), "x");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createLsTool(workspace)), mgr);

			const result = await wrapped.execute("t10", { path: workspace });
			expect(getTextOutput(result)).toContain("file.txt");
		});

		it("should deny listing outside CWD without grant", async () => {
			writeFileSync(join(outsideDir, "secret.txt"), "x");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createLsTool(workspace)), mgr);

			const result = await wrapped.execute("t11", { path: outsideDir });
			expect(getTextOutput(result)).toContain("Permission denied");
		});

		it("should allow listing with default path (CWD itself)", async () => {
			writeFileSync(join(workspace, "file.txt"), "x");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createLsTool(workspace)), mgr);

			const result = await wrapped.execute("t12", {});
			expect(getTextOutput(result)).toContain("file.txt");
		});
	});

	// ── Bash tool ───────────────────────────────────────────────────────

	describe("bash tool wrapping", () => {
		it("should NOT be wrapped (pass through unchanged)", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const original = createBashTool(workspace);
			const [wrapped] = wrapToolsWithPermissions(asTools(original), mgr);

			expect(wrapped).toBe(original);
		});
	});

	// ── Non-filesystem tools ────────────────────────────────────────────

	describe("non-filesystem tools", () => {
		it("should pass through unknown tools unwrapped", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const customTool: AgentTool = {
				name: "custom_tool",
				label: "custom",
				description: "custom tool",
				parameters: {} as any,
				execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined })),
			};
			const [wrapped] = wrapToolsWithPermissions([customTool], mgr);
			expect(wrapped).toBe(customTool);
		});
	});

	// ── Registry wrapping ───────────────────────────────────────────────

	describe("wrapToolRegistryWithPermissions", () => {
		it("should wrap all registry entries", () => {
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const registry = new Map<string, AgentTool>();
			registry.set("read", createReadTool(workspace) as unknown as AgentTool);
			registry.set("bash", createBashTool(workspace) as unknown as AgentTool);

			const wrapped = wrapToolRegistryWithPermissions(registry, mgr);

			expect(wrapped.size).toBe(2);
			expect(wrapped.get("read")).not.toBe(registry.get("read"));
			expect(wrapped.get("bash")).toBe(registry.get("bash"));
		});
	});

	// ── Relative path handling ──────────────────────────────────────────

	describe("relative paths", () => {
		it("should resolve relative paths against tool CWD", async () => {
			writeFileSync(join(workspace, "local.txt"), "local content");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t13", { path: "local.txt" });
			expect(getTextOutput(result)).toContain("local content");
		});

		it("should detect .. traversal escaping CWD", async () => {
			writeFileSync(join(outsideDir, "escape.txt"), "escaped");
			const mgr = new PermissionManager({ cwd: workspace, persistPath, preAllowedDirs: [] });
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t14", { path: "../outside/escape.txt" });
			expect(getTextOutput(result)).toContain("Permission denied");
		});
	});

	// ── Pre-allowed dirs integration ────────────────────────────────────

	describe("pre-allowed dirs integration", () => {
		it("should allow reading from pre-allowed directory without prompt", async () => {
			const file = join(outsideDir, "allowed.txt");
			writeFileSync(file, "allowed content");
			const promptFn = vi.fn();
			const mgr = new PermissionManager({
				cwd: workspace,
				persistPath,
				preAllowedDirs: [outsideDir],
				promptFn,
			});
			const [wrapped] = wrapToolsWithPermissions(asTools(createReadTool(workspace)), mgr);

			const result = await wrapped.execute("t15", { path: file });
			expect(getTextOutput(result)).toContain("allowed content");
			expect(promptFn).not.toHaveBeenCalled();
		});
	});
});
