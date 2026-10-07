import Foundation

/// Les deux lectures de la file d'impression : jamais sorti, ou deja sorti.
public enum PrintScope: String, Codable, Sendable {
    case new
    case printed
}

/// `GET /api/print/resume?scope=`
public struct PrintSummary: Codable, Sendable, Equatable {
    public var scope: PrintScope
    public var categories: [PrintCategory]
    public var total: Int
    public var noted: Int
    /// la liste du menu "transporteur" de l'edition d'un colis
    public var transporteurs: [CarrierOption]

    public init(scope: PrintScope, categories: [PrintCategory] = [], total: Int = 0, noted: Int = 0, transporteurs: [CarrierOption] = []) {
        self.scope = scope
        self.categories = categories
        self.total = total
        self.noted = noted
        self.transporteurs = transporteurs
    }
}

public struct PrintCategory: Codable, Sendable, Equatable, Identifiable, Hashable {
    /// MR, LP, BJ, LIT, SPECIAL, Inconnu...
    public var code: String
    public var label: String
    public var count: Int
    public var noted: Int
    /// les LIT sortent sur le rouleau 210 mm, pas sur la thermique
    public var roll: Bool
    public var id: String { code }
}

public struct CarrierOption: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var code: String
    public var label: String
    public var id: String { code }
}

/// `GET /api/print/colis?categorie=&scope=`
public struct PrintParcels: Codable, Sendable, Equatable {
    public var colis: [Parcel]
}

public struct Parcel: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var id: Int
    public var sender: String
    public var fileName: String?
    /// "pdf" ou "image"
    public var kind: String?
    public var note: String?
    public var price: Double
    /// transporteur reel (nil si non reconnu)
    public var carrier: String?
    public var type: String?
    /// numero de paire pour un special : le meme que sous son code-barre
    public var special: SpecialTag?

    public var displayName: String { fileName ?? "Colis #\(id)" }
}

public struct SpecialTag: Codable, Sendable, Equatable, Hashable {
    public var numero: Int
    public var code: Bool
}

/// Ce qu'on peut corriger a la main sur un colis (`PATCH /api/print/colis/:id`).
/// On n'envoie que ce qui a change : renvoyer le prix tel quel le figerait
/// contre les futurs changements de tarif de l'expediteur.
public struct ParcelPatch: Encodable, Sendable, Equatable {
    public var price: Double?
    /// double optionnel : `.some(nil)` remet le transporteur a "non reconnu"
    public var carrier: String??
    public var note: String?

    public init(price: Double? = nil, carrier: String?? = nil, note: String? = nil) {
        self.price = price
        self.carrier = carrier
        self.note = note
    }

    public var isEmpty: Bool { price == nil && carrier == nil && note == nil }

    enum CodingKeys: String, CodingKey { case price, carrier, note }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(price, forKey: .price)
        if let carrier {
            if let code = carrier { try c.encode(code, forKey: .carrier) } else { try c.encodeNil(forKey: .carrier) }
        }
        try c.encodeIfPresent(note, forKey: .note)
    }
}

public struct ParcelPatchResult: Codable, Sendable, Equatable {
    public var price: Double?
    public var carrier: String?
    public var note: String?
    /// ce que le bot a appris d'une correction de transporteur
    public var appris: String?
}

/// `POST /api/print/build` : soit une categorie entiere, soit des colis precis.
public struct PrintRequest: Encodable, Sendable {
    public var categorie: String?
    public var ids: [Int]?
    public var scope: PrintScope

    public static func category(_ code: String, scope: PrintScope) -> PrintRequest {
        PrintRequest(categorie: code, ids: nil, scope: scope)
    }

    /// "Tout imprimer" : toute la thermique 4x6 (les LIT a part)
    public static let allNew = PrintRequest(categorie: "*", ids: nil, scope: .new)

    public static func parcels(_ ids: [Int], scope: PrintScope) -> PrintRequest {
        PrintRequest(categorie: nil, ids: ids, scope: scope)
    }
}

public struct PrintJob: Codable, Sendable, Equatable {
    public var jobId: String
    /// chemin du PDF construit, a telecharger dans les 15 minutes
    public var url: String
    public var count: Int
    public var pages: Int?
    public var roll: Bool
    public var lengthMm: Double?
    public var missing: Int?
    public var failed: Int?
    /// les colis du PDF : renvoyes pour confirmer l'impression
    public var ids: [Int]?
    /// ce qui n'a pas pu entrer dans le PDF (reste "a imprimer")
    public var absents: [EtiquetteAbsente]?
}

public struct EtiquetteAbsente: Codable, Sendable, Equatable {
    public var label: String?
    public var reason: String?
}
