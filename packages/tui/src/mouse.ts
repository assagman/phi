/**
 * Mouse event handling for TUI
 * Supports SGR extended coordinates mode (1006) for precise mouse tracking
 *
 * SGR mouse protocol:
 * - Press: CSI < Cb ; Cx ; Cy M
 * - Release: CSI < Cb ; Cx ; Cy m
 *
 * Where:
 * - Cb = button + modifiers (see parseMouseButton)
 * - Cx = column (1-indexed)
 * - Cy = row (1-indexed)
 */

export interface MouseEvent {
	type: "press" | "release" | "drag" | "scroll" | "move";
	button: MouseButton;
	modifiers: MouseModifiers;
	column: number; // 0-indexed
	row: number; // 0-indexed
}

export type MouseButton =
	| "left"
	| "middle"
	| "right"
	| "scrollUp"
	| "scrollDown"
	| "scrollLeft"
	| "scrollRight"
	| "none";

export interface MouseModifiers {
	shift: boolean;
	meta: boolean;
	ctrl: boolean;
}

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Parse SGR mouse event from terminal input.
 * Returns the parsed event if valid SGR mouse sequence, null otherwise.
 *
 * SGR protocol (CSI < ... M/m):
 * The Cb value is encoded as:
 * - Bits 0-1: button (0=left, 1=middle, 2=right, 3=release)
 * - Bit 2: shift modifier (adds 4)
 * - Bit 3: meta/alt modifier (adds 8)
 * - Bit 4: ctrl modifier (adds 16)
 * - Bit 5: drag indicator (adds 32)
 * - Bits 6-7: scroll wheel (adds 64) - encodes scroll up/down/left/right
 */
export function parseMouseEvent(data: string): MouseEvent | null {
	const match = data.match(SGR_MOUSE_PATTERN);
	if (!match) return null;

	const buttonCode = parseInt(match[1], 10);
	const col = parseInt(match[2], 10) - 1; // Convert to 0-indexed
	const row = parseInt(match[3], 10) - 1; // Convert to 0-indexed
	const isRelease = match[4] === "m";

	const { button, modifiers, isDrag } = parseMouseButton(buttonCode);

	// Determine event type
	let type: MouseEvent["type"];
	if (button.startsWith("scroll")) {
		type = "scroll";
	} else if (isDrag) {
		type = "drag";
	} else if (isRelease) {
		type = "release";
	} else {
		type = "press";
	}

	return {
		type,
		button,
		modifiers,
		column: col,
		row,
	};
}

/**
 * Check if data looks like a potential mouse event (starts with CSI <).
 * Used for buffering incomplete sequences.
 */
export function isPotentialMouseEvent(data: string): boolean {
	return data.startsWith("\x1b[<");
}

/**
 * Parse mouse button code from SGR protocol.
 *
 * Button encoding (bits 0-1):
 * - 0 = left button press
 * - 1 = middle button press
 * - 2 = right button press
 * - 3 = release/motion with no button
 *
 * Scroll wheel encoding (when bits 6-7 are set, i.e., Cb >= 64):
 * - 64 = scroll up
 * - 65 = scroll down
 * - 66 = scroll left (shift + scroll up)
 * - 67 = scroll right (shift + scroll down)
 *
 * Modifier bits (add to base value):
 * - Bit 2 (value 4): shift
 * - Bit 3 (value 8): meta/alt
 * - Bit 4 (value 16): ctrl
 * - Bit 5 (value 32): drag/motion
 */
function parseMouseButton(code: number): { button: MouseButton; modifiers: MouseModifiers; isDrag: boolean } {
	// Extract modifier bits
	const modifiers = {
		shift: (code & 4) !== 0,
		meta: (code & 8) !== 0,
		ctrl: (code & 16) !== 0,
	};

	// Check for drag/motion (bit 5)
	const isDrag = (code & 32) !== 0;

	// Check for scroll wheel (bits 6-7 indicate scroll, i.e., code >= 64)
	if (code >= 64) {
		// For scroll events, the low 2 bits indicate direction
		const scrollType = code & 3;
		switch (scrollType) {
			case 0:
				return { button: "scrollUp", modifiers, isDrag: false };
			case 1:
				return { button: "scrollDown", modifiers, isDrag: false };
			case 2:
				return { button: "scrollLeft", modifiers, isDrag: false };
			case 3:
				return { button: "scrollRight", modifiers, isDrag: false };
		}
	}

	// Normal button press/release (bits 0-1)
	const buttonCode = code & 3;
	let button: MouseButton;
	switch (buttonCode) {
		case 0:
			button = "left";
			break;
		case 1:
			button = "middle";
			break;
		case 2:
			button = "right";
			break;
		case 3:
			button = "none";
			break;
		default:
			button = "none";
	}

	return { button, modifiers, isDrag };
}

/**
 * Check if input data is a complete SGR mouse event.
 */
export function isCompleteMouseEvent(data: string): boolean {
	return SGR_MOUSE_PATTERN.test(data);
}
