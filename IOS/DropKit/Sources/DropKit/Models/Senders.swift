import Foundation

/// `GET /api/senders` : un expediteur et ses trois tarifs.
public struct Sender: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var id: Int
    public var name: String
    public var price: Double
    public var litPrice: Double
    public var bjPrice: Double
    public var createdAt: String?
}

/// Les trois tarifs, tels que `PUT /api/senders/:id` les attend.
public enum PriceField: String, Sendable, CaseIterable, Identifiable {
    case price, litPrice, bjPrice
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .price: "Normal"
        case .litPrice: "LIT"
        case .bjPrice: "BJ"
        }
    }

    public func value(in sender: Sender) -> Double {
        switch self {
        case .price: sender.price
        case .litPrice: sender.litPrice
        case .bjPrice: sender.bjPrice
        }
    }
}

/// `GET /api/debts` : ce qu'un expediteur nous doit.
public struct Debt: Codable, Sendable, Equatable, Identifiable {
    public var senderName: String
    public var owed: Double
    public var count: Int
    public var id: String { senderName }
}

/// `GET /api/senders/merge-candidates` : qui peut etre regroupe en "Autre".
public struct MergeCandidate: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var name: String
    public var ca: Double
    public var colisCount: Int
    public var pct: Double
    /// un expediteur au-dessus de 25 % du CA est protege
    public var mergeable: Bool
}

public struct MergeResult: Codable, Sendable, Equatable {
    public var moved: Int
    public var target: String
}

public struct PayResult: Codable, Sendable, Equatable {
    public var count: Int
}
