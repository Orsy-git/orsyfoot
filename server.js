const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const MAX_ENRICHMENT_MATCHES = 100;
const API_FOOTBALL_URL = "https://v3.football.api-sports.io";
const ODDS_API_URL = "https://api.the-odds-api.com/v4";
const competitionConfig = {
  "Premier League": { footballLeague: 39, oddsSport: "soccer_epl" },
  "La Liga": { footballLeague: 140, oddsSport: "soccer_spain_la_liga" },
  "Ligue 1": { footballLeague: 61, oddsSport: "soccer_france_ligue_one" },
  "Serie A": { footballLeague: 135, oddsSport: "soccer_italy_serie_a" },
  "Ligue des champions": { footballLeague: 2, oddsSport: "soccer_uefa_champs_league" },
  "Ligue Europa": { footballLeague: 3, oddsSport: "soccer_uefa_europa_league" }
};
const cache = new Map();

function loadEnvironment() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith("#") || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadEnvironment();

function cacheGet(key, maxAge) {
  const item = cache.get(key);
  return item && Date.now() - item.timestamp < maxAge ? item.value : null;
}

function cacheSet(key, value) {
  cache.set(key, { value, timestamp: Date.now() });
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: "application/json", ...options.headers }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function normalizeTeamName(value) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|ac|afc|sc|club|deportivo|football|soccer)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  const aliases = {
    "man city": "manchester city",
    "man utd": "manchester united",
    "man united": "manchester united",
    "inter": "inter milan",
    "psg": "paris saint germain",
    "atletico": "atletico madrid"
  };
  return aliases[normalized] || normalized;
}

function teamsMatch(first, second) {
  const left = normalizeTeamName(first);
  const right = normalizeTeamName(second);
  return Boolean(left && right && (
    left === right ||
    (left.length > 4 && right.length > 4 && (left.includes(right) || right.includes(left)))
  ));
}

function dateDistanceHours(first, second) {
  const left = Date.parse(first);
  const right = Date.parse(second);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  return Math.abs(left - right) / 3_600_000;
}

function makeFixtureIndex(matches, apiFixtures) {
  const output = new Map();
  for (const match of matches) {
    const candidates = apiFixtures.filter((fixture) => {
      const home = fixture.teams?.home?.name;
      const away = fixture.teams?.away?.name;
      return teamsMatch(match.home, home) && teamsMatch(match.away, away);
    });
    candidates.sort((first, second) =>
      dateDistanceHours(first.fixture?.date, match.date) -
      dateDistanceHours(second.fixture?.date, match.date)
    );
    const selected = candidates[0];
    if (selected && dateDistanceHours(selected.fixture?.date, match.date) <= 36) {
      output.set(match.id, selected);
    }
  }
  return output;
}

function parsePercent(value) {
  const number = Number.parseFloat(String(value || "").replace("%", ""));
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number / 100 : null;
}

async function getFootballFixtures(leagueId, matches) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 2);
  const to = new Date(today);
  to.setDate(to.getDate() + 7);
  const dateString = (date) => date.toISOString().slice(0, 10);
  const season = today.getUTCMonth() < 6 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
  const params = new URLSearchParams({
    league: String(leagueId),
    season: String(season),
    from: dateString(from),
    to: dateString(to)
  });
  const key = `fixtures:${leagueId}:${params.get("from")}:${params.get("to")}`;
  const cached = cacheGet(key, 6 * 60 * 60_000);
  if (cached) return cached;
  const data = await getJson(`${API_FOOTBALL_URL}/fixtures?${params}`, {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY }
  });
  if (data.errors && Object.keys(data.errors).length) {
    const providerErrors = Object.values(data.errors).filter((error) => typeof error === "string");
    const seasonUnavailable = providerErrors.some((error) =>
      /free plans do not have access to this season/i.test(error)
    );
    throw new Error(seasonUnavailable
      ? "Le forfait gratuit API-Football ne donne pas accès à la saison actuelle."
      : "API-Football n'a pas accepté la requête calendrier");
  }
  const fixtures = Array.isArray(data.response) ? data.response : [];
  cacheSet(key, fixtures);
  return fixtures;
}

async function getPredictions(fixtureId) {
  const key = `prediction:${fixtureId}`;
  const cached = cacheGet(key, 6 * 60 * 60_000);
  if (cached) return cached;
  const params = new URLSearchParams({ fixture: String(fixtureId) });
  const data = await getJson(`${API_FOOTBALL_URL}/predictions?${params}`, {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY }
  });
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error("API-Football n'a pas fourni de prédiction pour cette rencontre");
  }
  const result = data.response?.[0] || null;
  cacheSet(key, result);
  return result;
}

async function getExpectedGoals(fixtureId, isLive) {
  const key = `xg:${fixtureId}`;
  const cached = cacheGet(key, isLive ? 10 * 60_000 : 24 * 60 * 60_000);
  if (cached) return cached;
  const params = new URLSearchParams({ fixture: String(fixtureId) });
  const data = await getJson(`${API_FOOTBALL_URL}/fixtures/statistics?${params}`, {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY }
  });
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error("API-Football n'a pas fourni les statistiques de cette rencontre");
  }
  const result = {};
  for (const team of Array.isArray(data.response) ? data.response : []) {
    const item = team.statistics?.find((stat) =>
      ["expected_goals", "expected goals", "xg"].includes(String(stat.type).toLowerCase())
    );
    const value = Number.parseFloat(String(item?.value ?? ""));
    if (team.team?.id && Number.isFinite(value)) result[String(team.team.id)] = value;
  }
  cacheSet(key, result);
  return result;
}

function parsePrediction(prediction, fixture) {
  const homeTeamId = String(fixture.teams?.home?.id || "");
  const awayTeamId = String(fixture.teams?.away?.id || "");
  const percent = prediction?.predictions?.percent;
  const goals = prediction?.predictions?.goals;
  const home = parsePercent(percent?.home);
  const draw = parsePercent(percent?.draw);
  const away = parsePercent(percent?.away);
  let probabilities = null;
  if (home !== null && draw !== null && away !== null && home + draw + away > 0) {
    const total = home + draw + away;
    probabilities = {
      home: home / total,
      draw: draw / total,
      away: away / total
    };
  }
  const forecastGoals = {
    home: Number.parseFloat(String(goals?.home ?? "")),
    away: Number.parseFloat(String(goals?.away ?? ""))
  };
  return {
    probabilities,
    forecastGoals: Number.isFinite(forecastGoals.home) && Number.isFinite(forecastGoals.away)
      ? forecastGoals
      : null,
    advice: typeof prediction?.predictions?.advice === "string"
      ? prediction.predictions.advice
      : null,
    xg: null,
    xgSource: null,
    teamIds: { home: homeTeamId, away: awayTeamId }
  };
}

function oddsMarket(event) {
  let home = null;
  let draw = null;
  let away = null;
  const sources = { home: null, draw: null, away: null };
  const bookmakerProbabilities = [];
  for (const bookmaker of event.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (market.key !== "h2h") continue;
      const prices = { home: null, draw: null, away: null };
      for (const outcome of market.outcomes || []) {
        const price = Number(outcome.price);
        if (!Number.isFinite(price) || price <= 1) continue;
        let key;
        if (String(outcome.name).toLowerCase() === "draw") key = "draw";
        else if (teamsMatch(outcome.name, event.home_team)) key = "home";
        else if (teamsMatch(outcome.name, event.away_team)) key = "away";
        if (key && (prices[key] === null || price > prices[key])) prices[key] = price;
        const currentPrice = key === "home" ? home : key === "draw" ? draw : away;
        if (key && (sources[key] === null || price > currentPrice)) {
          if (key === "home") home = price;
          else if (key === "draw") draw = price;
          else away = price;
          sources[key] = bookmaker.title || bookmaker.key || null;
        }
      }
      if (prices.home !== null && prices.draw !== null && prices.away !== null) {
        const total = 1 / prices.home + 1 / prices.draw + 1 / prices.away;
        bookmakerProbabilities.push({
          home: (1 / prices.home) / total,
          draw: (1 / prices.draw) / total,
          away: (1 / prices.away) / total
        });
      }
    }
  }
  if (home === null || draw === null || away === null) return null;
  const marketProbabilities = bookmakerProbabilities.length
    ? Object.fromEntries(["home", "draw", "away"].map((side) => [
      side,
      bookmakerProbabilities.reduce((sum, probabilities) => sum + probabilities[side], 0) /
        bookmakerProbabilities.length
    ]))
    : null;
  return {
    home,
    draw,
    away,
    impliedProbabilities: marketProbabilities,
    bookmakers: sources,
    source: "The Odds API",
    updatedAt: event.last_update || null
  };
}

async function getOdds(sportKey) {
  const key = `odds:${sportKey}`;
  const cached = cacheGet(key, 15 * 60_000);
  if (cached) return cached;
  const params = new URLSearchParams({
    apiKey: process.env.THE_ODDS_API_KEY,
    regions: process.env.ODDS_REGIONS || "eu",
    markets: "h2h",
    oddsFormat: "decimal"
  });
  const events = await getJson(`${ODDS_API_URL}/sports/${sportKey}/odds/?${params}`);
  if (!Array.isArray(events)) throw new Error("The Odds API n'a pas renvoyé les événements attendus");
  cacheSet(key, events);
  return events;
}

async function enrichMatches(matches) {
  const results = Object.fromEntries(matches.map((match) => [match.id, {
    odds: null,
    prediction: null,
    xg: null,
    sources: {}
  }]));
  const warnings = [];
  const config = {
    odds: Boolean(process.env.THE_ODDS_API_KEY),
    predictions: Boolean(process.env.API_FOOTBALL_KEY),
    xg: Boolean(process.env.API_FOOTBALL_KEY)
  };

  if (!config.odds && !config.predictions) {
    return {
      config,
      matches: results,
      warnings: ["Ajoutez les clés des fournisseurs dans .env et démarrez server.js pour activer l'enrichissement."]
    };
  }

  for (const [league, settings] of Object.entries(competitionConfig)) {
    const leagueMatches = matches.filter((match) => match.league === league);
    if (!leagueMatches.length) continue;
    const fixtureIndex = new Map();

    if (config.predictions) {
      try {
        const fixtures = await getFootballFixtures(settings.footballLeague, leagueMatches);
        for (const [matchId, fixture] of makeFixtureIndex(leagueMatches, fixtures)) {
          fixtureIndex.set(matchId, fixture);
        }

        const predictionCandidates = leagueMatches
          .filter((match) => match.state === "pre")
          .sort((left, right) => new Date(left.date) - new Date(right.date))
          .slice(0, 3);
        await Promise.allSettled(predictionCandidates.map(async (match) => {
          const fixture = fixtureIndex.get(match.id);
          if (!fixture) return;
          const prediction = await getPredictions(fixture.fixture.id);
          if (prediction) {
            results[match.id].prediction = parsePrediction(prediction, fixture);
            results[match.id].sources.prediction = "API-Football";
          }
        }));

        const liveOrRecent = leagueMatches
          .filter((match) => match.state === "in" ||
            (match.state === "post" && dateDistanceHours(match.date, new Date().toISOString()) <= 24))
          .slice(0, 2);
        await Promise.allSettled(liveOrRecent.map(async (match) => {
          const fixture = fixtureIndex.get(match.id);
          if (!fixture) return;
          const xg = await getExpectedGoals(fixture.fixture.id, match.state === "in");
          const home = xg[String(fixture.teams.home.id)];
          const away = xg[String(fixture.teams.away.id)];
          if (Number.isFinite(home) && Number.isFinite(away)) {
            results[match.id].xg = { home, away };
            results[match.id].sources.xg = "API-Football";
          }
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erreur API-Football";
        warnings.push(`API-Football · ${league} : ${message}`);
      }
    }

    if (config.odds) {
      try {
        const events = await getOdds(settings.oddsSport);
        for (const match of leagueMatches) {
          const candidates = events.filter((event) =>
            teamsMatch(match.home, event.home_team) &&
            teamsMatch(match.away, event.away_team)
          );
          candidates.sort((left, right) =>
            dateDistanceHours(left.commence_time, match.date) -
            dateDistanceHours(right.commence_time, match.date)
          );
          const event = candidates[0];
          if (!event || dateDistanceHours(event.commence_time, match.date) > 36) continue;
          const odds = oddsMarket(event);
          if (odds) {
            results[match.id].odds = odds;
            results[match.id].sources.odds = "The Odds API";
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erreur The Odds API";
        warnings.push(`The Odds API · ${league} : ${message}`);
      }
    }
  }

  return { config, matches: results, warnings };
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256_000) {
        reject(new Error("Requête trop volumineuse"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("JSON invalide"));
      }
    });
    request.on("error", reject);
  });
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml"
  })[extension] || "application/octet-stream";
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/api/providers" && request.method === "GET") {
    return sendJson(response, 200, {
      odds: Boolean(process.env.THE_ODDS_API_KEY),
      predictions: Boolean(process.env.API_FOOTBALL_KEY),
      xg: Boolean(process.env.API_FOOTBALL_KEY)
    });
  }

  if (url.pathname === "/api/enrichment" && request.method === "POST") {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) {
      return sendJson(response, 403, { error: "Origine de requête non autorisée." });
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    if (!Array.isArray(body.matches) || body.matches.length > MAX_ENRICHMENT_MATCHES) {
      return sendJson(response, 400, {
        error: `La requête doit inclure au maximum ${MAX_ENRICHMENT_MATCHES} matchs.`
      });
    }
    const matches = body.matches.filter((match) =>
      match &&
      typeof match.id === "string" &&
      typeof match.league === "string" &&
      competitionConfig[match.league] &&
      typeof match.home === "string" &&
      typeof match.away === "string" &&
      typeof match.date === "string" &&
      Number.isFinite(Date.parse(match.date)) &&
      ["pre", "in", "post"].includes(match.state)
    );
    try {
      const result = await enrichMatches(matches);
      return sendJson(response, 200, { ...result, updatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("Échec de l'enrichissement des données :", error);
      return sendJson(response, 502, { error: "Les fournisseurs de statistiques sont momentanément indisponibles." });
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD, POST" });
    return response.end();
  }
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    return response.end();
  }
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const filePath = path.resolve(ROOT, relativePath);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403);
    return response.end();
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      return response.end("Not found");
    }
    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    if (request.method === "HEAD") return response.end();
    response.end(content);
  });
}

http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Erreur serveur OrsyFoot :", error);
    if (!response.headersSent) sendJson(response, 500, { error: "Erreur interne du serveur OrsyFoot." });
    else response.end();
  });
}).listen(PORT, HOST, () => {
  console.log(`OrsyFoot disponible sur http://${HOST}:${PORT}`);
  console.log(`The Odds API : ${process.env.THE_ODDS_API_KEY ? "configurée" : "clé manquante"}`);
  console.log(`API-Football : ${process.env.API_FOOTBALL_KEY ? "configurée" : "clé manquante"}`);
});
