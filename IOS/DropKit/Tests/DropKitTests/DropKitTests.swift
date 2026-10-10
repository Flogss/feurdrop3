import Foundation
import Testing
@testable import DropKit

// Formats, comptage, memoire "+N", encodage : sans reseau.

@Test func euroALaFrancaise() {
    // l'espace des milliers et celle avant € sont insecables (U+202F / U+00A0)
    let normalise = { (s: String) in s.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ") }
    #expect(normalise(Format.euro(1893.5)) == "1 893,50 €")
    #expect(normalise(Format.euroCompact(1893.5)) == "1 894 €")
    #expect(normalise(Format.euroCompact(37.5)) == "37,50 €")
    #expect(normalise(Format.euroGraphe(41)) == "41 €")
    #expect(normalise(Format.euroGraphe(25.5)) == "25,50 €")
    #expect(Format.count(1, "colis", "colis") == "1 colis")
    #expect(Format.count(3, "colis dropé", "colis dropés") == "3 colis dropés")
    #expect(Format.multiple(3.62) == "3,6×")
    #expect(Format.chrono(75) == "01:15")
    #expect(Format.chrono(3725) == "1:02:05")
    #expect(Format.duration(2820) == "47 min")
}

@Test func dureeProportionnelleALEcart() {
    let petit = CountingDuration.seconds(from: 25, to: 30)
    let moyen = CountingDuration.seconds(from: 1200, to: 1300)
    let grand = CountingDuration.seconds(from: 1200, to: 2893)
    #expect(petit < moyen && moyen < grand)
    #expect(grand <= CountingDuration.maximum)
    #expect(CountingDuration.seconds(from: 5, to: 5) == 0)
}

@Test func bulleSeulementSiNouveau() {
    // premiere visite : pas de memoire, pas de "+35"
    #expect(LastSeenStore.start(remembered: nil, current: 35, bootFlourish: true) == CounterStart(from: 0, announces: false))
    // rien de nouveau : grande entree depuis zero, sans bulle
    #expect(LastSeenStore.start(remembered: 35, current: 35, bootFlourish: true) == CounterStart(from: 0, announces: false))
    // simple rafraichissement de la meme session : rien ne bouge
    #expect(LastSeenStore.start(remembered: 35, current: 35, bootFlourish: false) == CounterStart(from: nil, announces: false))
    // +10 depuis la derniere visite : 25 -> 35, avec la bulle
    #expect(LastSeenStore.start(remembered: 25, current: 35, bootFlourish: true) == CounterStart(from: 25, announces: true))
    // des colis ont ete dropes : ca descend, sans bulle
    #expect(LastSeenStore.start(remembered: 40, current: 35, bootFlourish: true) == CounterStart(from: 40, announces: false))
}

@Test func memoireParAppareil() throws {
    let defaults = try #require(UserDefaults(suiteName: "drop.tests.\(UUID().uuidString)"))
    let store = LastSeenStore(defaults: defaults)
    #expect(store.load() == nil)
    let snap = LastSeenSnapshot(pending: 25, earned: 1866.5, today: 25, day: "2026-10-03", at: Date(timeIntervalSince1970: 0))
    store.save(snap)
    #expect(store.load() == snap)
}

@Test func correctionNEnvoieQueCeQuiChange() throws {
    let encode = { (p: ParcelPatch) in String(data: try JSONEncoder().encode(p), encoding: .utf8)! }
    #expect(try encode(ParcelPatch(price: 8.5)) == #"{"price":8.5}"#)
    // remettre le transporteur a "non reconnu" envoie un null explicite
    #expect(try encode(ParcelPatch(carrier: .some(nil))) == #"{"carrier":null}"#)
    #expect(try encode(ParcelPatch(carrier: "MR", note: "fragile")).contains(#""carrier":"MR""#))
    #expect(ParcelPatch().isEmpty)
}

@Test func datesDuServeur() {
    #expect(ServerDate.parse("2026-09-09 14:32:10") != nil)
    #expect(ServerDate.parse("2026-09-25T22:09:17+02:00") != nil)
    #expect(ServerDate.parse("2026-09-18T06:20:23.854Z") != nil)
    #expect(ServerDate.weekdayShort("2026-10-02") == "Ven")
    #expect(ServerDate.longDay("2026-09-02") == "Mercredi 2 septembre")
    let tour = TourSummary(startedAt: "2026-10-03 00:12:00", endedAt: "2026-10-03 00:59:00", seconds: nil, count: 6, value: 26.5)
    #expect(tour.durationSeconds == 47 * 60)
}

@Test func etatDesPairesDuLocker() throws {
    let json = #"{"paires":[{"id":1,"numero":1,"sender":"@kevin","code":true,"seul":false,"colis":{"id":9,"fileName":"a.pdf","note":null,"printed":true}},{"id":2,"numero":2,"sender":"@nina","code":true,"seul":true,"colis":null},{"id":3,"numero":3,"sender":null,"code":false,"seul":false,"colis":{"id":10,"fileName":null,"note":"x","printed":false}}]}"#
    let paires = try JSONDecoder().decode(LockerPairs.self, from: Data(json.utf8)).paires
    #expect(paires.map(\.state) == [.printed, .alone, .missingCode])
    #expect(paires.map(\.isIncomplete) == [false, false, true])
    #expect(paires[1].canComplete)
}

@Test func etapeInconnueNeCassePasLeDecodage() throws {
    let json = #"{"total":1,"rows":[{"tracking_number":"8R1","milestone":"nouvelle_etape","last_label":null,"last_event_at":null}]}"#
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    let rows = try d.decode(TrackingRows.self, from: Data(json.utf8))
    #expect(rows.rows.first?.milestone == .unknown)
}

// MARK: - Controle des depots et impression choisie

@Test func controleDesDepotsSeDecode() throws {
    // la forme exacte de GET /api/depots (cles en camelCase et en snake_case)
    let json = """
    {"etat":{"enCours":false,"derniereSynchro":"2026-10-10T01:05:00.000Z",
      "dernierBilan":{"declencheur":"auto","verifies":12,"nouveauxEvenements":30,"erreurs":1,"reportes":0,"pauses":[]},
      "derniereErreur":null,"file":{"enAttente":3},
      "methodes":{"laposte":{"nom":"API La Poste (officielle)","configure":true,"pause":null,"derniereReussite":"2026-10-10 01:05:00"}},
      "transporteurs":[{"code":"LP","nom":"La Poste","methode":"laposte","colis":2},{"code":"UPS","nom":"UPS","methode":"manuel","colis":1}],
      "affichageJours":30,"delaiScanHeures":48},
     "compteurs":{"confirme":1,"non_confirme":1,"a_verifier":0,"bloque":1,"anomalie":0,"nonConfirmeHorsDelai":0,"aConstater":1,"attention":1,"total":3,"sansNumero":2,
      "horsControle":[{"code":"MR","nom":"Mondial Relay","colis":450}]},
     "lignes":[{"colisId":7,"numero":"6A12345678901","expediteur":"Alice","transporteur":{"code":"LP","nom":"La Poste","methode":"laposte"},
      "statutInterne":{"status":"dropped","libelle":"Dropé","dropeLe":"2026-10-09 18:44:15","imprimeLe":null,"paye":false},
      "controle":{"categorie":"confirme","libelle":"Dépôt confirmé","raison":"Pris en charge le 09/10 20:30","enRetard":false,
        "preuve":{"le":"2026-10-09T20:30:00+02:00","ms":1791570600000,"statut":"Votre colis a été déposé","lieu":null,"etape":"in_transit","code":"PC1","source":"laposte"},
        "dernierEvenement":null,"dernierStatut":{"etape":"in_transit","libelle":"Pris en charge / en transit"},"constat":null,"livre":false},
      "attention":false,"aConstater":false,"verifieLe":"2026-10-10 01:04:00","essaiLe":"2026-10-10 01:04:00","prochaineLe":null,"erreur":null,
      "lien":"https://www.laposte.fr/outils/suivre-vos-envois?code=6A12345678901"}]}
    """
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let vue = try decoder.decode(DepotsVue.self, from: Data(json.utf8))
    #expect(vue.compteurs.nonConfirme == 1)
    #expect(vue.compteurs.nombre(.bloque) == 1)
    #expect(vue.compteurs.horsControle?.first?.colis == 450)
    #expect(vue.etat.laPoste?.configure == true)
    #expect(vue.lignes.first?.controle.cat == .confirme)
    #expect(vue.lignes.first?.controle.preuve?.code == "PC1")
    #expect(vue.etat.transporteurs.last?.automatique == false)
}

@Test func impressionDesTransporteursChoisis() throws {
    let data = try JSONEncoder().encode(PrintRequest.carriers(["MR", "LP"]))
    let objet = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(objet["categories"] as? [String] == ["MR", "LP"])
    #expect(objet["scope"] as? String == "new")
    #expect(objet["categorie"] == nil)
}
