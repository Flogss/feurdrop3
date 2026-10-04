import SwiftUI

/// Le calendrier du lancement (en secondes), le meme sur le site :
/// - 0,12 : un point violet s'allume au loin, dans l'espace graphite ;
/// - 0,30 → 1,30 : la meteorite plonge vers le centre sur une courbe, en
///   accelerant (sa trainee s'allonge, les etoiles s'etirent, la lumiere se
///   courbe autour d'elle), puis freine et se comprime juste avant l'impact ;
/// - 1,30 : l'impact -- un eclair contenu, un trait anamorphique, deux ondes
///   de choc qui font onduler le fond, des etincelles, une legere secousse ;
/// - 1,30 → 2,20 : les fragments jaillissent, ralentissent, puis reviennent
///   en spirale dessiner le symbole de DROP (la fleche qui tombe dans le
///   bac : la chute de la meteorite) ;
/// - 2,12 : la lumiere se condense en logo, un reflet le traverse ;
/// - 2,45 : une onde de lumiere part du logo et ouvre l'interface, qui
///   arrive avec ses propres animations ; le logo rejoint sa place dans la
///   barre (Mac) ou se dissout dans l'onde (iPhone).
nonisolated enum Scenario {
    static let point = 0.12
    static let depart = 0.30
    static let impact = 1.30
    static let logo = 2.12
    static let revelation = 2.45
    static let dureeRevelation = 0.8
    static let vol = 0.62
    static let fin = 3.30
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
    var onRevelation: () -> Void
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
    /// `-DropIntroFige 1.3` : la sequence arretee a cet instant (photos)
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
            // mouvements reduits : pas de meteorite, le logo puis l'onde
            recommence(a: reduceMotion ? Scenario.logo : 0)
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
        if Date.now.timeIntervalSince(debut) < Scenario.logo - 0.05 { recommence(a: Scenario.logo) }
    }

    private func recommence(a instant: Double) {
        debut = Date.now.addingTimeInterval(-instant)
        moteur.recommence(a: instant)
    }

    /// Les moments ou l'app reagit : le retour tactile de l'impact et du
    /// logo, l'ouverture de l'interface, la pose du logo, la fin.
    private func deroule() async {
        #if DEBUG
        if let fige = Self.fige {
            logoActif = fige >= Scenario.logo - 0.05
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
        if deja < Scenario.impact {
            guard await attends(Scenario.impact) else { return }
            Haptics.impact()
        }
        guard await attends(Scenario.logo - 0.05) else { return }
        logoActif = true
        if deja < Scenario.logo + 0.08 {
            guard await attends(Scenario.logo + 0.08) else { return }
            Haptics.soft()
        }
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

    /// Le logo : il se condense dans la lumiere des particules, un reflet le
    /// traverse, puis il rejoint la barre ou se dissout dans l'onde.
    @ViewBuilder
    private func logo(_ t: Double, _ d: DecorLancement, _ origine: CGPoint) -> some View {
        let apparition = lisse((t - Scenario.logo) / 0.24)
        if apparition > 0 {
            let r = t - Scenario.revelation
            let geste = logoApres(r, d, origine)
            if geste.opacite > 0 {
                ZStack {
                    // le halo du logo
                    RadialGradient(colors: [Theme.violet.opacity(0.55 * apparition * geste.lueur), .clear], center: .center, startRadius: 0, endRadius: geste.cote * 1.1)
                        .frame(width: geste.cote * 2.6, height: geste.cote * 2.6)
                    MarqueDrop(cote: geste.cote)
                        .overlay { Reflet(progres: (t - (Scenario.logo + 0.12)) / 0.42, cote: geste.cote) }
                        .shadow(color: Theme.violet.opacity(0.8 * geste.lueur), radius: geste.cote * 0.22, y: geste.cote * 0.05)
                        .scaleEffect(geste.echelle * (0.86 + 0.14 * sortDouce(apparition)))
                }
                .blur(radius: geste.flou)
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
    }

    private func logoApres(_ r: Double, _ d: DecorLancement, _ origine: CGPoint) -> Geste {
        var g = Geste(centre: d.centre, cote: d.cote)
        guard r > 0 else { return g }
        if let cible {
            // il vole jusqu'a la barre, en arc, et se pose a la taille de la marque
            let f = entreeSortie(min(r / Scenario.vol, 1))
            let arrivee = CGPoint(x: cible.midX - origine.x, y: cible.midY - origine.y)
            g.centre = CGPoint(
                x: d.centre.x + (arrivee.x - d.centre.x) * f,
                y: d.centre.y + (arrivee.y - d.centre.y) * f - sin(.pi * f) * 50 * d.k
            )
            g.cote = d.cote + (cible.width - d.cote) * f
            g.echelle = 1 + 0.06 * sin(.pi * f)
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

// MARK: - Le decor : la course et les particules

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

/// un tirage stable dans 0...1
nonisolated private func tirage(_ i: Int, _ k: Int) -> Double {
    let x = sin(Double(i) * 12.9898 + Double(k) * 78.233) * 43758.5453
    return x - x.rounded(.down)
}

nonisolated struct DecorLancement: Sendable {
    let taille: CGSize
    /// l'echelle : 1 sur un telephone, plus sur un grand ecran
    let k: CGFloat
    let depart: CGPoint
    let controle: CGPoint
    let centre: CGPoint
    /// le cote du logo
    let cote: CGFloat
    let diag: CGFloat
    let particules: [Particule]
    let braises: [Braise]
    let etincelles: [Etincelle]


    struct Particule {
        let cible: CGPoint
        let direction: CGVector
        let elan: CGFloat
        let debut: Double
        let duree: Double
        let spirale: CGFloat
        let rayon: CGFloat
        let blanche: Bool
    }

    struct Braise {
        let naissance: Double
        let position: CGPoint
        let vitesse: CGVector
        let vie: Double
        let rayon: CGFloat
        let eclat: Double
    }

    struct Etincelle {
        let direction: CGVector
        let elan: CGFloat
        let vie: Double
        let largeur: CGFloat
    }

    struct Meteore {
        var position: CGPoint = .zero
        var intensite: Double = 0
        var halo: Double = 1
        var direction = CGVector(dx: 1, dy: 0)
        var vitesse: Double = 0
        var profondeur: Double = 0
    }

    init(taille: CGSize) {
        self.taille = taille
        let w = taille.width, h = taille.height
        let petit = min(w, h)
        let k = min(max(petit / 400, 0.9), 1.7)
        self.k = k
        let depart = CGPoint(x: 0.10 * w, y: 0.15 * h)
        self.depart = depart
        let controle = CGPoint(x: 0.74 * w, y: 0.02 * h)
        self.controle = controle
        let centre = CGPoint(x: 0.5 * w, y: (w > h ? 0.47 : 0.42) * h)
        self.centre = centre
        let cote = min(max(petit * 0.30, 96), 150)
        self.cote = cote
        diag = hypot(w, h)

        // les particules : 45 % sur le contour du carre, 55 % sur le symbole
        let nombre = w > 900 ? 480 : 340
        let surContour = Int(Double(nombre) * 0.45)
        let cibles = ContourMarque.points(surContour)
            + GlypheDrop.points(nombre - surContour).map { CGPoint(x: $0.x * 0.56, y: $0.y * 0.56) }
        particules = cibles.enumerated().map { i, c in
            let angle = tirage(i, 1) * 2 * .pi
            return Particule(
                cible: c,
                direction: CGVector(dx: cos(angle), dy: sin(angle)),
                elan: (200 + 560 * tirage(i, 2)) * k,
                debut: Scenario.impact + 0.10 + 0.30 * tirage(i, 3),
                duree: 0.48 + 0.24 * tirage(i, 4),
                spirale: (0.18 + 0.25 * tirage(i, 5)) * (tirage(i, 6) < 0.5 ? -1 : 1),
                rayon: (0.75 + 1.1 * tirage(i, 7)) * k,
                blanche: tirage(i, 8) < 0.28
            )
        }

        // les etincelles de l'impact
        etincelles = (0..<48).map { i in
            let angle = (Double(i) + tirage(i, 11)) / 48 * 2 * .pi
            return Etincelle(
                direction: CGVector(dx: cos(angle), dy: sin(angle)),
                elan: (380 + 760 * tirage(i, 12)) * k,
                vie: 0.45 + 0.4 * tirage(i, 13),
                largeur: (0.7 + 0.8 * tirage(i, 14)) * k
            )
        }

        // les braises semees pendant la course
        var semees: [Braise] = []
        let s = depart, q = controle, c = centre
        func point(_ u: Double) -> CGPoint {
            let v = 1 - u
            return CGPoint(x: v * v * s.x + 2 * u * v * q.x + u * u * c.x, y: v * v * s.y + 2 * u * v * q.y + u * u * c.y)
        }
        for i in 0..<72 {
            let tau = 0.08 + 0.9 * pow(tirage(i, 21), 0.7)
            let naissance = Scenario.depart + tau * (Scenario.impact - Scenario.depart)
            let u = DecorLancement.progression(naissance)
            let p = point(u)
            let avant = point(max(u - 0.01, 0))
            var dir = CGVector(dx: p.x - avant.x, dy: p.y - avant.y)
            let l = max(hypot(dir.dx, dir.dy), 0.001)
            dir = CGVector(dx: dir.dx / l, dy: dir.dy / l)
            let recul = (30 + 160 * tirage(i, 22)) * k
            let cote = (-150 + 300 * tirage(i, 23)) * k
            let z = DecorLancement.profondeur(u)
            semees.append(Braise(
                naissance: naissance,
                position: p,
                vitesse: CGVector(dx: -dir.dx * recul - dir.dy * cote, dy: -dir.dy * recul + dir.dx * cote),
                vie: 0.25 + 0.4 * tirage(i, 24),
                rayon: (0.5 + 1.0 * tirage(i, 25)) * k * (0.4 + 0.6 * z),
                eclat: 0.35 + 0.65 * tirage(i, 26)
            ))
        }
        braises = semees
    }

    // MARK: La course

    /// l'avancee sur la courbe : elle accelere, puis freine avant l'impact
    static func progression(_ t: Double) -> Double {
        let tau = min(max((t - Scenario.depart) / (Scenario.impact - Scenario.depart), 0), 1)
        return 1 - pow(1 - pow(tau, 2.4), 1.7)
    }

    /// la profondeur : un point au loin, puis tout pres
    static func profondeur(_ u: Double) -> Double { 0.10 + 0.90 * pow(u, 1.6) }

    func point(_ u: Double) -> CGPoint {
        let v = 1 - u
        return CGPoint(
            x: v * v * depart.x + 2 * u * v * controle.x + u * u * centre.x,
            y: v * v * depart.y + 2 * u * v * controle.y + u * u * centre.y
        )
    }

    func meteore(_ t: Double) -> Meteore {
        guard t >= Scenario.point, t < Scenario.impact else { return Meteore() }
        var m = Meteore()
        let u = Self.progression(t)
        m.position = point(u)
        m.profondeur = Self.profondeur(u)
        if t < Scenario.depart {
            // le point lointain s'allume, scintille
            let f = lisse((t - Scenario.point) / 0.14)
            m.intensite = 0.8 * f * (1 + 0.6 * exp(-(t - Scenario.point) / 0.07))
            let tangente = CGVector(dx: controle.x - depart.x, dy: controle.y - depart.y)
            let l = hypot(tangente.dx, tangente.dy)
            m.direction = CGVector(dx: tangente.dx / l, dy: tangente.dy / l)
        } else {
            let avant = point(Self.progression(t - 1.0 / 120))
            let v = CGVector(dx: (m.position.x - avant.x) * 120, dy: (m.position.y - avant.y) * 120)
            let vitesse = hypot(v.dx, v.dy)
            if vitesse > 1 { m.direction = CGVector(dx: v.dx / vitesse, dy: v.dy / vitesse) }
            m.vitesse = min(vitesse / (1.4 * max(taille.width, taille.height)), 1)
            let compression = lisse((t - (Scenario.impact - 0.13)) / 0.13)
            let scintille = 1 + 0.07 * sin(t * 53) + 0.05 * sin(t * 31 + 1)
            m.intensite = (0.78 + 0.5 * m.vitesse) * scintille * (1 + 1.4 * compression)
        }
        let compression = lisse((t - (Scenario.impact - 0.13)) / 0.13)
        m.halo = 80 * m.profondeur * k * (1 + 0.25 * compression)
        return m
    }

    /// la trainee : les dernieres positions, de la tete vers la queue
    func trainee(_ t: Double) -> [Float] {
        let n = 26
        guard t > Scenario.depart, t < Scenario.impact else { return [Float](repeating: 0, count: 8) }
        let retrait = 1 - lisse((t - (Scenario.impact - 0.14)) / 0.14)
        let vitesse = meteore(t).vitesse
        let monte = min((t - Scenario.depart) / 0.12, 1)
        var sortie: [Float] = []
        sortie.reserveCapacity(n * 4)
        for j in 0..<n {
            let tj = max(t - Double(j) * 0.0125 * retrait, Scenario.depart)
            let u = Self.progression(tj)
            let p = point(u)
            let f = 1 - Double(j) / Double(n - 1)
            sortie += [
                Float(p.x), Float(p.y),
                Float(7.5 * k * Self.profondeur(u) * pow(f, 0.9) + 0.4),
                Float(pow(f, 1.7) * (0.3 + 0.95 * vitesse) * monte),
            ]
        }
        return sortie
    }

    /// une secousse breve a l'impact (quelques points, amortie)
    func secousse(_ a: Double) -> CGPoint {
        guard a > 0, a < 0.45 else { return .zero }
        let amplitude = 3.0 * k * exp(-a / 0.09)
        return CGPoint(x: sin(a * 95) * amplitude, y: cos(a * 73) * amplitude * 0.8)
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

    // MARK: Pour la carte graphique

    /// les particules, braises, etincelles et segments du symbole, en
    /// paquets de quatre nombres (voir les structures des shaders)
    func donneesGPU() -> (particules: [SIMD4<Float>], braises: [SIMD4<Float>], etincelles: [SIMD4<Float>], segments: [SIMD4<Float>]) {
        var p: [SIMD4<Float>] = []
        for x in particules {
            p.append(SIMD4(Float(x.cible.x), Float(x.cible.y), Float(x.direction.dx), Float(x.direction.dy)))
            p.append(SIMD4(Float(x.elan), Float(x.debut), Float(x.duree), Float(x.spirale)))
            p.append(SIMD4(Float(x.rayon), x.blanche ? 1 : 0, 0, 0))
        }
        var b: [SIMD4<Float>] = []
        for x in braises {
            b.append(SIMD4(Float(x.naissance), Float(x.position.x), Float(x.position.y), Float(x.vie)))
            b.append(SIMD4(Float(x.vitesse.dx), Float(x.vitesse.dy), Float(x.rayon), Float(x.eclat)))
        }
        var e: [SIMD4<Float>] = []
        for x in etincelles {
            e.append(SIMD4(Float(x.direction.dx), Float(x.direction.dy), Float(x.elan), Float(x.vie)))
            e.append(SIMD4(Float(x.largeur), 0, 0, 0))
        }
        // le symbole : le contour (trace sur son pourtour), puis le glyphe
        // (tige, pointe, bac, l'un apres l'autre), en parts de leur trace
        var segments: [SIMD4<Float>] = []
        func ajoute(_ traits: [[CGPoint]], echelle: CGFloat, glyphe: Bool) {
            let paires = traits.flatMap { t in zip(t, t.dropFirst()).map { ($0.0, $0.1) } }
            let total = paires.reduce(0) { $0 + hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y) }
            var cumul: CGFloat = 0
            for (a, b) in paires {
                let l = hypot(b.x - a.x, b.y - a.y)
                segments.append(SIMD4(Float(a.x * echelle), Float(a.y * echelle), Float(b.x * echelle), Float(b.y * echelle)))
                segments.append(SIMD4(Float(cumul / total), Float((cumul + l) / total), glyphe ? 1 : 0, 0))
                cumul += l
            }
        }
        ajoute([ContourMarque.trait()], echelle: 1, glyphe: false)
        ajoute(GlypheDrop.traits(), echelle: 0.56, glyphe: true)
        return (p, b, e, segments)
    }
}
