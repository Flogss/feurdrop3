#!/usr/bin/env node
// Agent d'impression DROP.
//
// Tourne en tache de fond sur le Mac relie a l'imprimante. Toutes les
// POLL_SECONDS secondes il demande au serveur s'il y a des etiquettes qui ne
// sont pas encore sorties, recupere un PDF deja au format 4x6, l'envoie a
// l'imprimante avec `lp`, puis confirme au serveur.
//
// Rien n'est marque comme imprime tant que `lp` n'a pas accepte le travail :
// si le Mac s'endort ou perd le reseau au mauvais moment, l'etiquette
// repartira au prochain tour.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CONFIG_PATH = process.env.DROP_CONFIG || path.join(os.homedir(), ".drop-print.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Configuration absente : ${CONFIG_PATH}`);
    console.error('Cree ce fichier : { "server": "https://...", "token": "...", "printer": "Nom_Imprimante" }');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!config.server || !config.token) {
    console.error("Il faut au moins 'server' et 'token' dans la configuration.");
    process.exit(1);
  }
  return {
    pollSeconds: 20,
    printer: null, // null = imprimante par defaut du Mac
    ...config,
    server: String(config.server).replace(/\/+$/, ""),
  };
}

const config = loadConfig();
const log = (...args) => console.log(new Date().toISOString(), ...args);

function api(path, options = {}) {
  return fetch(`${config.server}${path}`, {
    ...options,
    headers: { "x-print-token": config.token, ...(options.headers || {}) },
  });
}

// `lp` rend la main des que le travail est accepte par la file d'impression.
function printFile(file) {
  return new Promise((resolve, reject) => {
    // -o media : la taille exacte de l'etiquette, pour que le pilote
    // n'applique aucune mise a l'echelle de son cote.
    const args = [
      ...(config.printer ? ["-d", config.printer] : []),
      "-o", "media=Custom.4x6in",
      "-o", "fit-to-page=false",
      "-o", "scaling=100",
      file,
    ];
    execFile("lp", args, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(String(stdout).trim());
    });
  });
}

async function tick() {
  const queue = await api("/api/print/queue");
  if (queue.status === 401) throw new Error("jeton refuse par le serveur");
  if (!queue.ok) throw new Error(`file d'attente : HTTP ${queue.status}`);

  const { enabled, count } = await queue.json();
  if (!enabled || count === 0) return;

  log(`${count} etiquette(s) a imprimer, recuperation...`);
  const next = await api("/api/print/next");
  if (next.status === 204) return;
  if (!next.ok) throw new Error(`recuperation : HTTP ${next.status}`);

  const ids = String(next.headers.get("x-drop-colis-ids") || "")
    .split(",")
    .map(Number)
    .filter(Boolean);
  const pdf = Buffer.from(await next.arrayBuffer());
  if (pdf.length === 0 || ids.length === 0) return;

  const file = path.join(os.tmpdir(), `drop-${Date.now()}.pdf`);
  fs.writeFileSync(file, pdf);
  try {
    const result = await printFile(file);
    log(`imprime : ${ids.length} etiquette(s) — ${result}`);
    await api("/api/print/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

async function main() {
  log(`agent demarre — serveur ${config.server}, imprimante ${config.printer || "(par defaut)"}, ` +
    `sondage toutes les ${config.pollSeconds} s`);

  for (;;) {
    try {
      await tick();
    } catch (err) {
      log("erreur :", err.message);
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}

main();
