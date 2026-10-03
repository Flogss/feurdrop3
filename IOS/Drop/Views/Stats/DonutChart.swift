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
                centre
            }
            .frame(maxWidth: .infinity)

            legende
        }
        .onScrollVisibilityChange(threshold: 0.4) { vu in
            visible = vu
            if vu { rejoue() }
        }
        .onChange(of: reveal) {
            if visible { rejoue() } else { dejaVu = -1 }
        }
        .sensoryFeedback(.selection, trigger: selection)
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
        let dx = point.x - taille / 2, dy = point.y - taille / 2
        let distance = hypot(dx, dy)
        guard distance > taille / 2 - 40, distance < taille / 2 + 6, total > 0 else {
            withAnimation(Theme.bouncy) { selection = nil }
            return
        }
        // le dessin est tourne de -90 degres : sa part 0 commence en haut, et
        // tourne dans le sens horaire
        var angle = atan2(dy, dx) / (2 * .pi) + 0.25
        if angle < 0 { angle += 1 }
        if angle >= 1 { angle -= 1 }
        var cumul = 0.0
        for s in slices {
            cumul += s.value / total
            if angle <= cumul {
                withAnimation(Theme.bouncy) { selection = selection == s.id ? nil : s.id }
                return
            }
        }
    }
}

/// Les arcs, recalcules a chaque image pendant le remplissage.
private struct DonutRing: View, Animatable {
    let slices: [DonutSlice]
    var progress: Double
    let selection: String?

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    var body: some View {
        Canvas(rendersAsynchronously: true) { ctx, taille in
            let total = slices.reduce(0) { $0 + $1.value }
            guard total > 0 else { return }
            let centre = CGPoint(x: taille.width / 2, y: taille.height / 2)
            let rayon = min(taille.width, taille.height) / 2 - 16
            // le fond de l'anneau
            ctx.stroke(Path(ellipseIn: CGRect(x: centre.x - rayon, y: centre.y - rayon, width: rayon * 2, height: rayon * 2)), with: .color(.white.opacity(0.05)), lineWidth: 20)

            let ecart = slices.count > 1 ? 0.012 : 0
            var debut = 0.0
            for s in slices {
                let part = s.value / total
                let fin = debut + part
                let visibleFin = min(fin, progress)
                if visibleFin > debut + ecart / 2 {
                    let choisie = s.id == selection
                    let estompee = selection != nil && !choisie
                    var arc = Path()
                    arc.addArc(center: centre, radius: rayon + (choisie ? 5 : 0),
                               startAngle: .radians((debut + ecart / 2) * 2 * .pi),
                               endAngle: .radians((visibleFin - (visibleFin == fin ? ecart / 2 : 0)) * 2 * .pi),
                               clockwise: false)
                    if choisie {
                        ctx.drawLayer { halo in
                            halo.addFilter(.blur(radius: 9))
                            halo.stroke(arc, with: .color(s.color.opacity(0.8)), style: StrokeStyle(lineWidth: 26, lineCap: .round))
                        }
                    }
                    ctx.stroke(arc, with: .color(s.color.opacity(estompee ? 0.35 : 1)), style: StrokeStyle(lineWidth: choisie ? 28 : 20, lineCap: .butt))
                }
                debut = fin
            }
            // la tete du trait, lumineuse pendant le remplissage
            if progress > 0.01 && progress < 0.995 {
                let a = progress * 2 * .pi
                let p = CGPoint(x: centre.x + cos(a) * rayon, y: centre.y + sin(a) * rayon)
                ctx.drawLayer { lumiere in
                    lumiere.addFilter(.blur(radius: 8))
                    lumiere.fill(Path(ellipseIn: CGRect(x: p.x - 12, y: p.y - 12, width: 24, height: 24)), with: .color(.white.opacity(0.8)))
                }
            }
        }
    }
}
