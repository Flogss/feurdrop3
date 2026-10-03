import Foundation

/// Etapes de suivi telles que le bot de suivi les classe.
public enum Milestone: String, Codable, Sendable, CaseIterable {
    case delivered
    case outForDelivery = "out_for_delivery"
    case inTransit = "in_transit"
    case infoReceived = "info_received"
    case pending
    case finalOther = "final_other"
    case expired
    case notFound = "not_found"
    case unknown

    public init(from decoder: any Decoder) throws {
        let brut = try decoder.singleValueContainer().decode(String.self)
        self = Milestone(rawValue: brut) ?? .unknown
    }

    public var label: String {
        switch self {
        case .delivered: "Livré"
        case .outForDelivery: "En cours de livraison"
        case .inTransit: "En transit"
        case .infoReceived: "Pris en charge"
        case .pending: "En attente"
        case .finalOther: "Clôturé"
        case .expired: "Expiré"
        case .notFound: "Introuvable"
        case .unknown: "Inconnu"
        }
    }

    /// un colis livre ou cloture ne bougera plus : seules ces etapes meritent
    /// d'etre reinterrogees
    public var isRecheckable: Bool {
        [.pending, .infoReceived, .inTransit, .outForDelivery].contains(self)
    }
}

/// `GET /api/suivi/overview`
public struct TrackingOverview: Codable, Sendable, Equatable {
    public var ready: Bool
    public var reason: String?
    public var totalChecked: Int?
    public var summary: [MilestoneCount]?
    public var labels: [TrackingLabel]?
}

public struct MilestoneCount: Codable, Sendable, Equatable, Identifiable {
    public var milestone: Milestone
    public var count: Int
    public var milestoneLabel: String?
    public var id: String { milestone.rawValue }
}

public struct TrackingLabel: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var label: String?
    public var count: Int
    public var lastEventAt: String?
    public var milestone: Milestone
    public var id: String { label ?? "(sans libellé)" }
    public var displayLabel: String { label ?? "(sans libellé)" }
}

/// `GET /api/suivi/label?label=&limit=&offset=`
public struct TrackingRows: Codable, Sendable, Equatable {
    public var total: Int
    public var rows: [TrackingRow]
}

public struct TrackingRow: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var trackingNumber: String
    public var milestone: Milestone
    public var lastLabel: String?
    public var lastEventAt: String?
    public var id: String { trackingNumber }

    /// la ligne qu'on colle dans un message : numero, date, ce que dit le suivi
    public var shareLine: String {
        [trackingNumber, ServerDate.shortDayTime(lastEventAt), lastLabel ?? ""]
            .joined(separator: " — ")
            .trimmingCharacters(in: .whitespaces)
    }
}

/// `GET /api/suivi/live?since=` : la verification en cours, lue plusieurs fois
/// par seconde pendant l'ecran de passage.
public struct LiveCheck: Codable, Sendable, Equatable {
    public var running: Bool
    public var job: LiveJob?
    public var finds: [LiveFind]
    public var seq: Int
    public var queued: Int
}

public struct LiveJob: Codable, Sendable, Equatable {
    public var id: String
    public var source: String
    public var total: Int
    public var checked: Int
    public var errors: Int?
    public var counts: [String: Int]?
    public var percent: Double
    public var elapsed: Int
    public var rate: Double
    public var eta: Int?
    public var state: String?
    public var fatalError: String?
    public var cancelled: Bool?
}

public struct LiveFind: Codable, Sendable, Equatable, Identifiable {
    public var seq: Int
    public var number: String
    public var milestone: Milestone
    public var found: Bool
    public var label: String?
    public var id: Int { seq }
}

/// `POST /api/suivi/verifier`
public struct VerifyResult: Codable, Sendable, Equatable {
    public var queued: Int?
    public var total: Int?
    public var invalid: Int?
    public var duplicates: Int?
}
