/**
 * Tools Configuration
 *
 * Use built-in tool sets or individual tools.
 *
 * IMPORTANT: When using a custom `cwd`, you must use the tool factory functions
 * (createCodingTools, createReadOnlyTools, createReadTool, etc.) to ensure
 * tools resolve paths relative to your cwd, not process.cwd().
 *
 * For custom tools, see 06-extensions.ts - custom tools are now registered
 * via the extensions system using pi.registerTool().
 */

import {
	bashTool,
	createAgentSession,
	createBashTool,
	createCodingTools,
	createReadTool,
	readOnlyTools,
	readTool,
	SessionManager,
} from "coding-agent";

// Read-only mode (no edit/write) - uses process.cwd()
await createAgentSession({
	tools: readOnlyTools,
	sessionManager: SessionManager.inMemory(),
});
console.log("Read-only session created");

// Custom tool selection - uses process.cwd()
// Note: Use bash tool with rg/fd for grep/find functionality
await createAgentSession({
	tools: [readTool, bashTool],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");

// With custom cwd - MUST use factory functions!
const customCwd = "/path/to/project";
await createAgentSession({
	cwd: customCwd,
	tools: createCodingTools(customCwd), // Tools resolve paths relative to customCwd
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom cwd session created");

// Or pick specific tools for custom cwd
await createAgentSession({
	cwd: customCwd,
	tools: [createReadTool(customCwd), createBashTool(customCwd)],
	sessionManager: SessionManager.inMemory(),
});
console.log("Specific tools with custom cwd session created");
