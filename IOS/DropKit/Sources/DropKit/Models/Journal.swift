import Foundation

/// `GET /api/journal` : l'historique de ce qui arrive aux colis (recus,
/// dropes, imprimes, retires, modifies...), du plus recent au plus ancien.
public struct EntreeJournal: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    /// heure du serveur (UTC), "2026-10-05 14:32:10"
    public var at: String
    /// recu, ajout, drop, impression, retrait, modif, note, stock, tournee,
    /// paiement, expediteur, reglage, fusion
    public var kind: String
    public var texte: String
    public var detail: String?
    public var valeur: Double?
    public var nombre: Int?
    /// telegram, site, app, imprimante
    public var source: String?
}

public struct PageJournal: Codable, Sendable, Equatable {
    public var entrees: [EntreeJournal]
    /// il y a des entrees plus anciennes
    public var suite: Bool
}

public enum FiltreJournal: String, CaseIterable, Sendable, Identifiable {
    case tout = "", recu, drop, impression, autres

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .tout: "Tout"
        case .recu: "Reçus"
        case .drop: "Drops"
        case .impression: "Impressions"
        case .autres: "Autres"
        }
    }
}
