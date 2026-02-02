import { spawnSync } from "child_process";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const PREFERRED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of PREFERRED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number },
): { stdout: Buffer; ok: boolean } {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
	});

	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	if (result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined);

	return { ok: true, stdout };
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...PREFERRED_IMAGE_MIME_TYPES] : [...PREFERRED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (platform === "linux" && isWaylandSession(env)) {
		return readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
	}

	if (platform === "darwin") {
		return readClipboardImageViaMacOS();
	}

	if (platform === "win32") {
		return readClipboardImageViaWindows();
	}

	// Fallback to xclip for Linux X11
	return readClipboardImageViaXclip();
}

function readClipboardImageViaMacOS(): ClipboardImage | null {
	// Use osascript to read clipboard image on macOS
	const result = runCommand("osascript", ["-e", "get the clipboard as «class PNGf»"]);
	if (!result.ok || result.stdout.length === 0) {
		return null;
	}

	// macOS returns clipboard data as a hex string, need to decode it
	const hexString = result.stdout.toString("utf-8").trim();
	if (!hexString) {
		return null;
	}

	// Convert hex string to bytes
	const bytes = Buffer.from(hexString, "hex");
	if (bytes.length === 0) {
		return null;
	}

	return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
}

function readClipboardImageViaWindows(): ClipboardImage | null {
	// Use PowerShell to read clipboard image on Windows
	const result = runCommand("powershell.exe", [
		"-command",
		"Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $img = [System.Windows.Forms.Clipboard]::GetImage(); $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bytes = $ms.ToArray(); [Convert]::ToBase64String($bytes) }",
	]);
	if (!result.ok || result.stdout.length === 0) {
		return null;
	}

	const base64 = result.stdout.toString("utf-8").trim();
	if (!base64) {
		return null;
	}

	const bytes = Buffer.from(base64, "base64");
	if (bytes.length === 0) {
		return null;
	}

	return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
}
