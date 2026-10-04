import SwiftUI

/// Le symbole de DROP, le meme que sur le site : une fleche qui tombe dans
/// un bac (dessine dans une grille de 24, comme l'icone du site).
nonisolated struct GlypheDrop: Shape {
    func path(in r: CGRect) -> Path {
        let s = min(r.width, r.height) / 24
        let o = CGPoint(x: r.midX - 12 * s, y: r.midY - 12 * s)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: o.x + x * s, y: o.y + y * s) }
        var chemin = Path()
        chemin.move(to: p(12, 3.5))
        chemin.addLine(to: p(12, 14))
        chemin.move(to: p(7.5, 9.5))
        chemin.addLine(to: p(12, 14))
        chemin.addLine(to: p(16.5, 9.5))
        chemin.move(to: p(4.5, 14.5))
        chemin.addLine(to: p(4.5, 17.5))
        chemin.addArc(center: p(7, 17.5), radius: 2.5 * s, startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true)
        chemin.addLine(to: p(17, 20))
        chemin.addArc(center: p(17, 17.5), radius: 2.5 * s, startAngle: .degrees(90), endAngle: .degrees(0), clockwise: true)
        chemin.addLine(to: p(19.5, 14.5))
        return chemin
    }

    /// Les traits du symbole (dans un carre de cote 1 centre sur l'origine) :
    /// la tige, la pointe, le bac.
    nonisolated static func traits() -> [[CGPoint]] {
        func q(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: (x - 12) / 24, y: (y - 12) / 24) }
        var bac = [q(4.5, 14.5), q(4.5, 17.5)]
        for i in 1...6 {
            let a = CGFloat.pi - CGFloat(i) / 6 * CGFloat.pi / 2
            bac.append(q(7 + 2.5 * cos(a), 17.5 + 2.5 * sin(a)))
        }
        bac.append(q(17, 20))
        for i in 1...6 {
            let a = CGFloat.pi / 2 - CGFloat(i) / 6 * CGFloat.pi / 2
            bac.append(q(17 + 2.5 * cos(a), 17.5 + 2.5 * sin(a)))
        }
        bac.append(q(19.5, 14.5))
        return [[q(12, 3.5), q(12, 14)], [q(7.5, 9.5), q(12, 14), q(16.5, 9.5)], bac]
    }

    /// des points regulierement espaces sur le symbole (les cibles des
    /// particules du lancement)
    nonisolated static func points(_ nombre: Int) -> [CGPoint] {
        repartis(nombre, sur: traits())
    }
}

/// Le contour arrondi de la marque (pour les particules du lancement).
nonisolated enum ContourMarque {
    /// rayon des coins, en part du cote (11 px pour 34 sur le site)
    static let arrondi: CGFloat = 0.32

    /// le contour, en un trait ferme (carre de cote 1 centre sur l'origine)
    static func trait() -> [CGPoint] {
        let r = arrondi, d = 0.5
        var trait: [CGPoint] = []
        let coins: [(CGPoint, CGFloat)] = [
            (CGPoint(x: d - r, y: -d + r), -.pi / 2),
            (CGPoint(x: d - r, y: d - r), 0),
            (CGPoint(x: -d + r, y: d - r), .pi / 2),
            (CGPoint(x: -d + r, y: -d + r), .pi),
        ]
        for (centre, depart) in coins {
            for i in 0...8 {
                let a = depart + CGFloat(i) / 8 * .pi / 2
                trait.append(CGPoint(x: centre.x + r * cos(a), y: centre.y + r * sin(a)))
            }
        }
        trait.append(trait[0])
        return trait
    }

    static func points(_ nombre: Int) -> [CGPoint] {
        repartis(nombre, sur: [trait()])
    }
}

/// Repartit `nombre` points a intervalles reguliers le long de traits.
nonisolated private func repartis(_ nombre: Int, sur traits: [[CGPoint]]) -> [CGPoint] {
    var segments: [(CGPoint, CGPoint, CGFloat)] = []
    for trait in traits {
        for (a, b) in zip(trait, trait.dropFirst()) {
            segments.append((a, b, hypot(b.x - a.x, b.y - a.y)))
        }
    }
    let total = segments.reduce(0) { $0 + $1.2 }
    guard total > 0, nombre > 0 else { return [] }
    var resultat: [CGPoint] = []
    var cumul: CGFloat = 0
    var i = 0
    for n in 0..<nombre {
        let voulu = (CGFloat(n) + 0.5) / CGFloat(nombre) * total
        while i < segments.count - 1 && cumul + segments[i].2 < voulu {
            cumul += segments[i].2
            i += 1
        }
        let (a, b, l) = segments[i]
        let f = l > 0 ? min(max((voulu - cumul) / l, 0), 1) : 0
        resultat.append(CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f))
    }
    return resultat
}

/// La marque : le carre arrondi au degrade violet et le symbole blanc, comme
/// le logo du site.
struct MarqueDrop: View {
    var cote: CGFloat = 34

    var body: some View {
        let forme = RoundedRectangle(cornerRadius: cote * ContourMarque.arrondi, style: .continuous)
        ZStack {
            forme.fill(Theme.accentGradient)
            GlypheDrop()
                .stroke(.white, style: StrokeStyle(lineWidth: max(cote * 0.054, 1.4), lineCap: .round, lineJoin: .round))
                .frame(width: cote * 0.56, height: cote * 0.56)
        }
        .frame(width: cote, height: cote)
        .overlay {
            // le liseré clair du haut (inset 0 1px 0 sur le site)
            forme.strokeBorder(
                LinearGradient(colors: [.white.opacity(0.45), .white.opacity(0.05), .clear], startPoint: .top, endPoint: .bottom),
                lineWidth: max(cote / 34, 1)
            )
        }
    }
}
