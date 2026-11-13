const STORAGE_KEY = "otakulist-anime-v1";
const API_URL = "https://kitsu.io/api/edge/anime";
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

let animeList = loadAnimeList();
let activeFilter = "all";
let searchAnimeResults = [];
let searchRequestId = 0;

function loadAnimeList() {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
		return Array.isArray(saved)
			? saved.filter((anime) => anime && (Number.isInteger(anime.id) || typeof anime.id === "string") && anime.title && STATUS_LABELS[anime.status])
			: [];
	} catch {
		return [];
	}
}

function saveAnimeList() {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList));
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

renderList();
