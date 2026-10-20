import SwiftUI

/// L'interrupteur de FeurDrop sur Mac : violet une fois allume, comme sur le
/// site. Le switch natif du Mac ignore la teinte de l'app sur les formulaires
/// en verre et restait gris-blanc allume -- on ne voyait pas s'il etait
/// active (B11). Sur iPhone, le switch natif, deja violet, reste.
struct InterrupteurDrop: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 12) {
            configuration.label
            Spacer(minLength: 8)
            Piste(allume: configuration.isOn)
                .onTapGesture { configuration.isOn.toggle() }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "Activé" : "Désactivé")
        .accessibilityAction { configuration.isOn.toggle() }
    }

    private struct Piste: View {
        let allume: Bool
        @Environment(\.isEnabled) private var actif

        var body: some View {
            Capsule()
                .fill(allume
                      ? AnyShapeStyle(LinearGradient(colors: [Theme.violetLight, Theme.violet], startPoint: .top, endPoint: .bottom))
                      : AnyShapeStyle(.white.opacity(0.14)))
                .overlay(Capsule().strokeBorder(.white.opacity(allume ? 0.18 : 0.12), lineWidth: 0.6))
                .shadow(color: Theme.violet.opacity(allume ? 0.55 : 0), radius: 8)
                .frame(width: 40, height: 23)
                .overlay(alignment: allume ? .trailing : .leading) {
                    Circle()
                        .fill(.white)
                        .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
                        .padding(2.5)
                }
                .opacity(actif ? 1 : 0.45)
                .animation(Theme.spring, value: allume)
        }
    }
}

extension View {
    /// Le switch de l'app : le notre sur Mac, le natif (violet) sur iPhone.
    @ViewBuilder
    func interrupteursDrop() -> some View {
        #if os(macOS)
        toggleStyle(InterrupteurDrop())
        #else
        toggleStyle(.switch)
        #endif
    }
}
