import Foundation

/// Ce qui peut mal tourner en parlant au serveur, dit pour l'ecran.
public enum APIError: LocalizedError, Sendable, Equatable {
    /// le serveur est injoignable (pas de reseau, serveur arrete)
    case offline
    /// le serveur met trop de temps a repondre
    case timeout
    /// le serveur a refuse : son message tel quel ("Cet expediteur existe deja")
    case server(status: Int, message: String)
    /// la reponse n'a pas la forme attendue
    case decoding(String)
    case invalidURL

    public var errorDescription: String? {
        switch self {
        case .offline: "Connexion impossible"
        case .timeout: "Le serveur met trop de temps à répondre"
        case let .server(_, message): message
        case let .decoding(detail): "Réponse inattendue du serveur (\(detail))"
        case .invalidURL: "Adresse du serveur invalide"
        }
    }

    /// une coupure reseau, par opposition a une requete refusee
    public var isNetwork: Bool { self == .offline || self == .timeout }
}

/// Le client HTTP. Une seule instance, partagee : toute la conversation avec le
/// serveur passe par ici, jamais par des URLSession eparpillees dans les vues.
///
/// Une lecture qui echoue sur le reseau est retentee une fois ; une ecriture
/// jamais (un drop rejoue deux fois serait un drop de trop).
public final class APIClient: Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        let decoder = JSONDecoder()
        // le serveur melange camelCase et snake_case ("sender_name") :
        // la conversion laisse le camelCase intact
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = decoder
        self.encoder = JSONEncoder()
    }

    public enum Method: String, Sendable { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

    /// Appel JSON -> JSON.
    public func send<Response: Decodable & Sendable>(
        _ method: Method,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil,
        timeout: TimeInterval = 15,
        operation: Bool = false,
        as: Response.Type = Response.self
    ) async throws -> Response {
        let data = try await raw(method, path, query: query, body: body, timeout: timeout, operation: operation)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch let DecodingError.keyNotFound(cle, contexte) {
            throw APIError.decoding("\(cle.stringValue) manquant dans \(contexte.codingPath.map(\.stringValue).joined(separator: "."))")
        } catch let DecodingError.typeMismatch(_, contexte) {
            throw APIError.decoding("type inattendu pour \(contexte.codingPath.map(\.stringValue).joined(separator: "."))")
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// Appel qui rend les octets bruts (PDF, image d'un code-barre).
    /// `operation` : une ecriture qui compte (ajout de colis, stock) -- elle
    /// porte une cle unique (Idempotency-Key) et peut donc etre renvoyee apres
    /// une coupure sans risque d'etre comptee deux fois.
    public func raw(
        _ method: Method,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil,
        timeout: TimeInterval = 15,
        operation: Bool = false
    ) async throws -> Data {
        // le chemin arrive deja encode (voir `segment`) : on le colle tel quel
        let base = baseURL.absoluteString.hasSuffix("/") ? String(baseURL.absoluteString.dropLast()) : baseURL.absoluteString
        guard var composants = URLComponents(string: base + path) else { throw APIError.invalidURL }
        if !query.isEmpty { composants.queryItems = query }
        guard let url = composants.url else { throw APIError.invalidURL }

        var requete = URLRequest(url: url, timeoutInterval: timeout)
        requete.httpMethod = method.rawValue
        requete.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            requete.setValue("application/json", forHTTPHeaderField: "Content-Type")
            requete.httpBody = try encoder.encode(body)
        } else if method != .get {
            // le serveur attend du JSON sur toutes les ecritures
            requete.setValue("application/json", forHTTPHeaderField: "Content-Type")
            requete.httpBody = Data("{}".utf8)
        }

        if operation { requete.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key") }

        // une lecture, ou une operation identifiee, se renvoie sans risque
        let essais = method == .get ? 2 : (operation ? 3 : 1)
        var derniere: APIError = .offline
        for essai in 1...essais {
            do {
                let (data, reponse) = try await session.data(for: requete)
                guard let http = reponse as? HTTPURLResponse else { throw APIError.offline }
                guard (200..<300).contains(http.statusCode) else {
                    throw APIError.server(status: http.statusCode, message: Self.message(from: data, status: http.statusCode))
                }
                return data
            } catch let erreur as APIError {
                throw erreur
            } catch let erreur as URLError {
                derniere = erreur.code == .timedOut ? .timeout : .offline
                if essai < essais, erreur.code != .cancelled {
                    try await Task.sleep(for: .milliseconds(700 * essai))
                    continue
                }
                if erreur.code == .cancelled { throw CancellationError() }
            }
        }
        throw derniere
    }

    private static func message(from data: Data, status: Int) -> String {
        struct Corps: Decodable { let error: String? }
        if let corps = try? JSONDecoder().decode(Corps.self, from: data), let texte = corps.error, !texte.isEmpty {
            return texte
        }
        return HTTPURLResponse.localizedString(forStatusCode: status).capitalized
    }
}

/// Un morceau de chemin sur : "Lucas M." -> "Lucas%20M.", "a/b" -> "a%2Fb".
public func segment(_ texte: String) -> String {
    var permis = CharacterSet.urlPathAllowed
    permis.remove(charactersIn: "/?#")
    return texte.addingPercentEncoding(withAllowedCharacters: permis) ?? texte
}
