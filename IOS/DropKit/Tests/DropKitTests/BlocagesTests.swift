import Foundation
import Testing
@testable import DropKit

// Aucun chargement sans fin : une requete se termine toujours (reponse,
// erreur ou delai depasse), et une lecture passagerement en echec est
// retentee un nombre FIXE de fois avant de rendre la main a l'ecran.

/// Un serveur qui repond au compte-gouttes, sans jamais finir : un octet
/// toutes les 100 ms. Le delai de URLRequest (silence entre deux paquets) ne
/// se declenche jamais -- seule la limite dure de l'APIClient peut l'arreter.
final class ServeurGoutte: URLProtocol, @unchecked Sendable {
    private var minuteur: DispatchSourceTimer?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reponse = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: reponse, cacheStoragePolicy: .notAllowed)
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now() + 0.1, repeating: 0.1)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            self.client?.urlProtocol(self, didLoad: Data(" ".utf8))
        }
        t.resume()
        minuteur = t
    }
    override func stopLoading() {
        minuteur?.cancel()
        minuteur = nil
    }
}

@Test func uneRequeteSansReponseSeTermineEnErreur() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ServeurGoutte.self]
    // (le delai de la session ne joue pas ici : seule la limite dure de l'APIClient)
    config.timeoutIntervalForRequest = 600
    config.timeoutIntervalForResource = 600
    let client = APIClient(baseURL: URL(string: "https://exemple.test")!, session: URLSession(configuration: config), jeton: .some(nil))
    let debut = ContinuousClock.now
    await #expect(throws: APIError.timeout) {
        // limite : 2 s + 5 s ; une seule tentative pour une ecriture non identifiee
        _ = try await client.raw(.post, "/api/print/colis/1/drop", timeout: 2)
    }
    let duree = ContinuousClock.now - debut
    // arrete par la limite dure (2 s + 5 s), pas avant, et pas sans fin
    #expect(duree >= .seconds(6.5), "arrete trop tot (\(duree)) : ce n'est pas la limite dure")
    #expect(duree < .seconds(12), "termine en \(duree)")
}

@Test func lesReessaisSontBornesEtSArretentSurUneErreurDefinitive() async throws {
    let compteur = Compteur()
    // passagere a chaque fois : 1 essai + 2 reessais, puis l'erreur remonte
    await #expect(throws: APIError.timeout) {
        try await avecReessais(delais: [.milliseconds(10), .milliseconds(10)]) {
            await compteur.ajoute()
            throw APIError.timeout
        }
    }
    #expect(await compteur.valeur == 3)

    // definitive (introuvable) : aucun reessai
    let definitif = Compteur()
    await #expect(throws: APIError.server(status: 404, message: "code introuvable")) {
        try await avecReessais(delais: [.milliseconds(10), .milliseconds(10)]) {
            await definitif.ajoute()
            throw APIError.server(status: 404, message: "code introuvable")
        }
    }
    #expect(await definitif.valeur == 1)

    // reussite au deuxieme essai
    let deuxieme = Compteur()
    let resultat = try await avecReessais(delais: [.milliseconds(10)]) { () async throws -> Int in
        await deuxieme.ajoute()
        if await deuxieme.valeur < 2 { throw APIError.server(status: 502, message: "Telegram") }
        return 42
    }
    #expect(resultat == 42)
    #expect(estPassagere(APIError.offline))
    #expect(!estPassagere(APIError.nonConnecte("Connexion requise")))
    #expect(!estPassagere(CancellationError()))
}

private actor Compteur {
    private(set) var valeur = 0
    func ajoute() { valeur += 1 }
}
