import SwiftUI

// Les boutons de verre. Sur iPhone : les styles Liquid Glass du systeme.
// Sur Mac, les boutons du systeme se grisent des que la fenetre n'est plus au
// premier plan et n'ont pas le meme toucher : ils sont dessines ici, en verre,
// avec survol, pression et teinte, et ne s'eteignent jamais.

enum FormeVerre { case capsule, rond }

extension View {
    /// bouton de verre clair
    @ViewBuilder
    func boutonVerre(_ forme: FormeVerre = .capsule) -> some View {
        #if os(iOS)
        if forme == .rond {
            self.buttonStyle(.glass).buttonBorderShape(.circle)
        } else {
            self.buttonStyle(.glass)
        }
        #else
        self.buttonStyle(VerreMac(fort: false, teinte: .clear, forme: forme))
        #endif
    }

    /// bouton de verre teinte (l'action principale)
    @ViewBuilder
    func boutonVerreFort(_ teinte: Color = Theme.violetDeep) -> some View {
        #if os(iOS)
        self.buttonStyle(.glassProminent).tint(teinte)
        #else
        self.buttonStyle(VerreMac(fort: true, teinte: teinte, forme: .capsule))
        #endif
    }
}

#if os(macOS)
struct VerreMac: ButtonStyle {
    let fort: Bool
    let teinte: Color
    let forme: FormeVerre

    func makeBody(configuration: Configuration) -> some View {
        Corps(configuration: configuration, fort: fort, teinte: teinte, forme: forme)
    }

    private struct Corps: View {
        let configuration: ButtonStyleConfiguration
        let fort: Bool
        let teinte: Color
        let forme: FormeVerre
        @Environment(\.isEnabled) private var actif
        @State private var survol = false
        /// chaque entree de la souris fait passer un reflet (boutons forts)
        @State private var reflets = 0

        var body: some View {
            let contenu = configuration.label
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(fort ? AnyShapeStyle(.white) : AnyShapeStyle(Theme.violetPale))
                // l'icone d'un bouton rond penche un peu au survol, comme sur le site
                .rotationEffect(.degrees(forme == .rond && survol && actif ? -12 : 0))
                .scaleEffect(forme == .rond && survol && actif ? 1.08 : 1)
                .padding(.horizontal, forme == .rond ? 0 : 16)
                // une hauteur minimale plutot qu'une marge : un bouton qui a deja
                // sa hauteur (comme sur l'iPhone) la garde
                .frame(minWidth: forme == .rond ? 32 : nil, minHeight: forme == .rond ? 32 : 34)
            Group {
                if forme == .rond {
                    contenu
                        .glassEffect(verre, in: .circle)
                        .overlay { Circle().strokeBorder(.white.opacity(survol ? 0.35 : 0.12), lineWidth: 0.8) }
                } else {
                    contenu
                        .glassEffect(verre, in: .capsule)
                        .overlay {
                            Capsule().strokeBorder(
                                LinearGradient(colors: [.white.opacity(survol ? 0.5 : 0.28), .white.opacity(0.04), (fort ? Theme.violetLight : .white).opacity(0.25)], startPoint: .top, endPoint: .bottom),
                                lineWidth: 0.8
                            )
                        }
                        .overlay {
                            if fort { Reflet(passages: reflets).clipShape(.capsule).allowsHitTesting(false) }
                        }
                }
            }
            .shadow(color: fort ? teinte.opacity(survol ? 0.85 : 0.5) : .clear, radius: survol ? 18 : 10, y: survol ? 6 : 3)
            .brightness(survol && actif ? 0.06 : 0)
            .scaleEffect(configuration.isPressed ? 0.94 : (survol && actif ? 1.025 : 1))
            // il se souleve d'un point, comme .btn:hover sur le site
            .offset(y: survol && actif && !configuration.isPressed && forme == .capsule ? -1 : 0)
            .opacity(actif ? 1 : 0.45)
            .animation(.spring(response: 0.28, dampingFraction: 0.6), value: configuration.isPressed)
            .animation(.spring(response: 0.35, dampingFraction: 0.75), value: survol)
            .onHover { dedans in
                survol = dedans
                if dedans && actif && fort { reflets += 1 }
            }
            .contentShape(.rect)
        }

        private var verre: Glass {
            fort ? .regular.tint(teinte.opacity(0.85)).interactive() : .regular.interactive()
        }
    }

    /// Le reflet qui traverse un bouton fort quand la souris arrive dessus
    /// (`reflet-survol` sur le site : de -130 % a 130 % en 0,9 s).
    private struct Reflet: View {
        let passages: Int

        var body: some View {
            GeometryReader { geo in
                let largeur = geo.size.width
                let bande = max(largeur * 0.45, 30)
                LinearGradient(colors: [.clear, .white.opacity(0.38), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: bande)
                    .rotationEffect(.degrees(18))
                    // de tout a gauche (cache) a tout a droite (cache)
                    .keyframeAnimator(initialValue: 0.0, trigger: passages) { vue, f in
                        vue.offset(x: -bande - 12 + (largeur + bande + 24) * f)
                    } keyframes: { _ in
                        KeyframeTrack {
                            MoveKeyframe(0)
                            CubicKeyframe(1, duration: 0.9)
                        }
                    }
            }
            .opacity(passages == 0 ? 0 : 1)
        }
    }
}
#endif
