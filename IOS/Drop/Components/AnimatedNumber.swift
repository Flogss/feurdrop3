import SwiftUI
import DropKit

/// Un texte dont la valeur s'interpole image par image : en animant `value`,
/// SwiftUI redessine "1 200, 1 201, 1 202..." jusqu'a la cible.
struct CountingText: View, Animatable {
    var value: Double
    let format: (Double) -> String

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    var body: some View {
        Text(format(value))
    }
}

/// Un nombre vivant. Quand sa valeur change, il monte (ou descend) pour de
/// vrai, d'autant plus longtemps que l'ecart est grand, en s'allumant pendant
/// qu'il compte. S'il monte et qu'une `bubble` est fournie, une bulle "+N"
/// apparait pres de lui, une onde part du chiffre, et l'iPhone tapote.
///
/// `start` sert au premier affichage : partir de l'ancienne valeur (avec
/// bulle) quand il y a du nouveau depuis la derniere visite, ou de zero pour la
/// grande entree du lancement.
struct AnimatedNumber: View {
    let value: Double
    var format: (Double) -> String = { Format.integer($0) }
    var start: CounterStart? = nil
    var delay: Double = 0
    var bubble: ((Double) -> String)? = nil
    var glow: Color = Theme.violet

    @State private var shown: Double?
    @State private var counting = false
    @State private var delta: Delta?
    @State private var onde = 0

    private struct Delta: Equatable, Identifiable {
        let id = UUID()
        let text: String
    }

    var body: some View {
        CountingText(value: shown ?? value, format: format)
            .monospacedDigit()
            .shadow(color: glow.opacity(counting ? 0.85 : 0), radius: counting ? 16 : 0)
            .scaleEffect(counting ? 1.035 : 1, anchor: .leading)
            .background { ondeVisuelle }
            .overlay(alignment: .topTrailing) { bulle }
            .onAppear(perform: premierAffichage)
            .onChange(of: value) { ancien, nouveau in
                anime(de: shown ?? ancien, a: nouveau, annonce: nouveau > ancien)
            }
            .sensoryFeedback(.increase, trigger: onde)
    }

    private func premierAffichage() {
        guard shown == nil else { return }
        guard let start, let depart = start.from else {
            shown = value
            return
        }
        shown = depart
        anime(de: depart, a: value, annonce: start.announces, retard: delay)
    }

    private func anime(de depart: Double, a cible: Double, annonce: Bool, retard: Double = 0) {
        guard depart != cible else {
            shown = cible
            return
        }
        let duree = CountingDuration.seconds(from: depart, to: cible)
        if annonce, let bubble {
            let texte = bubble(cible - depart)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(max(0, retard - 0.25)))
                withAnimation(Theme.bouncy) { delta = Delta(text: texte) }
                try? await Task.sleep(for: .seconds(0.3))
                onde += 1
                try? await Task.sleep(for: .seconds(2.2))
                withAnimation(.easeIn(duration: 0.35)) { delta = nil }
            }
        }
        Task { @MainActor in
            if retard > 0 { try? await Task.sleep(for: .seconds(retard)) }
            withAnimation(.easeOut(duration: 0.25)) { counting = true }
            withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: duree)) { shown = cible }
            try? await Task.sleep(for: .seconds(duree))
            withAnimation(.easeOut(duration: 0.6)) { counting = false }
        }
    }

    /// la bulle "+10 colis" : elle gonfle, monte un peu, puis s'evapore
    @ViewBuilder
    private var bulle: some View {
        if let delta {
            Text(delta.text)
                .font(.system(size: 14, weight: .bold).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .glassEffect(.regular.tint(Theme.violet.opacity(0.85)), in: .capsule)
                .shadow(color: Theme.violet.opacity(0.9), radius: 14)
                .fixedSize()
                .offset(x: 18, y: -26)
                .transition(
                    .asymmetric(
                        insertion: .scale(scale: 0.4, anchor: .bottomLeading).combined(with: .opacity).combined(with: .offset(y: 12)),
                        removal: .opacity.combined(with: .offset(y: -18)).combined(with: .scale(scale: 0.9))
                    )
                )
                .id(delta.id)
        }
    }

    /// l'onde : un anneau de lumiere qui part du chiffre quand il se met a compter
    private var ondeVisuelle: some View {
        Circle()
            .strokeBorder(Theme.violetLight, lineWidth: 2)
            .frame(width: 70, height: 70)
            .keyframeAnimator(initialValue: Onde(), trigger: onde) { cercle, o in
                cercle.scaleEffect(o.echelle).opacity(o.opacite).blur(radius: o.flou)
            } keyframes: { _ in
                KeyframeTrack(\.echelle) {
                    MoveKeyframe(0.3)
                    CubicKeyframe(2.4, duration: 0.9)
                }
                KeyframeTrack(\.opacite) {
                    MoveKeyframe(0.9)
                    CubicKeyframe(0, duration: 0.9)
                }
                KeyframeTrack(\.flou) {
                    MoveKeyframe(0)
                    CubicKeyframe(4, duration: 0.9)
                }
            }
            .allowsHitTesting(false)
    }

    private struct Onde {
        var echelle: CGFloat = 0.3
        var opacite: Double = 0
        var flou: CGFloat = 0
    }
}
