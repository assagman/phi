/**
 * Sandbox violation tracking.
 *
 * Stores violation events from the macOS sandbox log monitor,
 * associates them with commands, and annotates stderr.
 */

import { EOL } from "node:os";
import { encodeSandboxedCommand } from "./sandbox-utils.js";
import type { SandboxViolationEvent } from "./types.js";

export class SandboxViolationStore {
	private _violations: SandboxViolationEvent[] = [];
	private _totalCount = 0;
	private readonly _maxSize = 100;
	private _listeners: Set<(violations: SandboxViolationEvent[]) => void> = new Set();

	addViolation(violation: SandboxViolationEvent): void {
		this._violations.push(violation);
		this._totalCount++;
		if (this._violations.length > this._maxSize) {
			this._violations = this._violations.slice(-this._maxSize);
		}
		this._notifyListeners();
	}

	getViolations(limit?: number): SandboxViolationEvent[] {
		if (limit === undefined) return [...this._violations];
		return this._violations.slice(-limit);
	}

	getCount(): number {
		return this._violations.length;
	}

	getTotalCount(): number {
		return this._totalCount;
	}

	getViolationsForCommand(command: string): SandboxViolationEvent[] {
		const commandBase64 = encodeSandboxedCommand(command);
		return this._violations.filter((v) => v.encodedCommand === commandBase64);
	}

	clear(): void {
		this._violations = [];
		this._notifyListeners();
	}

	subscribe(listener: (violations: SandboxViolationEvent[]) => void): () => void {
		this._listeners.add(listener);
		listener(this.getViolations());
		return () => {
			this._listeners.delete(listener);
		};
	}

	/**
	 * Annotate stderr with sandbox violation details for a given command.
	 */
	annotateStderr(command: string, stderr: string): string {
		const violations = this.getViolationsForCommand(command);
		if (violations.length === 0) return stderr;

		let annotated = stderr;
		annotated += `${EOL}<sandbox_violations>${EOL}`;
		for (const violation of violations) {
			annotated += violation.line + EOL;
		}
		annotated += `</sandbox_violations>`;
		return annotated;
	}

	private _notifyListeners(): void {
		const violations = this.getViolations();
		for (const listener of this._listeners) {
			listener(violations);
		}
	}
}
