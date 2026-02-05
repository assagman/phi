/**
 * Unified provider registry for login flows.
 *
 * Merges OAuth providers (interactive login) with env-var-only providers
 * (API key via environment variable) into a single list for the /login UI.
 */

import type { KnownProvider } from "../types.js";
import { getOAuthProviders } from "./oauth/index.js";

// ─── Env-var provider registry ──────────────────────────────────────────────

/**
 * Map of providers to their environment variable names.
 * Single source of truth — also consumed by stream.ts getEnvApiKey().
 */
export const ENV_API_KEY_VARS = {
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"kimi-for-coding": "KIMI_API_KEY",
} as const satisfies Partial<Record<KnownProvider, string>>;

export type EnvApiKeyProvider = keyof typeof ENV_API_KEY_VARS;

/** Display names for env-var providers. */
const ENV_PROVIDER_NAMES: Record<EnvApiKeyProvider, string> = {
	openai: "OpenAI",
	google: "Google Gemini",
	groq: "Groq",
	cerebras: "Cerebras",
	xai: "xAI (Grok)",
	openrouter: "OpenRouter",
	"vercel-ai-gateway": "Vercel AI Gateway",
	zai: "ZhipuAI",
	mistral: "Mistral",
	minimax: "MiniMax",
	"minimax-cn": "MiniMax (CN)",
	opencode: "OpenCode",
	"kimi-for-coding": "Kimi (Moonshot)",
};

// ─── Unified provider types ─────────────────────────────────────────────────

export interface OAuthLoginProviderInfo {
	kind: "oauth";
	id: string;
	name: string;
	available: boolean;
}

export interface EnvLoginProviderInfo {
	kind: "env";
	id: EnvApiKeyProvider;
	name: string;
	envVar: string;
	isSet: boolean;
}

export type LoginProviderInfo = OAuthLoginProviderInfo | EnvLoginProviderInfo;

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * Get all env-var-only providers with their current set/unset status.
 */
export function getEnvApiKeyProviders(): EnvLoginProviderInfo[] {
	return (Object.entries(ENV_API_KEY_VARS) as [EnvApiKeyProvider, string][]).map(([id, envVar]) => ({
		kind: "env" as const,
		id,
		name: ENV_PROVIDER_NAMES[id],
		envVar,
		isSet: !!(process.env[envVar] && process.env[envVar]!.trim().length > 0),
	}));
}

/**
 * Get a unified list of all login providers (OAuth + env-var).
 * OAuth providers appear first, then env-var providers sorted alphabetically.
 */
export function getLoginProviders(): LoginProviderInfo[] {
	const oauthProviders: OAuthLoginProviderInfo[] = getOAuthProviders().map((p) => ({
		kind: "oauth" as const,
		id: p.id,
		name: p.name,
		available: p.available,
	}));

	const envProviders = getEnvApiKeyProviders().sort((a, b) => a.name.localeCompare(b.name));

	return [...oauthProviders, ...envProviders];
}
