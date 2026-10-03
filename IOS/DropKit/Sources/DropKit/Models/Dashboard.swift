import Foundation

// Reponses du serveur pour le tableau de bord. Les noms suivent le JSON ; les
// cles en snake_case ("sender_name") sont converties par le decodeur.

/// `GET /api/stats` : tout ce que montre le dashboard, en un appel.
public struct Stats: Codable, Sendable, Equatable {
    public var pendingCount: Int
    public var pendingValue: Double
    public var droppedCount: Int
    public var droppedValue: Double
    public var todayCount: Int
    public var todayValue: Double
    public var litPendingCount: Int
    public var litPendingValue: Double
    public var bjPendingCount: Int
    public var bjPendingValue: Double
    public var bySender: [SenderSummary]
    public var byCarrier: [CarrierSummary]
    public var autoPrint: AutoPrint
    /// etiquettes jamais imprimees, LIT compris (pastille de l'onglet Imprime)
    public var aImprimer: Int?
    public var tour: Tour

    public init(
        pendingCount: Int = 0, pendingValue: Double = 0, droppedCount: Int = 0, droppedValue: Double = 0,
        todayCount: Int = 0, todayValue: Double = 0, litPendingCount: Int = 0, litPendingValue: Double = 0,
        bjPendingCount: Int = 0, bjPendingValue: Double = 0, bySender: [SenderSummary] = [],
        byCarrier: [CarrierSummary] = [], autoPrint: AutoPrint = .init(), aImprimer: Int? = nil, tour: Tour = .init()
    ) {
        self.pendingCount = pendingCount
        self.pendingValue = pendingValue
        self.droppedCount = droppedCount
        self.droppedValue = droppedValue
        self.todayCount = todayCount
        self.todayValue = todayValue
        self.litPendingCount = litPendingCount
        self.litPendingValue = litPendingValue
        self.bjPendingCount = bjPendingCount
        self.bjPendingValue = bjPendingValue
        self.bySender = bySender
        self.byCarrier = byCarrier
        self.autoPrint = autoPrint
        self.aImprimer = aImprimer
        self.tour = tour
    }
}

public struct SenderSummary: Codable, Sendable, Equatable, Identifiable {
    public var senderName: String
    public var pendingCount: Int
    public var pendingValue: Double
    public var droppedCount: Int
    public var droppedValue: Double
    public var id: String { senderName }
}

public struct CarrierSummary: Codable, Sendable, Equatable, Identifiable {
    public var carrier: String
    public var pendingCount: Int
    public var pendingValue: Double
    public var id: String { carrier }
}

public struct AutoPrint: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var pending: Int
    public init(enabled: Bool = false, pending: Int = 0) {
        self.enabled = enabled
        self.pending = pending
    }
}

/// La tournee en cours (startedAt) et le resume de la derniere (last).
public struct Tour: Codable, Sendable, Equatable {
    public var startedAt: String?
    public var arrivedCount: Int
    public var arrivedValue: Double
    /// heure du serveur : le chrono s'y recale pour ne pas deriver
    public var now: String?
    public var last: TourSummary?

    public init(startedAt: String? = nil, arrivedCount: Int = 0, arrivedValue: Double = 0, now: String? = nil, last: TourSummary? = nil) {
        self.startedAt = startedAt
        self.arrivedCount = arrivedCount
        self.arrivedValue = arrivedValue
        self.now = now
        self.last = last
    }

    public var isActive: Bool { startedAt != nil }
}

public struct TourSummary: Codable, Sendable, Equatable {
    public var startedAt: String
    public var endedAt: String
    public var seconds: Int?
    public var count: Int
    public var value: Double
    public var smicHourly: Double?
    public var day: TourDay?

    /// duree reelle, recalculee depuis les dates si le serveur ne l'a pas donnee
    public var durationSeconds: Int {
        if let seconds { return seconds }
        guard let debut = ServerDate.parse(startedAt), let fin = ServerDate.parse(endedAt) else { return 0 }
        return max(0, Int(fin.timeIntervalSince(debut)))
    }
}

public struct TourDay: Codable, Sendable, Equatable {
    public var sessions: Int
    public var seconds: Int
    public var count: Int
    public var value: Double
}

/// `GET /api/stock` : deux cartons, deux compteurs.
public struct Stock: Codable, Sendable, Equatable {
    public var normal: Int
    public var bj: Int
    public init(normal: Int = 0, bj: Int = 0) {
        self.normal = normal
        self.bj = bj
    }
}

public enum StockKind: String, Codable, Sendable, CaseIterable, Identifiable {
    case normal, bj
    public var id: String { rawValue }
    public var label: String { self == .normal ? "Normal" : "BJ" }
}

/// Reponse des drops groupes (par expediteur, transporteur, tout...).
public struct DropResult: Codable, Sendable, Equatable {
    public var count: Int
    public var stocks: Stock?
}

public struct OK: Codable, Sendable, Equatable {
    public var ok: Bool?
}
