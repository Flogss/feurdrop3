const { fetchJson, withParams } = require("../http");

// Boites aux lettres de rue, depuis l'open data de La Poste. Gratuit, sans
// cle, et c'est le referentiel de l'operateur : chaque boite y figure avec sa
// position et son HEURE DE LEVEE, en semaine et le samedi.
//
// Une boite n'a pas d'horaire d'ouverture : elle est toujours accessible. Ce
// qui compte, c'est la levee. Poster a 18h dans une boite levee a 9h n'est pas
// un echec, c'est juste une lettre qui part le lendemain -- d'ou le drapeau
// `soft` : le calcul essaie d'arriver avant la levee, mais ne renonce jamais a
// une boite pour autant.

const BASE = "https://data.laposte.fr/data-fair/api/v1/datasets";
const DATASET = "laposte-boiterue";

const FIELDS = [
  "co_mup",
  "va_no_voie",
  "lb_extension",
  "lb_voie_ext",
  "lb_com",
  "co_postal",
  "va_coord_adr_x",
  "va_coord_adr_y",
  "hdl_semaine_extra",
  "hdl_samedi_extra",
].join(",");

// "T09:00:00+00:00" -> "09:00". Le format est une heure locale de levee, pas
// un instant : le fuseau affiche est decoratif et on ne le convertit pas.
function levee(value) {
  const match = /T?(\d{2}):(\d{2})/.exec(String(value || ""));
  return match ? `${match[1]}:${match[2]}` : null;
}

// samedi = 6 ; le dimanche il n'y a pas de levee publiee
function leveeFor(row, day) {
  const weekday = new Date(`${day}T12:00:00`).getDay();
  if (weekday === 0) return null;
  return levee(weekday === 6 ? row.hdl_samedi_extra : row.hdl_semaine_extra);
}

async function searchPoints({ lat, lng, radius = 1500, limit = 25, day }) {
  const data = await fetchJson(
    withParams(`${BASE}/${DATASET}/lines`, {
      size: limit,
      geo_distance: `${lng},${lat},${radius}`,
      select: FIELDS,
    })
  );

  return (data.results || [])
    .filter((row) => row.va_coord_adr_x && row.va_coord_adr_y)
    .map((row) => {
      const street = [row.va_no_voie, row.lb_extension, row.lb_voie_ext].filter(Boolean).join(" ");
      const heure = leveeFor(row, day);
      return {
        source: "boitejaune",
        source_ref: row.co_mup,
        name: `Boite jaune — ${street}`,
        kind: "Boite aux lettres",
        address: street,
        postal_code: row.co_postal,
        city: row.lb_com,
        lat: row.va_coord_adr_y,
        lng: row.va_coord_adr_x,
        carriers: ["BJ"],
        distance: row._geo_distance,
        // toujours accessible ; la levee est une echeance souple
        hours: heure
          ? { source: "laposte", ranges: ["00:00-23:59"], cutoffColis: heure, soft: true }
          : null,
      };
    });
}

module.exports = { searchPoints };
