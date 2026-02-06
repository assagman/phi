/**
 * Deterministic test data generators for benchmark scenarios.
 * All generators produce the same output given the same parameters.
 */

/**
 * Generate a long markdown document in chunks (simulating LLM streaming).
 * Each chunk appends to the previous, building up a multi-block document.
 */
export function generateMarkdownChunks(totalChunks: number): string[] {
	const chunks: string[] = [];
	let accumulated = "";

	// Blocks rotate through: heading, paragraph, code block, list, blockquote
	const blockGenerators = [
		(i: number) => `## Section ${i}\n\n`,
		(i: number) =>
			`This is paragraph ${i} with **bold text**, *italic text*, and \`inline code\`. ` +
			`It contains a link and some longer text to exercise ` +
			`word wrapping across multiple lines in the terminal viewport. The quick brown fox jumps ` +
			`over the lazy dog, repeated for length.\n\n`,
		(i: number) =>
			"```typescript\n" +
			`function processItem${i}(data: Record<string, unknown>): void {\n` +
			`  const result = Object.keys(data).map(key => {\n` +
			`    return { key, value: data[key], index: ${i} };\n` +
			`  });\n` +
			`  console.log("Processed:", result.length, "items");\n` +
			`}\n` +
			"```\n\n",
		(i: number) =>
			`- Item ${i}a: First list entry with details\n` +
			`- Item ${i}b: Second list entry with **emphasis**\n` +
			`- Item ${i}c: Third entry with \`code\` inside\n` +
			`  - Nested sub-item with more text\n\n`,
		(i: number) => `> Blockquote ${i}: Important note about the implementation.\n> Second line of the quote.\n\n`,
	];

	for (let i = 0; i < totalChunks; i++) {
		const gen = blockGenerators[i % blockGenerators.length];
		const block = gen(i);
		// Simulate streaming: break block into small character chunks
		const chunkSize = 15 + (i % 10); // Vary chunk size 15-24 chars
		for (let offset = 0; offset < block.length; offset += chunkSize) {
			accumulated += block.slice(offset, offset + chunkSize);
			chunks.push(accumulated);
		}
	}

	return chunks;
}

/**
 * Generate a set of plain-text lines simulating bash/tool output.
 */
export function generateBashOutput(lineCount: number): string[] {
	const lines: string[] = [];
	for (let i = 0; i < lineCount; i++) {
		const lineType = i % 5;
		switch (lineType) {
			case 0:
				lines.push(`[${String(i).padStart(5, "0")}] INFO  Processing batch ${Math.floor(i / 10)}...`);
				break;
			case 1:
				lines.push(`[${String(i).padStart(5, "0")}] DEBUG   key=item_${i} value=${"x".repeat(20 + (i % 30))}`);
				break;
			case 2:
				lines.push(`[${String(i).padStart(5, "0")}] WARN  Retrying request (attempt ${(i % 3) + 1}/3)`);
				break;
			case 3:
				lines.push(`[${String(i).padStart(5, "0")}] INFO  ${"=".repeat(60)}`);
				break;
			case 4:
				lines.push(`[${String(i).padStart(5, "0")}] DATA  {"id":${i},"status":"ok","ts":${1700000000 + i}}`);
				break;
		}
	}
	return lines;
}

/**
 * Generate a simple identity theme for benchmarking (no ANSI overhead).
 */
export function createBenchTheme() {
	const identity = (s: string) => s;
	return {
		heading: identity,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: identity,
		italic: identity,
		strikethrough: identity,
		underline: identity,
	};
}
