/**
 * Rainbow Border - animates editor border with rainbow colors while agent is working
 *
 * This is an example extension demonstrating the built-in rainbow border feature.
 * The feature is enabled by default, but this extension shows how to customize
 * or implement similar animations.
 *
 * Usage: pi --extension ./examples/extensions/rainbow-border.ts
 */

import type { ExtensionAPI } from "coding-agent";

// Smooth rainbow colors (8 hues across the spectrum)
const RAINBOW: [number, number, number][] = [
	[255, 107, 107], // red
	[255, 159, 67], // orange
	[255, 217, 61], // yellow
	[111, 207, 151], // green
	[72, 219, 251], // cyan
	[108, 137, 227], // blue
	[156, 109, 217], // purple
	[243, 104, 185], // pink
];

function rgbColor(rgb: [number, number, number]): string {
	const [r, g, b] = rgb;
	return `\x1b[38;2;${r};${g};${b}m`;
}

function lerp(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

function lerpColor(c1: [number, number, number], c2: [number, number, number], t: number): [number, number, number] {
	return [lerp(c1[0]!, c2[0]!, t), lerp(c1[1]!, c2[1]!, t), lerp(c1[2]!, c2[2]!, t)];
}

function getRainbowColor(position: number): [number, number, number] {
	// position is 0-1, interpolate smoothly across the rainbow
	const scaled = position * RAINBOW.length;
	const index = Math.floor(scaled) % RAINBOW.length;
	const nextIndex = (index + 1) % RAINBOW.length;
	const t = scaled - Math.floor(scaled);
	return lerpColor(RAINBOW[index]!, RAINBOW[nextIndex]!, t);
}

const RESET = "\x1b[0m";

export default function (pi: ExtensionAPI) {
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let frame = 0;
	let savedBorderColor: ((str: string) => string) | undefined;

	function startAnimation(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		if (animationTimer) return;

		// Save the current border color
		savedBorderColor = ctx.ui.editorComponent?.borderColor;

		frame = 0;
		animationTimer = setInterval(() => {
			frame++;
			// Slow cycle: ~4 seconds for full rainbow (60fps * 4 = 240 frames)
			const position = (frame % 240) / 240;
			const color = getRainbowColor(position);
			const colorCode = rgbColor(color);

			if (ctx.ui.editorComponent) {
				ctx.ui.editorComponent.borderColor = (str: string) => colorCode + str + RESET;
			}
			ctx.ui.requestRender();
		}, 1000 / 60); // 60fps for smooth animation
	}

	function stopAnimation(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		if (animationTimer) {
			clearInterval(animationTimer);
			animationTimer = undefined;
		}

		// Restore saved border color
		if (ctx.ui.editorComponent && savedBorderColor !== undefined) {
			ctx.ui.editorComponent.borderColor = savedBorderColor;
			ctx.ui.requestRender();
		}
		savedBorderColor = undefined;
	}

	pi.on("agent_start", (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		stopAnimation(ctx);
	});
}
