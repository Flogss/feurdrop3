import Foundation

/// Une lecture qui peut echouer passagerement (reseau, serveur, Telegram
/// derriere lui) : essayee encore apres chaque delai, puis l'erreur remonte --
/// a l'ecran de la dire et de proposer « Réessayer ». Jamais une attente sans
/// fin : le nombre d'essais est fixe, chaque essai a sa limite (APIClient).
///
/// Une erreur definitive (introuvable, refuse, session expiree) n'est pas
/// retentee.
public func avecReessais<T: Sendable>(
    delais: [Duration] = [.seconds(1.5), .seconds(4)],
    _ operation: @Sendable () async throws -> T
) async throws -> T {
    var restants = delais[...]
    while true {
        do {
            return try await operation()
        } catch {
            guard let delai = restants.popFirst(), estPassagere(error) else { throw error }
            try await Task.sleep(for: delai)
        }
    }
}

/// reseau, delai, ou erreur du serveur (5xx) : un nouvel essai a du sens
public func estPassagere(_ erreur: any Error) -> Bool {
    if erreur is CancellationError { return false }
    guard let api = erreur as? APIError else { return true }
    switch api {
    case .offline, .timeout: return true
    case let .server(status, _): return status >= 500 || status == 429 || status == 409
    case .nonConnecte, .decoding, .invalidURL: return false
    }
}
