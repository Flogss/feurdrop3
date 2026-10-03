import Foundation

/// Les transporteurs : un nom lisible et une couleur qui ne sert qu'a
/// reconnaitre (rose Mondial Relay, jaune La Poste...). Les couleurs sont des
/// triplets RGB : DropKit ne depend pas de SwiftUI.
public enum Carrier {
    public struct RGB: Sendable, Equatable {
        public let r: Double, g: Double, b: Double
        public init(_ r: Double, _ g: Double, _ b: Double) {
            self.r = r / 255
            self.g = g / 255
            self.b = b / 255
        }
    }

    public static func label(_ code: String) -> String {
        switch code {
        case "MR": "Mondial Relay"
        case "LP": "La Poste"
        case "CHRONO": "Chronopost"
        case "UPS": "UPS"
        case "DPD": "DPD"
        case "GLS": "GLS"
        case "DHL": "DHL"
        case "FEDEX": "FedEx"
        case "BJ": "BJ (boîtes jaunes)"
        case "LIT": "LIT"
        case "SPECIAL": "Spéciaux"
        case "Inconnu": "Non reconnu"
        default: code
        }
    }

    /// nom court pour les legendes serrees
    public static func shortLabel(_ code: String) -> String {
        code == "BJ" ? "BJ" : label(code)
    }

    public static func color(_ code: String) -> RGB {
        switch code {
        case "MR": RGB(255, 95, 162)
        case "LP": RGB(255, 207, 64)
        case "CHRONO": RGB(94, 222, 140)
        case "UPS": RGB(205, 150, 100)
        case "DPD": RGB(255, 92, 92)
        case "GLS": RGB(96, 160, 255)
        case "DHL": RGB(255, 196, 0)
        case "FEDEX": RGB(120, 120, 255)
        case "BJ": RGB(255, 214, 51)
        case "LIT": RGB(64, 208, 214)
        case "SPECIAL": RGB(255, 164, 76)
        default: RGB(140, 136, 156)
        }
    }
}
