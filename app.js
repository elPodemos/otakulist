const STORAGE_KEY = "otakulist-anime-v1";
const API_URL = "https://kitsu.io/api/edge/anime";
const SUPABASE_URL = window.OTAKULIST_CONFIG?.supabaseUrl?.replace(/\/+$/, "");
const SUPABASE_ANON_KEY = window.OTAKULIST_CONFIG?.supabaseAnonKey;
const hasSharedStorage = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
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
const importLocalButton = document.querySelector("#import-local");
const retrySyncButton = document.querySelector("#retry-sync");

const localAnimeList = loadAnimeList();
let animeList = hasSharedStorage ? [] : localAnimeList;
let activeFilter = "all";
let searchAnimeResults = [];
let searchRequestId = 0;
let remoteUpdatedAt = null;
let pendingWrites = 0;
let writeQueue = Promise.resolve();
let sharedStorageReady = false;
let localRevision = 0;
let localChangesPending = false;

function loadAnimeList() {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
		return Array.isArray(saved) ? saved.filter(isValidAnime) : [];
	} catch {
		return [];
	}
}

function setSyncStatus(message, state) {
	syncStatus.textContent = message;
	syncStatus.dataset.state = state;
}

function setCollectionEnabled(enabled) {
	document.querySelectorAll(
		".collection-toolbar button, .filter-tabs button, #search-form input, #search-form button, #close-search, .remove-button, .status-select, .result-add, .empty-add",
	).forEach((control) => { control.disabled = !enabled; });
}

function saveAnimeList() {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList));
	localRevision += 1;
	if (!hasSharedStorage) return;
	importLocalButton.hidden = true;
	localChangesPending = true;
	if (!sharedStorageReady) {
		setSyncStatus("Stockage partagé indisponible : changements enregistrés sur cet appareil.", "error");
		return;
	}

	const snapshot = animeList.map((anime) => ({ ...anime }));
	const revision = localRevision;
	pendingWrites += 1;
	setSyncStatus("Enregistrement des modifications...", "pending");
	retrySyncButton.hidden = true;
	writeQueue = writeQueue.then(async () => {
		try {
			const response = await fetch(
				`${SUPABASE_URL}/rest/v1/otaku_collection?id=eq.1&select=updated_at`,
				{
					method: "PATCH",
					headers: {
						apikey: SUPABASE_ANON_KEY,
						"Content-Type": "application/json",
						Prefer: "return=representation",
					},
					body: JSON.stringify({ anime_list: snapshot }),
				},
			);
			if (!response.ok) throw new Error(`Erreur du stockage partagé (${response.status}).`);
			const updatedRows = await response.json();
			if (updatedRows.length !== 1) throw new Error("La liste partagée n'a pas pu être mise à jour.");
			remoteUpdatedAt = updatedRows[0].updated_at;
			if (localRevision === revision) localChangesPending = false;
		} catch (error) {
			setSyncStatus(`${error.message} Vos changements restent sur cet appareil.`, "error");
			retrySyncButton.hidden = false;
		} finally {
			pendingWrites -= 1;
			if (pendingWrites === 0 && remoteUpdatedAt && !localChangesPending) {
				setSyncStatus("Liste synchronisée entre appareils.", "success");
			}
		}
	});
}

function sharedStorageHeaders() {
	return { apikey: SUPABASE_ANON_KEY };
}

async function loadSharedAnimeList() {
	const response = await fetch(
		`${SUPABASE_URL}/rest/v1/otaku_collection?id=eq.1&select=anime_list,updated_at`,
		{ headers: sharedStorageHeaders() },
	);
	if (!response.ok) throw new Error(`Erreur du stockage partagé (${response.status}).`);
	const rows = await response.json();
	if (rows.length !== 1 || !Array.isArray(rows[0].anime_list)) {
		throw new Error("La liste partagée n'est pas encore initialisée.");
	}
	return rows[0];
}

async function refreshSharedAnimeList() {
	if (!hasSharedStorage || pendingWrites > 0 || localChangesPending) return;
	const revision = localRevision;
	try {
		const sharedList = await loadSharedAnimeList();
		if (revision !== localRevision) return;
		if (!remoteUpdatedAt || Date.parse(sharedList.updated_at) > Date.parse(remoteUpdatedAt)) {
			animeList = sharedList.anime_list.filter(isValidAnime);
			remoteUpdatedAt = sharedList.updated_at;
			localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList));
			renderList();
			if (animeList.length > 0) importLocalButton.hidden = true;
		}
		setSyncStatus("Liste synchronisée entre appareils.", "success");
		retrySyncButton.hidden = true;
	} catch (error) {
		setSyncStatus(`${error.message} Vérifiez la configuration Supabase.`, "error");
		retrySyncButton.hidden = false;
	}
}

function isValidAnime(anime) {
	return anime && (Number.isInteger(anime.id) || typeof anime.id === "string")
		&& typeof anime.title === "string" && anime.title.length > 0 && anime.title.length <= 500
		&& typeof anime.status === "string" && STATUS_LABELS[anime.status];
}

async function initializeStorage() {
	if (!hasSharedStorage) {
		setSyncStatus("Données enregistrées sur cet appareil uniquement.", "error");
		renderList();
		return;
	}

	const hadPendingChanges = localChangesPending;
	const localListToImport = loadAnimeList();
	setCollectionEnabled(false);
	setSyncStatus("Connexion à la liste partagée...", "pending");
	try {
		const sharedList = await loadSharedAnimeList();
		animeList = sharedList.anime_list.filter(isValidAnime);
		remoteUpdatedAt = sharedList.updated_at;
		sharedStorageReady = true;
		localChangesPending = hadPendingChanges;
		if (!hadPendingChanges && (animeList.length > 0 || localListToImport.length === 0)) {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList));
		}
		renderList();
		if (hadPendingChanges) {
			setSyncStatus("Des changements locaux ne sont pas synchronisés. Importez-les pour remplacer la liste partagée.", "error");
			importLocalButton.hidden = false;
		} else {
			setSyncStatus("Liste synchronisée entre appareils.", "success");
			importLocalButton.hidden = !(animeList.length === 0 && localListToImport.length > 0);
		}
		retrySyncButton.hidden = true;
		window.setInterval(refreshSharedAnimeList, 10000);
	} catch (error) {
		animeList = loadAnimeList();
		renderList();
		setSyncStatus(`${error.message} Modifications locales uniquement.`, "error");
		retrySyncButton.hidden = false;
	} finally {
		setCollectionEnabled(true);
	}
}

function makeElement(tag, className, text) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function renderList() {
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
	emptyState.hidden = animeList.length > 0;
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
		add.disabled = alreadyAdded;
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
	if (animeList.some((entry) => entry.id === anime.id)) return;
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

importLocalButton.addEventListener("click", () => {
	animeList = loadAnimeList();
	importLocalButton.hidden = true;
	renderList();
	saveAnimeList();
});

retrySyncButton.addEventListener("click", () => {
	if (!sharedStorageReady) {
		initializeStorage();
	} else if (localChangesPending) {
		saveAnimeList();
	} else {
		refreshSharedAnimeList();
	}
});

initializeStorage();
