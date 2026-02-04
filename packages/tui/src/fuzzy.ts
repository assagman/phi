/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 *
 * Optimized for file path matching:
 * - Strongly rewards matches in filename (basename) over directory parts
 * - Rewards prefix matches and consecutive character runs
 * - Penalizes scattered matches across path segments
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

/**
 * Core fuzzy matching on a string segment.
 */
function matchSegment(query: string, text: string, startIndex: number = 0): FuzzyMatch {
	if (query.length === 0) {
		return { matches: true, score: 0 };
	}

	if (query.length > text.length) {
		return { matches: false, score: 0 };
	}

	const textLower = text.toLowerCase();
	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (let i = 0; i < textLower.length && queryIndex < query.length; i++) {
		if (textLower[i] === query[queryIndex]) {
			const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!);

			// Reward consecutive matches
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				// Penalize gaps
				if (lastMatchIndex >= 0) {
					score += (i - lastMatchIndex - 1) * 2;
				}
			}

			// Reward word boundary matches
			if (isWordBoundary) {
				score -= 10;
			}

			// Slight penalty for later matches (using absolute position)
			score += (startIndex + i) * 0.1;

			lastMatchIndex = i;
			queryIndex++;
		}
	}

	if (queryIndex < query.length) {
		return { matches: false, score: 0 };
	}

	return { matches: true, score };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();

	if (queryLower.length === 0) {
		return { matches: true, score: 0 };
	}

	// Find basename (filename) for prioritized matching
	const lastSlash = text.lastIndexOf("/");
	const basename = lastSlash >= 0 ? text.slice(lastSlash + 1) : text;
	const basenameStart = lastSlash + 1;

	// Helper to check if a match is "high quality" (consecutive or at word boundaries)
	const isHighQualityMatch = (match: FuzzyMatch, queryLen: number): boolean => {
		if (!match.matches) return false;
		// A good match should have a negative or low positive score
		// Threshold based on query length - longer queries can have slightly worse scores
		const threshold = queryLen * 5;
		return match.score < threshold;
	};

	// Strategy 1: Try matching entirely within the basename
	// Only give big bonus if it's a high-quality match (consecutive or word-boundary)
	const basenameMatch = matchSegment(queryLower, basename, basenameStart);
	if (basenameMatch.matches && isHighQualityMatch(basenameMatch, queryLower.length)) {
		// Big bonus for good basename matches
		return { matches: true, score: basenameMatch.score - 100 };
	}

	// Strategy 2: Standard full-path matching
	// This handles cases like "tui" matching "packages/tui/..." with consecutive chars
	const fullPathMatch = matchSegment(queryLower, text, 0);
	if (fullPathMatch.matches) {
		// Give bonus if the match is high quality
		if (isHighQualityMatch(fullPathMatch, queryLower.length)) {
			return { matches: true, score: fullPathMatch.score - 30 };
		}
		return fullPathMatch;
	}

	// Strategy 3: Fallback - if basename matched (even scattered), use it
	if (basenameMatch.matches) {
		// Small bonus for any basename match
		return { matches: true, score: basenameMatch.score - 20 };
	}

	// Try swapped alphanumeric patterns (e.g., "ts1" -> "1ts")
	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return { matches: false, score: 0 };
	}

	const swappedMatch = matchSegment(swappedQuery.toLowerCase(), text, 0);
	if (!swappedMatch.matches) {
		return { matches: false, score: 0 };
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports space-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}
