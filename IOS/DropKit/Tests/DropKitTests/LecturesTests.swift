import Foundation
import Testing
@testable import DropKit

// B03 : une lecture partie avant une ecriture ne doit pas ecraser ce que
// l'ecriture vient de changer. Le client dit si une lecture a croise une
// ecriture qui touche le dashboard -- et seulement celles-la.

/// Un serveur qui repond `{}` apres un delai lu dans l'adresse (?ms=300).
final class ServeurLent: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let ms = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "ms" }?.value.flatMap(Int.init) ?? 0
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in
            guard let self, let client = self.client else { return }
            let reponse = HTTPURLResponse(url: self.request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client.urlProtocol(self, didReceive: reponse, cacheStoragePolicy: .notAllowed)
            client.urlProtocol(self, didLoad: Data("{}".utf8))
            client.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

private func clientLent() -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ServeurLent.self]
    return APIClient(baseURL: URL(string: "https://exemple.test")!, session: URLSession(configuration: config), jeton: .some(nil))
}

@Test func uneLectureQuiCroiseUneEcritureEstPerimee() async throws {
    let client = clientLent()
    let instant = client.instantLecture
    // le rafraichissement part (lent), le stock change pendant ce temps
    async let lecture = client.raw(.get, "/api/stats", query: [URLQueryItem(name: "ms", value: "400")])
    try await Task.sleep(for: .milliseconds(50))
    _ = try await client.raw(.post, "/api/stock/adjust", query: [URLQueryItem(name: "ms", value: "50")], operation: true)
    _ = try await lecture
    #expect(!client.lectureFraiche(instant), "la lecture a croise l'ecriture : elle ne doit pas s'afficher")
    // la relecture qui suit fait foi
    let apres = client.instantLecture
    _ = try await client.raw(.get, "/api/stats")
    #expect(client.lectureFraiche(apres))
}

@Test func lesEcrituresDeFondNeGelentPasLeDashboard() async throws {
    let client = clientLent()
    let instant = client.instantLecture
    // la lecture des pages de suivi sur le Mac ecrit sans arret : ca ne doit
    // pas rendre toutes les lectures du dashboard « perimees »
    _ = try await client.raw(.post, "/api/depots/campagne/resultats")
    _ = try await client.raw(.post, "/api/push/seen")
    #expect(client.lectureFraiche(instant))
}
