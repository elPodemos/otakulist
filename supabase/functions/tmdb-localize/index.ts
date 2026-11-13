const allowedOrigins = new Set([
	"https://elpodemos.github.io",
	"http://localhost:5500",
	"http://127.0.0.1:5500",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
]);
const responseCache = new Map<string, { expiresAt: number; value: LocalizedAnime }>();
const requestCounts = new Map<string, { windowStartedAt: number; count: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT = 30;

type LocalizedAnime = {
	titleFr: string;
	synopsisFr: string;
};

type SearchResult = {
	id: number;
	media_type: "movie" | "tv" | string;
	title?: string;
	name?: string;
	original_title?: string;
	original_name?: string;
	release_date?: string;
	first_air_date?: string;
};

function jsonResponse(body: unknown, status: number, origin: string) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Max-Age": "86400",
			"Cache-Control": "no-store",
			"Content-Type": "application/json",
			"Vary": "Origin",
		},
	});
}

function normalizeTitle(value: string) {
	return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function getSearchResultYear(result: SearchResult) {
	const date = result.release_date || result.first_air_date || "";
	const year = Number(date.slice(0, 4));
	return Number.isInteger(year) && year > 0 ? year : null;
}

function scoreSearchResult(
	result: SearchResult,
	expectedTitles: Set<string>,
	year: number | null,
	preferredType: string,
) {
	const titles = [result.title, result.name, result.original_title, result.original_name]
		.filter((value): value is string => typeof value === "string")
		.map(normalizeTitle)
		.filter(Boolean);
	if (!titles.some((value) => expectedTitles.has(value))) return -1;

	const resultYear = getSearchResultYear(result);
	const yearDifference = year !== null && resultYear !== null ? Math.abs(year - resultYear) : null;
	if (yearDifference !== null && yearDifference > 1) return -1;
	return 100
		+ (yearDifference === null ? 0 : 10 - yearDifference)
		+ (result.media_type === preferredType ? 1 : 0);
}

function rateLimitKey(request: Request, origin: string) {
	const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
	return request.headers.get("cf-connecting-ip") || forwardedFor || origin;
}

function isRateLimited(request: Request, origin: string) {
	const now = Date.now();
	const key = rateLimitKey(request, origin);
	const current = requestCounts.get(key);
	if (!current || now - current.windowStartedAt >= RATE_LIMIT_WINDOW) {
		if (requestCounts.size >= 1000) {
			for (const [knownKey, entry] of requestCounts) {
				if (now - entry.windowStartedAt >= RATE_LIMIT_WINDOW) requestCounts.delete(knownKey);
			}
			if (requestCounts.size >= 1000) {
				const firstKey = requestCounts.keys().next().value;
				if (firstKey) requestCounts.delete(firstKey);
			}
		}
		requestCounts.set(key, { windowStartedAt: now, count: 1 });
		return false;
	}
	current.count += 1;
	return current.count > RATE_LIMIT;
}

function readCache(key: string) {
	const cached = responseCache.get(key);
	if (!cached) return null;
	if (cached.expiresAt <= Date.now()) {
		responseCache.delete(key);
		return null;
	}
	return cached.value;
}

function writeCache(key: string, value: LocalizedAnime) {
	if (responseCache.size >= 1000) {
		const firstKey = responseCache.keys().next().value;
		if (firstKey) responseCache.delete(firstKey);
	}
	responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL, value });
}

async function tmdbRequest<T>(url: URL, accessToken: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
	});
	if (!response.ok) throw new Error(`TMDB a répondu avec l’erreur ${response.status}.`);
	return await response.json() as T;
}

Deno.serve(async (request: Request) => {
	const origin = request.headers.get("origin") || "";
	if (!allowedOrigins.has(origin)) {
		return new Response("Origine non autorisée.", { status: 403 });
	}
	if (request.method === "OPTIONS") {
		return jsonResponse({}, 200, origin);
	}
	if (request.method !== "POST") {
		return jsonResponse({ error: "Méthode non autorisée." }, 405, origin);
	}
	if (isRateLimited(request, origin)) {
		return jsonResponse({ error: "Trop de demandes. Réessayez dans une minute." }, 429, origin);
	}

	let input: { title?: unknown; aliases?: unknown; year?: unknown; type?: unknown };
	try {
		const body = await request.text();
		if (new TextEncoder().encode(body).length > 4096) {
			return jsonResponse({ error: "La demande est trop volumineuse." }, 413, origin);
		}
		input = JSON.parse(body);
	} catch {
		return jsonResponse({ error: "Le format de la demande est invalide." }, 400, origin);
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return jsonResponse({ error: "Le format de la demande est invalide." }, 400, origin);
	}

	const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
	if (!title) return jsonResponse({ error: "Le titre de l’anime est requis." }, 400, origin);
	const aliases = Array.isArray(input.aliases)
		? input.aliases
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.map((value) => value.trim().slice(0, 200))
			.slice(0, 10)
		: [];
	const expectedTitles = new Set([title, ...aliases].map(normalizeTitle).filter(Boolean));
	const yearText = typeof input.year === "string" ? input.year : "";
	const year = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
	const type = typeof input.type === "string" ? input.type.toLowerCase() : "";
	const preferredType = type.includes("movie") ? "movie" : "tv";
	const cacheKey = `${[...expectedTitles].sort().join("|")}:${year || ""}:${preferredType}`;
	const cached = readCache(cacheKey);
	if (cached) return jsonResponse(cached, 200, origin);

	const accessToken = Deno.env.get("TMDB_ACCESS_TOKEN");
	if (!accessToken) {
		return jsonResponse({ error: "La clé TMDB n’est pas encore configurée dans Supabase." }, 503, origin);
	}

	try {
		const queries = [...new Set([title, ...aliases])]
			.map((value) => value.trim().slice(0, 200))
			.filter(Boolean)
			.slice(0, 3);
		const matches: Array<{ result: SearchResult; score: number }> = [];
		for (const query of queries) {
			const searchUrl = new URL("https://api.themoviedb.org/3/search/multi");
			searchUrl.searchParams.set("query", query);
			searchUrl.searchParams.set("language", "en-US");
			searchUrl.searchParams.set("include_adult", "false");
			const search = await tmdbRequest<{ results?: SearchResult[] }>(searchUrl, accessToken);
			for (const result of search.results || []) {
				if (result.media_type !== "movie" && result.media_type !== "tv") continue;
				const score = scoreSearchResult(result, expectedTitles, year, preferredType);
				if (score >= 0) matches.push({ result, score });
			}
			if (matches.length) break;
		}

		matches.sort((left, right) => right.score - left.score);
		const match = matches[0]?.result;
		let localized: LocalizedAnime = { titleFr: "", synopsisFr: "" };
		if (match) {
			const translationsUrl = new URL(`https://api.themoviedb.org/3/${match.media_type}/${match.id}/translations`);
			const translations = await tmdbRequest<{
				translations?: Array<{
					iso_639_1?: string;
					iso_3166_1?: string;
					data?: { name?: string; title?: string; overview?: string };
				}>;
			}>(translationsUrl, accessToken);
			const frenchTranslations = (translations.translations || [])
				.filter((entry) => entry.iso_639_1 === "fr")
				.filter((entry) => entry.data?.overview || entry.data?.name || entry.data?.title);
			const translation = frenchTranslations.find((entry) => entry.iso_3166_1 === "FR")
				|| frenchTranslations[0];
			if (translation?.data) {
				localized = {
					titleFr: (translation.data.name || translation.data.title || "").trim(),
					synopsisFr: (translation.data.overview || "").trim(),
				};
			}
		}

		writeCache(cacheKey, localized);
		return jsonResponse(localized, 200, origin);
	} catch (error) {
		console.error("Échec de la localisation TMDB.", error);
		return jsonResponse({ error: "TMDB est temporairement indisponible." }, 502, origin);
	}
});
