#!/usr/bin/env node
// Affiche le jeton de l'agent d'impression (voir agent/README.md), sans le
// faire passer par les journaux du serveur. A lancer la ou la base vit : en
// local, ou dans un terminal du service Railway (railway ssh).
require("dotenv").config();
const { getPrintToken } = require("../src/db");

console.log(getPrintToken());
