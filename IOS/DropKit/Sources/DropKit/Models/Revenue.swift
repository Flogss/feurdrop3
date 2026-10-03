import Foundation

/// `GET /api/stats/revenue`
public struct RevenueSummary: Codable, Sendable, Equatable {
    public var bestDay: BestDay?
}

public struct BestDay: Codable, Sendable, Equatable {
    public var date: String
    public var value: Double
    public var count: Int
}

/// `GET /api/stats/revenue/daily-series` : un point par jour (dimanches exclus).
public struct DailySeries: Codable, Sendable, Equatable {
    public var days: [DayRevenue]
}

public struct DayRevenue: Codable, Sendable, Equatable, Identifiable {
    public var date: String
    public var value: Double
    public var count: Int
    public var id: String { date }
}

/// `GET /api/stats/revenue/weekly-series` : un point par semaine (lundi -> dimanche).
public struct WeeklySeries: Codable, Sendable, Equatable {
    public var weeks: [WeekRevenue]
}

public struct WeekRevenue: Codable, Sendable, Equatable, Identifiable {
    public var start: String
    public var end: String
    public var value: Double
    public var count: Int
    public var id: String { start }
}
