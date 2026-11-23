// Le classement d'un fichier envoye en prive : une legende "met lui dedans",
// meme en majuscules ou avec une faute de frappe, l'envoie dans special.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyFile, legendeDitSpecial } = require("../src/classify");

test("« met lui (dedans) » et ses fautes envoient dans special", () => {
  for (const legende of [
    "met lui dedans",
    "met lui",
    "MET lui",
    "met ylui",
    "MET YLUI DEDANS",
    "mets-lui dedans",
    "Mets le dedans",
    "mé lui",
    "metlui",
    "mzt lui",
    "met luii stp",
    "  met   lui  ",
  ]) {
    assert.equal(classifyFile({ fileName: "etiquette.pdf", caption: legende }), "special", legende);
  }
});

test("la legende l'emporte sur le nom du fichier", () => {
  assert.equal(classifyFile({ fileName: "BOITEJAUNE6N00028490616.pdf", caption: "met lui" }), "special");
  assert.equal(classifyFile({ fileName: "scotch.pdf", caption: "Met lui dedans" }), "special");
});

test("sans « met lui », rien ne change", () => {
  for (const legende of [
    null,
    "",
    "met",
    "lui",
    "je met le prix demain",
    "c'est pour lui",
    "mettre de cote",
    "mais lui",
    "le colis est dedans",
    "📦 mondial relay 5kg",
    "DPD 2 KG",
  ]) {
    assert.equal(legendeDitSpecial(legende), false, String(legende));
    assert.equal(classifyFile({ fileName: "etiquette.pdf", caption: legende }), "normal", String(legende));
  }
  assert.equal(classifyFile({ fileName: "BOITEJAUNE6N00028490616.pdf", caption: null }), "bj");
  assert.equal(classifyFile({ fileName: "etiquette.pdf", caption: "avec scotch" }), "lit");
});
