// La recherche des numeros de suivi de l'espace expediteur : « 123456 »
// propose aussi « 123456XXXX », et un numero tape avec une faute garde ses
// colis (« numéros proches »).
//
// Chaque numero recoit un score, du plus sur au plus lache :
//   100  le numero entier ;
//    90  son debut          (« 6A1234 »      -> 6A12345678901) ;
//    80  sa fin             (on tape souvent les derniers chiffres) ;
//    70  n'importe ou dedans ;
//    60  une lettre lue pour un chiffre (O/0, I/1, L/1) ;
//  50/40 a une ou deux fautes pres (chiffre change, oublie, en trop, deux
//        chiffres inverses) : une faute des 5 caracteres, deux des 9.
// Les espaces, tirets et la casse ne comptent jamais. Utilise par la page
// (window.rechercheNumeros) et par les tests (module.exports).
(function (racine) {
  "use strict";

  const norme = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  // les confusions de lecture d'une etiquette
  const CONFUSIONS = { O: "0", Q: "0", I: "1", L: "1" };
  const sansConfusion = (s) => s.replace(/[OQIL]/g, (c) => CONFUSIONS[c]);
  const fautesPermises = (longueur) => (longueur >= 9 ? 2 : longueur >= 5 ? 1 : 0);

  // La meilleure sous-chaine de `texte` a distance d'edition minimale de
  // `motif` (substitution, oubli, ajout, deux voisins inverses) : { fautes,
  // debut, fin }. Algorithme de Sellers (le debut dans le texte est libre).
  function approche(motif, texte) {
    const m = motif.length;
    const n = texte.length;
    const D = [];
    const S = [];
    for (let i = 0; i <= m; i += 1) {
      D.push(new Int16Array(n + 1));
      S.push(new Int16Array(n + 1));
      D[i][0] = i;
    }
    for (let j = 0; j <= n; j += 1) S[0][j] = j;
    for (let i = 1; i <= m; i += 1) {
      for (let j = 1; j <= n; j += 1) {
        let meilleur = D[i - 1][j - 1] + (motif[i - 1] === texte[j - 1] ? 0 : 1);
        let debut = S[i - 1][j - 1];
        if (D[i - 1][j] + 1 < meilleur) {
          meilleur = D[i - 1][j] + 1;
          debut = S[i - 1][j];
        }
        if (D[i][j - 1] + 1 < meilleur) {
          meilleur = D[i][j - 1] + 1;
          debut = S[i][j - 1];
        }
        if (i > 1 && j > 1 && motif[i - 1] === texte[j - 2] && motif[i - 2] === texte[j - 1] && D[i - 2][j - 2] + 1 < meilleur) {
          meilleur = D[i - 2][j - 2] + 1;
          debut = S[i - 2][j - 2];
        }
        D[i][j] = meilleur;
        S[i][j] = debut;
      }
    }
    let fin = 0;
    for (let j = 1; j <= n; j += 1) if (D[m][j] < D[m][fin]) fin = j;
    return { fautes: D[m][fin], debut: S[m][fin], fin };
  }

  /**
   * Le score d'un numero pour une recherche, et la partie qui correspond
   * (positions dans le numero normalise) ; null s'il ne correspond pas.
   */
  function compare(recherche, numero) {
    const q = norme(recherche);
    const t = norme(numero);
    if (q.length < 3 || !t) return null;
    if (t === q) return { score: 100, type: "exact", debut: 0, fin: t.length };
    if (t.startsWith(q)) return { score: 90, type: "debut", debut: 0, fin: q.length };
    if (t.endsWith(q)) return { score: 80, type: "fin", debut: t.length - q.length, fin: t.length };
    const i = t.indexOf(q);
    if (i >= 0) return { score: 70, type: "contient", debut: i, fin: i + q.length };
    const qc = sansConfusion(q);
    const tc = sansConfusion(t);
    const k = tc.indexOf(qc);
    if (k >= 0) return { score: 60, type: "proche", debut: k, fin: k + q.length, fautes: 0 };
    const permis = fautesPermises(q.length);
    if (!permis || t.length < q.length - permis) return null;
    const a = approche(qc, tc);
    if (a.fautes > permis) return null;
    return { score: 60 - a.fautes * 10, type: "proche", debut: a.debut, fin: a.fin, fautes: a.fautes };
  }

  /**
   * Les colis qui correspondent, du meilleur au moins bon (puis du plus
   * recent) : [{ c, score, type, debut, fin }]. `numeroDe(c)` : son numero.
   */
  function classe(colis, recherche, { numeroDe = (c) => c.suivi?.numero, dateDe = (c) => c.recuLe || "" } = {}) {
    const resultats = [];
    for (const c of colis) {
      const r = compare(recherche, numeroDe(c));
      if (r) resultats.push({ c, ...r });
    }
    return resultats.sort((a, b) => b.score - a.score || String(dateDe(b.c)).localeCompare(String(dateDe(a.c))));
  }

  const api = { norme, compare, classe, approche };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else racine.rechercheNumeros = api;
})(typeof window !== "undefined" ? window : globalThis);
