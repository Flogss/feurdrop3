// Appels aux services exterieurs. Tout passe par ici pour une raison simple :
// aucune donnee inventee. Si un service ne repond pas, on remonte l'erreur
// telle quelle plutot que de renvoyer une liste vide qui passerait pour "il
// n'y a rien ici".

const UA = "drop-ctrl/1.0 (tournees de depot, usage personnel)";

async function fetchJson(url, { timeout = 15000, method = "GET", body = null, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: { "User-Agent": UA, Accept: "application/json", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("service injoignable (delai depasse)");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function withParams(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

module.exports = { fetchJson, withParams };
