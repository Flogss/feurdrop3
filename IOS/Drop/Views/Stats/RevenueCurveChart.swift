import SwiftUI
import DropKit

/// Les revenus par jour : une courbe qui se trace de gauche a droite, tete
/// lumineuse en premier ; chaque point s'allume au passage avec sa valeur, le
/// record prend sa pastille, et le dernier point continue de battre.
///
/// Dessinee a la main plutot qu'avec Swift Charts : le trace progressif, la
/// tete qui suit exactement la courbe et l'allumage des points au passage
/// demandent de piloter chaque image.
struct RevenueCurveChart: View {
    let days: [DayRevenue]
    let reveal: Int
    @Binding var range: String

    @State private var progress: Double = 0
    @State private var selection: Int?
    @State private var dejaVu = -1
    /// d'ou part la tete : le bord gauche de ce qu'on voit (les jours plus
    /// anciens, hors de l'ecran, sont deja traces)
    @State private var depart: CGFloat = 0
    @State private var traceFini = false
    /// le defilement courant, lu au depart du trace (une classe : le suivre
    /// ne fait pas recalculer la vue a chaque image de defilement)
    @State private var defilement = Defilement()

    private final class Defilement {
        var x: CGFloat = 0
        /// le jour sous la souris (Mac)
        var survole: Int?
    }

    static let spacing: CGFloat = 54
    static let height: CGFloat = 230

    var body: some View {
        GeometryReader { geo in
            let largeur = max(geo.size.width, CGFloat(days.count) * Self.spacing)
            let geometrie = CurveGeometry(values: days.map(\.value), width: largeur, height: Self.height)
            ScrollView(.horizontal) {
                ZStack(alignment: .topLeading) {
                    // trois couches : ce qui ne bouge pas (grille, jours), la courbe
                    // dessinee une fois et devoilee par un masque, puis seulement ce
                    // qui change a chaque image (tete, points, valeurs)
                    CurveBase(geometry: geometrie, labels: days.map { ServerDate.weekdayShort($0.date) })
                        .frame(width: largeur, height: Self.height)
                    CurveTrace(geometry: geometrie)
                        .frame(width: largeur, height: Self.height)
                        .mask(alignment: .topLeading) {
                            RevealMask(debut: depart, fin: geometrie.points.last?.x ?? 0, progress: progress)
                        }
                    CurvePoints(geometry: geometrie, depart: depart, progress: progress, selection: selection)
                        .frame(width: largeur, height: Self.height)
                    if traceFini, let dernier = geometrie.points.last {
                        DernierPoint()
                            .position(dernier)
                    }
                    if let i = selection, i < days.count {
                        Bulle(day: days[i])
                            .position(x: min(max(geometrie.points[i].x, 80), largeur - 80), y: max(geometrie.points[i].y - 52, 30))
                            .transition(.scale(scale: 0.7, anchor: .bottom).combined(with: .opacity))
                    }
                }
                .frame(width: largeur, height: Self.height)
                .contentShape(.rect)
                .gesture(SpatialTapGesture().onEnded { tap in
                    let i = geometrie.nearest(x: tap.location.x)
                    withAnimation(Theme.bouncy) { selection = selection == i ? nil : i }
                    Haptics.selection()
                })
                #if os(macOS)
                // a la souris : la valeur du jour survole, la bulle suit le pointeur
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let p):
                        let i = geometrie.nearest(x: p.x)
                        guard i != defilement.survole, traceFini else { return }
                        defilement.survole = i
                        withAnimation(.snappy(duration: 0.22)) { selection = i }
                    case .ended:
                        defilement.survole = nil
                        if selection != nil { withAnimation(.snappy(duration: 0.22)) { selection = nil } }
                    }
                }
                #endif
            }
            .sansIndicateurs()
            .defaultScrollAnchor(.trailing)
            .tirerPourDefiler()
            .onScrollGeometryChange(for: ClosedRange<Int>.self) { g in
                defilement.x = g.contentOffset.x
                return visibles(offset: g.contentOffset.x, largeur: g.containerSize.width)
            } action: { _, visibles in
                range = texte(visibles)
            }
        }
        .frame(height: Self.height)
        .onChange(of: reveal, initial: true) { rejoue() }
        .onChange(of: days) {
            if progress < 1 { return }
            selection = nil
        }
    }

    private func rejoue() {
        guard reveal != dejaVu, !days.isEmpty else { return }
        dejaVu = reveal
        selection = nil
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) {
            progress = 0
            traceFini = false
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(0.35))
            // la tete part du bord gauche de l'ecran, pas du premier jour (hors
            // de l'ecran, on ne voyait rien pendant presque tout le trace)
            let premierX = Self.spacing / 2
            withTransaction(t) { depart = max(premierX, defilement.x - 12) }
            withAnimation(.timingCurve(0.45, 0.05, 0.2, 1, duration: 2.0)) {
                progress = 1
            } completion: {
                traceFini = true
            }
        }
    }

    private func visibles(offset: CGFloat, largeur: CGFloat) -> ClosedRange<Int> {
        guard !days.isEmpty else { return 0...0 }
        let premier = Int((offset / Self.spacing).rounded(.down))
        let dernier = Int(((offset + largeur) / Self.spacing).rounded(.up)) - 1
        let a = min(max(premier, 0), days.count - 1)
        let b = min(max(dernier, a), days.count - 1)
        return a...b
    }

    private func texte(_ r: ClosedRange<Int>) -> String {
        guard !days.isEmpty else { return "—" }
        return "\(ServerDate.dayMonth(days[r.lowerBound].date)) – \(ServerDate.dayMonth(days[r.upperBound].date))"
    }

    /// la valeur d'un jour touche
    private struct Bulle: View {
        let day: DayRevenue

        var body: some View {
            VStack(spacing: 1) {
                Text(ServerDate.longDay(day.date)).font(.caption2.weight(.semibold)).foregroundStyle(Theme.text2)
                Text(Format.euro(day.value)).font(.subheadline.weight(.bold).monospacedDigit())
                Text(Format.count(day.count, "colis", "colis")).font(.caption2).foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .glassEffect(.regular.tint(Theme.violet.opacity(0.3)), in: .rect(cornerRadius: 14))
            .fixedSize()
        }
    }

    /// le dernier point bat doucement : c'est aujourd'hui
    private struct DernierPoint: View {
        @State private var bat = false

        var body: some View {
            ZStack {
                Circle().stroke(Theme.violetLight, lineWidth: 2)
                    .frame(width: 14, height: 14)
                    .scaleEffect(bat ? 2.6 : 1)
                    .opacity(bat ? 0 : 0.9)
                Circle().fill(.white)
                    .frame(width: 9, height: 9)
                    .shadow(color: Theme.violet, radius: 8)
            }
            .allowsHitTesting(false)
            .onAppear {
                withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { bat = true }
            }
        }
    }
}

/// Les points, la courbe lissee et sa version echantillonnee (pour placer la
/// tete exactement sur le trait).
struct CurveGeometry {
    let points: [CGPoint]
    let samples: [CGPoint]
    let path: Path
    let baseY: CGFloat
    let maxValue: Double
    let best: Int?
    let values: [Double]

    static let padTop: CGFloat = 40
    static let padBottom: CGFloat = 30

    init(values: [Double], width: CGFloat, height: CGFloat) {
        self.values = values
        let plafond = max(values.max() ?? 0, 1) * 1.08
        maxValue = plafond
        baseY = height - Self.padBottom
        let hauteurUtile = baseY - Self.padTop
        let pas = values.isEmpty ? 0 : width / CGFloat(values.count)
        points = values.enumerated().map { i, v in
            CGPoint(x: pas / 2 + CGFloat(i) * pas, y: Self.padTop + hauteurUtile * (1 - CGFloat(v / plafond)))
        }
        let meilleur = values.indices.max(by: { values[$0] < values[$1] })
        best = (meilleur.map { values[$0] > 0 } ?? false) ? meilleur : nil

        // Catmull-Rom -> Bezier, controles bornes au plancher : la courbe ne
        // plonge jamais sous zero entre deux jours a zero
        var p = Path()
        var echantillons: [CGPoint] = []
        if let premier = points.first {
            p.move(to: premier)
            echantillons.append(premier)
            for i in 0..<(points.count - 1) {
                let p0 = points[max(i - 1, 0)], p1 = points[i], p2 = points[i + 1], p3 = points[min(i + 2, points.count - 1)]
                let c1 = CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: min(p1.y + (p2.y - p0.y) / 6, baseY))
                let c2 = CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: min(p2.y - (p3.y - p1.y) / 6, baseY))
                p.addCurve(to: p2, control1: c1, control2: c2)
                for k in 1...14 {
                    let t = CGFloat(k) / 14
                    let u = 1 - t
                    let x = u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x
                    let y = u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y
                    echantillons.append(CGPoint(x: x, y: y))
                }
            }
        }
        path = p
        samples = echantillons
    }

    /// le point de la courbe a l'abscisse x
    func point(atX x: CGFloat) -> CGPoint {
        guard let premier = samples.first else { return .zero }
        guard x > premier.x else { return premier }
        var bas = 0, haut = samples.count - 1
        while haut - bas > 1 {
            let m = (bas + haut) / 2
            if samples[m].x < x { bas = m } else { haut = m }
        }
        let a = samples[bas], b = samples[haut]
        let t = b.x == a.x ? 0 : (x - a.x) / (b.x - a.x)
        return CGPoint(x: x, y: a.y + (b.y - a.y) * min(max(t, 0), 1))
    }

    func nearest(x: CGFloat) -> Int {
        points.indices.min(by: { abs(points[$0].x - x) < abs(points[$1].x - x) }) ?? 0
    }
}

/// La grille et les jours : ne dependent que des donnees, dessines une fois.
private struct CurveBase: View {
    let geometry: CurveGeometry
    let labels: [String]

    var body: some View {
        Canvas(rendersAsynchronously: true) { ctx, taille in
            let g = geometry
            for k in 0...2 {
                let y = CurveGeometry.padTop + (g.baseY - CurveGeometry.padTop) * CGFloat(k) / 2
                var ligne = Path()
                ligne.move(to: CGPoint(x: 0, y: y))
                ligne.addLine(to: CGPoint(x: taille.width, y: y))
                ctx.stroke(ligne, with: .color(.white.opacity(k == 2 ? 0.1 : 0.05)), style: StrokeStyle(lineWidth: 1, dash: k == 2 ? [] : [3, 5]))
            }
            for (i, p) in g.points.enumerated() where i < labels.count {
                let dernierJour = i == g.points.count - 1
                let texte = Text(dernierJour ? "Auj." : labels[i])
                    .font(.system(size: 10.5, weight: dernierJour ? .bold : .medium))
                    .foregroundStyle(dernierJour ? Theme.violetLight : Theme.text3)
                ctx.draw(texte, at: CGPoint(x: p.x, y: taille.height - 8), anchor: .center)
            }
        }
    }
}

/// L'aire, le halo et le trait : la courbe entiere, dessinee UNE fois (avec
/// son flou) et gardee en texture. Le trace progressif est un masque qui
/// s'elargit : plus de flou recalcule a chaque image.
private struct CurveTrace: View {
    let geometry: CurveGeometry

    var body: some View {
        Canvas { ctx, taille in
            let g = geometry
            guard let premier = g.points.first, let dernier = g.points.last else { return }
            var aire = g.path
            aire.addLine(to: CGPoint(x: dernier.x, y: g.baseY))
            aire.addLine(to: CGPoint(x: premier.x, y: g.baseY))
            aire.closeSubpath()
            ctx.fill(aire, with: .linearGradient(
                Gradient(colors: [Theme.violet.opacity(0.42), Theme.violet.opacity(0.08), .clear]),
                startPoint: CGPoint(x: 0, y: CurveGeometry.padTop), endPoint: CGPoint(x: 0, y: g.baseY)
            ))
            ctx.drawLayer { halo in
                halo.addFilter(.blur(radius: 7))
                halo.stroke(g.path, with: .color(Theme.violet.opacity(0.9)), style: StrokeStyle(lineWidth: 5, lineCap: .round))
            }
            ctx.stroke(g.path, with: .linearGradient(
                Gradient(colors: [Theme.violetDeep, Theme.violetBright, Theme.violetPale]),
                startPoint: .zero, endPoint: CGPoint(x: taille.width, y: 0)
            ), style: StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
        }
        .drawingGroup()
    }
}

/// Le masque du trace : tout ce qui est a gauche de la tete.
private nonisolated struct RevealMask: Shape {
    let debut: CGFloat
    let fin: CGFloat
    var progress: Double

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let teteX = debut + (fin - debut) * progress
        return Path(CGRect(x: 0, y: 0, width: teteX + 1, height: rect.height))
    }
}

/// Ce qui change a chaque image du trace : la tete lumineuse, et les points
/// qui s'allument au passage avec leur valeur. Les textes et le halo de la
/// tete sont prepares une fois (symboles) puis seulement poses.
private struct CurvePoints: View, Animatable {
    let geometry: CurveGeometry
    let depart: CGFloat
    var progress: Double
    let selection: Int?

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    private enum Symbole: Hashable { case valeur(Int), record, lueur }

    var body: some View {
        Canvas(rendersAsynchronously: true) { ctx, taille in
            let g = geometry
            guard let dernier = g.points.last else { return }
            let teteX = depart + (dernier.x - depart) * progress
            let tete = g.point(atX: teteX)

            for (i, p) in g.points.enumerated() {
                let passe = (teteX - p.x) / 26
                guard passe > 0 else { continue }
                let pop = min(passe, 1)
                let rebond = 1 + 0.45 * sin(.pi * pop) * (1 - pop * 0.3)
                let estRecord = i == g.best
                let estChoisi = i == selection
                let r = (estRecord || estChoisi ? 5.5 : 3.6) * rebond
                if estChoisi {
                    var repere = Path()
                    repere.move(to: CGPoint(x: p.x, y: p.y))
                    repere.addLine(to: CGPoint(x: p.x, y: g.baseY))
                    ctx.stroke(repere, with: .color(Theme.violetLight.opacity(0.5)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - r * 2.2, y: p.y - r * 2.2, width: r * 4.4, height: r * 4.4)), with: .color(Theme.violet.opacity(0.22 * pop)))
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(estRecord ? .white : Theme.violetPale))
                ctx.stroke(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(Theme.violetDeep), lineWidth: 1.4)

                if g.values[i] > 0, let valeur = ctx.resolveSymbol(id: Symbole.valeur(i)) {
                    ctx.opacity = pop
                    ctx.draw(valeur, at: CGPoint(x: p.x, y: p.y - 14 - 6 * pop), anchor: .bottom)
                    if estRecord, let badge = ctx.resolveSymbol(id: Symbole.record) {
                        ctx.draw(badge, at: CGPoint(x: p.x, y: p.y - 30 - 6 * pop), anchor: .bottom)
                    }
                    ctx.opacity = 1
                }
            }

            // la tete lumineuse, tant que le trace avance
            if progress > 0.001 && progress < 0.999 {
                if let lueur = ctx.resolveSymbol(id: Symbole.lueur) { ctx.draw(lueur, at: tete) }
                ctx.fill(Path(ellipseIn: CGRect(x: tete.x - 5, y: tete.y - 5, width: 10, height: 10)), with: .color(.white))
            }
        } symbols: {
            ForEach(Array(geometry.values.enumerated()), id: \.offset) { i, v in
                let estRecord = i == geometry.best
                Text(Format.euroGraphe(v))
                    .font(.system(size: estRecord ? 11.5 : 10, weight: estRecord ? .bold : .semibold).monospacedDigit())
                    .foregroundStyle(estRecord ? Theme.violetPale : Theme.text2)
                    .tag(Symbole.valeur(i))
            }
            Text("Record").font(.system(size: 9, weight: .heavy)).foregroundStyle(Theme.violetBright).tag(Symbole.record)
            // le halo de la tete : un disque flou, rendu une fois
            Circle().fill(Theme.violetBright).frame(width: 28, height: 28).blur(radius: 10).padding(20).tag(Symbole.lueur)
        }
    }
}
