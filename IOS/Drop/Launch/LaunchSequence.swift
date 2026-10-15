import SwiftUI

/// Le calendrier du lancement (en secondes), le meme sur le site
/// (public/lancement-rendu.js) :
/// - 0,30 : au loin, une lumiere violette ; un point s'y allume ;
/// - 0,70 → 2,30 : la meteorite se met en route, accelere, passe tout pres
///   en traversant l'ecran (sa trainee s'etire et seme des braises, les
///   etoiles filent, la camera la suit), puis freine et s'immobilise au
///   centre en fin de spirale ;
/// - 2,30 → 2,72 : immobile, la roche se fissure : la lumiere violette monte
///   dans ses failles, en deux battements ;
/// - 2,72 : elle se fragmente -- chaque piece se detache a son tour, une
///   onde de choc douce (pas d'eclair blanc) ;
/// - 2,94 → 3,72 : ses eclats deviennent energie et sont attires un par un
///   sur le symbole de DROP, qu'ils tracent en arrivant ;
/// - 3,72 : le symbole se condense en logo, un reflet le traverse ;
/// - 4,00 : une onde part du logo et ouvre l'interface ; le logo rejoint sa
///   place dans la barre (Mac) ou se dissout dans l'onde (iPhone).
nonisolated enum Scenario {
    static let point = 0.3
    static let depart = 0.7
    static let arrivee = 2.3
    static let eclat = 2.72
    static let attraction = 2.94
    static let logo = 3.72
    static let revelation = 4.0
    static let dureeRevelation = 0.95
    static let vol = 0.66
    static let fin = 5.05
    /// le trace du symbole suit l'arrivee des eclats
    static let traceDebut = attraction + 0.32
    static let traceDuree = 0.42
}

/// Ou la sequence commence : la scene entiere (premiere ouverture, ou plus
/// de 6 h apres la derniere), une entree courte (l'energie se rassemble en
/// logo), ou juste apres le mot de passe (le coeur deja au centre).
nonisolated enum EntreeLancement: Sendable {
    case complet, retour, connexion

    var instant: Double {
        switch self {
        case .complet: 0
        case .retour: 2.95
        case .connexion: 2.58
        }
    }

    private static let cle = "drop.lancement.complet"

    /// l'entree de cette ouverture (et la note, si c'est la scene entiere)
    static func choisie(apresConnexion: Bool) -> EntreeLancement {
        if apresConnexion { return .connexion }
        let dernier = UserDefaults.standard.double(forKey: cle)
        if dernier > 0, Date.now.timeIntervalSince1970 - dernier < 6 * 3600 { return .retour }
        UserDefaults.standard.set(Date.now.timeIntervalSince1970, forKey: cle)
        return .complet
    }
}

/// La sequence de lancement, par-dessus l'interface (deja prete dessous) :
/// la lumiere et les particules par Metal, sur leur propre fil
/// (`MoteurLancement`) ; le logo en vue SwiftUI, a partir du moment ou il se
/// condense. Tout est fonction du meme temps : chaque image est calculee,
/// rien ne derive. Toucher l'ecran passe directement au logo.
struct LaunchSequence: View {
    /// ou poser le logo a la fin (coordonnees de la fenetre) ; sans cible,
    /// il se dissout dans l'onde
    var cible: CGRect?
    /// juste apres le mot de passe : la sequence reprend au coeur de la meteorite
    var apresConnexion = false
    var onRevelation: () -> Void
    /// juste avant l'onde (0,25 s) : l'interface, encore couverte par la
    /// scene opaque, se remet a etre dessinee -- avant, elle l'etait (floue)
    /// pendant toute la sequence, pour rien, et prenait la carte graphique a
    /// la meteorite
    var onPreparation: () -> Void = {}
    var onLogoPose: () -> Void = {}
    var onFin: () -> Void

    @State private var debut = Date.now
    @State private var moteur = MoteurLancement()
    @State private var cache = CacheDecor()
    /// le logo ne se dessine (et l'horloge SwiftUI ne tourne) qu'a partir de
    /// sa condensation : avant, le fil principal reste libre pour construire
    /// l'interface
    @State private var logoActif = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale

    #if DEBUG
    /// `-DropIntroFige 3.1` : la sequence arretee a cet instant (photos)
    nonisolated static let fige: Double? = {
        let v = UserDefaults.standard.double(forKey: "DropIntroFige")
        return v > 0 ? v : nil
    }()
    #endif

    var body: some View {
        GeometryReader { geo in
            let decor = cache.decor(geo.size)
            let origine = geo.frame(in: .global).origin
            ZStack {
                LumiereLancement(moteur: moteur)
                if logoActif {
                    TimelineView(.animation) { contexte in
                        logo(temps(contexte.date), decor, origine)
                    }
                }
            }
            .onAppear { moteur.configure(decor, echelle: min(displayScale, 2)) }
            .onChange(of: geo.size) { moteur.configure(cache.decor(geo.size), echelle: min(displayScale, 2)) }
        }
        .ignoresSafeArea()
        .contentShape(.rect)
        .onTapGesture { accelere() }
        .onAppear {
            #if DEBUG
            // `-DropSansIntro 1` : directement l'interface (verifications)
            if UserDefaults.standard.bool(forKey: "DropSansIntro") {
                onPreparation()
                onRevelation()
                onLogoPose()
                onFin()
                return
            }
            #endif
            // mouvements reduits : pas de meteorite, le logo puis l'onde
            var entree = EntreeLancement.choisie(apresConnexion: apresConnexion)
            #if DEBUG
            if Self.fige != nil { entree = .complet }
            #endif
            let depart = reduceMotion ? Scenario.logo - 0.15 : entree.instant
            moteur.entree(depart)
            recommence(a: depart)
            moteur.demarre()
        }
        .onDisappear { moteur.arrete() }
        .task(id: debut) { await deroule() }
        .accessibilityHidden(true)
    }

    private func temps(_ date: Date) -> Double {
        #if DEBUG
        if let fige = Self.fige { return fige }
        #endif
        return date.timeIntervalSince(debut)
    }

    /// toucher pendant la sequence : on passe au logo
    private func accelere() {
        if Date.now.timeIntervalSince(debut) < Scenario.logo - 0.25 { recommence(a: Scenario.logo - 0.25) }
    }

    private func recommence(a instant: Double) {
        debut = Date.now.addingTimeInterval(-instant)
        moteur.recommence(a: instant)
    }

    /// Les moments ou l'app reagit : le retour tactile de la fragmentation et
    /// du logo, l'ouverture de l'interface, la pose du logo, la fin.
    private func deroule() async {
        #if DEBUG
        if let fige = Self.fige {
            logoActif = fige >= Scenario.logo - 0.05
            if fige >= Scenario.revelation - 0.25 { onPreparation() }
            if fige >= Scenario.revelation { onRevelation() }
            return
        }
        #endif
        let debut = debut
        func attends(_ t: Double) async -> Bool {
            let reste = t - Date.now.timeIntervalSince(debut)
            if reste > 0 { try? await Task.sleep(for: .seconds(reste)) }
            return !Task.isCancelled
        }
        let deja = Date.now.timeIntervalSince(debut)
        if deja < Scenario.eclat {
            guard await attends(Scenario.eclat) else { return }
            Haptics.impact()
        }
        guard await attends(Scenario.logo - 0.05) else { return }
        logoActif = true
        if deja < Scenario.logo + 0.08 {
            guard await attends(Scenario.logo + 0.08) else { return }
            Haptics.soft()
        }
        guard await attends(Scenario.revelation - 0.25) else { return }
        onPreparation()
        guard await attends(Scenario.revelation) else { return }
        onRevelation()
        if cible != nil {
            guard await attends(Scenario.revelation + Scenario.vol) else { return }
            onLogoPose()
        }
        guard await attends(Scenario.fin) else { return }
        moteur.arrete()
        onFin()
    }

    // MARK: Le logo

    /// Le logo : il se condense sous les traits de lumiere (flou, surexpose,
    /// puis net), un reflet le traverse, puis il rejoint la barre ou se
    /// dissout dans l'onde.
    @ViewBuilder
    private func logo(_ t: Double, _ d: DecorLancement, _ origine: CGPoint) -> some View {
        let apparition = lisse((t - Scenario.logo) / 0.36)
        if apparition > 0 {
            let r = t - Scenario.revelation
            let geste = logoApres(r, d, origine)
            if geste.opacite > 0 {
                ZStack {
                    // le halo du logo
                    RadialGradient(colors: [Theme.violet.opacity(0.55 * apparition * geste.lueur), .clear], center: .center, startRadius: 0, endRadius: geste.cote * 1.1)
                        .frame(width: geste.cote * 2.6, height: geste.cote * 2.6)
                    MarqueDrop(cote: geste.cote)
                        .overlay { Reflet(progres: (t - (Scenario.logo + 0.14)) / 0.46, cote: geste.cote) }
                        .shadow(color: Theme.violet.opacity(0.8 * geste.lueur), radius: geste.cote * 0.22, y: geste.cote * 0.05)
                        .brightness(0.5 * (1 - apparition))
                        .scaleEffect(geste.echelle * (0.9 + 0.1 * sortDouce(apparition)))
                        .rotationEffect(.degrees(geste.rotation))
                }
                .blur(radius: geste.flou + 8 * (1 - apparition))
                .opacity(apparition * geste.opacite)
                .position(geste.centre)
                .allowsHitTesting(false)
            }
        }
    }

    private struct Geste {
        var centre: CGPoint
        var cote: CGFloat
        var echelle: CGFloat = 1
        var flou: CGFloat = 0
        var opacite: Double = 1
        var lueur: Double = 1
        var rotation: Double = 0
    }

    private func logoApres(_ r: Double, _ d: DecorLancement, _ origine: CGPoint) -> Geste {
        var g = Geste(centre: d.centre, cote: d.cote)
        guard r > 0 else { return g }
        if let cible {
            // il vole jusqu'a la barre, en arc, et se pose a la taille de la marque
            let f = entreeSortie(min(r / Scenario.vol, 1))
            let arc = sin(.pi * f)
            let arrivee = CGPoint(x: cible.midX - origine.x, y: cible.midY - origine.y)
            g.centre = CGPoint(
                x: d.centre.x + (arrivee.x - d.centre.x) * f,
                y: d.centre.y + (arrivee.y - d.centre.y) * f - arc * 56 * d.k
            )
            g.cote = d.cote + (cible.width - d.cote) * f
            g.echelle = 1 + 0.07 * arc
            g.rotation = -8 * arc
            g.lueur = 1 - 0.6 * f
            g.opacite = r >= Scenario.vol ? 0 : 1
        } else {
            // il s'etend et se dissout dans la lumiere de l'onde
            let f = min(r / 0.5, 1)
            g.echelle = 1 + 0.35 * sortDouce(f)
            g.flou = 14 * f
            g.opacite = 1 - f
        }
        return g
    }

    /// le reflet qui traverse le logo, une fois
    private struct Reflet: View {
        let progres: Double
        let cote: CGFloat

        var body: some View {
            if progres > 0 && progres < 1 {
                LinearGradient(colors: [.clear, .white.opacity(0.6), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: cote * 0.42)
                    .rotationEffect(.degrees(20))
                    .offset(x: -cote * 0.9 + cote * 1.8 * progres)
                    .clipShape(.rect(cornerRadius: cote * ContourMarque.arrondi, style: .continuous))
                    .blendMode(.plusLighter)
            }
        }
    }
}

/// le decor d'une taille d'ecran, calcule une fois
@MainActor
private final class CacheDecor {
    private var dernier: DecorLancement?

    func decor(_ taille: CGSize) -> DecorLancement {
        if let d = dernier, d.taille == taille { return d }
        let d = DecorLancement(taille: taille)
        dernier = d
        return d
    }
}

// MARK: - Le decor : la course, la roche, les eclats

nonisolated private func lisse(_ x: Double) -> Double { lisseLancement(x) }

nonisolated func lisseLancement(_ x: Double) -> Double {
    let c = min(max(x, 0), 1)
    return c * c * (3 - 2 * c)
}

nonisolated private func entreeSortie(_ x: Double) -> Double {
    x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2
}

nonisolated private func sortDouce(_ x: Double) -> Double {
    1 - pow(1 - min(max(x, 0), 1), 3)
}

/// un tirage stable dans 0...1 (le meme que le site)
nonisolated private func tirage(_ i: Int, _ k: Int) -> Double {
    let x = sin(Double(i) * 12.9898 + Double(k) * 78.233) * 43758.5453
    return x - x.rounded(.down)
}

/// Catmull-Rom centripete : une courbe douce qui passe par chaque point
/// (x, y, profondeur)
nonisolated private func courbe(_ points: [SIMD3<Double>], parSegment: Int) -> [SIMD3<Double>] {
    let P = [2 * points[0] - points[1]] + points + [2 * points[points.count - 1] - points[points.count - 2]]
    func pas(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> Double { max(sqrt(hypot(b.x - a.x, b.y - a.y)), 1e-3) }
    func mel(_ a: SIMD3<Double>, _ b: SIMD3<Double>, _ ta: Double, _ tb: Double, _ t: Double) -> SIMD3<Double> {
        a * ((tb - t) / (tb - ta)) + b * ((t - ta) / (tb - ta))
    }
    var sortie: [SIMD3<Double>] = []
    for i in 1..<(P.count - 2) {
        let (p0, p1, p2, p3) = (P[i - 1], P[i], P[i + 1], P[i + 2])
        let t0 = 0.0, t1 = t0 + pas(p0, p1), t2 = t1 + pas(p1, p2), t3 = t2 + pas(p2, p3)
        for j in 0..<parSegment {
            let t = t1 + (t2 - t1) * Double(j) / Double(parSegment)
            let A1 = mel(p0, p1, t0, t1, t), A2 = mel(p1, p2, t1, t2, t), A3 = mel(p2, p3, t2, t3, t)
            let B1 = mel(A1, A2, t0, t2, t), B2 = mel(A2, A3, t1, t3, t)
            sortie.append(mel(B1, B2, t1, t2, t))
        }
    }
    sortie.append(points[points.count - 1])
    return sortie
}

/// l'avancee le long de la course : un depart doux, une pleine vitesse vers
/// 45 % du trajet, puis un long freinage jusqu'a l'arret
nonisolated private func profil(_ tau: Double) -> Double {
    (1 - cos(.pi * pow(min(max(tau, 0), 1), 0.8))) / 2
}

nonisolated struct DecorLancement: Sendable {
    let taille: CGSize
    /// l'echelle : 1 sur un telephone, plus sur un grand ecran
    let k: CGFloat
    let centre: CGPoint
    /// le cote du logo
    let cote: CGFloat
    /// la roche immobile au centre, et a pleine profondeur
    let R0: Double
    let Rmax: Double
    let zFin: Double
    /// la course, echantillonnee : x, y, profondeur, distance parcourue
    let X: [Double], Y: [Double], Z: [Double], L: [Double]
    var longueur: Double { L[L.count - 1] }
    /// la lumiere au loin, d'ou vient la meteorite
    var lointain: CGPoint { CGPoint(x: X[0], y: Y[0]) }

    /// pour la carte graphique, en paquets de quatre nombres
    let eclats: [SIMD4<Float>]      // 4 par eclat
    let braises: [SIMD4<Float>]     // 2 par braise
    let etincelles: [SIMD4<Float>]  // 2 par etincelle
    let segments: [SIMD4<Float>]    // 2 par segment du symbole

    struct Meteore {
        var position: CGPoint = .zero
        var rayon: Double = 0
        var intensite: Double = 0
        var direction = CGVector(dx: -1, dy: 0)
        var vitesse: Double = 0
        var profondeur: Double = 0
        var rotation: Double = 0
        var fissures: Double = 0
        var dissolution: Double = 0
        var chaleur: Double = 0
    }

    init(taille: CGSize) {
        self.taille = taille
        let w = Double(taille.width), h = Double(taille.height)
        let petit = min(w, h)
        let k = min(max(petit / 400, 0.9), 1.7)
        self.k = k
        let centre = CGPoint(x: 0.5 * w, y: (w > h ? 0.47 : 0.42) * h)
        self.centre = centre
        let cote = min(max(petit * 0.30, 96), 150)
        self.cote = cote
        R0 = cote * 0.25
        zFin = 0.62
        Rmax = R0 / zFin

        // la spirale : du fond (en haut a droite), tout pres en traversant,
        // puis le freinage jusqu'au centre
        let portrait = h > w * 1.15
        let F: [SIMD3<Double>] = portrait
            ? [[0.86, 0.1, 0.04], [0.66, 0.15, 0.14], [0.26, 0.26, 0.58], [0.13, 0.45, 0.92], [0.27, 0.62, 1.0], [0.66, 0.6, 0.86], [0.68, 0.5, 0.72]]
            : [[0.86, 0.14, 0.04], [0.64, 0.19, 0.14], [0.31, 0.3, 0.56], [0.15, 0.55, 0.92], [0.3, 0.8, 1.0], [0.58, 0.79, 0.86], [0.64, 0.61, 0.72]]
        let points = F.map { SIMD3<Double>($0.x * w, $0.y * h, $0.z) } + [SIMD3<Double>(Double(centre.x), Double(centre.y), 0.62)]
        let echant = courbe(points, parSegment: 70)
        var X: [Double] = [], Y: [Double] = [], Z: [Double] = [], L: [Double] = []
        for (i, p) in echant.enumerated() {
            X.append(p.x); Y.append(p.y); Z.append(p.z)
            L.append(i == 0 ? 0 : L[i - 1] + hypot(p.x - X[i - 1], p.y - Y[i - 1]))
        }
        self.X = X; self.Y = Y; self.Z = Z; self.L = L
        let longueur = L[L.count - 1]
        func surCourse(_ s0: Double) -> SIMD3<Double> {
            let s = min(max(s0, 0), longueur)
            var a = 0, b = L.count - 1
            while b - a > 1 {
                let m = (a + b) / 2
                if L[m] < s { a = m } else { b = m }
            }
            let f = L[b] > L[a] ? (s - L[a]) / (L[b] - L[a]) : 0
            return SIMD3(X[a] + (X[b] - X[a]) * f, Y[a] + (Y[b] - Y[a]) * f, Z[a] + (Z[b] - Z[a]) * f)
        }
        func aInstant(_ t: Double) -> SIMD3<Double> {
            surCourse(profil((t - Scenario.depart) / (Scenario.arrivee - Scenario.depart)) * longueur)
        }

        // les eclats de la roche : chacun part d'un point de la roche, jaillit,
        // ralentit, devient energie, puis rejoint sa place sur le symbole
        let nombre = w > 900 ? 440 : 320
        let surContour = Int(Double(nombre) * 0.45)
        let cibles = ContourMarque.points(surContour) + GlypheDrop.points(nombre - surContour).map { CGPoint(x: $0.x * 0.56, y: $0.y * 0.56) }
        var E: [SIMD4<Float>] = []
        E.reserveCapacity(nombre * 4)
        for (i, c) in cibles.enumerated() {
            let a = tirage(i, 1) * 2 * .pi, r = sqrt(tirage(i, 2)) * 0.92
            let dev = (tirage(i, 3) - 0.5) * 1.1
            let s = Double(i) / Double(nombre - 1)
            E.append(SIMD4(Float(cos(a) * r), Float(sin(a) * r), Float(cos(a + dev)), Float(sin(a + dev))))
            E.append(SIMD4(Float((80 + 560 * pow(tirage(i, 4), 1.7)) * k), Float((tirage(i, 5) - 0.5) * 12),
                           Float((1.3 + 1.6 * tirage(i, 6) + 5.5 * pow(tirage(i, 14), 6)) * k), Float(tirage(i, 7))))
            E.append(SIMD4(Float(c.x), Float(c.y), Float(Scenario.attraction + s * 0.34 + 0.04 * tirage(i, 8)), Float(0.32 + 0.07 * tirage(i, 9))))
            E.append(SIMD4(Float((0.16 + 0.3 * tirage(i, 10)) * (tirage(i, 11) < 0.82 ? 1 : -1)), tirage(i, 12) < 0.3 ? 1 : 0, Float(s), Float(0.6 + 0.8 * tirage(i, 13))))
        }
        eclats = E

        // quelques etincelles a l'eclat : de l'elan, pas un feu d'artifice
        var T: [SIMD4<Float>] = []
        for i in 0..<28 {
            let a = (Double(i) + tirage(i, 11)) / 28 * 2 * .pi
            T.append(SIMD4(Float(cos(a)), Float(sin(a)), Float((300 + 520 * tirage(i, 12)) * k), Float(0.4 + 0.35 * tirage(i, 13))))
            T.append(SIMD4(Float((0.6 + 0.6 * tirage(i, 14)) * k), 0, 0, 0))
        }
        etincelles = T

        // les braises semees par la trainee, plus nombreuses quand elle va vite
        let nB = w > 900 ? 120 : 84
        var B: [SIMD4<Float>] = []
        var pose = 0, i = 0
        while pose < nB && i < nB * 6 {
            defer { i += 1 }
            let tau = 0.06 + 0.86 * tirage(i, 21)
            let t = Scenario.depart + tau * (Scenario.arrivee - Scenario.depart)
            let p0 = aInstant(t - 0.01), p1 = aInstant(t)
            let v = hypot(p1.x - p0.x, p1.y - p0.y) * 100
            if tirage(i, 22) > min(v / (0.9 * max(w, h)), 1) * 1.1 + 0.08 { continue }
            let l = max(hypot(p1.x - p0.x, p1.y - p0.y), 1e-3)
            let dx = (p1.x - p0.x) / l, dy = (p1.y - p0.y) / l
            let recul = (40 + 170 * tirage(i, 23)) * k, cote2 = (-110 + 220 * tirage(i, 24)) * k
            B.append(SIMD4(Float(t), Float(p1.x), Float(p1.y), Float(0.45 + 0.65 * tirage(i, 25))))
            B.append(SIMD4(Float(-dx * recul - dy * cote2), Float(-dy * recul + dx * cote2),
                           Float((0.55 + 1.1 * tirage(i, 26)) * k * (0.45 + 0.55 * min(p1.z, 1))), Float(0.35 + 0.65 * tirage(i, 27))))
            pose += 1
        }
        braises = B

        // le symbole trace en lumiere : contour, puis tige, pointe et bac, dans
        // l'ordre ou les eclats arrivent
        var segments: [SIMD4<Float>] = []
        func ajoute(_ traits: [[CGPoint]], echelle: CGFloat, glyphe: Bool, de: Double, a: Double) {
            let paires = traits.flatMap { t in zip(t, t.dropFirst()).map { ($0.0, $0.1) } }
            let total = paires.reduce(0) { $0 + hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y) }
            var cumul: CGFloat = 0
            for (p, q) in paires {
                let l = hypot(q.x - p.x, q.y - p.y)
                segments.append(SIMD4(Float(p.x * echelle), Float(p.y * echelle), Float(q.x * echelle), Float(q.y * echelle)))
                segments.append(SIMD4(Float(de + (a - de) * Double(cumul / total)), Float(de + (a - de) * Double((cumul + l) / total)), glyphe ? 1 : 0, 0))
                cumul += l
            }
        }
        ajoute([ContourMarque.trait()], echelle: 1, glyphe: false, de: 0, a: 0.45)
        ajoute(GlypheDrop.traits(), echelle: 0.56, glyphe: true, de: 0.45, a: 1)
        self.segments = segments
    }

    // MARK: La course

    func surCourse(_ s0: Double) -> SIMD3<Double> {
        let s = min(max(s0, 0), longueur)
        var a = 0, b = L.count - 1
        while b - a > 1 {
            let m = (a + b) / 2
            if L[m] < s { a = m } else { b = m }
        }
        let f = L[b] > L[a] ? (s - L[a]) / (L[b] - L[a]) : 0
        return SIMD3(X[a] + (X[b] - X[a]) * f, Y[a] + (Y[b] - Y[a]) * f, Z[a] + (Z[b] - Z[a]) * f)
    }

    func aInstant(_ t: Double) -> SIMD3<Double> {
        surCourse(profil((t - Scenario.depart) / (Scenario.arrivee - Scenario.depart)) * longueur)
    }

    /// l'etat de la meteorite a l'instant t
    func meteore(_ t: Double) -> Meteore {
        var m = Meteore(position: lointain)
        guard t >= Scenario.point - 0.05, t <= Scenario.eclat + 0.3 else { return m }
        m.rotation = 0.85 * t + 0.5 * sin(0.7 * t)
        if t < Scenario.depart {
            // le point lointain s'allume, palpite
            let p0 = aInstant(Scenario.depart), p1 = surCourse(4)
            let l = max(hypot(p1.x - p0.x, p1.y - p0.y), 1e-3)
            m.position = CGPoint(x: p0.x, y: p0.y)
            m.profondeur = p0.z
            m.direction = CGVector(dx: (p1.x - p0.x) / l, dy: (p1.y - p0.y) / l)
            m.intensite = lisse((t - Scenario.point) / 0.3) * (0.62 + 0.08 * sin(t * 11))
        } else if t < Scenario.arrivee {
            let p = aInstant(t), pa = aInstant(t - 1.0 / 120)
            let vx = (p.x - pa.x) * 120, vy = (p.y - pa.y) * 120, v = hypot(vx, vy)
            m.position = CGPoint(x: p.x, y: p.y)
            m.profondeur = p.z
            if v > 1 {
                m.direction = CGVector(dx: vx / v, dy: vy / v)
            } else {
                let pb = aInstant(t - 0.05)
                let l = max(hypot(p.x - pb.x, p.y - pb.y), 1e-3)
                m.direction = CGVector(dx: (p.x - pb.x) / l, dy: (p.y - pb.y) / l)
            }
            m.vitesse = min(v / (1.05 * max(Double(taille.width), Double(taille.height))), 1)
            let scintille = 1 + 0.06 * sin(t * 47) + 0.04 * sin(t * 29 + 1)
            m.intensite = (0.66 + 0.6 * m.vitesse) * scintille * (0.62 + 0.38 * lisse((t - Scenario.depart) / 0.25))
            m.chaleur = 0.35 + 0.65 * m.vitesse
        } else {
            // immobile au centre : elle flotte a peine, se fissure, la lumiere
            // monte en deux battements, puis elle se fragmente
            let h = t - Scenario.arrivee
            m.position = CGPoint(x: centre.x, y: centre.y + sin(h * 3.2) * 1.2 * k * (1 - lisse((t - Scenario.eclat + 0.1) / 0.1)))
            m.profondeur = zFin
            let pb = aInstant(Scenario.arrivee - 0.08)
            let l = max(hypot(m.position.x - pb.x, m.position.y - pb.y), 1e-3)
            m.direction = CGVector(dx: (m.position.x - pb.x) / l, dy: (m.position.y - pb.y) / l)
            m.fissures = lisse((h - 0.03) / (Scenario.eclat - Scenario.arrivee - 0.05))
            let battement = 0.22 * exp(-pow(t - (Scenario.eclat - 0.24), 2) / 0.0012) + 0.32 * exp(-pow(t - (Scenario.eclat - 0.06), 2) / 0.0012)
            m.intensite = 0.78 + 0.35 * m.fissures + battement
            m.chaleur = 0.25 + 0.3 * (1 - lisse(h / 0.3))
            m.dissolution = lisse((t - Scenario.eclat) / 0.17)
        }
        m.rayon = max(Rmax * m.profondeur, 0.5)
        return m
    }

    static let pointsTrainee = 28

    /// la trainee : les dernieres positions, de la tete vers la queue
    func trainee(_ t: Double, vitesse: Double) -> [Float] {
        let n = Self.pointsTrainee
        guard t > Scenario.depart, t < Scenario.arrivee + 0.35 else { return [Float](repeating: 0, count: 8) }
        let retrait = 1 - lisse((t - (Scenario.arrivee - 0.2)) / 0.5)
        let monte = min((t - Scenario.depart) / 0.18, 1)
        let tTete = min(t, Scenario.arrivee)
        var sortie: [Float] = []
        sortie.reserveCapacity(n * 4)
        for j in 0..<n {
            let tj = max(tTete - Double(j) * 0.0135, Scenario.depart)
            let p = aInstant(tj)
            let f = 1 - Double(j) / Double(n - 1)
            sortie += [
                Float(p.x), Float(p.y),
                Float(Rmax * p.z * 0.62 * pow(f, 0.75) * (0.45 + 0.55 * vitesse) + 0.5),
                Float(pow(f, 1.5) * (0.25 + 1.05 * vitesse) * monte * retrait),
            ]
        }
        return sortie
    }

    /// une secousse breve a l'eclat (quelques points, amortie)
    func secousse(_ a: Double) -> CGPoint {
        guard a > 0, a < 0.4 else { return .zero }
        let amplitude = 2.2 * k * exp(-a / 0.08)
        return CGPoint(x: sin(a * 90) * amplitude, y: cos(a * 71) * amplitude * 0.8)
    }

    /// l'onde qui ouvre l'interface : rayon, largeur du bord, eclat du bord
    func onde(_ t: Double) -> (rayon: Double, bord: Double, eclat: Double) {
        guard t >= Scenario.revelation else { return (0, 0, 0) }
        let s = min((t - Scenario.revelation) / Scenario.dureeRevelation, 1)
        let e = 1 - pow(1 - s, 1.8)
        let bord = (80 + 160 * e) * k
        // jusqu'au coin le plus eloigne (bord compris) : la meme traversee
        // sur un telephone et sur un grand ecran
        let coin = hypot(max(centre.x, taille.width - centre.x), max(centre.y, taille.height - centre.y))
        return (cote * 0.6 + e * (coin + bord * 1.3), bord, pow(1 - s, 1.3) * 0.95)
    }
}
