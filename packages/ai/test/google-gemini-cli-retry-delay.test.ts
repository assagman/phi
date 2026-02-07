import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractRetryDelay } from "../src/providers/google-gemini-cli.js";

describe("extractRetryDelay header parsing", () => {
	let originalDateNow: typeof Date.now;

	beforeEach(() => {
		originalDateNow = Date.now;
	});

	afterEach(() => {
		Date.now = originalDateNow;
	});

	it("prefers Retry-After seconds header", () => {
		const response = new Response("", { headers: { "Retry-After": "5" } });
		const delay = extractRetryDelay("Please retry in 1s", response);

		expect(delay).toBe(6000);
	});

	it("parses Retry-After HTTP date header", () => {
		const now = new Date("2025-01-01T00:00:00Z");
		Date.now = () => now.getTime();

		const retryAt = new Date(now.getTime() + 12000).toUTCString();
		const response = new Response("", { headers: { "Retry-After": retryAt } });
		const delay = extractRetryDelay("", response);

		expect(delay).toBe(13000);
	});

	it("parses x-ratelimit-reset header", () => {
		const now = new Date("2025-01-01T00:00:00Z");
		Date.now = () => now.getTime();

		const resetAtMs = now.getTime() + 20000;
		const resetSeconds = Math.floor(resetAtMs / 1000).toString();
		const response = new Response("", { headers: { "x-ratelimit-reset": resetSeconds } });
		const delay = extractRetryDelay("", response);

		expect(delay).toBe(21000);
	});

	it("parses x-ratelimit-reset-after header", () => {
		const response = new Response("", { headers: { "x-ratelimit-reset-after": "30" } });
		const delay = extractRetryDelay("", response);

		expect(delay).toBe(31000);
	});
});
