import SwiftUI

// Le survol a la souris, comme sur le site au bureau : une lumiere suit le
// pointeur sur les cartes, les lignes s'eclairent, les tuiles se soulevent.
// Sur iPhone (pas de pointeur), ces modificateurs ne font rien.

extension View {
    /// La lumiere qui suit la souris sur une carte : un halo doux dedans, et
    /// un liseré qui s'allume sur la bordure, juste sous le pointeur.
    @ViewBuilder
    func lumiereSurvol(_ rayon: CGFloat = Theme.Radius.card) -> some View {
        #if os(macOS)
        modifier(LumiereSurvol(rayon: rayon))
        #else
        self
        #endif
    }

    /// Une ligne de liste qui s'eclaire au survol ; le fond deborde de
    /// `marge` de chaque cote, sans deplacer le contenu.
    @ViewBuilder
    func ligneSurvol(rayon: CGFloat = 12, marge: CGFloat = 10) -> some View {
        #if os(macOS)
        modifier(LigneSurvol(rayon: rayon, marge: marge))
        #else
        self
        #endif
    }

    /// Une tuile qui se souleve un peu au survol, sa bordure s'eclaire
    /// (de sa couleur, `lueur`, avec un halo dessous).
    @ViewBuilder
    func souleveSurvol(_ rayon: CGFloat, hauteur: CGFloat = 2, lueur: Color? = nil) -> some View {
        #if os(macOS)
        modifier(SouleveSurvol(rayon: rayon, hauteur: hauteur, lueur: lueur))
        #else
        self
        #endif
    }

    /// Les barres de defilement cachees, meme avec une souris branchee (sur
    /// Mac, `.hidden` les laisse quand une souris est la).
    func sansIndicateurs() -> some View {
        #if os(macOS)
        scrollIndicators(.never)
        #else
        scrollIndicators(.hidden)
        #endif
    }
}

extension EnvironmentValues {
    /// vrai dans une ligne survolee (le chevron avance, comme sur le site)
    @Entry var ligneSurvolee = false
}

/// Le chevron d'une ligne qui ouvre quelque chose : il avance au survol.
struct ChevronLigne: View {
    @Environment(\.ligneSurvolee) private var survolee

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(survolee ? Theme.text2 : Theme.text3)
            .offset(x: survolee ? 4 : 0)
            .animation(.spring(response: 0.32, dampingFraction: 0.6), value: survolee)
    }
}

#if os(macOS)
private struct LumiereSurvol: ViewModifier {
    let rayon: CGFloat
    @State private var point: CGPoint = .zero
    @State private var dedans = false

    func body(content: Content) -> some View {
        content
            .overlay {
                Lumiere(rayon: rayon, point: point)
                    .opacity(dedans ? 1 : 0)
                    .allowsHitTesting(false)
            }
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case .active(let p):
                    point = p
                    if !dedans { withAnimation(.easeOut(duration: 0.35)) { dedans = true } }
                case .ended:
                    withAnimation(.easeOut(duration: 0.5)) { dedans = false }
                }
            }
    }

    /// Les deux lumieres du site : `radial-gradient(380px …, 8 %, transparent
    /// 45 %)` dans la carte, `radial-gradient(260px …, 55 %, transparent 60 %)`
    /// sur la bordure.
    private struct Lumiere: View {
        let rayon: CGFloat
        let point: CGPoint

        var body: some View {
            let forme = RoundedRectangle(cornerRadius: rayon, style: .continuous)
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [Theme.violetBright.opacity(0.12), .clear], center: .center, startRadius: 0, endRadius: 171))
                    .frame(width: 342, height: 342)
                    .position(point)
                Circle()
                    .fill(RadialGradient(colors: [Theme.violetLight.opacity(0.6), .clear], center: .center, startRadius: 0, endRadius: 156))
                    .frame(width: 312, height: 312)
                    .position(point)
                    .mask { forme.strokeBorder(lineWidth: 1) }
            }
            .clipShape(forme)
        }
    }
}

private struct LigneSurvol: ViewModifier {
    let rayon: CGFloat
    let marge: CGFloat
    @State private var survol = false

    func body(content: Content) -> some View {
        content
            .environment(\.ligneSurvolee, survol)
            .padding(.horizontal, marge)
            .background {
                RoundedRectangle(cornerRadius: rayon, style: .continuous)
                    .fill(.white.opacity(survol ? 0.045 : 0))
            }
            .onHover { dedans in
                withAnimation(.easeOut(duration: dedans ? 0.12 : 0.25)) { survol = dedans }
            }
            .padding(.horizontal, -marge)
    }
}

private struct SouleveSurvol: ViewModifier {
    let rayon: CGFloat
    let hauteur: CGFloat
    let lueur: Color?
    @State private var survol = false

    func body(content: Content) -> some View {
        content
            .overlay {
                RoundedRectangle(cornerRadius: rayon, style: .continuous)
                    .strokeBorder((lueur ?? .white).opacity(survol ? (lueur == nil ? 0.16 : 0.45) : 0), lineWidth: 0.8)
                    .allowsHitTesting(false)
            }
            .shadow(color: (lueur ?? .black).opacity(survol ? (lueur == nil ? 0.35 : 0.5) : 0), radius: 16, y: 10)
            .offset(y: survol ? -hauteur : 0)
            .onHover { dedans in
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { survol = dedans }
            }
    }
}
#endif

/// Les petits boutons + et − : ils se compriment a l'appui et, a la souris,
/// prennent un fond clair au survol (comme `.step` sur le site).
struct PasStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Corps(configuration: configuration)
    }

    private struct Corps: View {
        let configuration: ButtonStyleConfiguration
        @State private var survol = false

        var body: some View {
            configuration.label
                .foregroundStyle(survol || configuration.isPressed ? Theme.text : Theme.text2)
                .background {
                    Capsule()
                        .fill(configuration.isPressed ? Theme.violet.opacity(0.25) : .white.opacity(survol ? 0.08 : 0))
                        .padding(2)
                }
                .scaleEffect(configuration.isPressed ? 0.85 : 1)
                .animation(configuration.isPressed ? .easeOut(duration: 0.08) : .spring(response: 0.4, dampingFraction: 0.6), value: configuration.isPressed)
                .animation(.easeOut(duration: 0.15), value: survol)
                .onHover { survol = $0 }
        }
    }
}

extension View {
    /// Un graphique horizontal qu'on fait defiler en le tirant a la souris
    /// (la main du Mac, de l'elan au lacher) ; la molette, elle, fait defiler
    /// la page. A poser sur le ScrollView horizontal.
    @ViewBuilder
    func tirerPourDefiler() -> some View {
        #if os(macOS)
        modifier(TirerPourDefiler())
        #else
        self
        #endif
    }
}

#if os(macOS)
private struct TirerPourDefiler: ViewModifier {
    @State private var position = ScrollPosition()
    @State private var etat = Etat()
    @State private var tire = false

    /// lu a chaque image de defilement : une classe, pour ne pas recalculer la vue
    private final class Etat {
        var x: CGFloat = 0
        var max: CGFloat = 0
        var depart: CGFloat?
    }

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .onScrollGeometryChange(for: CGPoint.self) { g in
                CGPoint(x: g.contentOffset.x, y: Swift.max(0, g.contentSize.width + g.contentInsets.leading + g.contentInsets.trailing - g.containerSize.width))
            } action: { _, v in
                etat.x = v.x
                etat.max = v.y
            }
            .simultaneousGesture(
                DragGesture(minimumDistance: 3, coordinateSpace: .global)
                    .onChanged { v in
                        if etat.depart == nil {
                            etat.depart = etat.x
                            tire = true
                        }
                        position.scrollTo(x: borne((etat.depart ?? 0) - v.translation.width))
                    }
                    .onEnded { v in
                        etat.depart = nil
                        tire = false
                        // l'elan : la ou le geste serait alle, freine en douceur
                        let elan = v.predictedEndTranslation.width - v.translation.width
                        guard abs(elan) > 2 else { return }
                        withAnimation(.smooth(duration: 0.75)) { position.scrollTo(x: borne(etat.x - elan)) }
                    }
            )
            .pointerStyle(tire ? .grabActive : .grabIdle)
    }

    private func borne(_ x: CGFloat) -> CGFloat { Swift.min(Swift.max(x, 0), etat.max) }
}
#endif
