import SwiftUI

/// Le message ephemere, en haut, sous l'ile dynamique : une capsule de verre
/// qui descend en se precisant, avec une coche qui se dessine.
struct ToastOverlay: View {
    let center: ToastCenter

    var body: some View {
        ZStack {
            if let toast = center.current {
                HStack(spacing: 10) {
                    icone(toast.style)
                    Text(toast.message)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .padding(.leading, 10)
                .padding(.trailing, 16)
                .padding(.vertical, 10)
                .glassEffect(.regular.tint(teinte(toast.style).opacity(0.22)).interactive(), in: .capsule)
                .shadow(color: teinte(toast.style).opacity(0.45), radius: 20, y: 6)
                .onTapGesture { center.dismiss() }
                .gesture(DragGesture(minimumDistance: 8).onEnded { if $0.translation.height < 0 { center.dismiss() } })
                .transition(
                    .asymmetric(
                        insertion: .move(edge: .top).combined(with: .opacity).combined(with: .scale(scale: 0.85, anchor: .top)),
                        removal: .move(edge: .top).combined(with: .opacity)
                    )
                )
                .id(toast.id)
            }
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, alignment: .top)
    }

    private func teinte(_ style: ToastCenter.Style) -> Color {
        switch style {
        case .success: Theme.violet
        case .error: Theme.danger
        case .info: Theme.info
        }
    }

    private func icone(_ style: ToastCenter.Style) -> some View {
        let symbole = switch style {
        case .success: "checkmark"
        case .error: "exclamationmark.triangle.fill"
        case .info: "info"
        }
        return Image(systemName: symbole)
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(teinte(style).gradient, in: .circle)
            .symbolEffect(.bounce, options: .nonRepeating)
            .transition(.symbolEffect(.drawOn))
    }
}

/// Des etincelles violettes qui jaillissent d'un point et retombent : le
/// succes se voit, sans feu d'artifice. A poser en overlay ; chaque
/// incrementation de `trigger` lance une gerbe.
struct SparkBurst: View {
    let trigger: Int
    var count = 14
    var power: CGFloat = 1

    @State private var gerbes: [Gerbe] = []

    private var portee: CGFloat { (82 + 26) * power + 14 }

    private struct Gerbe: Identifiable {
        let id = UUID()
        let depart = Date.now
        let angles: [Double]
        let portees: [Double]
    }

    var body: some View {
        TimelineView(.animation(paused: gerbes.isEmpty)) { contexte in
            Canvas(rendersAsynchronously: true) { ctx, taille in
                let centre = CGPoint(x: taille.width / 2, y: taille.height / 2)
                for gerbe in gerbes {
                    let t = contexte.date.timeIntervalSince(gerbe.depart) / 0.95
                    guard t < 1 else { continue }
                    let sortie = 1 - pow(1 - t, 3)
                    for i in gerbe.angles.indices {
                        let a = gerbe.angles[i]
                        let p = gerbe.portees[i] * power
                        let x = centre.x + cos(a) * p * sortie
                        let y = centre.y + sin(a) * p * sortie + 26 * power * t * t
                        let r = 3.6 * (1 - t) + 0.6
                        let couleur = i % 3 == 0 ? Color.white : Theme.violetLight
                        ctx.fill(Path(ellipseIn: CGRect(x: x - r * 2.4, y: y - r * 2.4, width: r * 4.8, height: r * 4.8)), with: .color(Theme.violet.opacity(0.25 * (1 - t))))
                        ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)), with: .color(couleur.opacity(1 - t)))
                    }
                }
            }
        }
        // sa toile a la portee des etincelles (la plus lointaine, sa chute et
        // sa lueur), centree sur l'element qui la porte : elle ne prend plus
        // la taille de cet element, qui coupait la gerbe dans un rectangle
        .frame(width: portee * 2, height: portee * 2)
        .allowsHitTesting(false)
        .onChange(of: trigger) {
            let n = count
            let gerbe = Gerbe(
                angles: (0..<n).map { Double($0) / Double(n) * .pi * 2 + .random(in: 0...0.5) },
                portees: (0..<n).map { _ in .random(in: 38...82) }
            )
            gerbes.append(gerbe)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.1))
                gerbes.removeAll { $0.id == gerbe.id }
            }
        }
    }
}
