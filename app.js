const DATA_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const REFRESH_INTERVAL = 60_000;
const ENRICH_REFRESH_INTERVAL = 15 * 60_000;
const SCHEDULE_REFRESH_INTERVAL = 30 * 60_000;
const CACHE_KEY = "orsyfoot.live-matches.v8";
const competitions = [
  { name: "Premier League", slug: "eng.1", style: "dot-england" },
  { name: "La Liga", slug: "esp.1", style: "dot-spain" },
  { name: "Ligue 1", slug: "fra.1", style: "dot-france" },
  { name: "Serie A", slug: "ita.1", style: "dot-italy" },
  { name: "Ligue des champions", slug: "uefa.champions", style: "dot-champions" },
  { name: "Ligue Europa", slug: "uefa.europa", style: "dot-europa" }
];

const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[char]));

const formatTime = (date) => new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit"
}).format(new Date(date));

const formatDate = (date) => new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long"
}).format(new Date(date));

const formatDateTime = (date) => new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit"
}).format(new Date(date));

const percent = (value) => `${Math.round(value * 100)}%`;

function todayAtMidnight() {
  return new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
}

function parseCompetitionEvent(event, competition) {
  const game = event.competitions?.[0];
  if (!game || !event.date || !Array.isArray(game.competitors)) return null;

  const homeTeam = game.competitors.find((team) => team.homeAway === "home");
  const awayTeam = game.competitors.find((team) => team.homeAway === "away");
  if (!homeTeam?.team?.displayName || !awayTeam?.team?.displayName) return null;

  const status = game.status?.type;
  const state = ["pre", "in", "post"].includes(status?.state) ? status.state : "pre";
  const detail = status?.shortDetail || status?.detail || status?.description || "";
  return {
    id: `${competition.slug}-${event.id}`,
    eventId: String(event.id),
    league: competition.name,
    leagueSlug: competition.slug,
    leagueStyle: competition.style,
    date: event.date,
    venue: game.venue?.fullName || "",
    venueCity: game.venue?.address?.city || "",
    state,
    detail,
    status: state === "in"
      ? (game.status?.displayClock && game.status.displayClock !== "0'" ? `En direct · ${game.status.displayClock}` : "En direct")
      : state === "post" ? "Terminé" : "À venir",
    home: parseTeam(homeTeam),
    away: parseTeam(awayTeam)
  };
}

function parseTeam(competitor) {
  const team = competitor.team;
  const logo = typeof team.logo === "string" && /^https:\/\/a\.espncdn\.com\//.test(team.logo)
    ? team.logo
    : "";
  return {
    name: team.displayName,
    shortName: team.shortDisplayName || team.abbreviation || team.displayName,
    logo,
    score: /^\d+$/.test(String(competitor.score ?? "")) ? Number(competitor.score) : null,
    form: typeof competitor.form === "string" ? competitor.form : "",
    record: competitor.records?.find((record) => record.type === "total")?.summary || ""
  };
}

function readCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!Array.isArray(cached?.matches) || !cached.matches.every((match) =>
      match && typeof match.id === "string" && typeof match.league === "string"
    )) return null;
    return cached;
  } catch (error) {
    console.warn("Le cache local des matchs OrsyFoot est illisible :", error);
    return null;
  }
}

let matches = [];
let lastUpdated = null;
let scheduleUpdatedAt = null;
let refreshInProgress = false;
let enrichmentUpdatedAt = null;
let enrichmentInProgress = false;
let enrichmentConfig = { odds: false, predictions: false, xg: false };
let activeDialogMatchId = null;

function setFeedStatus(message, state = "online") {
  const status = document.getElementById("feed-status");
  const providerState = document.getElementById("provider-state");
  const sourceIndicator = document.querySelector(".model-card .status-pulse");
  status.classList.toggle("feed-error", state === "error");
  status.classList.toggle("feed-loading", state === "loading");
  status.innerHTML = `<span class="live-dot"></span>${escapeHTML(message)}`;
  providerState.textContent = state === "error" ? "Flux indisponible" : state === "loading" ? "Actualisation…" : "Connecté à ESPN";
  sourceIndicator.classList.toggle("is-error", state === "error");
  sourceIndicator.classList.toggle("is-loading", state === "loading");
}

function updateLastUpdated() {
  const element = document.getElementById("last-updated");
  if (!lastUpdated) {
    element.textContent = "En attente";
    return;
  }
  element.textContent = `Mis à jour à ${formatTime(lastUpdated)}`;
  element.title = lastUpdated.toLocaleString("fr-FR");
}

function getMatchProbabilities(match) {
  return match.enrichment?.prediction?.probabilities || null;
}

function parseSeasonRecord(record) {
  const values = String(record || "").match(/^\s*(\d+)-(\d+)-(\d+)\s*$/);
  if (!values) return null;
  const [wins, draws, losses] = values.slice(1).map(Number);
  const games = wins + draws + losses;
  return games > 0 ? { wins, draws, losses, games } : null;
}

function getSeasonRecordPrediction(match) {
  const home = parseSeasonRecord(match.home.record);
  const away = parseSeasonRecord(match.away.record);
  if (!home || !away || home.games < 2 || away.games < 2) return null;

  const homePointsPerGame = (home.wins * 3 + home.draws) / home.games;
  const awayPointsPerGame = (away.wins * 3 + away.draws) / away.games;
  const drawProbability = Math.min(0.34, Math.max(
    0.15,
    (home.draws + away.draws + 1) / (home.games + away.games + 4)
  ));
  const homeShareOfWins = 1 / (1 + Math.exp(
    -0.9 * (homePointsPerGame - awayPointsPerGame + 0.25)
  ));
  const decisiveProbability = 1 - drawProbability;
  const confidence = Math.min(home.games, away.games) < 5
    ? "échantillon très court"
    : Math.min(home.games, away.games) < 10
      ? "échantillon limité"
      : "bilan saison disponible";

  return {
    home: decisiveProbability * homeShareOfWins,
    draw: drawProbability,
    away: decisiveProbability * (1 - homeShareOfWins),
    sampleSize: { home: home.games, away: away.games },
    confidence
  };
}

function getMatchOutcomeAssessment(match) {
  const modelProbabilities = getMatchProbabilities(match);
  const seasonProbabilities = getSeasonRecordPrediction(match);
  const marketProbabilities = match.enrichment?.odds?.impliedProbabilities;
  const probabilities = modelProbabilities || seasonProbabilities || marketProbabilities;
  if (!probabilities) return null;
  const source = modelProbabilities
    ? "Prédiction API-Football"
    : seasonProbabilities
      ? "Bilan saison ESPN (V-N-D)"
      : "Tendance moyenne des cotes des bookmakers";
  const reliability = seasonProbabilities
    ? `${seasonProbabilities.sampleSize.home} et ${seasonProbabilities.sampleSize.away} matchs terminés · ${seasonProbabilities.confidence}`
    : modelProbabilities
      ? "Estimation fournisseur, non garantie"
      : "Probabilités moyennes du marché, non garanties";
  const outcomes = [
    { key: "home", label: match.home.name, probability: probabilities.home },
    { key: "draw", label: "Match nul", probability: probabilities.draw },
    { key: "away", label: match.away.name, probability: probabilities.away }
  ].filter((outcome) => Number.isFinite(outcome.probability));
  if (!outcomes.length) return null;
  const favorite = outcomes.reduce((best, outcome) =>
    outcome.probability > best.probability ? outcome : best
  );
  return { outcomes, favorite, source, reliability };
}

function getMatchDisplayProbabilities(match) {
  const assessment = getMatchOutcomeAssessment(match);
  if (!assessment) return null;
  return Object.fromEntries(assessment.outcomes.map(({ key, probability }) => [key, probability]));
}

function renderLiveMatchStats(stats) {
  const statLabels = [
    ["totalShots", "Tirs"],
    ["shotsOnTarget", "Tirs cadrés"],
    ["totalCrosses", "Centres"],
    ["wonCorners", "Corners"]
  ];
  const availableStats = statLabels.filter(([key]) =>
    Number.isFinite(stats.home[key]) || Number.isFinite(stats.away[key])
  );
  if (!availableStats.length) return "Les tirs, centres et corners ne sont pas fournis pour cette rencontre.";
  return `<div class="live-stat-grid">${availableStats.map(([key, label]) => {
    const home = stats.home[key];
    const away = stats.away[key];
    const homeValue = Number.isFinite(home) ? home : "—";
    const awayValue = Number.isFinite(away) ? away : "—";
    return `<div class="live-stat-row"><span>${homeValue}</span><strong>${label}</strong><span>${awayValue}</span></div>`;
  }).join("")}</div><p class="dialog-note">Chiffres observés en direct, pas une prévision du total final · ESPN.</p>`;
}

async function fetchLiveMatchStats(match) {
  const response = await fetch(
    `${DATA_URL}/${encodeURIComponent(match.leagueSlug)}/summary?event=${encodeURIComponent(match.eventId)}`,
    { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(12_000) }
  );
  if (!response.ok) throw new Error(`ESPN a répondu HTTP ${response.status}`);
  const summary = await response.json();
  const teams = summary.boxscore?.teams;
  if (!Array.isArray(teams)) throw new Error("Statistiques ESPN absentes pour cette rencontre");
  const parsed = {};
  for (const team of teams) {
    const side = team.homeAway;
    if (side !== "home" && side !== "away") continue;
    parsed[side] = {};
    for (const statistic of team.statistics || []) {
      const value = Number.parseFloat(String(statistic.displayValue ?? ""));
      if (Number.isFinite(value)) parsed[side][statistic.name] = value;
    }
  }
  if (!parsed.home || !parsed.away) throw new Error("Comparaison des statistiques ESPN impossible");
  return parsed;
}

function getValueOpportunities() {
  return matches.flatMap((match) => {
      const probabilities = getMatchProbabilities(match);
      const odds = match.enrichment?.odds;
      if (!probabilities || !odds || match.state === "post") return [];
      return [
        { key: "home", label: `Victoire ${match.home.name}`, probability: probabilities.home, odds: odds.home },
        { key: "draw", label: "Match nul", probability: probabilities.draw, odds: odds.draw },
        { key: "away", label: `Victoire ${match.away.name}`, probability: probabilities.away, odds: odds.away }
      ].filter((selection) =>
        Number.isFinite(selection.probability) &&
        Number.isFinite(selection.odds) &&
        selection.odds > 1 &&
        selection.probability * selection.odds - 1 > 0
      ).map((selection) => ({
        match,
        ...selection,
        value: selection.probability * selection.odds - 1,
        bookmaker: odds.bookmakers?.[selection.key] || ""
      }));
  }).sort((first, second) => second.value - first.value);
}

function renderValueBets() {
  const opportunities = getValueOpportunities();
  document.getElementById("stat-values").textContent = String(opportunities.length);
  document.getElementById("value-count").textContent =
    `${opportunities.length} opportunité${opportunities.length === 1 ? "" : "s"}`;
  document.getElementById("values-empty").hidden = opportunities.length > 0;
  document.getElementById("value-table-body").innerHTML = opportunities.map((item) => `
      <tr>
        <td class="value-match-cell">${escapeHTML(item.match.home.name)} – ${escapeHTML(item.match.away.name)}<small>${escapeHTML(item.match.league)} · ${escapeHTML(formatDateTime(item.match.date))}</small></td>
        <td><span class="market-pill">${escapeHTML(item.label)}</span></td>
        <td class="value-percent">${percent(item.probability)}</td>
        <td>${item.odds.toFixed(2)}<small>${escapeHTML(item.bookmaker)}</small></td>
        <td><span class="value-positive">+${(item.value * 100).toFixed(1)}%</span></td>
    </tr>`).join("");

  document.getElementById("top-value-bets").innerHTML = opportunities.length
    ? opportunities.slice(0, 3).map((item) => `
        <div class="top-value-item">
          <div><div class="top-value-match">${escapeHTML(item.match.home.shortName)} – ${escapeHTML(item.match.away.shortName)}</div><div class="top-value-market">${escapeHTML(item.label)} · ${escapeHTML(item.match.league)}</div></div>
          <div><div class="top-value-return">+${(item.value * 100).toFixed(1)}%</div><div class="top-value-odds">${item.odds.toFixed(2)} · ${escapeHTML(item.bookmaker)}</div></div>
      </div>`).join("")
    : '<p class="section-description">Aucune value bet calculable : les fournisseurs doivent fournir une probabilité réelle et une cote pour la même rencontre.</p>';
}

function renderProviderState(message) {
  document.getElementById("enrichment-status").textContent = message;
  document.getElementById("football-provider-status").textContent =
    enrichmentConfig.predictions || enrichmentConfig.xg
      ? "API-Football · clé configurée"
      : "API-Football · clé requise";
  document.getElementById("odds-provider-status").textContent =
    enrichmentConfig.odds
      ? "The Odds API · clé configurée"
      : "The Odds API · clé requise";
  document.getElementById("stat-values").textContent = String(getValueOpportunities().length);
}

async function refreshEnrichment({ force = false } = {}) {
  if (enrichmentInProgress || !matches.length) return;
  if (!force && enrichmentUpdatedAt && Date.now() - enrichmentUpdatedAt.getTime() < ENRICH_REFRESH_INTERVAL) return;
  enrichmentInProgress = true;
  renderProviderState("Mise à jour des cotes et du modèle…");
  try {
    const response = await fetch("/api/enrichment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          matches: matches.map((match) => ({
            id: match.id,
            league: match.league,
            home: match.home.name,
            away: match.away.name,
            date: match.date,
            state: match.state
          }))
        }),
        signal: AbortSignal.timeout(90_000)
      });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Serveur de données non disponible (HTTP ${response.status})`);
    }
    const result = await response.json();
    enrichmentConfig = result.config || enrichmentConfig;
    const updates = result.matches || {};
    matches = matches.map((match) => ({
        ...match,
        enrichment: updates[match.id] || match.enrichment || null
      }));
    enrichmentUpdatedAt = new Date(result.updatedAt || Date.now());
    saveCache();
    renderAll();

    const activeSources = [
        enrichmentConfig.predictions && "prédictions",
        enrichmentConfig.odds && "cotes",
        enrichmentConfig.xg && "xG (matchs démarrés)"
    ].filter(Boolean);
    let statusMessage;
    if (!enrichmentConfig.predictions && !enrichmentConfig.xg && !enrichmentConfig.odds) {
      statusMessage = "Clés API à configurer dans .env";
    } else {
      statusMessage = activeSources.length
        ? `Connecté · ${activeSources.join(", ")}`
        : "Fournisseurs connectés · données en attente";
    }
    if (Array.isArray(result.warnings) && result.warnings.length) {
      console.warn("Certaines données de cotes/statistiques ne sont pas disponibles :", result.warnings);
      if (enrichmentConfig.predictions || enrichmentConfig.xg || enrichmentConfig.odds) {
        const warnings = result.warnings.filter((warning) => typeof warning === "string");
        const summary = warnings.slice(0, 2).join(" · ");
        const remaining = warnings.length - 2;
        statusMessage =
          `Données partielles : ${summary}${remaining > 0 ? ` (+${remaining} autres alertes)` : ""}`;
      }
    }
    renderProviderState(statusMessage);
  } catch (error) {
    console.warn("Enrichissement API indisponible :", error.message);
    renderProviderState(error.message.includes("Failed to fetch") ||
      error.message.includes("non disponible") ||
      error.message.includes("Not Found") ||
      error.message.includes("HTTP 404")
      ? "Lancer node server.js pour activer les API"
      : "Fournisseur temporairement indisponible");
  } finally {
    enrichmentInProgress = false;
  }
}

async function fetchScoreboard(competition, date) {
  const dateQuery = date ? `?dates=${date}` : "";
  const response = await fetch(`${DATA_URL}/${competition.slug}/scoreboard${dateQuery}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    throw new Error(`${competition.name} : ESPN a répondu HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.events)) {
    throw new Error(`${competition.name} : réponse ESPN sans calendrier exploitable`);
  }
  return data;
}

function formatApiDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function fetchCompetition(competition, includeSchedule) {
  const data = await fetchScoreboard(competition);
  const events = data.events.map((event) => parseCompetitionEvent(event, competition)).filter(Boolean);
  if (!includeSchedule) return { matches: events, warnings: [] };

  const calendar = data.leagues?.[0]?.calendar;
  if (!Array.isArray(calendar)) {
    return {
      matches: events,
      warnings: [`${competition.name} : le calendrier prévisionnel n'est pas fourni par ESPN`]
    };
  }

  const firstKey = formatApiDate(todayAtMidnight());
  const lastDay = todayAtMidnight();
  lastDay.setDate(lastDay.getDate() + 6);
  const lastKey = formatApiDate(lastDay);
  const loadedDates = new Set(events.map((event) => event.date.slice(0, 10).replaceAll("-", "")));
  const upcomingDates = [...new Set(calendar
    .filter((date) => typeof date === "string")
    .map((date) => date.slice(0, 10).replaceAll("-", ""))
    .filter((date) => date >= firstKey && date <= lastKey && !loadedDates.has(date)))];
  const allEvents = new Map(events.map((event) => [event.id, event]));
  const warnings = [];

  for (const date of upcomingDates) {
    try {
      const scoreboard = await fetchScoreboard(competition, date);
      for (const event of scoreboard.events) {
        const parsedEvent = parseCompetitionEvent(event, competition);
        if (parsedEvent) allEvents.set(parsedEvent.id, parsedEvent);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `${competition.name} : erreur inconnue`);
    }
  }

  return { matches: [...allEvents.values()], warnings };
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      matches,
      updatedAt: lastUpdated?.toISOString() || null,
      scheduleUpdatedAt: scheduleUpdatedAt?.toISOString() || null
    }));
  } catch (error) {
    console.warn("Impossible d'enregistrer le cache local des matchs :", error);
  }
}

function matchOrder(match) {
  if (match.state === "in") return 0;
  if (match.state === "pre") return 1;
  return 2;
}

function getVisibleMatches(list = matches) {
  return [...list].sort((left, right) => {
    const stateDifference = matchOrder(left) - matchOrder(right);
    if (stateDifference !== 0) return stateDifference;
    if (left.state === "post") return new Date(right.date) - new Date(left.date);
    return new Date(left.date) - new Date(right.date);
  });
}

function renderTeam(team, score) {
  const badge = team.logo
    ? `<img class="team-logo" src="${escapeHTML(team.logo)}" alt="" loading="lazy">`
    : `<span class="team-badge">${escapeHTML(team.shortName.slice(0, 2).toUpperCase())}</span>`;
  const actualScore = score === null ? "–" : escapeHTML(score);
  return `<div class="team-row"><span class="team-info">${badge}<span class="team-name">${escapeHTML(team.name)}</span></span><span class="team-goals">${actualScore}</span></div>`;
}

function getMatchCard(match) {
  const probabilities = getMatchDisplayProbabilities(match);
  const assessment = getMatchOutcomeAssessment(match);
  const values = probabilities ? [probabilities.home, probabilities.draw, probabilities.away] : [];
  const highest = values.length ? Math.max(...values) : null;
  const detail = match.state === "in"
    ? `<span class="status-pill is-live"><i></i>${escapeHTML(match.status)}</span>`
    : `<span class="status-pill ${match.state === "post" ? "is-finished" : ""}">${escapeHTML(match.state === "post" ? match.status : formatDateTime(match.date))}</span>`;
  const scoreVisible = match.state !== "pre";
  return `
    <article class="match-card" tabindex="0" role="button" aria-label="Détails ${escapeHTML(match.home.name)} contre ${escapeHTML(match.away.name)}" data-match="${escapeHTML(match.id)}">
      <div class="match-card-top"><span class="league-label"><i class="league-dot ${match.leagueStyle}"></i>${escapeHTML(match.league)}</span>${detail}</div>
      ${renderTeam(match.home, scoreVisible ? match.home.score : null)}
      <div class="match-divider"></div>
      ${renderTeam(match.away, scoreVisible ? match.away.score : null)}
      ${probabilities ? `<div class="probability-row">${[
        { label: "1", value: probabilities.home },
        { label: "N", value: probabilities.draw },
        { label: "2", value: probabilities.away }
      ].map((item) => `<div class="prob-cell ${item.value === highest ? "is-favorite" : ""}"><span>${item.label === "1" ? "Victoire dom." : item.label === "N" ? "Match nul" : "Victoire ext."}</span><strong>${percent(item.value)}</strong></div>`).join("")}</div>` : ""}
      ${assessment ? `<div class="probability-source">${escapeHTML(assessment.source)} · ${escapeHTML(assessment.reliability)}</div>` : ""}
      <div class="match-enrichment">
        ${match.enrichment?.xg ? `<span class="enrichment-chip xg-chip">xG réel <strong>${match.enrichment.xg.home.toFixed(2)} – ${match.enrichment.xg.away.toFixed(2)}</strong></span>` : ""}
        ${match.enrichment?.prediction?.forecastGoals ? `<span class="enrichment-chip">Buts prévus <strong>${match.enrichment.prediction.forecastGoals.home.toFixed(1)} – ${match.enrichment.prediction.forecastGoals.away.toFixed(1)}</strong></span>` : ""}
        ${match.enrichment?.odds ? `<span class="enrichment-chip">Cotes 1N2 <strong>${match.enrichment.odds.home.toFixed(2)} / ${match.enrichment.odds.draw.toFixed(2)} / ${match.enrichment.odds.away.toFixed(2)}</strong></span>` : ""}
        ${!match.enrichment?.xg && !match.enrichment?.prediction && !match.enrichment?.odds ? `<span class="enrichment-unavailable">${assessment ? "Cotes API et xG indisponibles pour ce match" : enrichmentConfig.xg || enrichmentConfig.predictions || enrichmentConfig.odds ? "Pronostic fournisseur en attente" : "Clés API requises pour xG, pronostics et cotes"}</span>` : ""}
      </div>
      <div class="match-card-bottom"><span class="match-date-label">${escapeHTML(formatDate(match.date))}</span><span class="match-detail-link">${match.venue ? "Voir le match" : "Détails"} →</span></div>
    </article>`;
}

function renderMatchCards(target, list) {
  target.innerHTML = list.map(getMatchCard).join("");
}

function renderLiveScores() {
  const panel = document.getElementById("live-scores-panel");
  const liveMatches = matches.filter((match) => match.state === "in");
  const nextMatches = getVisibleMatches(matches.filter((match) => match.state === "pre")).slice(0, 3);
  const items = liveMatches.length ? liveMatches : nextMatches;
  document.getElementById("live-panel-caption").textContent = liveMatches.length
    ? `${liveMatches.length} rencontre${liveMatches.length > 1 ? "s" : ""} en cours maintenant.`
    : "Aucun match en cours dans le flux ; prochaines rencontres programmées.";
  panel.innerHTML = items.length
    ? items.map((match) => {
      const homeScore = match.state === "pre" ? "–" : match.home.score ?? "–";
      const awayScore = match.state === "pre" ? "–" : match.away.score ?? "–";
      return `
      <div class="top-value-item" data-match="${escapeHTML(match.id)}" role="button" tabindex="0">
        <div><div class="top-value-match">${escapeHTML(match.home.shortName)} ${homeScore} – ${awayScore} ${escapeHTML(match.away.shortName)}</div><div class="top-value-market">${escapeHTML(match.league)} · ${match.state === "in" ? escapeHTML(match.status) : escapeHTML(formatDateTime(match.date))}</div></div>
        <span class="top-value-return ${match.state === "in" ? "live-score-label" : ""}">${match.state === "in" ? "LIVE" : "À venir"}</span>
      </div>`;
    }).join("")
    : '<p class="section-description">Aucune rencontre disponible dans les compétitions suivies.</p>';
}

function renderStats() {
  document.getElementById("stat-matches").textContent = String(matches.length);
  document.getElementById("stat-live").textContent = String(matches.filter((match) => match.state === "in").length);
  document.getElementById("match-nav-count").textContent = String(matches.length);
  document.getElementById("stat-xg").textContent = String(matches.filter((match) => match.enrichment?.xg).length);
  renderValueBets();
}

function renderDashboard(filter = "all") {
  const filtered = filter === "all" ? matches : matches.filter((match) => match.league === filter);
  const ordered = getVisibleMatches(filtered);
  renderMatchCards(document.getElementById("dashboard-matches"), ordered.slice(0, 6));
  document.getElementById("today-count").textContent = `${filtered.length} rencontre${filtered.length === 1 ? "" : "s"}`;
  document.querySelectorAll("#dashboard-filters .filter-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  });
}

function renderMatchesPage(filter = "all") {
  const query = document.getElementById("match-search").value.trim().toLocaleLowerCase("fr");
  const filtered = getVisibleMatches(matches.filter((match) => {
    const inLeague = filter === "all" || match.league === filter;
    const inSearch = `${match.home.name} ${match.away.name} ${match.league}`.toLocaleLowerCase("fr").includes(query);
    return inLeague && inSearch;
  }));
  renderMatchCards(document.getElementById("all-matches"), filtered);
  document.getElementById("matches-empty").hidden = filtered.length > 0;
  document.querySelectorAll("#matches-filters .filter-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  });
}

function renderAll(filter = "all") {
  renderStats();
  renderDashboard(document.querySelector("#dashboard-filters .filter-chip.active")?.dataset.filter || filter);
  renderMatchesPage(document.querySelector("#matches-filters .filter-chip.active")?.dataset.filter || "all");
  renderLiveScores();
  updateLastUpdated();
  renderValueBets();
}

async function refreshMatches({ initial = false } = {}) {
  if (refreshInProgress) return;
  refreshInProgress = true;
  const button = document.getElementById("refresh-button");
  button.disabled = true;
  button.classList.add("is-refreshing");
  if (initial && !matches.length) setFeedStatus("Connexion à ESPN…", "loading");

  try {
    const scheduleAge = scheduleUpdatedAt ? Date.now() - scheduleUpdatedAt.getTime() : Infinity;
    const includeSchedule = scheduleAge >= SCHEDULE_REFRESH_INTERVAL;
    const results = await Promise.allSettled(
      competitions.map((competition) => fetchCompetition(competition, includeSchedule))
    );
    const failures = [];
    const scheduleWarnings = [];
    let successfulFeeds = 0;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const competition = competitions[index];
      if (result.status === "rejected") {
        failures.push(result.reason instanceof Error ? result.reason.message : `${competition.name} : erreur inconnue`);
        continue;
      }
      successfulFeeds += 1;
      scheduleWarnings.push(...result.value.warnings);
      const incomingMatches = result.value.matches;
      const incomingIds = new Set(incomingMatches.map((match) => match.id));
      if (includeSchedule && result.value.warnings.length === 0) {
        const previousMatches = new Map(matches
          .filter((match) => match.league === competition.name)
          .map((match) => [match.id, match]));
        matches = matches.filter((match) => match.league !== competition.name);
        matches.push(...incomingMatches.map((incoming) => {
          const previous = previousMatches.get(incoming.id);
          return previous?.enrichment ? { ...incoming, enrichment: previous.enrichment } : incoming;
        }));
      } else {
        matches = matches.map((match) => incomingIds.has(match.id)
          ? incomingMatches.find((incoming) => incoming.id === match.id)
          : match);
        for (const incoming of incomingMatches) {
          if (!matches.some((match) => match.id === incoming.id)) matches.push(incoming);
        }
      }
    }

    if (successfulFeeds > 0) {
      matches = getVisibleMatches(matches);
      lastUpdated = new Date();
      if (includeSchedule) scheduleUpdatedAt = lastUpdated;
      saveCache();
      renderAll();
    }

    if (failures.length === competitions.length) {
      console.error("Échec de récupération des flux ESPN :", failures.join(" | "));
      if (matches.length && lastUpdated) {
        setFeedStatus(`Hors ligne · cache du ${lastUpdated.toLocaleString("fr-FR")}`, "error");
      } else {
        setFeedStatus("Flux ESPN indisponible", "error");
      }
    } else if (failures.length || scheduleWarnings.length) {
      if (failures.length) console.error("Certains flux ESPN n'ont pas répondu :", failures.join(" | "));
      if (scheduleWarnings.length) console.error("Calendriers incomplets :", scheduleWarnings.join(" | "));
      setFeedStatus(
        failures.length
          ? `Données partielles · ${successfulFeeds}/${competitions.length} compétitions`
          : "Scores à jour · calendrier partiel",
        failures.length ? "error" : "online"
      );
    } else {
      setFeedStatus("Scores en direct · ESPN", "online");
    }
    void refreshEnrichment();
  } catch (error) {
    console.error("Erreur inattendue lors de l'actualisation des matchs :", error);
    setFeedStatus("Erreur de chargement des scores", "error");
  } finally {
    refreshInProgress = false;
    button.disabled = false;
    button.classList.remove("is-refreshing");
  }
}

function showPage(page) {
  const titles = {
    dashboard: "Vue d'ensemble",
    matches: "Matchs",
    valuebets: "Value bets",
    performance: "Performances"
  };
  document.querySelectorAll(".page-view").forEach((view) => {
    view.classList.toggle("active", view.id === `page-${page}`);
  });
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === page);
  });
  document.getElementById("page-breadcrumb").textContent = titles[page] || titles.dashboard;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setMobileMenuOpen(isOpen) {
  const sidebar = document.getElementById("sidebar");
  const button = document.getElementById("mobile-menu-button");
  const backdrop = document.getElementById("sidebar-backdrop");
  const mobile = window.matchMedia("(max-width: 600px)").matches;
  const shouldOpen = Boolean(isOpen && mobile);
  document.body.classList.toggle("sidebar-open", shouldOpen);
  sidebar.setAttribute("aria-hidden", String(!shouldOpen && mobile));
  sidebar.inert = !shouldOpen && mobile;
  button.setAttribute("aria-expanded", String(shouldOpen));
  button.setAttribute("aria-label", shouldOpen ? "Fermer le menu" : "Ouvrir le menu");
  button.textContent = shouldOpen ? "×" : "☰";
  backdrop.hidden = !shouldOpen;
}

function openMatch(matchId) {
  const match = matches.find((item) => item.id === matchId);
  if (!match) return;
  const dialog = document.getElementById("match-dialog");
  const venue = [match.venue, match.venueCity].filter(Boolean).join(" · ");
  const hasStarted = match.state !== "pre";
  const assessment = getMatchOutcomeAssessment(match);
  const formRows = [
    { team: match.home, label: match.home.form },
    { team: match.away, label: match.away.form }
  ].filter((row) => row.label);
  document.getElementById("dialog-content").innerHTML = `
    <div class="dialog-heading"><small>${escapeHTML(match.league)} · ${escapeHTML(formatDateTime(match.date))}</small><h2 id="dialog-title">${escapeHTML(match.home.name)} <span>contre</span> ${escapeHTML(match.away.name)}</h2><p>${escapeHTML(match.status)}${match.state === "in" && match.detail ? ` · ${escapeHTML(match.detail)}` : ""}</p></div>
    <div class="dialog-section-title">${hasStarted ? "Score officiel" : "Score"}</div>
    <div class="dialog-scoreline">${hasStarted ? `<strong>${match.home.score ?? "–"}</strong><span>–</span><strong>${match.away.score ?? "–"}</strong>` : '<span class="upcoming-score-label">Pas encore commencé</span>'}</div>
    ${assessment ? `<div class="dialog-section-title">Qui est favori ?</div><div class="match-assessment"><strong>${escapeHTML(assessment.favorite.label)} · ${percent(assessment.favorite.probability)}</strong><span>${escapeHTML(assessment.source)} · ${escapeHTML(assessment.reliability)}. Ce chiffre est indicatif, pas une garantie.</span><div class="dialog-probabilities">${assessment.outcomes.map((outcome) => `<div class="dialog-probability"><strong>${percent(outcome.probability)}</strong><span>${escapeHTML(outcome.label)}</span></div>`).join("")}</div></div>` : '<div class="dialog-section-title">Pronostic du résultat</div><div class="match-meta">Bilan saison insuffisant pour établir une estimation indépendante des cotes.</div>'}
    <div class="dialog-section-title">${match.state === "in" ? "Statistiques en direct" : match.state === "post" ? "Statistiques du match" : "Tirs, centres et corners"}</div>
    <div id="live-match-stats" class="match-meta">${match.state === "pre" ? "Les prévisions de volume avant le match ne sont pas fournies par les sources actuelles. Les statistiques réelles seront affichées pendant la rencontre si ESPN les fournit." : "Chargement des statistiques ESPN…"}</div>
    ${venue ? `<div class="dialog-section-title">Stade</div><div class="match-meta">${escapeHTML(venue)}</div>` : ""}
    ${formRows.length ? `<div class="dialog-section-title">Forme récente publiée par ESPN</div><div class="match-meta">${formRows.map((row) => `${escapeHTML(row.team.name)} : ${escapeHTML(row.label)}${row.team.record ? ` (${escapeHTML(row.team.record)})` : ""}`).join("<br>")}</div>` : ""}
    ${match.enrichment?.prediction?.probabilities ? `<div class="dialog-section-title">Probabilités prédites · API-Football</div><div class="dialog-probabilities"><div class="dialog-probability"><strong>${percent(match.enrichment.prediction.probabilities.home)}</strong><span>Victoire dom.</span></div><div class="dialog-probability"><strong>${percent(match.enrichment.prediction.probabilities.draw)}</strong><span>Match nul</span></div><div class="dialog-probability"><strong>${percent(match.enrichment.prediction.probabilities.away)}</strong><span>Victoire ext.</span></div></div>` : ""}
    ${match.enrichment?.prediction?.forecastGoals ? `<div class="dialog-section-title">Buts prévus · API-Football</div><div class="dialog-scoreline"><strong>${match.enrichment.prediction.forecastGoals.home.toFixed(1)}</strong><span>–</span><strong>${match.enrichment.prediction.forecastGoals.away.toFixed(1)}</strong></div>` : ""}
    ${match.enrichment?.xg ? `<div class="dialog-section-title">Expected goals (xG) · match réel</div><div class="match-meta">${escapeHTML(match.home.name)} : ${match.enrichment.xg.home.toFixed(2)} · ${escapeHTML(match.away.name)} : ${match.enrichment.xg.away.toFixed(2)}</div>` : ""}
    ${match.enrichment?.odds ? `<div class="dialog-section-title">Cotes 1N2 · The Odds API</div><div class="match-meta">1 : ${match.enrichment.odds.home.toFixed(2)} (${escapeHTML(match.enrichment.odds.bookmakers?.home || "bookmaker")})<br>N : ${match.enrichment.odds.draw.toFixed(2)} (${escapeHTML(match.enrichment.odds.bookmakers?.draw || "bookmaker")})<br>2 : ${match.enrichment.odds.away.toFixed(2)} (${escapeHTML(match.enrichment.odds.bookmakers?.away || "bookmaker")})</div>` : ""}
    <p class="dialog-note">Le pronostic saison est une estimation simplifiée fondée sur les bilans victoire-nul-défaite de cette compétition ; il ne tient pas compte des compositions, blessures ni de la force des adversaires. Les données API et les cotes s'affichent uniquement si elles sont disponibles. Aucune estimation ne garantit un résultat.</p>`;
  activeDialogMatchId = match.id;
  dialog.showModal();
  if (match.state !== "pre") {
    void fetchLiveMatchStats(match)
      .then((stats) => {
        if (!dialog.open || activeDialogMatchId !== match.id) return;
        const target = document.getElementById("live-match-stats");
        if (target) target.innerHTML = renderLiveMatchStats(stats);
      })
      .catch((error) => {
        console.warn(`Statistiques ESPN indisponibles pour ${match.home.name} – ${match.away.name} :`, error);
        if (!dialog.open || activeDialogMatchId !== match.id) return;
        const target = document.getElementById("live-match-stats");
        if (target) target.textContent = "Statistiques momentanément indisponibles pour cette rencontre.";
      });
  }
}

function updateCalendarLabels() {
  const today = todayAtMidnight();
  document.getElementById("current-date-label").textContent = formatDate(today).toLocaleUpperCase("fr-FR");
  document.getElementById("date-button-label").textContent = formatDate(today);
  document.getElementById("current-year").textContent = String(new Date().getFullYear());
}

document.getElementById("dashboard-filters").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]");
  if (chip) renderDashboard(chip.dataset.filter);
});

document.getElementById("matches-filters").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]");
  if (chip) renderMatchesPage(chip.dataset.filter);
});

document.getElementById("match-search").addEventListener("input", () => {
  const active = document.querySelector("#matches-filters .filter-chip.active");
  renderMatchesPage(active?.dataset.filter || "all");
});

document.getElementById("refresh-button").addEventListener("click", () => refreshMatches());
document.getElementById("enrichment-refresh").addEventListener("click", () => refreshEnrichment({ force: true }));
document.getElementById("date-button").addEventListener("click", () => refreshMatches());
document.getElementById("mobile-menu-button").addEventListener("click", () => {
  const isOpen = document.body.classList.contains("sidebar-open");
  setMobileMenuOpen(!isOpen);
});
document.getElementById("sidebar-backdrop").addEventListener("click", () => setMobileMenuOpen(false));
window.matchMedia("(max-width: 600px)").addEventListener("change", () => setMobileMenuOpen(false));

document.addEventListener("click", (event) => {
  const pageLink = event.target.closest("[data-page]");
  if (pageLink) {
    event.preventDefault();
    showPage(pageLink.dataset.page);
    setMobileMenuOpen(false);
    return;
  }
  const leagueLink = event.target.closest(".league-link");
  if (leagueLink) {
    renderDashboard(leagueLink.dataset.league);
    showPage("dashboard");
    setMobileMenuOpen(false);
    return;
  }
  const matchElement = event.target.closest("[data-match]");
  if (matchElement) openMatch(matchElement.dataset.match);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("sidebar-open")) {
    setMobileMenuOpen(false);
  }
  const matchElement = event.target.closest?.("[data-match]");
  if (matchElement && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openMatch(matchElement.dataset.match);
  }
});

updateCalendarLabels();
const cached = readCache();
if (cached) {
  matches = cached.matches;
  const cachedDate = cached.updatedAt ? new Date(cached.updatedAt) : null;
  lastUpdated = cachedDate && !Number.isNaN(cachedDate.getTime()) ? cachedDate : null;
  const cachedScheduleDate = cached.scheduleUpdatedAt ? new Date(cached.scheduleUpdatedAt) : null;
  scheduleUpdatedAt = cachedScheduleDate && !Number.isNaN(cachedScheduleDate.getTime())
    ? cachedScheduleDate
    : null;
  renderAll();
  setFeedStatus("Mise à jour des scores…", "loading");
}

refreshMatches({ initial: !cached });
window.setInterval(() => {
  if (document.visibilityState === "visible") refreshMatches();
}, REFRESH_INTERVAL);
window.setInterval(() => {
  if (document.visibilityState === "visible") refreshEnrichment({ force: true });
}, ENRICH_REFRESH_INTERVAL);

let installPrompt;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  document.getElementById("install-button").hidden = false;
});

document.getElementById("install-button").addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  document.getElementById("install-button").hidden = true;
});

setMobileMenuOpen(false);
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("Impossible d'enregistrer le service worker OrsyFoot :", error);
    });
  });
}
