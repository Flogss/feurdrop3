import Foundation

/// Combien de temps un nombre met a monter. Un petit ecart va vite, un grand
/// prend son temps -- sans jamais faire attendre : la duree croit avec le
/// logarithme de l'ecart et plafonne.
///
///     +1     -> ~0,7 s
///     +10    -> ~1,2 s
///     +100   -> ~1,8 s
///     +1 000 -> ~2,4 s (plafond 2,6 s)
public enum CountingDuration {
    public static let minimum: Double = 0.5
    public static let maximum: Double = 2.6

    public static func seconds(from ancien: Double, to nouveau: Double) -> Double {
        let ecart = abs(nouveau - ancien)
        guard ecart > 0 else { return 0 }
        return min(maximum, 0.52 + log10(ecart + 1) * 0.64)
    }
}

/// Le dernier etat vu SUR CET APPAREIL. C'est lui qui permet de dire "+10
/// colis depuis ta derniere visite" : rien ne part au serveur, donc un autre
/// telephone a sa propre memoire et ne voit jamais les nouveautes des autres.
public struct LastSeenSnapshot: Codable, Sendable, Equatable {
    public var pending: Int
    public var earned: Double
    public var today: Double
    /// "2026-10-03" : la valeur du jour ne vaut que pour ce jour-la
    public var day: String
    public var at: Date

    public init(pending: Int, earned: Double, today: Double, day: String, at: Date = .now) {
        self.pending = pending
        self.earned = earned
        self.today = today
        self.day = day
        self.at = at
    }
}

/// D'ou part un compteur, et faut-il une bulle "+N".
public struct CounterStart: Sendable, Equatable {
    /// valeur de depart de l'animation (nil : afficher directement la valeur)
    public var from: Double?
    /// vrai seulement s'il y a VRAIMENT du nouveau depuis la derniere visite
    public var announces: Bool

    public init(from: Double?, announces: Bool) {
        self.from = from
        self.announces = announces
    }
}

/// La memoire, rangee dans les UserDefaults de l'app.
public final class LastSeenStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard, key: String = "drop.dernier-etat") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> LastSeenSnapshot? {
        lock.lock(); defer { lock.unlock() }
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(LastSeenSnapshot.self, from: data)
    }

    public func save(_ snapshot: LastSeenSnapshot) {
        lock.lock(); defer { lock.unlock() }
        if let data = try? JSONEncoder().encode(snapshot) { defaults.set(data, forKey: key) }
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        defaults.removeObject(forKey: key)
    }

    /// Le point de depart d'un compteur au lancement de l'app.
    ///
    /// - Du nouveau depuis la derniere visite : on part de l'ancienne valeur,
    ///   avec la bulle "+N".
    /// - Rien de nouveau, ou premiere visite : pas de bulle. Le compteur part
    ///   de zero (la grande entree du lancement) si `bootFlourish`, sinon il
    ///   s'affiche directement.
    public static func start(remembered: Double?, current: Double, bootFlourish: Bool) -> CounterStart {
        if let remembered, remembered != current {
            return CounterStart(from: remembered, announces: current > remembered)
        }
        return CounterStart(from: bootFlourish ? 0 : nil, announces: false)
    }

    /// "2026-10-03" dans le fuseau de l'appareil
    public static func dayKey(_ date: Date = .now) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
}
