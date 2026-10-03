import SwiftUI
import DropKit

/// La direction visuelle : graphite tres sombre, violet electrique. Le violet
/// porte l'argent, les actions, la navigation et les succes ; le rouge et
/// l'orange gardent leur sens ; les transporteurs gardent leurs couleurs.
enum Theme {
    // MARK: Surfaces

    static let background = Color(red: 0.031, green: 0.027, blue: 0.043)
    static let surface = Color(red: 0.071, green: 0.063, blue: 0.090)
    static let surfaceRaised = Color(red: 0.094, green: 0.086, blue: 0.118)
    static let hairline = Color.white.opacity(0.07)

    // MARK: Violet, de l'ombre a la lumiere

    static let violetDark = Color(red: 50 / 255, green: 28 / 255, blue: 112 / 255)
    static let violetDeep = Color(red: 110 / 255, green: 64 / 255, blue: 240 / 255)
    static let violet = Color(red: 145 / 255, green: 98 / 255, blue: 255 / 255)
    static let violetBright = Color(red: 170 / 255, green: 132 / 255, blue: 255 / 255)
    static let violetLight = Color(red: 196 / 255, green: 170 / 255, blue: 255 / 255)
    static let violetPale = Color(red: 222 / 255, green: 208 / 255, blue: 255 / 255)

    // MARK: Semantique

    static let warn = Color(red: 1, green: 176 / 255, blue: 72 / 255)
    static let danger = Color(red: 1, green: 92 / 255, blue: 108 / 255)
    static let info = Color(red: 120 / 255, green: 176 / 255, blue: 1)
    static let teal = Color(red: 64 / 255, green: 208 / 255, blue: 214 / 255)
    static let special = Color(red: 1, green: 164 / 255, blue: 76 / 255)

    static let text = Color.white
    static let text2 = Color.white.opacity(0.66)
    static let text3 = Color.white.opacity(0.42)

    // MARK: Degrades

    static let accentGradient = LinearGradient(
        colors: [violetBright, violet, violetDeep],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
    /// les grands nombres : du blanc vers un violet tres pale
    static let numberGradient = LinearGradient(colors: [.white, violetPale], startPoint: .top, endPoint: .bottom)
    /// l'argent
    static let moneyGradient = LinearGradient(colors: [violetPale, violetBright], startPoint: .top, endPoint: .bottom)

    // MARK: Couleurs metier

    static func carrier(_ code: String) -> Color {
        let c = Carrier.color(code)
        return Color(red: c.r, green: c.g, blue: c.b)
    }

    static func milestone(_ m: Milestone) -> Color {
        switch m {
        case .delivered: violetBright
        case .outForDelivery: warn
        case .inTransit: info
        case .infoReceived: teal
        case .pending: Color(white: 0.55)
        case .finalOther: Color(red: 1, green: 95 / 255, blue: 162 / 255)
        case .expired: Color(white: 0.45)
        case .notFound: danger
        case .unknown: Color(white: 0.5)
        }
    }

    /// les parts de l'anneau : le violet d'abord, puis des teintes qui s'en
    /// distinguent bien
    static let categorical: [Color] = [
        violet, teal, Color(red: 1, green: 122 / 255, blue: 198 / 255), violetLight,
        info, warn, violetDeep, Color(red: 94 / 255, green: 230 / 255, blue: 176 / 255),
    ]

    // MARK: Mesures

    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 28
    }

    enum Radius {
        static let card: CGFloat = 28
        static let inner: CGFloat = 18
        static let control: CGFloat = 14
    }

    // MARK: Mouvement

    /// le ressort de presque tout : vif, qui se pose sans rebondir trop
    static let spring = Animation.spring(response: 0.42, dampingFraction: 0.78)
    /// ce qui claque : interrupteurs, coches, pastilles
    static let bouncy = Animation.spring(response: 0.38, dampingFraction: 0.6)
    /// les entrees de contenu
    static let entrance = Animation.spring(response: 0.62, dampingFraction: 0.86)
}

extension Color {
    /// Une couleur de transporteur a partir de son code.
    static func carrier(_ code: String) -> Color { Theme.carrier(code) }
}

extension ShapeStyle where Self == Color {
    static var violet: Color { Theme.violet }
}

/// Avatar stable par expediteur : la meme teinte d'une visite a l'autre, pour
/// reconnaitre quelqu'un sans lire son nom.
func senderHue(_ name: String) -> Double {
    let h = name.unicodeScalars.reduce(17) { ($0 * 31 + Int($1.value)) % 360 }
    return Double(h) / 360
}

func senderInitial(_ name: String) -> String {
    let propre = name.drop { "@ _.-".contains($0) }
    return String(propre.prefix(1)).uppercased().ifEmpty("?")
}

extension String {
    func ifEmpty(_ remplacement: String) -> String { isEmpty ? remplacement : self }
}
