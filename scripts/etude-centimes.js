#!/usr/bin/env node
// Etude du passage des montants en centimes entiers -- en LECTURE SEULE.
//
//   node scripts/etude-centimes.js [chemin/vers/drop.db]
//
// Les montants (prix des colis, tarifs, valeur des tournees, journal) sont
// stockes en REAL. Depuis la correction, ils sont arrondis au centime a
// l'ecriture et dans chaque total, ce qui supprime les ecarts d'affichage.
// Les stocker en centimes entiers irait plus loin, mais toucherait chaque
// requete et chaque reponse de l'API (site, app iOS) : on ne le fait qu'apres
// avoir verifie, sur une COPIE de la base de production, que rien ne se perd.
//
// Ce script dit, colonne par colonne : combien de valeurs ne tombent pas
// pile sur un centime (et seraient donc arrondies), et si les totaux
// changeraient. Il n'ecrit rien.
require("dotenv").config();
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { cheminBase } = require("../src/db/connexion");

const chemin = process.argv[2] || cheminBase().chemin;
const base = new DatabaseSync(chemin, { readOnly: true });

const COLONNES = [
  ["colis", "price"],
  ["senders", "price"],
  ["senders", "lit_price"],
  ["senders", "bj_price"],
  ["tours", "value"],
  ["journal", "valeur"],
];

const existe = (table, colonne) =>
  base.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) &&
  base.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === colonne);

console.log(`Base : ${path.resolve(chemin)}\n`);
let sansPerte = true;
for (const [table, colonne] of COLONNES) {
  if (!existe(table, colonne)) {
    console.log(`${table}.${colonne} : absente`);
    continue;
  }
  const lignes = base.prepare(`SELECT ${colonne} AS v FROM ${table} WHERE ${colonne} IS NOT NULL`).all();
  let horsCentime = 0;
  let ecartMax = 0;
  let totalReel = 0;
  let totalCentimes = 0;
  for (const { v } of lignes) {
    const centimes = Math.round(v * 100);
    const ecart = Math.abs(v * 100 - centimes);
    if (ecart > 1e-6) {
      horsCentime += 1;
      ecartMax = Math.max(ecartMax, ecart / 100);
    }
    totalReel += v;
    totalCentimes += centimes;
  }
  const ecartTotal = Math.abs(totalReel - totalCentimes / 100);
  if (horsCentime > 0 || ecartTotal >= 0.005) sansPerte = false;
  console.log(
    `${`${table}.${colonne}`.padEnd(18)} ${String(lignes.length).padStart(7)} valeurs · ` +
      `${horsCentime} hors centime${horsCentime ? ` (ecart max ${ecartMax.toFixed(6)} €)` : ""} · ` +
      `total ${totalReel.toFixed(4)} € -> ${(totalCentimes / 100).toFixed(2)} € en centimes`
  );
}

console.log(
  sansPerte
    ? "\nConversion en centimes entiers SANS PERTE : chaque montant tombe pile sur un centime."
    : "\nATTENTION : des montants ne tombent pas pile sur un centime. Les examiner avant toute conversion."
);
console.log(`
Plan de la migration (a n'ecrire qu'apres ce constat sur une copie de la production) :
  1. sauvegarde de la base (VACUUM INTO) et verification de la copie ;
  2. colonnes *_centimes INTEGER ajoutees a cote des colonnes REAL (rien n'est retire) ;
  3. remplissage : ROUND(valeur * 100), puis comparaison des totaux ligne a ligne ;
  4. le code lit et ecrit les centimes, l'API continue de repondre en euros (centimes / 100) ;
  5. les colonnes REAL restent en place une version, pour pouvoir revenir en arriere.`);
base.close();
