import Foundation

/// `GET /api/special/paires` : les codes-barres du topic special, dans l'ordre
/// des numeros imprimes sur les etiquettes.
public struct LockerPairs: Codable, Sendable, Equatable {
    public var paires: [LockerPair]
}

public struct LockerPair: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var id: Int
    public var numero: Int
    public var sender: String?
    /// le code-barre est-il arrive ?
    public var code: Bool
    /// un code qui ne va avec aucun PDF (`/special seul`)
    public var seul: Bool
    public var colis: LockerParcel?

    public enum State: Sendable, Equatable {
        case missingCode, missingParcel, alone, printed, toPrint
    }

    /// une paire incomplete doit se voir avant de partir, pas devant le locker
    public var state: State {
        if !code { return .missingCode }
        if colis == nil && !seul { return .missingParcel }
        if seul && colis == nil { return .alone }
        return (colis?.printed ?? false) ? .printed : .toPrint
    }

    public var isIncomplete: Bool { state == .missingCode || state == .missingParcel }
    /// un code seul n'a pas de colis a droper : "Fait" le retire une fois utilise
    public var canComplete: Bool { colis != nil || seul }
}

public struct LockerParcel: Codable, Sendable, Equatable, Hashable {
    public var id: Int
    public var fileName: String?
    public var note: String?
    public var printed: Bool
}
