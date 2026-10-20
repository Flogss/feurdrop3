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
    // +10 colis se voit monter ; l'argent prend plus de temps, sans jamais trainer
    #expect(CountingDuration.seconds(from: 25, to: 35) > 1.2)
    #expect(CountingDuration.seconds(from: 0, to: 900, argent: true) > CountingDuration.seconds(from: 0, to: 900))
    #expect(CountingDuration.seconds(from: 0, to: 1_000_000, argent: true) <= CountingDuration.maximum)
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

@Test func toutVerifierSeDecodeEtLeMacRendSesPages() throws {
    // GET /api/depots/campagne, tel que le serveur le rend
    let json = """
    {"campagne":{"id":2,"statut":"active","creeLe":"2026-10-11 16:54:21","finLe":null,"par":"site","force":true},
     "compteurs":{"total":6,"verifies":2,"restants":4,"confirmes":1,"nonConfirmes":1,"aVerifier":0,"bloques":0,"erreurs":0,"aConstater":0,"annules":0},
     "parTransporteur":[{"code":"MR","nom":"Mondial Relay","methode":"navigateur","total":4,"faits":2,"restants":2,"bloques":0,"erreurs":0,"aConstater":0,"message":null}],
     "attendMac":true,"agent":{"le":"2026-10-11T16:55:00.000Z","nom":"Mac · MacBook Air","actif":true}}
    """
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let etat = try decoder.decode(DepotCampagneEtat.self, from: Data(json.utf8))
    #expect(etat.active)
    #expect(etat.compteurs?.avancee == 2.0 / 6.0)
    #expect(etat.parTransporteur?.first?.methode == "navigateur")
    #expect(etat.agent?.actif == true)
    // un lot de travail, puis ce que le Mac renvoie (cles en camelCase, comme le serveur les lit)
    let lot = try decoder.decode(DepotTravail.self, from: Data(#"{"campagne":2,"pauseMs":2500,"items":[{"numero":"4278870015","transporteur":"MR","nom":"Mondial Relay","url":"https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=4278870015"}]}"#.utf8))
    #expect(lot.items.first?.numero == "4278870015")
    let page = DepotPageLue(numero: "4278870015", transporteur: "MR", url: lot.items[0].url, titre: "Suivi de colis - Mondial Relay", texte: "SUIVI DÉTAILLÉ DE MON COLIS", erreur: nil)
    let objet = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(page)) as? [String: Any])
    #expect(objet["numero"] as? String == "4278870015")
    #expect(objet["transporteur"] as? String == "MR")
    // un serveur sans « anomalie » (quatre statuts) se lit aussi
    let compteurs = try decoder.decode(DepotsCompteurs.self, from: Data(#"{"confirme":1,"non_confirme":0,"a_verifier":2,"bloque":0,"nonConfirmeHorsDelai":0,"aConstater":0,"attention":0,"total":3,"sansNumero":0}"#.utf8))
    #expect(compteurs.anomalie == nil)
    #expect(compteurs.nombre(.aVerifier) == 2)
    #expect(compteurs.nombre(.enAttente) == 0)
}

@Test func laListeActiveEtLHistorique() throws {
    // GET /api/depots apres la correction : la liste active, l'historique
    // (confirmes, retires), « en attente », et l'etat du Mac
    let json = """
    {"etat":{"enCours":false,"derniereSynchro":null,"dernierBilan":null,"derniereErreur":null,"file":{"enAttente":0},
      "methodes":{"laposte":{"nom":"API La Poste (officielle)","configure":true,"pause":null,"derniereReussite":null},
                  "ups":{"nom":"API UPS (officielle)","configure":false,"pause":null,"derniereReussite":null},
                  "dhl":{"nom":"API DHL (officielle)","configure":false,"pause":null,"derniereReussite":null},
                  "navigateur":{"nom":"Page officielle lue sur le Mac","configure":true,"pause":null,"derniereReussite":null}},
      "transporteurs":[],"affichageJours":30,"delaiScanHeures":48,
      "mac":{"actif":false,"nom":"Mac · MacBook Air","le":"2026-10-11T20:00:00.000Z","pagesDues":3}},
     "compteurs":{"confirme":1,"non_confirme":0,"a_verifier":0,"bloque":0,"en_attente":1,"anomalie":0,"nonConfirmeHorsDelai":0,"aConstater":0,"attention":0,
      "actifs":1,"retires":1,"total":3,"sansNumero":0,"horsControle":[]},
     "lignes":[{"colisId":9,"numero":"4278870071","expediteur":"Bob","transporteur":{"code":"MR","nom":"Mondial Relay","methode":"navigateur"},
      "statutInterne":{"status":"dropped","libelle":"Dropé","dropeLe":"2026-10-11 10:00:00","imprimeLe":null,"paye":false},
      "controle":{"categorie":"en_attente","libelle":"En attente de lecture","raison":"En attente de lecture : …","enRetard":false,"preuve":null,
        "dernierEvenement":null,"dernierStatut":null,"constat":null,"livre":false,"suite":null,"erreurTechnique":false},
      "attention":false,"aConstater":false,"verifieLe":null,"essaiLe":null,"prochaineLe":"2026-10-11 20:00:00","erreur":null,"lecture":null,
      "confirmeLe":null,"retire":null,"lien":null}],
     "historique":{"confirmes":[{"colisId":7,"numero":"6A12345678901","expediteur":"Alice","transporteur":{"code":"LP","nom":"La Poste","methode":"laposte"},
        "dropeLe":"2026-10-09 18:44:15","confirmeLe":"2026-10-10 01:04:00","preuve":{"le":"2026-10-09T20:30:00+02:00","statut":"Votre colis a été déposé","source":"laposte"},
        "suite":null,"livre":false,"retire":null,"lien":null}],
      "retires":[{"colisId":8,"numero":"6A11000000001","expediteur":"Chloé","transporteur":{"code":"LP","nom":"La Poste","methode":"laposte"},
        "dropeLe":"2026-10-07 10:00:00","confirmeLe":null,"preuve":null,"suite":null,"livre":false,
        "retire":{"le":"2026-10-11 08:00:00","motif":"inconnu de La Poste : 2 lectures sur 13 h, drop il y a 96 h"},"lien":null}]}}
    """
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let vue = try decoder.decode(DepotsVue.self, from: Data(json.utf8))
    #expect(vue.lignes.first?.controle.cat == .enAttente)
    #expect(vue.compteurs.nombre(.enAttente) == 1)
    #expect(vue.historique?.confirmes.first?.confirmeLe == "2026-10-10 01:04:00")
    #expect(vue.historique?.retires.first?.retire?.motif?.contains("inconnu") == true)
    #expect(vue.etat.mac?.pagesDues == 3)
    #expect(vue.etat.apisConfigurees.count == 1)
    // la somme : la liste active, les confirmes et les retires
    #expect(DepotCategorie.allCases.reduce(0) { $0 + vue.compteurs.nombre($1) } + (vue.compteurs.retires ?? 0) == vue.compteurs.total)
    #expect(try decoder.decode(DepotAgentSignal.self, from: Data(#"{"aLire":4,"campagne":null}"#.utf8)).aLire == 4)
}

@Test func impressionDesTransporteursChoisis() throws {
    let data = try JSONEncoder().encode(PrintRequest.carriers(["MR", "LP"]))
    let objet = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(objet["categories"] as? [String] == ["MR", "LP"])
    #expect(objet["scope"] as? String == "new")
    #expect(objet["categorie"] == nil)
}

// MARK: - Connexion : le jeton part, un 401 ramene a la connexion

/// Un faux serveur : retient la derniere requete, repond ce qu'on lui dit.
final class FauxServeur: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var derniere: URLRequest?
    nonisolated(unsafe) static var reponse: (Int, String) = (200, "{}")

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.derniere = request
        let (statut, corps) = Self.reponse
        let http = HTTPURLResponse(url: request.url!, statusCode: statut, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(corps.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Test func jetonEnvoyeEt401CommeNonConnecte() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [FauxServeur.self]
    let client = APIClient(baseURL: URL(string: "https://exemple.test")!, session: URLSession(configuration: config), jeton: .some("jeton-de-test"))
    let api = DropAPI(client: client)

    FauxServeur.reponse = (200, #"{"normal":3,"bj":1,"lowThreshold":10}"#)
    _ = try? await api.stock()
    #expect(FauxServeur.derniere?.value(forHTTPHeaderField: "Authorization") == "Bearer jeton-de-test")

    FauxServeur.reponse = (401, #"{"error":"Connexion requise"}"#)
    do {
        _ = try await api.stats()
        Issue.record("aurait du echouer")
    } catch let erreur as APIError {
        #expect(erreur.exigeConnexion)
        #expect(erreur.errorDescription == "Connexion requise")
    }

    // deconnecte : plus d'en-tete du tout
    client.definitJeton(nil)
    FauxServeur.reponse = (401, #"{"error":"Connexion requise"}"#)
    _ = try? await api.stock()
    #expect(FauxServeur.derniere?.value(forHTTPHeaderField: "Authorization") == nil)
}

@Test func refonteDuCheckerSeDecode() throws {
    // « Numéro incorrect », Redrop, historique enrichi, ligne des speciaux
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let compteurs = try decoder.decode(DepotsCompteurs.self, from: Data("""
    {"confirme":3,"non_confirme":2,"a_verifier":1,"bloque":0,"en_attente":0,"incorrect":4,"pasEncoreScanne":2,"redropsEnAttente":1,
     "nonConfirmeHorsDelai":1,"aConstater":0,"attention":5,"total":10,"sansNumero":0}
    """.utf8))
    #expect(compteurs.nombre(.incorrect) == 4)
    #expect(compteurs.redropsEnAttente == 1)
    #expect(DepotCategorie(rawValue: "incorrect") == .incorrect)
    #expect(DepotCategorie.compteurs.contains(.incorrect))
    #expect(DepotCategorie.nonConfirme.court == "Pas encore scanné")
    #expect(DepotCategorie.nonConfirme.rang < DepotCategorie.aVerifier.rang)

    let reponse = try decoder.decode(DepotRedropReponse.self, from: Data("""
    {"colisId":7,"numero":"4278870015","expediteur":"Alice","transporteur":{"code":"MR","nom":"Mondial Relay","methode":"navigateur"},
     "statutInterne":{"status":"dropped","libelle":"Dropé","dropeLe":"2026-10-09 18:44:15","imprimeLe":null,"paye":false},
     "controle":{"categorie":"non_confirme","libelle":"Pas encore scanné","raison":"Étiquette seule","enRetard":true,"livre":false},
     "attention":false,"evenements":[],"redrop":{"enAttente":42,"de":null},"deja":false,"nouveau":{"id":42,"status":"pending","price":0}}
    """.utf8))
    #expect(reponse.nouveau.id == 42)
    #expect(reponse.deja == false)
    #expect(reponse.detail.redrop?.enAttente == 42)

    let h = try decoder.decode(DepotHistorique.self, from: Data("""
    {"colisId":8,"numero":"6A1","expediteur":"Bob","transporteur":{"code":"LP","nom":"La Poste","methode":"laposte"},
     "retire":{"le":"2026-10-20 10:00:00","motif":"Numéro incorrect : inconnu","regle":"inconnu","incorrect":true},"categorie":"incorrect"}
    """.utf8))
    #expect(h.incorrect)

    let s = try decoder.decode(CarrierSummary.self, from: Data("""
    {"carrier":"SPECIAL","pending_count":3,"pending_value":18,"detail":[{"carrier":"LP","pending_count":1,"pending_value":6},{"carrier":"MR","pending_count":2,"pending_value":12}]}
    """.utf8))
    #expect(s.detail?.map(\.carrier) == ["LP", "MR"])
}
