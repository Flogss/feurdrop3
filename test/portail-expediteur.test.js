// L'espace expediteur : « Redrop » (le colis repasse a imprimer, a 0 €, et
// le groupe Telegram est prevenu), la recherche des numeros (debut, fin,
// fautes de frappe) et les stats (des nombres de colis, jamais d'argent).
// Avec le vrai bot face a un faux serveur Telegram, et le vrai service du
// portail (son propre processus) devant le dashboard.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { environnementDeTest, demarreApp, videBase } = require("./aide");
const { creeFauxTelegram } = require("./fixtures/faux-telegram");

environnementDeTest();
const GROUPE = -1004388459228;
const faux = creeFauxTelegram();

let db;
let app;
let bot;
let portail;
let basePortail;

const espace = (nom) => require("../src/portail").creePortail(db.getOrCreateSender(nom).id).sender.portail_jeton;
// un colis depose, a une date choisie (UTC, comme en base)
function drope(expediteur, quand, options = {}) {
  const c = db.addColis(expediteur, { fileId: `f-${Math.random()}`, fileKind: "pdf", carrier: "LP", ...options });
  db.markPrinted([c.id], "test");
  db.db.prepare("UPDATE colis SET status = 'dropped', dropped_at = ? WHERE id = ?").run(quand, c.id);
  return c.id;
}
const messagesGroupe = () => faux.appelsDe("sendMessage").filter((a) => Number(a.params.chat_id) === GROUPE);

const portLibre = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  process.env.TELEGRAM_API_URL = await faux.demarre();
  process.env.TELEGRAM_ALLOWED_USERS = "111";
  process.env.FILE_REPRISES_MS = "";
  process.env.GROUP_WRITE_INTERVAL_MS = "5";
  db = require("../src/db");
  bot = require("../src/bot").startBot();
  app = await demarreApp();
  // le service du portail, sur son propre port, devant ce dashboard
  const port = await portLibre();
  basePortail = `http://127.0.0.1:${port}`;
  portail = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: { ...process.env, DROP_ROLE: "portail", PORT: String(port), DROP_INTERNE: app.base },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    portail.stdout.on("data", (d) => String(d).includes("[portail]") && resolve());
    portail.on("exit", (code) => reject(new Error(`portail arrete (${code})`)));
    setTimeout(() => reject(new Error("portail trop lent")), 10000);
  });
});

after(async () => {
  portail?.kill();
  await app.ferme();
  for (let n = -1; n !== faux.appels.length; ) {
    n = faux.appels.length;
    await new Promise((r) => setTimeout(r, 400));
  }
  await bot.stopPolling({ cancel: true }).catch(() => {});
  await faux.ferme();
});

beforeEach(() => videBase());

const viaPortail = async (chemin, options = {}) => {
  const r = await fetch(`${basePortail}${chemin}`, options);
  const texte = await r.text();
  let json = null;
  try {
    json = JSON.parse(texte);
  } catch {}
  return { status: r.status, json, texte };
};

test("Redrop depuis l'espace : le colis repasse a imprimer, a 0 €, et le groupe est prevenu", async () => {
  const id = drope("Alice", "2026-11-10 14:00:00", { fileName: "6A12345678901.pdf" });
  db.db.prepare("UPDATE colis SET price = 4.5 WHERE id = ?").run(id);
  const jeton = espace("Alice");
  const avant = await viaPortail(`/api/portail/${jeton}`);
  const ligne = avant.json.colis[0];
  assert.equal(ligne.etape, "drope");
  assert.equal(ligne.redropPossible, true);

  // par le service du portail, comme l'expediteur
  const r = await viaPortail(`/api/portail/${jeton}/redrop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: ligne.ref }) });
  assert.equal(r.status, 200, r.texte);
  assert.equal(r.json.deja, false);

  const nouveau = db.db.prepare("SELECT * FROM colis WHERE redrop_de = ?").get(id);
  assert.equal(nouveau.status, "pending");
  assert.equal(nouveau.price, 0, "gratuit");
  assert.equal(nouveau.printed_at, null, "de nouveau a imprimer");
  assert.equal(nouveau.file_id, db.getColisById(id).file_id, "la meme etiquette");
  // l'original ne bouge pas (son prix, son drop)
  assert.equal(db.getColisById(id).price, 4.5);
  assert.equal(db.getColisById(id).status, "dropped");
  // il est dans la file d'impression
  const { rowsFor } = require("../src/routes/print");
  assert.ok(rowsFor({ categorie: "LP", scope: "new" }).some((c) => c.id === nouveau.id));

  // l'expediteur le voit « Pas imprimé », marque Redrop
  const apres = await viaPortail(`/api/portail/${jeton}`);
  assert.equal(apres.json.colis.length, 1);
  assert.equal(apres.json.colis[0].etape, "a_imprimer");
  assert.equal(apres.json.colis[0].redrop, true);
  assert.ok(!apres.texte.includes('"price"'));

  // le message dans le groupe (topic General : pas de message_thread_id)
  assert.ok(await faux.attends(() => messagesGroupe().length === 1));
  const m = messagesGroupe()[0].params;
  assert.equal(m.parse_mode, "HTML");
  assert.equal(m.message_thread_id, undefined);
  assert.match(m.text, /Redrop demandé/);
  assert.match(m.text, /6A12345678901\.pdf<\/code> à redrop/);
  assert.match(m.text, /par <b>Alice<\/b>/);
  assert.match(m.text, /à imprimer<\/b> · prix <b>0 €<\/b>/);

  // redemande : le meme redrop, pas un second, pas de second message
  const encore = await app.appel(`/api/portail/${jeton}/redrop`, { methode: "POST", corps: { ref: ligne.ref }, anonyme: true });
  assert.equal(encore.status, 200);
  assert.equal(encore.json.deja, true);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis WHERE redrop_de = ?").get(id).n, 1);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(messagesGroupe().length, 1);
});

test("Redrop : seulement un colis depose, et seulement les siens", async () => {
  const aBob = drope("Bob", "2026-11-10 14:00:00");
  const enAttente = db.addColis("Alice", { fileId: "f-attente", fileKind: "pdf" });
  const jetonAlice = espace("Alice");
  const jetonBob = espace("Bob");
  const refBob = (await app.appel(`/api/portail/${jetonBob}`, { anonyme: true })).json.colis[0].ref;
  const refAttente = (await app.appel(`/api/portail/${jetonAlice}`, { anonyme: true })).json.colis.find((c) => c.etape === "a_imprimer").ref;

  const redrop = (jeton, ref) => app.appel(`/api/portail/${jeton}/redrop`, { methode: "POST", corps: { ref }, anonyme: true });
  assert.equal((await redrop(jetonAlice, refBob)).status, 409, "le colis de Bob n'existe pas pour Alice");
  assert.equal((await redrop(jetonAlice, refAttente)).status, 409, "pas encore depose");
  assert.equal((await redrop(jetonAlice, "pas une ref !")).status, 404);
  assert.equal((await redrop("x".repeat(30), refBob)).status, 404);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis WHERE redrop_de IS NOT NULL").get().n, 0);
  assert.ok(db.getColisById(aBob) && db.getColisById(enAttente.id));
});

test("le message du groupe dit le fichier, l'expediteur, le transporteur et 0 €", () => {
  const { messageRedrop } = require("../src/routes/portail");
  const t = messageRedrop({
    origine: { id: 3, file_name: "8R50345899012.pdf", caption: null, carrier: "LP", type: "normal", dropped_at: "2026-11-10 14:05:00" },
    colis: { type: "normal" },
    expediteur: "Rayan <Shop>",
  });
  assert.match(t, /^♻️ <b>Redrop demandé<\/b>/);
  assert.match(t, /<code>8R50345899012\.pdf<\/code> à redrop/);
  assert.match(t, /par <b>Rayan &lt;Shop&gt;<\/b>/, "echappe");
  assert.match(t, /La Poste · <code>8R50345899012<\/code>/);
  assert.match(t, /déjà dropé mardi 10 novembre à 15:05/);
  assert.match(t, /prix <b>0 €<\/b>/);
});

test("stats : des colis par jour, semaine, mois, les meilleures journees -- jamais d'argent", async () => {
  // lundi 2 nov. : 2 ; mardi 3 : 3 ; dimanche 8 : 1 (compte le lundi 9) ; lundi 9 : 1
  drope("Alice", "2026-11-02 09:00:00");
  drope("Alice", "2026-11-02 10:00:00", { carrier: "MR" });
  drope("Alice", "2026-11-03 09:00:00");
  drope("Alice", "2026-11-03 10:00:00");
  const redrope = drope("Alice", "2026-11-03 11:00:00");
  drope("Alice", "2026-11-08 12:00:00");
  drope("Alice", "2026-11-09 12:00:00");
  drope("Bob", "2026-11-03 09:00:00");
  db.addColis("Alice", { fileId: "en-attente", fileKind: "pdf" });
  // le colis du 3 redropé et redeposé le 9 : compte une fois, le 9
  const r = db.redropColis(redrope);
  db.db.prepare("UPDATE colis SET status = 'dropped', dropped_at = '2026-11-09 15:00:00' WHERE id = ?").run(r.colis.id);

  const s = await viaPortail(`/api/portail/${espace("Alice")}/stats`);
  assert.equal(s.status, 200, s.texte);
  const d = s.json;
  assert.equal(d.total, 7, "7 colis postes (Bob et le colis en attente n'y sont pas, le redrop compte une fois)");
  const jour = (j) => d.jours.find((x) => x.date === j)?.colis;
  assert.equal(jour("2026-11-02"), 2);
  assert.equal(jour("2026-11-03"), 2);
  assert.equal(jour("2026-11-09"), 3, "le dimanche compte le lundi, le redrop a son dernier drop");
  assert.ok(!d.jours.some((x) => new Date(`${x.date}T12:00:00Z`).getUTCDay() === 0), "pas de dimanche");
  assert.deepEqual(d.meilleursJours[0], { date: "2026-11-09", colis: 3 });
  const semaine = d.semaines.find((w) => w.debut === "2026-11-02");
  assert.equal(semaine.colis, 4);
  assert.equal(d.mois.find((m) => m.mois === "2026-11").colis, 7);
  assert.deepEqual(
    d.transporteurs.map((t) => [t.code, t.colis]),
    [
      ["LP", 6],
      ["MR", 1],
    ]
  );
  for (const interdit of ["price", "prix", "valeur", "value", "€", "Bob"]) assert.ok(!s.texte.includes(interdit), `rien d'autre que des colis : ${interdit}`);

  assert.equal((await viaPortail(`/api/portail/${"x".repeat(30)}/stats`)).status, 404);
});

test("la page du portail charge ses scripts (recherche, stats) par leur empreinte", async () => {
  const page = await viaPortail(`/${espace("Alice")}`);
  assert.equal(page.status, 200);
  for (const f of ["portail-recherche.js", "portail.js", "portail-stats.js"]) {
    const m = page.texte.match(new RegExp(`src="/${f.replace(".", "\\.")}\\?v=([0-9a-f]{10})"`));
    assert.ok(m, `${f} versionne`);
    assert.equal((await viaPortail(`/${f}`)).status, 200);
  }
});

test("recherche : debut, fin, n'importe ou, puis les numeros proches (fautes de frappe)", () => {
  const { classe, compare } = require("../public/portail-recherche.js");
  const colis = ["6A12345678901", "6A12345600000", "XX123456789FR", "8R50345899012", "1Z999AA10123456784"].map((numero, i) => ({ suivi: { numero }, recuLe: `2026-11-0${i + 1}` }));
  const types = (q) => classe(colis, q).map((r) => [r.c.suivi.numero, r.type]);

  // « 123456 » propose aussi 123456XXXX, ou qu'il soit
  assert.equal(types("123456").length, 4);
  assert.deepEqual(types("6A1234"), [
    ["6A12345600000", "debut"],
    ["6A12345678901", "debut"],
  ]);
  assert.deepEqual(types("8901")[0], ["6A12345678901", "fin"]);
  assert.deepEqual(types("6a 1234 5678 901")[0], ["6A12345678901", "exact"], "espaces et casse ignores");
  // une faute : un chiffre change, deux inverses, un oublie
  assert.deepEqual(types("8R5034599012"), [["8R50345899012", "proche"]]);
  assert.deepEqual(types("6A12345678910")[0], ["6A12345678901", "proche"]);
  assert.deepEqual(types("8R503458990"), [["8R50345899012", "debut"]]);
  assert.deepEqual(types("8R5034589012")[0], ["8R50345899012", "proche"]);
  // une lettre lue pour un chiffre
  assert.equal(compare("8R5O345899012", "8R50345899012").type, "proche");
  // trop court, ou trop different : rien
  assert.deepEqual(types("12"), []);
  assert.deepEqual(types("777777"), []);
  // la partie a surligner
  assert.deepEqual(
    (({ debut, fin }) => [debut, fin])(compare("456789", "6A12345678901")),
    [5, 11]
  );
});
