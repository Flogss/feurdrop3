#if os(macOS)
import SwiftUI

/// Le fond vivant du Mac, plus riche que celui du telephone (le Mac a de la
/// puissance, et pas de batterie a menager quand il est branche) :
/// - la nappe de degrades violets, sur une grille plus fine (4 x 4) ;
/// - des aurores : de grandes lueurs douces qui derivent lentement et
///   respirent ;
/// - une lumiere qui suit la souris, avec un peu de retard ;
/// - un champ d'etoiles lointaines qui scintillent (certaines en croix) ;
/// - des particules qui montent, a plusieurs profondeurs (les proches sont
///   plus grandes, plus rapides, et bougent plus avec la souris), qui
///   s'allument quand le pointeur passe pres d'elles ;
/// - de temps en temps, une etoile filante.
/// Tout est fonction du temps : rien a memoriser, a 60 images par seconde.
struct FondMac: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lissage = Lissage()
    #if DEBUG
    /// `-DropFondFige 1` : le fond arrete (photos comparees)
    static let fige = UserDefaults.standard.bool(forKey: "DropFondFige")
    #else
    static let fige = false
    #endif

    /// le pointeur suivi en douceur (lissage exponentiel a chaque image)
    private final class Lissage {
        var x = 0.0
        var y = 0.0
        var temps = 0.0

        func avance(vers cx: Double, _ cy: Double, a t: Double) -> (Double, Double) {
            let dt = temps == 0 ? 1 : min(max(t - temps, 0), 0.1)
            temps = t
            let k = 1 - exp(-dt / 0.35)
            x += (cx - x) * k
            y += (cy - y) * k
            return (x, y)
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion || Self.fige)) { contexte in
            let t = Self.fige ? 1000 : contexte.date.timeIntervalSinceReferenceDate
            let pointeur = MotionParallax.shared
            let p = lissage.avance(vers: pointeur.cibleX, pointeur.cibleY, a: t)
            let px = p.0, py = p.1
            ZStack {
                Theme.background
                nappe(t)
                    .offset(x: px * 22, y: py * 22)
                    .scaleEffect(1.15)
                Canvas(rendersAsynchronously: true) { ctx, taille in
                    DessinFond.dessine(&ctx, taille, t, px, py)
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// 4 x 4 points de couleur ; ceux de l'interieur (et des bords, le long
    /// de leur bord) derivent doucement.
    private func nappe(_ t: Double) -> some View {
        let d = { (vitesse: Double, phase: Double) in Float(sin(t * vitesse + phase) * 0.1) }
        let noir = Theme.background
        let c = { (r: Double, g: Double, b: Double) in Color(red: r, green: g, blue: b) }
        return MeshGradient(
            width: 4, height: 4,
            points: [
                [0, 0], [0.33 + d(0.11, 0), 0], [0.66 + d(0.09, 1), 0], [1, 0],
                [0, 0.33 + d(0.08, 2)], [0.33 + d(0.13, 3), 0.33 + d(0.1, 4)], [0.66 + d(0.12, 5), 0.33 + d(0.09, 6)], [1, 0.33 + d(0.07, 7)],
                [0, 0.66 + d(0.1, 8)], [0.33 + d(0.09, 9), 0.66 + d(0.12, 10)], [0.66 + d(0.11, 11), 0.66 + d(0.08, 12)], [1, 0.66 + d(0.1, 13)],
                [0, 1], [0.33 + d(0.07, 14), 1], [0.66 + d(0.1, 15), 1], [1, 1],
            ],
            colors: [
                Theme.violetDark.opacity(0.95), Theme.violetDeep.opacity(0.5), c(0.22, 0.07, 0.38), c(0.13, 0.05, 0.29),
                c(0.06, 0.04, 0.14), Theme.violetDark.opacity(0.6), c(0.30, 0.10, 0.50).opacity(0.55), c(0.25, 0.08, 0.42).opacity(0.7),
                noir, c(0.10, 0.05, 0.25), Theme.violetDark.opacity(0.5), c(0.08, 0.06, 0.22),
                noir, noir, c(0.05, 0.05, 0.16), c(0.10, 0.06, 0.26),
            ],
            smoothsColors: true
        )
        .opacity(0.92)
    }
}

/// Le dessin des lumieres du fond, image par image.
nonisolated enum DessinFond {
    /// un nombre pseudo-aleatoire stable dans 0...1
    static func alea(_ i: Double, _ k: Double) -> Double {
        (sin(i * 12.9898 * k + k * 78.233) * 43758.5453).truncatingRemainder(dividingBy: 1).magnitude
    }

    static func couleur(_ r: Double, _ g: Double, _ b: Double) -> Color {
        Color(red: r / 255, green: g / 255, blue: b / 255)
    }

    static let lilas = couleur(196, 170, 255)
    static let violetVif = couleur(170, 132, 255)
    static let bleute = couleur(120, 176, 255)
    static let teintesAurores = [couleur(110, 64, 240), couleur(170, 90, 255), couleur(80, 96, 255), couleur(200, 80, 230), couleur(140, 110, 255)]

    static func dessine(_ ctx: inout GraphicsContext, _ taille: CGSize, _ t: Double, _ px: Double, _ py: Double) {
        let w = taille.width, h = taille.height
        guard w > 0, h > 0 else { return }
        let pointeur = CGPoint(x: (px + 1) / 2 * w, y: (py + 1) / 2 * h)
        var lumiere = ctx
        lumiere.blendMode = .plusLighter
        aurores(&lumiere, w, h, t, px, py)
        lueurPointeur(&lumiere, pointeur)
        etoiles(&ctx, w, h, t, px, py)
        particules(&ctx, w, h, t, px, py, pointeur)
        filantes(&lumiere, w, h, t)
    }

    /// Cinq grandes lueurs qui derivent sur des courbes lentes et respirent.
    static func aurores(_ ctx: inout GraphicsContext, _ w: Double, _ h: Double, _ t: Double, _ px: Double, _ py: Double) {
        let base = max(w, h)
        for (i, teinte) in teintesAurores.enumerated() {
            let d = Double(i) + 1
            let rayon = base * (0.3 + alea(d, 1.7) * 0.22)
            let vx = 0.05 + alea(d, 2.3) * 0.07
            let vy = 0.04 + alea(d, 3.1) * 0.06
            let profondeur = 24 + d * 7
            let centre = CGPoint(
                x: w * (0.5 + 0.44 * sin(t * vx + d * 1.9)) + px * profondeur,
                y: h * (0.45 + 0.4 * cos(t * vy + d * 2.7)) + py * profondeur
            )
            let souffle = 0.72 + 0.28 * sin(t * (0.15 + d * 0.03) + d)
            let o = (0.09 + alea(d, 4.1) * 0.08) * souffle
            let gradient = Gradient(stops: [
                .init(color: teinte.opacity(o), location: 0),
                .init(color: teinte.opacity(o * 0.45), location: 0.45),
                .init(color: teinte.opacity(0), location: 1),
            ])
            ctx.fill(
                Path(ellipseIn: CGRect(x: centre.x - rayon, y: centre.y - rayon, width: rayon * 2, height: rayon * 2)),
                with: .radialGradient(gradient, center: centre, startRadius: 0, endRadius: rayon)
            )
        }
    }

    /// La lumiere sous la souris, comme le halo du site qui suit le pointeur.
    static func lueurPointeur(_ ctx: inout GraphicsContext, _ p: CGPoint) {
        let rayon = 460.0
        let gradient = Gradient(stops: [
            .init(color: violetVif.opacity(0.11), location: 0),
            .init(color: violetVif.opacity(0.04), location: 0.4),
            .init(color: violetVif.opacity(0), location: 1),
        ])
        ctx.fill(
            Path(ellipseIn: CGRect(x: p.x - rayon, y: p.y - rayon, width: rayon * 2, height: rayon * 2)),
            with: .radialGradient(gradient, center: p, startRadius: 0, endRadius: rayon)
        )
    }

    /// Des etoiles lointaines qui glissent a peine et scintillent ; les plus
    /// brillantes s'ouvrent parfois en petite croix.
    static func etoiles(_ ctx: inout GraphicsContext, _ w: Double, _ h: Double, _ t: Double, _ px: Double, _ py: Double) {
        let boucle = w + 40
        for i in 0..<140 {
            let d = Double(i) + 100
            var x = (alea(d, 1.1) * boucle - t * (1.5 + alea(d, 2.2) * 2.5)).truncatingRemainder(dividingBy: boucle)
            if x < 0 { x += boucle }
            let p = CGPoint(x: x - 20 + px * 5, y: alea(d, 3.3) * h + py * 5)
            let eclat = pow(max(0, sin(t * (0.6 + alea(d, 4.4) * 1.6) + d * 3)), 4)
            let a = (0.12 + alea(d, 5.5) * 0.25) * (0.35 + 0.65 * eclat)
            let r = 0.45 + alea(d, 6.6) * 0.7
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(.white.opacity(a)))
            if eclat > 0.8 && alea(d, 7.7) < 0.35 {
                let l = 3 + r * 5 * eclat
                var croix = Path()
                croix.move(to: CGPoint(x: p.x - l, y: p.y))
                croix.addLine(to: CGPoint(x: p.x + l, y: p.y))
                croix.move(to: CGPoint(x: p.x, y: p.y - l))
                croix.addLine(to: CGPoint(x: p.x, y: p.y + l))
                ctx.stroke(croix, with: .color(.white.opacity(a * 0.55)), lineWidth: 0.6)
            }
        }
    }

    /// Les particules qui montent, a trois profondeurs melangees ; pres du
    /// pointeur, elles s'allument.
    static func particules(_ ctx: inout GraphicsContext, _ w: Double, _ h: Double, _ t: Double, _ px: Double, _ py: Double, _ pointeur: CGPoint) {
        let haut = h + 60
        for i in 0..<120 {
            let d = Double(i)
            let z = 0.35 + alea(d, 0.7) * 0.65
            let vitesse = (6 + alea(d, 1.3) * 16) * (0.5 + z)
            let x = alea(d, 2.1) * w + sin(t * 0.3 + d) * 12 * z + px * 16 * z
            let y = h + 30 - (t * vitesse + alea(d, 3.7) * haut).truncatingRemainder(dividingBy: haut) + py * 16 * z
            let rayon = (0.5 + alea(d, 4.4) * 1.5) * (0.6 + z * 0.7)
            let scintille = 0.5 + 0.5 * sin(t * (0.8 + alea(d, 5.1)) + d)
            let proche = max(0, 1 - hypot(x - pointeur.x, y - pointeur.y) / 220)
            let a = min(1, (0.15 + alea(d, 6.3) * 0.45) * scintille * (0.5 + z * 0.6) * (1 + proche * 1.8))
            let tirage = alea(d, 7.9)
            let teinte = tirage < 0.3 ? Color.white : (tirage < 0.85 ? lilas : bleute)
            let halo = rayon * (3.2 + proche * 2)
            ctx.fill(Path(ellipseIn: CGRect(x: x - halo, y: y - halo, width: halo * 2, height: halo * 2)), with: .color(teinte.opacity(a * 0.2)))
            ctx.fill(Path(ellipseIn: CGRect(x: x - rayon, y: y - rayon, width: rayon * 2, height: rayon * 2)), with: .color(teinte.opacity(a)))
        }
    }

    /// Une etoile filante toutes les quelques secondes (pas a chaque fois) :
    /// un trait qui file en biais, sa tete brille, sa queue s'efface.
    static func filantes(_ ctx: inout GraphicsContext, _ w: Double, _ h: Double, _ t: Double) {
        let periode = 6.5
        let n = (t / periode).rounded(.down)
        for k in [n - 1, n] {
            let graine = k.truncatingRemainder(dividingBy: 9973) + 1
            guard alea(graine, 0.37) < 0.7 else { continue }
            let debut = k * periode + alea(graine, 1.9) * 3
            let u = (t - debut) / 1.15
            guard u > 0, u < 1 else { continue }
            let versDroite = alea(graine, 2.8) < 0.6
            let angle = 0.3 + alea(graine, 3.9) * 0.28
            let dx = cos(angle) * (versDroite ? 1 : -1), dy = sin(angle)
            let x0 = versDroite ? w * (0.05 + alea(graine, 4.6) * 0.5) : w * (0.45 + alea(graine, 4.6) * 0.5)
            let y0 = h * (0.04 + alea(graine, 5.3) * 0.35)
            let avance = 1 - pow(1 - u, 2)
            let parcours = w * 0.42
            let tete = CGPoint(x: x0 + dx * parcours * avance, y: y0 + dy * parcours * avance)
            let longueur = (140 + alea(graine, 6.1) * 120) * (0.35 + 0.65 * sin(.pi * min(u * 1.4, 1)))
            let queue = CGPoint(x: tete.x - dx * longueur, y: tete.y - dy * longueur)
            let presence = sin(.pi * u)
            var trait = Path()
            trait.move(to: queue)
            trait.addLine(to: tete)
            ctx.stroke(
                trait,
                with: .linearGradient(Gradient(colors: [.white.opacity(0), lilas.opacity(0.35 * presence), .white.opacity(0.9 * presence)]), startPoint: queue, endPoint: tete),
                style: StrokeStyle(lineWidth: 1.6, lineCap: .round)
            )
            let r = 7.0
            ctx.fill(
                Path(ellipseIn: CGRect(x: tete.x - r, y: tete.y - r, width: r * 2, height: r * 2)),
                with: .radialGradient(Gradient(colors: [.white.opacity(0.85 * presence), lilas.opacity(0.25 * presence), .clear]), center: tete, startRadius: 0, endRadius: r)
            )
        }
    }
}
#endif
