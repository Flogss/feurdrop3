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

        var body: some View {
            let contenu = configuration.label
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(fort ? AnyShapeStyle(.white) : AnyShapeStyle(Theme.violetPale))
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
                }
            }
            .shadow(color: fort ? teinte.opacity(survol ? 0.75 : 0.5) : .clear, radius: survol ? 16 : 10, y: 3)
            .brightness(survol && actif ? 0.06 : 0)
            .scaleEffect(configuration.isPressed ? 0.94 : (survol && actif ? 1.025 : 1))
            .opacity(actif ? 1 : 0.45)
            .animation(.spring(response: 0.28, dampingFraction: 0.6), value: configuration.isPressed)
            .animation(.spring(response: 0.35, dampingFraction: 0.75), value: survol)
            .onHover { survol = $0 }
            .contentShape(.rect)
        }

        private var verre: Glass {
            fort ? .regular.tint(teinte.opacity(0.85)).interactive() : .regular.interactive()
        }
    }
}
#endif
