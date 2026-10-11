import Foundation

// La connexion de l'app au dashboard (voir Trousseau.swift).

/// `POST /api/auth/connexion` (mode app) : le jeton a garder dans le trousseau.
public struct SessionApp: Codable, Sendable, Equatable {
    public var jeton: String
    /// fin de la session (ISO) : 72 h apres la connexion
    public var expireLe: String
}

/// `GET /api/auth/session`
public struct InfoSession: Codable, Sendable, Equatable {
    public var type: String
    public var appareil: String?
    public var creeLe: String
    public var expireLe: String
    public var vuLe: String?
    /// les appareils connectes en ce moment (celui-ci compris)
    public var appareils: Int?
}
