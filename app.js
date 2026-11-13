const API_URL = "https://kitsu.io/api/edge/anime";
const TRANSLATION_URL = "https://api.mymemory.translated.net/get";
const TRANSLATION_CHUNK_LIMIT = 450;
const SUPABASE_URL = window.OTAKULIST_CONFIG?.supabaseUrl?.replace(/\/+$/, "");
const SUPABASE_ANON_KEY = window.OTAKULIST_CONFIG?.supabaseAnonKey;
const TMDB_LOCALIZE_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/tmdb-localize` : "";
const FRENCH_METADATA_CACHE_KEY = "otakulist-french-metadata-v1";
const FRENCH_METADATA_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const SESSION_KEY = "otakulist-auth-session-v1";
const COLLECTIONS_URL = `${SUPABASE_URL}/rest/v1/user_anime_lists`;
const STATUS_LABELS = {
	planned: "À voir",
	watching: "En cours",
	completed: "Terminé",
};

const listElement = document.querySelector("#anime-list");
const emptyState = document.querySelector("#empty-state");
const filteredEmpty = document.querySelector("#filtered-empty");
const searchPanel = document.querySelector("#search-panel");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#anime-query");
const searchSubmit = document.querySelector("#search-submit");
const searchResults = document.querySelector("#search-results");
const syncStatus = document.querySelector("#sync-status");
const retrySyncButton = document.querySelector("#retry-sync");
const authToggle = document.querySelector("#auth-toggle");
const animeDetailsDialog = document.querySelector("#anime-details-dialog");
const animeDetailsContent = document.querySelector("#anime-details-content");
const loginPanel = document.querySelector("#login-panel");
const loginForm = document.querySelector("#login-form");
const loginSubmit = document.querySelector("#login-submit");
const recoveryRequestForm = document.querySelector("#recovery-request-form");
const recoveryRequestSubmit = document.querySelector("#recovery-request-submit");
const recoveryUpdateForm = document.querySelector("#recovery-update-form");
const recoveryUpdateSubmit = document.querySelector("#recovery-update-submit");
const backToLoginFromUpdate = document.querySelector("#back-to-login-from-update");
const authMessage = document.querySelector("#auth-message");
const listPicker = document.querySelector("#list-picker");
const listSelect = document.querySelector("#list-select");
const listPermission = document.querySelector("#list-permission");
const noAccounts = document.querySelector("#no-accounts");
const openSearchButton = document.querySelector("#open-search");
const introCopy = document.querySelector("#intro-copy");

let collections = [];
let selectedOwnerId = null;
let animeList = [];
let authSession = null;
let activeFilter = "all";
let searchAnimeResults = [];
let searchRequestId = 0;
const synopsisTranslations = new Map();
const animeMetadataRequests = new Map();
const frenchAnimeMetadataRequests = new Map();
let translationQueue = Promise.resolve();
let tmdbLocalizationQueue = Promise.resolve();
let tmdbFailureCooldownUntil = 0;
let pendingWrites = 0;
let writeQueue = Promise.resolve();
let loginPanelOpen = false;
let authView = "login";
let recoverySession = null;

function setSyncStatus(message, state) {
	syncStatus.textContent = message;
	syncStatus.dataset.state = state;
}

function canEditSelectedList() {
	return Boolean(authSession?.user?.id && selectedOwnerId === authSession.user.id);
}

function apiHeaders({ json = false, authenticated = false } = {}) {
	const headers = { apikey: SUPABASE_ANON_KEY };
	if (json) headers["Content-Type"] = "application/json";
	if (authenticated && authSession?.access_token) {
		headers.Authorization = "Bearer " + authSession.access_token;
	}
	return headers;
}

async function responseError(response, fallback) {
	let detail = "";
	try {
		const payload = await response.json();
		detail = payload.msg || payload.message || payload.error_description || payload.error || "";
	} catch {
		detail = "";
	}
	return new Error(detail || `${fallback} (${response.status}).`);
}

function persistSession() {
	if (authSession) localStorage.setItem(SESSION_KEY, JSON.stringify(authSession));
	else localStorage.removeItem(SESSION_KEY);
}

async function renewSession(refreshToken) {
	const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
		method: "POST",
		headers: apiHeaders({ json: true }),
		body: JSON.stringify({ refresh_token: refreshToken }),
	});
	if (!response.ok) throw await responseError(response, "Impossible de renouveler la session");
	const session = await response.json();
	authSession = { ...session, expires_at: Date.now() + session.expires_in * 1000 };
	persistSession();
}

async function ensureSessionValid() {
	if (!authSession || authSession.expires_at > Date.now() + 60000) return;
	await renewSession(authSession.refresh_token);
}

async function restoreSession() {
	try {
		const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
		if (!stored?.access_token || !stored?.refresh_token) return;
		authSession = stored;
		if (!stored.expires_at || stored.expires_at <= Date.now() + 60000) {
			await renewSession(stored.refresh_token);
		} else {
			const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
				headers: apiHeaders({ authenticated: true }),
			});
			if (!response.ok) throw await responseError(response, "Session invalide");
			authSession.user = await response.json();
			persistSession();
		}
	} catch (error) {
		authSession = null;
		persistSession();
		authMessage.textContent = `Session expirée. ${error.message}`;
	}
}

function isValidAnime(anime) {
	return anime && (Number.isInteger(anime.id) || typeof anime.id === "string")
		&& typeof anime.title === "string" && anime.title.length > 0 && anime.title.length <= 500
		&& typeof anime.status === "string" && STATUS_LABELS[anime.status];
}

async function loadCollections() {
	await ensureSessionValid();
	const response = await fetch(
		`${COLLECTIONS_URL}?select=owner_id,display_name,anime_list,updated_at&order=display_name.asc`,
		{ headers: apiHeaders({ authenticated: true }) },
	);
	if (!response.ok) throw await responseError(response, "Impossible de charger les listes");
	const rows = await response.json();
	collections = rows.filter((entry) => entry.owner_id && entry.display_name && Array.isArray(entry.anime_list))
		.map((entry) => ({ ...entry, anime_list: entry.anime_list.filter(isValidAnime) }));
	if (!collections.some((entry) => entry.owner_id === selectedOwnerId)) {
		selectedOwnerId = collections.some((entry) => entry.owner_id === authSession?.user?.id)
			? authSession.user.id
			: collections[0]?.owner_id || null;
	}
	animeList = collections.find((entry) => entry.owner_id === selectedOwnerId)?.anime_list || [];
	renderList();
	const hasOwnList = collections.some((entry) => entry.owner_id === authSession?.user?.id);
	if (authSession && !hasOwnList) {
		setSyncStatus("Votre compte n’a pas encore de liste configurée. Contactez l’administrateur.", "error");
	} else {
		setSyncStatus(authSession ? "Listes synchronisées." : "Listes publiques en lecture seule.", "success");
	}
	retrySyncButton.hidden = true;
}

async function refreshCollections() {
	if (pendingWrites > 0) return;
	try {
		await loadCollections();
	} catch (error) {
		setSyncStatus(error.message, "error");
		retrySyncButton.hidden = false;
	}
}

function saveAnimeList() {
	if (!canEditSelectedList()) return;
	const snapshot = animeList.map((anime) => ({ ...anime }));
	const ownerId = selectedOwnerId;
	pendingWrites += 1;
	setSyncStatus("Enregistrement de votre liste...", "pending");
	retrySyncButton.hidden = true;
	writeQueue = writeQueue.then(async () => {
		try {
			await ensureSessionValid();
			const response = await fetch(
				`${COLLECTIONS_URL}?owner_id=eq.${encodeURIComponent(ownerId)}&select=owner_id,updated_at`,
				{
					method: "PATCH",
					headers: { ...apiHeaders({ json: true, authenticated: true }), Prefer: "return=representation" },
					body: JSON.stringify({ anime_list: snapshot }),
				},
			);
			if (!response.ok) throw await responseError(response, "Impossible d’enregistrer la liste");
			const updatedRows = await response.json();
			if (updatedRows.length !== 1) throw new Error("Aucune liste personnelle n’a été mise à jour.");
			const current = collections.find((entry) => entry.owner_id === ownerId);
			if (current) {
				current.anime_list = snapshot;
				current.updated_at = updatedRows[0].updated_at;
			}
			if (selectedOwnerId === ownerId) setSyncStatus("Votre liste est enregistrée.", "success");
		} catch (error) {
			setSyncStatus(error.message, "error");
			retrySyncButton.hidden = false;
		} finally {
			pendingWrites -= 1;
		}
	});
}

async function signIn(email, password) {
	const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
		method: "POST",
		headers: apiHeaders({ json: true }),
		body: JSON.stringify({ email, password }),
	});
	if (!response.ok) throw await responseError(response, "Connexion impossible");
	const session = await response.json();
	authSession = { ...session, expires_at: Date.now() + session.expires_in * 1000 };
	persistSession();
	selectedOwnerId = authSession.user.id;
	loginPanelOpen = false;
	loginForm.hidden = true;
	authMessage.textContent = "";
	updateAccountControls();
	await loadCollections();
}

async function requestPasswordRecovery(email) {
	const redirectTo = `${window.location.origin}${window.location.pathname}`;
	const response = await fetch(
		`${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
		{
			method: "POST",
			headers: apiHeaders({ json: true }),
			body: JSON.stringify({ email }),
		},
	);
	if (!response.ok) throw await responseError(response, "Impossible d’envoyer le lien de récupération");
}

function consumeRecoveryRedirect() {
	const params = new URLSearchParams(window.location.hash.slice(1));
	const type = params.get("type");
	const errorCode = params.get("error_code");
	if (type !== "recovery" && !errorCode) return false;

	window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
	loginPanelOpen = true;
	if (errorCode) {
		authView = "request";
		authMessage.textContent = errorCode === "otp_expired"
			? "Ce lien a expiré ou a déjà été utilisé. Demandez-en un nouveau."
			: params.get("error_description") || "Le lien de récupération est invalide.";
		return true;
	}

	const accessToken = params.get("access_token");
	const refreshToken = params.get("refresh_token");
	if (!accessToken || !refreshToken) {
		authView = "request";
		authMessage.textContent = "Le lien de récupération est incomplet. Demandez-en un nouveau.";
		return true;
	}

	recoverySession = {
		access_token: accessToken,
		refresh_token: refreshToken,
		token_type: params.get("token_type") || "bearer",
		expires_in: Number(params.get("expires_in")) || 3600,
	};
	authView = "update";
	authMessage.textContent = "Choisissez votre nouveau mot de passe.";
	return true;
}

async function updateRecoveredPassword(password) {
	if (!recoverySession?.access_token) throw new Error("Votre lien de récupération n’est plus valide. Demandez-en un nouveau.");
	const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
		method: "PUT",
		headers: {
			...apiHeaders({ json: true }),
			Authorization: `Bearer ${recoverySession.access_token}`,
		},
		body: JSON.stringify({ password }),
	});
	if (!response.ok) throw await responseError(response, "Impossible de modifier le mot de passe");
	const user = await response.json();
	authSession = {
		...recoverySession,
		user,
		expires_at: Date.now() + recoverySession.expires_in * 1000,
	};
	recoverySession = null;
	persistSession();
	authMessage.textContent = "Mot de passe modifié. Vous êtes connecté.";
	updateAccountControls();
	await loadCollections();
}

function signOut() {
	authSession = null;
	persistSession();
	selectedOwnerId = collections[0]?.owner_id || null;
	animeList = collections[0]?.anime_list || [];
	loginPanelOpen = false;
	loginForm.hidden = true;
	authMessage.textContent = "";
	authView = "login";
	recoverySession = null;
	updateAccountControls();
	renderList();
	setSyncStatus("Déconnecté. Listes publiques en lecture seule.", "success");
	void refreshCollections();
}

function updateAccountControls() {
	authToggle.textContent = authSession ? "Se déconnecter" : "Se connecter";
	loginPanel.hidden = Boolean(authSession) || !loginPanelOpen;
	loginForm.hidden = authView !== "login";
	recoveryRequestForm.hidden = authView !== "request";
	recoveryUpdateForm.hidden = authView !== "update";
	backToLoginFromUpdate.hidden = authView !== "update";
}

async function initializeStorage() {
	if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
		setSyncStatus("Configuration du stockage indisponible.", "error");
		return;
	}
	const isRecoveryRedirect = consumeRecoveryRedirect();
	if (!isRecoveryRedirect) await restoreSession();
	updateAccountControls();
	await refreshCollections();
	window.setInterval(refreshCollections, 10000);
}

function makeElement(tag, className, text) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function splitSynopsis(synopsis) {
	const chunks = [];
	let remaining = synopsis.trim();
	while (remaining.length > TRANSLATION_CHUNK_LIMIT) {
		const lastSpace = remaining.lastIndexOf(" ", TRANSLATION_CHUNK_LIMIT);
		const splitAt = lastSpace >= TRANSLATION_CHUNK_LIMIT / 2 ? lastSpace : TRANSLATION_CHUNK_LIMIT;
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

async function requestFrenchTranslation(synopsis) {
	const translatedChunks = [];
	for (const chunk of splitSynopsis(synopsis)) {
		const params = new URLSearchParams({ q: chunk, langpair: "en|fr" });
		const response = await fetch(`${TRANSLATION_URL}?${params}`);
		if (!response.ok) throw new Error(`L'API de traduction a répondu avec l'erreur ${response.status}.`);
		const result = await response.json();
		if (result.responseStatus !== 200 || typeof result.responseData?.translatedText !== "string") {
			throw new Error(result.responseDetails || "La traduction du synopsis a échoué.");
		}
		translatedChunks.push(result.responseData.translatedText);
	}
	return translatedChunks.join(" ");
}

function translateSynopsisToFrench(synopsis) {
	let translation = synopsisTranslations.get(synopsis);
	if (!translation) {
		translation = translationQueue.then(() => requestFrenchTranslation(synopsis));
		translationQueue = translation.then(() => undefined, () => undefined);
		synopsisTranslations.set(synopsis, translation);
	}
	return translation;
}

function getFrenchMetadataStorageKey(anime) {
	return `${FRENCH_METADATA_CACHE_KEY}:${encodeURIComponent(String(anime.id))}`;
}

function readCachedFrenchMetadata(anime) {
	try {
		const cached = JSON.parse(localStorage.getItem(getFrenchMetadataStorageKey(anime)) || "null");
		if (!cached || Date.now() - cached.savedAt >= FRENCH_METADATA_CACHE_TTL) return null;
		return cached.value;
	} catch (error) {
		console.warn("Le cache de traduction français est indisponible.", error);
		return null;
	}
}

function cacheFrenchMetadata(anime, value) {
	try {
		localStorage.setItem(getFrenchMetadataStorageKey(anime), JSON.stringify({ savedAt: Date.now(), value }));
	} catch (error) {
		console.warn("Impossible de conserver le cache de traduction français.", error);
	}
}

async function requestFrenchAnimeMetadata(anime) {
	if (!TMDB_LOCALIZE_URL || !SUPABASE_ANON_KEY) {
		throw new Error("La fonction de localisation TMDB n’est pas configurée.");
	}
	const response = await fetch(TMDB_LOCALIZE_URL, {
		method: "POST",
		headers: {
			...apiHeaders({ json: true }),
			Authorization: `Bearer ${authSession?.access_token || SUPABASE_ANON_KEY}`,
		},
		body: JSON.stringify({
			title: anime.title_english || anime.title,
			aliases: Array.isArray(anime.titleAliases) ? anime.titleAliases.slice(0, 10) : [],
			year: anime.year || "",
			type: anime.type || "",
		}),
	});
	if (!response.ok) {
		let detail = "";
		try {
			const payload = await response.json();
			detail = payload.error || "";
		} catch {
			detail = "";
		}
		throw new Error(detail || `La fonction de localisation TMDB a répondu avec l’erreur ${response.status}.`);
	}
	const result = await response.json();
	return {
		titleFr: typeof result.titleFr === "string" ? result.titleFr : "",
		synopsisFr: typeof result.synopsisFr === "string" ? result.synopsisFr : "",
	};
}

function getFrenchAnimeMetadata(anime) {
	if (anime.titleFr || anime.synopsisFr) {
		return Promise.resolve({ titleFr: anime.titleFr || "", synopsisFr: anime.synopsisFr || "" });
	}
	const key = `${String(anime.id)}:${anime.year || ""}`;
	let request = frenchAnimeMetadataRequests.get(key);
	if (request) return request;
	const cached = readCachedFrenchMetadata(anime);
	if (cached) return Promise.resolve(cached);
	if (Date.now() < tmdbFailureCooldownUntil) {
		return Promise.reject(new Error("Le service de localisation TMDB est temporairement indisponible."));
	}
	request = tmdbLocalizationQueue
		.then(() => {
			if (Date.now() < tmdbFailureCooldownUntil) {
				throw new Error("Le service de localisation TMDB est temporairement indisponible.");
			}
			return requestFrenchAnimeMetadata(anime);
		})
		.then((metadata) => {
			cacheFrenchMetadata(anime, metadata);
			return metadata;
		})
		.catch((error) => {
			frenchAnimeMetadataRequests.delete(key);
			if (Date.now() >= tmdbFailureCooldownUntil) {
				tmdbFailureCooldownUntil = Date.now() + 60 * 1000;
				console.warn("Le service de localisation TMDB est indisponible.", error);
			}
			throw error;
		});
	tmdbLocalizationQueue = request.then(() => undefined, () => undefined);
	frenchAnimeMetadataRequests.set(key, request);
	return request;
}

function localizeAnimeTitleInto(element, anime, onLocalized) {
	void getFrenchAnimeMetadata(anime).then((metadata) => {
		if (!metadata.titleFr || !element.isConnected) return;
		element.textContent = metadata.titleFr;
		if (onLocalized) onLocalized(metadata.titleFr);
	}).catch(() => {});
}

function formatEpisodeCount(count) {
	if (Number.isInteger(count) && count >= 0) return `${count} épisode${count === 1 ? "" : "s"}`;
	if (count === undefined) return "Nombre d’épisodes en cours de chargement…";
	return "Nombre d’épisodes non communiqué";
}

function requestAnimeMetadata(animeId) {
	const key = String(animeId);
	let request = animeMetadataRequests.get(key);
	if (!request) {
		const params = new URLSearchParams({
			"fields[anime]": "episodeCount,ageRating,averageRating,status,slug,subtype,startDate",
		});
		request = fetch(`${API_URL}/${encodeURIComponent(key)}?${params}`)
			.then((response) => {
				if (!response.ok) throw new Error(`L'API Kitsu a répondu avec l'erreur ${response.status}.`);
				return response.json();
			})
			.then((payload) => {
				const metadata = payload.data?.attributes;
				if (!metadata || metadata.episodeCount === undefined) {
					throw new Error("Les informations de cet anime sont indisponibles.");
				}
				if (metadata.episodeCount !== null && (!Number.isInteger(metadata.episodeCount) || metadata.episodeCount < 0)) {
					throw new Error("Le nombre d’épisodes fourni par Kitsu est invalide.");
				}
				return metadata;
			});
		animeMetadataRequests.set(key, request);
	}
	return request;
}

function mergeAnimeMetadata(anime, metadata) {
	if (anime.episodeCount === undefined) anime.episodeCount = metadata.episodeCount;
	if (!anime.ageRating) anime.ageRating = metadata.ageRating || "";
	if (!anime.averageRating) anime.averageRating = metadata.averageRating || "";
	if (!anime.airStatus) anime.airStatus = metadata.status || "";
	if (!anime.slug) anime.slug = metadata.slug || "";
	if (!anime.type) anime.type = metadata.subtype || "";
	if (!anime.year) anime.year = metadata.startDate?.slice(0, 4) || "";
}

function hasMissingAnimeMetadata(anime) {
	return anime.episodeCount === undefined || !anime.ageRating || !anime.averageRating || !anime.airStatus || !anime.slug;
}

function loadAnimeMetadata(anime, element) {
	void requestAnimeMetadata(anime.id).then((metadata) => {
		mergeAnimeMetadata(anime, metadata);
		if (element.isConnected) element.textContent = formatEpisodeCount(anime.episodeCount);
	}).catch(() => {
		if (element.isConnected) element.textContent = "Nombre d’épisodes indisponible.";
	});
}

function translateSynopsisInto(element, anime) {
	const source = anime.synopsis;
	const localizedMetadata = getFrenchAnimeMetadata(anime).catch(() => ({}));
	void localizedMetadata.then((metadata) => {
		if (metadata.synopsisFr) return metadata.synopsisFr;
		return translateSynopsisToFrench(source);
	}).then((translation) => {
		if (element.isConnected) element.textContent = translation;
	}).catch(() => {
		if (!element.isConnected) return;
		element.textContent = source;
		const warning = makeElement("p", "translation-warning", "Traduction indisponible. Le texte original est affiché.");
		warning.setAttribute("role", "status");
		element.after(warning);
	});
}

function renderList() {
	const selectedCollection = collections.find((entry) => entry.owner_id === selectedOwnerId);
	const canEdit = canEditSelectedList();
	listSelect.replaceChildren();
	collections.forEach((entry) => {
		const option = document.createElement("option");
		option.value = entry.owner_id;
		option.textContent = entry.display_name;
		option.selected = entry.owner_id === selectedOwnerId;
		listSelect.append(option);
	});
	listPicker.hidden = collections.length === 0;
	noAccounts.hidden = collections.length > 0;
	openSearchButton.hidden = !canEdit;
	document.querySelectorAll(".empty-add").forEach((button) => { button.hidden = !canEdit; });
	searchPanel.hidden = !canEdit;
	if (!selectedCollection) {
		introCopy.textContent = authSession
			? "Votre compte n’a pas encore de liste configurée."
			: "Aucune liste de membre n’est encore disponible.";
		listPermission.textContent = "";
	} else {
		introCopy.textContent = `Liste publique de ${selectedCollection.display_name}.`;
		listPermission.textContent = canEdit
			? "Vous pouvez modifier cette liste."
			: authSession
				? "Lecture seule : votre compte ne peut modifier que sa propre liste."
				: "Lecture seule. Connectez-vous pour modifier votre propre liste.";
	}

	listElement.replaceChildren();
	const visibleAnime = activeFilter === "all"
		? animeList
		: animeList.filter((anime) => anime.status === activeFilter);

	visibleAnime.forEach((anime) => listElement.append(createAnimeCard(anime)));

	const counts = animeList.reduce((result, anime) => {
		result[anime.status] += 1;
		return result;
	}, { planned: 0, watching: 0, completed: 0 });

	document.querySelector("#total-count").textContent = animeList.length;
	document.querySelector("#count-plural").textContent = animeList.length > 1 ? "S" : "";
	document.querySelector("#all-count").textContent = animeList.length;
	document.querySelector("#planned-count").textContent = counts.planned;
	document.querySelector("#watching-count").textContent = counts.watching;
	document.querySelector("#completed-count").textContent = counts.completed;
	emptyState.hidden = !selectedCollection || animeList.length > 0;
	emptyState.querySelector("h2").textContent = canEdit
		? "Votre prochaine histoire commence ici."
		: "Cette liste est encore vide.";
	emptyState.querySelector(":scope > p:not(.eyebrow)").textContent = canEdit
		? "Recherchez un anime et ajoutez-le à votre collection."
		: "Aucun anime n’a encore été ajouté à cette liste.";
	filteredEmpty.hidden = animeList.length === 0 || visibleAnime.length > 0;
}

function createAnimeCard(anime) {
	const card = makeElement("article", "anime-card");
	card.dataset.status = anime.status;
	const poster = anime.image
		? makeElement("img", "poster")
		: makeElement("div", "poster poster-fallback", anime.title.slice(0, 1));

	if (anime.image) {
		poster.src = anime.image;
		poster.alt = `Affiche de ${anime.title}`;
		poster.loading = "lazy";
		poster.addEventListener("error", () => {
			const fallback = makeElement("div", "poster poster-fallback", anime.title.slice(0, 1));
			poster.replaceWith(fallback);
		}, { once: true });
	}

	const info = makeElement("div", "anime-info");
	const meta = [anime.year, anime.type].filter(Boolean).join(" · ");
	info.append(makeElement("p", "anime-meta", meta || "Anime"));
	const episodes = makeElement("p", "anime-episodes", formatEpisodeCount(anime.episodeCount));
	info.append(episodes);
	if (anime.episodeCount === undefined && anime.id) loadAnimeMetadata(anime, episodes);
	const title = makeElement("h2", "anime-title", anime.titleFr || anime.title);
	info.append(title);
	if (anime.synopsis) {
		const synopsis = makeElement("p", "anime-synopsis", "Traduction en cours…");
		info.append(synopsis);
		translateSynopsisInto(synopsis, anime);
	}
	const details = makeElement("button", "details-card-button", "En savoir plus");
	details.type = "button";
	details.setAttribute("aria-label", `En savoir plus sur ${anime.title}`);
	details.addEventListener("click", () => showAnimeDetails(anime));
	localizeAnimeTitleInto(title, anime, (localizedTitle) => {
		details.setAttribute("aria-label", `En savoir plus sur ${localizedTitle}`);
	});
	info.append(details);

	const bottom = makeElement("div", "card-bottom");
	const status = document.createElement("select");
	status.className = "status-select";
	status.setAttribute("aria-label", `Statut de ${anime.title}`);
	status.dataset.status = anime.status;
	status.disabled = !canEditSelectedList();
	Object.entries(STATUS_LABELS).forEach(([value, label]) => {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		option.selected = anime.status === value;
		status.append(option);
	});
	status.addEventListener("change", () => {
		anime.status = status.value;
		saveAnimeList();
		renderList();
	});

	const remove = makeElement("button", "remove-button", "×");
	remove.type = "button";
	remove.setAttribute("aria-label", `Supprimer ${anime.title}`);
	remove.title = "Supprimer de la liste";
	remove.hidden = !canEditSelectedList();
	remove.addEventListener("click", () => {
		animeList = animeList.filter((item) => item.id !== anime.id);
		saveAnimeList();
		renderList();
	});

	bottom.append(status, remove);
	info.append(bottom);
	card.append(poster, info);
	return card;
}

function openSearch() {
	searchPanel.hidden = false;
	searchInput.focus();
}

function showSearchMessage(message) {
	searchResults.replaceChildren(makeElement("p", "search-message", message));
}

function getAirStatusLabel(status) {
	return {
		finished: "Diffusion terminée",
		current: "En cours de diffusion",
		upcoming: "À venir",
		tba: "À confirmer",
	}[status] || "";
}

function formatAnimeFacts(anime) {
	const facts = [
		anime.year,
		anime.type,
		anime.ageRating ? `Âge conseillé : ${anime.ageRating}` : "",
		getAirStatusLabel(anime.airStatus),
	];
	const rating = anime.averageRating ? Number(anime.averageRating) : Number.NaN;
	if (Number.isFinite(rating)) facts.push(`Note Kitsu : ${(rating / 10).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}/10`);
	return facts.filter(Boolean).join(" · ") || "Informations non renseignées";
}

function showAnimeDetails(anime) {
	const layout = makeElement("div", "anime-details-layout");
	const animeTitle = anime.title_english || anime.title;
	const imageUrl = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || anime.image;
	if (imageUrl) {
		const poster = makeElement("img", "details-poster");
		poster.src = imageUrl;
		poster.alt = `Affiche de ${animeTitle}`;
		poster.loading = "lazy";
		layout.append(poster);
	} else {
		layout.append(makeElement("div", "details-poster details-poster-fallback", animeTitle.slice(0, 1)));
	}

	const overview = makeElement("div", "details-overview");
	const title = makeElement("h2", "details-title", animeTitle);
	title.id = "anime-details-title";
	overview.append(title);
	localizeAnimeTitleInto(title, anime);
	const metadataFacts = makeElement("p", "details-meta", formatAnimeFacts(anime));
	overview.append(metadataFacts);
	const episodes = makeElement("p", "details-episodes", formatEpisodeCount(anime.episodeCount));
	overview.append(episodes);
	layout.append(overview);
	if (anime.id && hasMissingAnimeMetadata(anime)) {
		void requestAnimeMetadata(anime.id).then((metadata) => {
			mergeAnimeMetadata(anime, metadata);
			if (metadataFacts.isConnected) metadataFacts.textContent = formatAnimeFacts(anime);
			if (episodes.isConnected) episodes.textContent = formatEpisodeCount(anime.episodeCount);
		}).catch(() => {
			if (metadataFacts.isConnected) metadataFacts.textContent = `${formatAnimeFacts(anime)} · Détails Kitsu indisponibles`;
			if (episodes.isConnected && anime.episodeCount === undefined) episodes.textContent = "Nombre d’épisodes indisponible.";
		});
	}

	const synopsisSection = makeElement("section", "details-synopsis");
	synopsisSection.append(makeElement("h3", "", "Synopsis"));
	const synopsis = makeElement("p", "details-synopsis-copy", anime.synopsis || "Aucun synopsis disponible.");
	synopsis.setAttribute("aria-live", "polite");
	synopsisSection.append(synopsis);
	if (anime.synopsis) translateSynopsisInto(synopsis, anime);
	layout.append(synopsisSection);

	const link = document.createElement("a");
	link.className = "details-source";
	link.href = `https://kitsu.io/anime/${encodeURIComponent(anime.slug || anime.id)}`;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.textContent = "Voir la fiche complète sur Kitsu";
	synopsisSection.append(link);

	animeDetailsContent.replaceChildren(layout);
	animeDetailsDialog.showModal();
}

function renderSearchResults(animeResults) {
	searchResults.replaceChildren();
	if (animeResults.length === 0) {
		showSearchMessage("Aucun résultat. Essayez un autre titre.");
		return;
	}

	animeResults.forEach((anime) => {
		const item = makeElement("article", "result-item");
		const imageUrl = anime.images?.jpg?.image_url;
		const title = anime.title_english || anime.title;
		if (imageUrl) {
			const image = makeElement("img", "result-poster");
			image.src = imageUrl;
			image.alt = "";
			image.loading = "lazy";
			image.addEventListener("error", () => {
				image.replaceWith(makeElement("div", "result-poster result-poster-fallback", title.slice(0, 1)));
			}, { once: true });
			item.append(image);
		} else {
			item.append(makeElement("div", "result-poster result-poster-fallback", title.slice(0, 1)));
		}

		const copy = makeElement("div", "result-copy");
		copy.append(makeElement("p", "result-title", title));
		const resultMeta = [anime.year, anime.type];
		if (Number.isInteger(anime.episodeCount)) resultMeta.push(formatEpisodeCount(anime.episodeCount));
		copy.append(makeElement("p", "result-meta", resultMeta.filter(Boolean).join(" · ") || "Anime"));

		const actions = makeElement("div", "result-actions");
		const details = makeElement("button", "result-details", "En savoir plus");
		details.type = "button";
		details.setAttribute("aria-label", `En savoir plus sur ${title}`);
		details.addEventListener("click", () => showAnimeDetails(anime));

		const alreadyAdded = animeList.some((entry) => entry.id === anime.id);
		const add = makeElement("button", "result-add", alreadyAdded ? "Déjà ajouté" : "Ajouter à la liste");
		add.type = "button";
		add.setAttribute("aria-label", `Ajouter ${title} à la liste`);
		add.title = alreadyAdded ? `${title} est déjà dans la liste` : `Ajouter ${title} à la liste`;
		add.disabled = alreadyAdded || !canEditSelectedList();
		if (alreadyAdded) {
			add.setAttribute("aria-label", `${title} est déjà dans votre liste`);
		}
		add.addEventListener("click", () => addAnime(anime));
		actions.append(details, add);
		copy.append(actions);
		item.append(copy);
		searchResults.append(item);
	});
}

function addAnime(anime) {
	if (!canEditSelectedList() || animeList.some((entry) => entry.id === anime.id)) return;
	animeList.unshift({
		id: anime.id,
		title: anime.title_english || anime.title,
		image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "",
		year: anime.year || anime.aired?.prop?.from?.year || "",
		type: anime.type || "",
		titleAliases: Array.isArray(anime.titleAliases) ? anime.titleAliases.slice(0, 10) : [],
		episodeCount: anime.episodeCount,
		ageRating: anime.ageRating || "",
		averageRating: anime.averageRating || "",
		airStatus: anime.airStatus || "",
		slug: anime.slug || "",
		synopsis: anime.synopsis || "",
		status: "planned",
	});
	saveAnimeList();
	renderList();
	renderSearchResults(searchAnimeResults);
}

searchForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const query = searchInput.value.trim();
	if (!query) return;
	const requestId = ++searchRequestId;

	searchSubmit.disabled = true;
	searchSubmit.textContent = "Recherche...";
	showSearchMessage("Recherche en cours...");
	try {
		const params = new URLSearchParams({
			"filter[text]": query,
			"page[limit]": "8",
			"sort": "popularityRank",
		});
		const response = await fetch(`${API_URL}?${params}`);
		if (response.status === 429) throw new Error("Trop de recherches en peu de temps. Réessayez dans quelques secondes.");
		if (!response.ok) throw new Error(`L'API Kitsu a répondu avec l'erreur ${response.status}.`);
		const payload = await response.json();
		if (requestId !== searchRequestId) return;
		searchAnimeResults = (payload.data || []).map((item) => {
			const attributes = item.attributes || {};
			const poster = attributes.posterImage || {};
			const title = attributes.titles?.en || attributes.canonicalTitle || "Anime sans titre";
			const titleAliases = [
				attributes.canonicalTitle,
				...Object.values(attributes.titles || {}),
				...(Array.isArray(attributes.abbreviatedTitles) ? attributes.abbreviatedTitles : []),
			].filter((value) => typeof value === "string" && value.trim() && value !== title);
			return {
				id: item.id,
				title,
				title_english: title,
				titleAliases: [...new Set(titleAliases)].slice(0, 10),
				type: attributes.subtype || "",
				year: attributes.startDate?.slice(0, 4) || "",
				episodeCount: Number.isInteger(attributes.episodeCount) ? attributes.episodeCount : undefined,
				ageRating: attributes.ageRating || "",
				averageRating: attributes.averageRating || "",
				airStatus: attributes.status || "",
				slug: attributes.slug || "",
				synopsis: attributes.synopsis || "",
				images: {
					jpg: {
						image_url: poster.medium || poster.small || poster.original || "",
						large_image_url: poster.large || poster.original || poster.medium || "",
					},
				},
			};
		});
		renderSearchResults(searchAnimeResults);
	} catch (error) {
		if (requestId === searchRequestId) {
			searchAnimeResults = [];
			const message = error instanceof TypeError
				? "Impossible de joindre l'API Kitsu. Vérifiez votre connexion et réessayez."
				: error.message;
			showSearchMessage(message);
		}
	} finally {
		if (requestId === searchRequestId) {
			searchSubmit.disabled = false;
			searchSubmit.textContent = "Rechercher";
		}
	}
});

document.querySelectorAll("[data-filter]").forEach((button) => {
	button.addEventListener("click", () => {
		activeFilter = button.dataset.filter;
		document.querySelectorAll("[data-filter]").forEach((tab) => {
			const selected = tab === button;
			tab.classList.toggle("is-active", selected);
			tab.setAttribute("aria-pressed", String(selected));
		});
		renderList();
	});
});

document.querySelectorAll(".empty-add, #open-search").forEach((button) => button.addEventListener("click", openSearch));
document.querySelector("#close-search").addEventListener("click", () => { searchPanel.hidden = true; });
document.querySelector("#close-anime-details").addEventListener("click", () => animeDetailsDialog.close());

listSelect.addEventListener("change", () => {
	selectedOwnerId = listSelect.value;
	animeList = collections.find((entry) => entry.owner_id === selectedOwnerId)?.anime_list || [];
	renderList();
	setSyncStatus(canEditSelectedList() ? "Votre liste est affichée." : "Liste affichée en lecture seule.", "success");
});

authToggle.addEventListener("click", () => {
	if (authSession) {
		signOut();
		return;
	}
	loginPanelOpen = !loginPanelOpen;
	updateAccountControls();
	if (loginPanelOpen && authView === "login") document.querySelector("#login-email").focus();
});

document.querySelector("#forgot-password-link").addEventListener("click", () => {
	authView = "request";
	authMessage.textContent = "";
	document.querySelector("#recovery-email").value = document.querySelector("#login-email").value;
	updateAccountControls();
	document.querySelector("#recovery-email").focus();
});

document.querySelector("#back-to-login-from-request").addEventListener("click", () => {
	authView = "login";
	authMessage.textContent = "";
	updateAccountControls();
	document.querySelector("#login-email").focus();
});

backToLoginFromUpdate.addEventListener("click", () => {
	authView = "login";
	loginPanelOpen = true;
	authMessage.textContent = "";
	updateAccountControls();
	document.querySelector("#login-email").focus();
});

loginForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const formData = new FormData(loginForm);
	loginSubmit.disabled = true;
	loginSubmit.textContent = "Connexion...";
	authMessage.textContent = "";
	try {
		await signIn(String(formData.get("email")).trim(), String(formData.get("password")));
	} catch (error) {
		authMessage.textContent = error.message;
	} finally {
		loginSubmit.disabled = false;
		loginSubmit.textContent = "Se connecter";
	}
});

recoveryRequestForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const email = String(new FormData(recoveryRequestForm).get("email")).trim();
	recoveryRequestSubmit.disabled = true;
	recoveryRequestSubmit.textContent = "Envoi...";
	authMessage.textContent = "";
	try {
		await requestPasswordRecovery(email);
		authMessage.textContent = "Si un compte correspond à cette adresse, un lien de récupération va être envoyé.";
	} catch (error) {
		authMessage.textContent = error.message;
	} finally {
		recoveryRequestSubmit.disabled = false;
		recoveryRequestSubmit.textContent = "Envoyer le lien";
	}
});

recoveryUpdateForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const formData = new FormData(recoveryUpdateForm);
	const password = String(formData.get("password"));
	if (password !== String(formData.get("confirm-password"))) {
		authMessage.textContent = "Les deux mots de passe ne correspondent pas.";
		return;
	}
	recoveryUpdateSubmit.disabled = true;
	recoveryUpdateSubmit.textContent = "Enregistrement...";
	authMessage.textContent = "";
	try {
		await updateRecoveredPassword(password);
	} catch (error) {
		authMessage.textContent = error.message;
	} finally {
		recoveryUpdateSubmit.disabled = false;
		recoveryUpdateSubmit.textContent = "Enregistrer le mot de passe";
	}
});

retrySyncButton.addEventListener("click", () => { void refreshCollections(); });

initializeStorage();
