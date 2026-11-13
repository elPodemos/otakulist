const API_URL = "https://kitsu.io/api/edge/anime";
const SUPABASE_URL = window.OTAKULIST_CONFIG?.supabaseUrl?.replace(/\/+$/, "");
const SUPABASE_ANON_KEY = window.OTAKULIST_CONFIG?.supabaseAnonKey;
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
	info.append(makeElement("h2", "anime-title", anime.title));
	if (anime.synopsis) info.append(makeElement("p", "anime-synopsis", anime.synopsis));

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
		copy.append(makeElement("p", "result-meta", [anime.year, anime.type].filter(Boolean).join(" · ") || "Anime"));

		const add = makeElement("button", "result-add", "+");
		add.type = "button";
		add.setAttribute("aria-label", `Ajouter ${title}`);
		add.title = `Ajouter ${title}`;
		const alreadyAdded = animeList.some((entry) => entry.id === anime.id);
		add.disabled = alreadyAdded || !canEditSelectedList();
		if (alreadyAdded) {
			add.textContent = "✓";
			add.setAttribute("aria-label", `${title} est déjà dans votre liste`);
		}
		add.addEventListener("click", () => addAnime(anime));
		item.append(copy, add);
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
			return {
				id: item.id,
				title,
				title_english: title,
				type: attributes.subtype || "",
				year: attributes.startDate?.slice(0, 4) || "",
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
