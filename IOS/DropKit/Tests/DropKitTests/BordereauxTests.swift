import Foundation
import Testing
@testable import DropKit

// Les reponses de /api/bordereaux, telles que le serveur les envoie
// (capturees sur le vrai serveur de test, etiquette de test inventee).

private func lit<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return try d.decode(T.self, from: Data(json.utf8))
}

private let detailJSON = #"""
{"colis":{"id":1,"expediteur":"Alice","transporteur":{"code":"LP","nom":"La Poste"},"type":"normal","fichier":"6A99887766554.pdf","genre":"pdf","recuLe":"2026-11-17 17:11:45","imprimeLe":null,"deposeLe":null,"etape":"a_imprimer","redrop":false,"suivi":{"numero":"6A99887766554","transporteur":"LP","nom":"La Poste","lien":"https://www.laposte.fr/outils/suivre-vos-envois?code=6A99887766554","page":"https://www.laposte.fr/outils/suivre-vos-envois"}},"note":null,"annotation":null,"analyse":{"etat":"analyse","erreur":null,"empreinte":"9e0a5884700407c3862de595b1791330788c0b1af2b6efb66c90240b906f6f3b","type":"pdf","octets":11586,"nombrePages":1,"partiel":false,"analyseLe":"2026-11-17T17:11:45.275Z","dureeMs":143,"lisibles":2,"illisibles":0,"pages":[{"page":1,"largeur":1600,"hauteur":2400,"codes":[{"id":1,"page":1,"format":"Code128","nomFormat":"Code 128","famille":"1D","lisible":true,"valeur":"6A99887766554","erreur":null,"zone":{"x0":0.06938,"y0":0.14333,"x1":0.8675,"y1":0.30542},"polygone":[[0.06938,0.14333],[0.8675,0.14333],[0.8675,0.30542],[0.06938,0.30542]],"orientation":0,"role":"suivi","suivi":{"numero":"6A99887766554","transporteur":"LP","nom":"La Poste","lien":"https://www.laposte.fr/outils/suivre-vos-envois?code=6A99887766554","page":"https://www.laposte.fr/outils/suivre-vos-envois"}},{"id":2,"page":1,"format":"QRCode","nomFormat":"QR Code","famille":"2D","lisible":true,"valeur":"https://suivi.exemple.test/colis?id=QX41","erreur":null,"zone":{"x0":0.08313,"y0":0.4675,"x1":0.46563,"y1":0.7225},"polygone":[[0.08313,0.4675],[0.465,0.4675],[0.46563,0.7225],[0.08313,0.72208]],"orientation":0,"role":"lien","lien":"https://suivi.exemple.test/colis?id=QX41","contientSuivi":false}]}]}}
"""#

private let listeJSON = #"""
{"bordereaux":[{"id":1,"expediteur":"Alice","transporteur":{"code":"LP","nom":"La Poste"},"type":"normal","fichier":"6A99887766554.pdf","genre":"pdf","recuLe":"2026-11-17 17:11:45","imprimeLe":null,"deposeLe":null,"etape":"a_imprimer","redrop":false,"suivi":{"numero":"6A99887766554","transporteur":"LP","nom":"La Poste","lien":"https://www.laposte.fr/outils/suivre-vos-envois?code=6A99887766554","page":"https://www.laposte.fr/outils/suivre-vos-envois"},"index":{"etat":"analyse","pages":1,"lisibles":2,"illisibles":0}}],"suite":null}
"""#

private let rechercheJSON = #"""
{"requete":"6A9988","total":1,"resultats":[{"id":1,"expediteur":"Alice","transporteur":{"code":"LP","nom":"La Poste"},"type":"normal","fichier":"6A99887766554.pdf","genre":"pdf","recuLe":"2026-11-17 17:11:45","imprimeLe":null,"deposeLe":null,"etape":"a_imprimer","redrop":false,"suivi":{"numero":"6A99887766554","transporteur":"LP","nom":"La Poste","lien":"https://www.laposte.fr/outils/suivre-vos-envois?code=6A99887766554","page":"https://www.laposte.fr/outils/suivre-vos-envois"},"index":{"etat":"analyse","pages":1,"lisibles":2,"illisibles":0},"score":90,"correspondances":[{"source":"code","codeId":1,"page":1,"format":"Code128","nomFormat":"Code 128","famille":"1D","valeur":"6A99887766554","norme":"6A99887766554","score":90,"type":"debut","debut":0,"fin":6}]}]}
"""#

private let etatJSON = #"""
{"etiquettes":1,"analysees":1,"echecs":0,"codes":2,"indexation":{"active":false,"restants":0,"jours":45}}
"""#

@Test func bordereauDetailSeLit() throws {
    let d = try lit(BordereauDetail.self, detailJSON)
    #expect(d.colis.expediteur == "Alice")
    #expect(d.colis.suivi?.numero == "6A99887766554")
    #expect(d.colis.suivi?.url?.absoluteString == "https://www.laposte.fr/outils/suivre-vos-envois?code=6A99887766554")
    #expect(d.analyse.etat == "analyse")
    #expect(d.analyse.nombrePages == 1)
    let codes = d.analyse.codes
    #expect(codes.count == 2)
    let barre = try #require(codes.first { $0.format == "Code128" })
    #expect(barre.role == "suivi")
    #expect(barre.famille == "1D")
    #expect(barre.zone.x0 < barre.zone.x1 && barre.zone.y0 < barre.zone.y1)
    let qr = try #require(codes.first { $0.format == "QRCode" })
    #expect(qr.role == "lien")
    #expect(qr.lien == "https://suivi.exemple.test/colis?id=QX41")
}

@Test func bordereauxListeRechercheEtatSeLisent() throws {
    let l = try lit(BordereauxListe.self, listeJSON)
    #expect(l.bordereaux.first?.index?.etat == "analyse")
    #expect(l.bordereaux.first?.index?.lisibles == 2)
    let r = try lit(BordereauxRecherche.self, rechercheJSON)
    let m = try #require(r.resultats.first?.correspondances.first)
    #expect(m.source == "code")
    #expect(m.type == "debut")
    #expect(m.page == 1)
    #expect(m.debut == 0 && m.fin == 6)
    let e = try lit(BordereauxEtat.self, etatJSON)
    #expect(e.codes == 2 && e.indexation.jours == 45)
}
