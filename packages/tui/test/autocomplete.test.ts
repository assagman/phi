import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";

// Resolve fd path for fuzzy search tests
function findFd(): string | null {
	const { execSync } = require("node:child_process");
	try {
		return execSync("which fd", { encoding: "utf-8" }).trim() || null;
	} catch {
		return null;
	}
}

const fdPath = findFd();

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			assert.notEqual(result, null, "Should return suggestions for root directory");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});

		it("extracts /A from '/A' when forced", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2; // After the "A"

			const result = provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			console.log("Result:", result);
			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			if (result) {
				assert.strictEqual(result.prefix, "/A", "Prefix should be '/A'");
			}
		});

		it("does not trigger for slash commands", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6; // After "model"

			const result = provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			console.log("Result:", result);
			assert.strictEqual(result, null, "Should not trigger for slash commands");
		});

		it("triggers for absolute paths after slash command argument", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10; // After the second "/"

			const result = provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			console.log("Result:", result);
			assert.notEqual(result, null, "Should trigger for absolute paths in command arguments");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});
	});

	describe("@ fuzzy file search (multi-token)", () => {
		let testDir: string;

		beforeEach(() => {
			// Create a temp directory tree that mimics a project structure
			testDir = join(tmpdir(), `autocomplete-test-${Date.now()}`);
			mkdirSync(join(testDir, "packages", "tui", "src"), { recursive: true });
			mkdirSync(join(testDir, "packages", "ai", "src"), { recursive: true });
			writeFileSync(join(testDir, "packages", "tui", "src", "autocomplete.ts"), "");
			writeFileSync(join(testDir, "packages", "tui", "src", "fuzzy.ts"), "");
			writeFileSync(join(testDir, "packages", "ai", "src", "stream.ts"), "");
			// Add .git so findGitRoot resolves to testDir
			mkdirSync(join(testDir, ".git"), { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("getSuggestions returns results for single-token @ query", () => {
			if (!fdPath) return; // skip if fd not available
			const provider = new CombinedAutocompleteProvider([], testDir, fdPath);

			const result = provider.getSuggestions(["@fuzzy"], 0, 6);
			assert.notEqual(result, null, "Should return suggestions for @fuzzy");
			if (result) {
				assert.ok(result.prefix.startsWith("@"), "Prefix should start with @");
				assert.ok(result.items.length > 0, "Should have at least one match");
				assert.ok(
					result.items.some((item) => item.value.includes("fuzzy")),
					"Should match fuzzy.ts",
				);
			}
		});

		it("getSuggestions returns results for multi-token @ query", () => {
			if (!fdPath) return;
			const provider = new CombinedAutocompleteProvider([], testDir, fdPath);

			// "tui auto" should match "packages/tui/src/autocomplete.ts"
			const result = provider.getSuggestions(["@tui auto"], 0, 9);
			assert.notEqual(result, null, "Should return suggestions for multi-token query");
			if (result) {
				assert.strictEqual(result.prefix, "@tui auto", "Prefix should include full multi-token query");
				assert.ok(result.items.length > 0, "Should have at least one match");
				assert.ok(
					result.items.some((item) => item.description?.includes("autocomplete")),
					"Should match autocomplete.ts via multi-token search",
				);
			}
		});

		it("getSuggestions handles @ query after other text", () => {
			if (!fdPath) return;
			const provider = new CombinedAutocompleteProvider([], testDir, fdPath);

			// "@tui auto" after "look at " should still work
			const result = provider.getSuggestions(["look at @tui auto"], 0, 17);
			assert.notEqual(result, null, "Should return suggestions for @ after text");
			if (result) {
				assert.strictEqual(result.prefix, "@tui auto", "Prefix should be just the @ part");
				assert.ok(
					result.items.some((item) => item.description?.includes("autocomplete")),
					"Should match autocomplete.ts",
				);
			}
		});

		it("getSuggestions returns null for @ with no matches", () => {
			if (!fdPath) return;
			const provider = new CombinedAutocompleteProvider([], testDir, fdPath);

			const result = provider.getSuggestions(["@xyznonexistent"], 0, 15);
			assert.strictEqual(result, null, "Should return null when no files match");
		});
	});

	describe("applyCompletion with @ prefix", () => {
		it("replaces single-token @ prefix correctly", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["@fuz"];
			const item = { value: "@packages/tui/src/fuzzy.ts", label: "fuzzy.ts" };

			const result = provider.applyCompletion(lines, 0, 4, item, "@fuz");
			assert.strictEqual(result.lines[0], "@packages/tui/src/fuzzy.ts ");
			assert.strictEqual(result.cursorCol, "@packages/tui/src/fuzzy.ts ".length);
		});

		it("replaces multi-token @ prefix correctly", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["@tui auto"];
			const item = { value: "@packages/tui/src/autocomplete.ts", label: "autocomplete.ts" };

			const result = provider.applyCompletion(lines, 0, 9, item, "@tui auto");
			assert.strictEqual(result.lines[0], "@packages/tui/src/autocomplete.ts ");
			assert.strictEqual(result.cursorCol, "@packages/tui/src/autocomplete.ts ".length);
		});

		it("replaces multi-token @ prefix after other text", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["check @tui auto please"];
			const item = { value: "@packages/tui/src/autocomplete.ts", label: "autocomplete.ts" };
			// Cursor is at position 15 ("check @tui auto" length), prefix is "@tui auto"
			const result = provider.applyCompletion(lines, 0, 15, item, "@tui auto");
			assert.strictEqual(result.lines[0], "check @packages/tui/src/autocomplete.ts  please");
			assert.strictEqual(result.cursorCol, "check @packages/tui/src/autocomplete.ts ".length);
		});
	});
});
