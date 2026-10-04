import SwiftUI
import DropKit

/// L'anneau : les parts se dessinent l'une apres l'autre, comme un trait qui
/// fait le tour, pendant que l'anneau finit de tourner. Toucher une part (ou
/// sa ligne de legende) la fait ressortir, et le centre affiche son montant.
/// Il ne se rejoue qu'a l'arrivee sur l'ecran, jamais en boucle.
struct DonutChart: View {
    let slices: [DonutSlice]
    let reveal: Int
    var centerLabel = "total"
    var format: (Double) -> String = Format.euroCompact

    @State private var progress: Double = 0
    @State private var selection: String?
    @State private var dejaVu = -1
    @State private var visible = false

    private var total: Double { slices.reduce(0) { $0 + $1.value } }

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                DonutRing(slices: slices, progress: progress, selection: selection)
                    .frame(width: 210, height: 210)
                    .rotationEffect(.degrees(-90 - 110 * (1 - progress)))
                    .contentShape(.circle)
                    .gesture(SpatialTapGesture().onEnded { tap in
                        choisis(partAt: tap.location, taille: 210)
                    })
                    #if os(macOS)
                    // a la souris, comme sur le site : la part survolee ressort
                    .onContinuousHover { phase in
                        guard case .active(let p) = phase, progress > 0.95, let id = part(at: p, taille: 210), id != selection else { return }
                        withAnimation(Theme.bouncy) { selection = id }
                    }
                    #endif
                centre
            }
            .frame(maxWidth: .infinity)

            legende
        }
        #if os(macOS)
        .onHover { dedans in
            if !dedans && selection != nil { withAnimation(Theme.spring) { selection = nil } }
        }
        #endif
        .onScrollVisibilityChange(threshold: 0.4) { vu in
            visible = vu
            if vu { rejoue() }
        }
        .onChange(of: reveal) {
            if visible { rejoue() } else { dejaVu = -1 }
        }
        .sensoryFeedback(.selection, trigger: selection)
        #if DEBUG
        // `-DropDonutChoix 0` : une part choisie (photos)
        .task {
            guard let i = UserDefaults.standard.string(forKey: "DropDonutChoix").flatMap(Int.init), i < slices.count else { return }
            try? await Task.sleep(for: .seconds(3))
            withAnimation(Theme.bouncy) { selection = slices[i].id }
        }
        #endif
    }

    private var centre: some View {
        let choisie = slices.first { $0.id == selection }
        return VStack(spacing: 2) {
            if let choisie {
                Text(choisie.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(choisie.color)
                    .lineLimit(1)
                Text(format(choisie.value))
                    .font(.system(size: 24, weight: .bold, design: .rounded).monospacedDigit())
                Text(pourcent(choisie.value))
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            } else {
                CountingText(value: total * progress, format: format)
                    .font(.system(size: 26, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Theme.moneyGradient)
                Text(centerLabel)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            }
        }
        .frame(width: 130)
        .multilineTextAlignment(.center)
        .contentTransition(.opacity)
        .animation(Theme.spring, value: selection)
        .background {
            RadialGradient(colors: [(choisie?.color ?? Theme.violet).opacity(0.16), .clear], center: .center, startRadius: 20, endRadius: 80)
                .frame(width: 160, height: 160)
                .animation(Theme.spring, value: selection)
                .allowsHitTesting(false)
        }
    }

    private var legende: some View {
        VStack(spacing: 2) {
            ForEach(Array(slices.enumerated()), id: \.element.id) { i, s in
                Button {
                    withAnimation(Theme.bouncy) { selection = selection == s.id ? nil : s.id }
                } label: {
                    HStack(spacing: 10) {
                        Circle().fill(s.color).frame(width: 9, height: 9).shadow(color: s.color, radius: 3)
                        Text(s.label).font(.subheadline).lineLimit(1)
                        Spacer()
                        Text(format(s.value)).font(.subheadline.weight(.semibold).monospacedDigit())
                        Text(pourcent(s.value))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Theme.text3)
                            .frame(width: 42, alignment: .trailing)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(selection == s.id ? s.color.opacity(0.14) : .clear, in: .rect(cornerRadius: 10))
                    .opacity(selection == nil || selection == s.id ? 1 : 0.5)
                    .contentShape(.rect)
                }
                .buttonStyle(PressScaleStyle(scale: 0.98))
                #if os(macOS)
                .onHover { dedans in
                    if dedans && selection != s.id && progress > 0.95 { withAnimation(Theme.bouncy) { selection = s.id } }
                }
                #endif
                .opacity(progress > Double(i) / Double(max(slices.count, 1)) * 0.8 ? 1 : 0)
                .offset(y: progress > Double(i) / Double(max(slices.count, 1)) * 0.8 ? 0 : 8)
                .animation(Theme.entrance, value: progress > Double(i) / Double(max(slices.count, 1)) * 0.8)
            }
        }
    }

    private func pourcent(_ v: Double) -> String {
        guard total > 0 else { return "" }
        return "\(Int((v / total * 100).rounded())) %"
    }

    private func rejoue() {
        guard reveal != dejaVu, !slices.isEmpty else { return }
        dejaVu = reveal
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) {
            progress = 0
            selection = nil
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            withAnimation(.timingCurve(0.3, 0.1, 0.2, 1, duration: 1.6)) { progress = 1 }
        }
    }

    /// la part sous le doigt, d'apres l'angle
    private func choisis(partAt point: CGPoint, taille: CGFloat) {
        let id = part(at: point, taille: taille)
        withAnimation(Theme.bouncy) { selection = id == nil || selection == id ? nil : id }
    }

    /// la part a cet endroit de l'anneau (rien au centre ni dehors)
    private func part(at point: CGPoint, taille: CGFloat) -> String? {
        let dx = point.x - taille / 2, dy = point.y - taille / 2
        let distance = hypot(dx, dy)
        guard distance > taille / 2 - 40, distance < taille / 2 + 6, total > 0 else { return nil }
        // le dessin est tourne de -90 degres : sa part 0 commence en haut, et
        // tourne dans le sens horaire
        var angle = atan2(dy, dx) / (2 * .pi) + 0.25
        if angle < 0 { angle += 1 }
        if angle >= 1 { angle -= 1 }
        var cumul = 0.0
        for s in slices {
            cumul += s.value / total
            if angle <= cumul { return s.id }
        }
        return nil
    }
}

/// Les arcs, recalcules a chaque image pendant le remplissage. Des formes
/// SwiftUI plutot qu'un Canvas : un Canvas ne dessine que dans son cadre, et
/// la lueur de la part choisie (son arc grossi et son flou) etait coupee net
/// sur les bords d'un carre invisible de 210 points. Ici chaque part porte sa
/// propre lumiere, de sa couleur, qui deborde librement et s'eteint en douceur.
private struct DonutRing: View, Animatable {
    let slices: [DonutSlice]
    var progress: Double
    let selection: String?

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    private let rayon: CGFloat = 89
    private let epaisseur: CGFloat = 20

    private struct Part: Identifiable {
        let id: String
        let couleur: Color
        let debut: Double
        let fin: Double
    }

    private var parts: [Part] {
        let total = slices.reduce(0) { $0 + $1.value }
        guard total > 0 else { return [] }
        let ecart = slices.count > 1 ? 0.012 : 0
        var debut = 0.0
        var resultat: [Part] = []
        for s in slices {
            let fin = debut + s.value / total
            let visibleFin = min(fin, progress)
            if visibleFin > debut + ecart / 2 {
                resultat.append(Part(id: s.id, couleur: s.color, debut: debut + ecart / 2, fin: visibleFin - (visibleFin == fin ? ecart / 2 : 0)))
            }
            debut = fin
        }
        return resultat
    }

    var body: some View {
        ZStack {
            // le creux de l'anneau : la piste, une ombre interieure
            Circle()
                .stroke(.white.opacity(0.05), lineWidth: epaisseur)
                .frame(width: rayon * 2, height: rayon * 2)
            Circle()
                .stroke(.black.opacity(0.45), lineWidth: 5)
                .blur(radius: 4)
                .frame(width: (rayon - epaisseur / 2) * 2 + 4, height: (rayon - epaisseur / 2) * 2 + 4)

            ForEach(parts) { p in
                let choisie = p.id == selection
                let estompee = selection != nil && !choisie
                ArcDonut(debut: p.debut, fin: p.fin)
                    .stroke(p.couleur.opacity(estompee ? 0.35 : 1), style: StrokeStyle(lineWidth: epaisseur, lineCap: .butt))
                    .frame(width: rayon * 2, height: rayon * 2)
                    // sa lumiere : elle suit la part, de sa couleur, et deborde
                    .shadow(color: p.couleur.opacity(estompee ? 0.12 : (choisie ? 0.95 : 0.45)), radius: choisie ? 16 : 7)
                    .shadow(color: p.couleur.opacity(choisie ? 0.5 : 0), radius: choisie ? 34 : 0)
                    // la part choisie ressort de l'anneau
                    .scaleEffect(choisie ? 1.07 : 1)
                    .animation(.spring(response: 0.38, dampingFraction: 0.62), value: choisie)
                    .animation(.easeOut(duration: 0.25), value: estompee)
            }

            // le relief : un liseré de lumiere sur le bord exterieur
            Circle()
                .strokeBorder(
                    LinearGradient(colors: [.white.opacity(0.22), .white.opacity(0.02), .white.opacity(0.08)], startPoint: .top, endPoint: .bottom),
                    lineWidth: 0.8
                )
                .frame(width: rayon * 2 + epaisseur, height: rayon * 2 + epaisseur)
                .allowsHitTesting(false)

            // la tete du trait, lumineuse pendant le remplissage
            if progress > 0.01 && progress < 0.995 {
                let a = progress * 2 * .pi
                Circle()
                    .fill(.white.opacity(0.85))
                    .frame(width: 22, height: 22)
                    .blur(radius: 8)
                    .offset(x: cos(a) * rayon, y: sin(a) * rayon)
                    .blendMode(.plusLighter)
            }
        }
        .frame(width: 210, height: 210)
    }
}

/// un arc de l'anneau, de `debut` a `fin` (parts du tour, sens horaire a
/// partir de 3 heures ; l'anneau est tourne pour commencer en haut)
nonisolated private struct ArcDonut: Shape {
    var debut: Double
    var fin: Double

    func path(in r: CGRect) -> Path {
        var chemin = Path()
        guard fin > debut else { return chemin }
        chemin.addArc(
            center: CGPoint(x: r.midX, y: r.midY), radius: min(r.width, r.height) / 2,
            startAngle: .radians(debut * 2 * .pi), endAngle: .radians(fin * 2 * .pi), clockwise: false
        )
        return chemin
    }
}
