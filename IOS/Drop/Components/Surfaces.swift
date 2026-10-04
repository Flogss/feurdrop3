import SwiftUI
import DropKit

// Les surfaces communes. Le verre (Liquid Glass) va a ce qui flotte et se
// touche : barres, boutons, pastilles, cartes interactives. Le contenu dense
// (listes) garde une surface sombre plus calme, pour rester lisible.

extension View {
    /// Une carte de verre sombre, legerement teintee de violet, posee sur le
    /// fond vivant. `interactive` : elle reagit au toucher (reflet, pression).
    func glassCard(cornerRadius: CGFloat = Theme.Radius.card, tint: Color = .black.opacity(0.28), interactive: Bool = false) -> some View {
        self
            .padding(Theme.Space.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(interactive ? .regular.tint(tint).interactive() : .regular.tint(tint), in: .rect(cornerRadius: cornerRadius))
            .lumiereSurvol(cornerRadius)
    }

    /// Une surface calme pour le contenu dense.
    func surfaceCard(cornerRadius: CGFloat = Theme.Radius.card) -> some View {
        self
            .padding(Theme.Space.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Theme.surface.opacity(0.82))
                    .overlay {
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .strokeBorder(
                                LinearGradient(colors: [.white.opacity(0.11), .white.opacity(0.03)], startPoint: .top, endPoint: .bottom),
                                lineWidth: 0.7
                            )
                    }
                    .shadow(color: .black.opacity(0.35), radius: 18, y: 10)
            }
            .lumiereSurvol(cornerRadius)
    }

    /// L'entree d'un bloc : il monte, se precise (flou -> net) et grandit un
    /// peu, avec un decalage selon son rang.
    func entrance(_ visible: Bool, index: Int = 0) -> some View {
        self
            .opacity(visible ? 1 : 0)
            .blur(radius: visible ? 0 : 10)
            .scaleEffect(visible ? 1 : 0.96)
            .offset(y: visible ? 0 : 26)
            .animation(Theme.entrance.delay(Double(index) * 0.07), value: visible)
    }
}

/// L'en-tete des trois onglets : la date, puis le grand titre, au meme
/// endroit sur chaque onglet (pas de barre de navigation au-dessus, qui
/// laissait un vide sur Imprime et Stats).
struct PageHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: Trailing

    init(_ title: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Locale(identifier: "fr_FR"))).uppercased())
                    .font(.caption.weight(.semibold))
                    .tracking(0.8)
                    .foregroundStyle(Theme.text3)
                Text(title)
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.numberGradient)
                    .shadow(color: Theme.violet.opacity(0.45), radius: 16)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer()
            trailing
        }
        .padding(.top, 8)
        .padding(.horizontal, 4)
    }
}

/// Le titre d'une section, avec un complement a droite.
struct SectionHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: Trailing

    init(_ title: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.semibold))
            Spacer(minLength: 8)
            trailing
                .font(.subheadline)
                .foregroundStyle(Theme.text3)
        }
    }
}

/// Le petit point lumineux aux couleurs d'un transporteur.
struct CarrierDot: View {
    let color: Color
    var size: CGFloat = 10

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.85), radius: 5)
            .background(Circle().fill(color.opacity(0.18)).frame(width: size + 8, height: size + 8))
    }
}

/// L'avatar d'un expediteur : son initiale sur sa teinte a lui.
struct SenderAvatar: View {
    let name: String
    var size: CGFloat = 40

    var body: some View {
        let teinte = senderHue(name)
        Text(senderInitial(name))
            .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
            .foregroundStyle(Color(hue: teinte, saturation: 0.55, brightness: 1))
            .frame(width: size, height: size)
            .background(
                LinearGradient(
                    colors: [Color(hue: teinte, saturation: 0.55, brightness: 0.34), Color(hue: teinte, saturation: 0.45, brightness: 0.18)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ),
                in: .rect(cornerRadius: size * 0.32, style: .continuous)
            )
            .overlay(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous).strokeBorder(.white.opacity(0.1), lineWidth: 0.6))
    }
}

/// La part d'un ensemble : une jauge fine qui pousse jusqu'a sa longueur.
struct ShareBar: View {
    let fraction: Double
    let color: Color
    var height: CGFloat = 4
    @State private var pousse = false

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(.white.opacity(0.06))
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(LinearGradient(colors: [color.opacity(0.6), color], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(height, geo.size.width * (pousse ? fraction : 0)))
                        .shadow(color: color.opacity(0.8), radius: 5)
                }
        }
        .frame(height: height)
        .onAppear {
            withAnimation(.spring(response: 1.1, dampingFraction: 0.82).delay(0.25)) { pousse = true }
        }
        .animation(.spring(response: 0.9, dampingFraction: 0.85), value: fraction)
    }
}

/// "En direct" : dit si le dernier rafraichissement a joint le serveur.
struct LivePill: View {
    let online: Bool
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(online ? Theme.violetLight : Theme.danger)
                .frame(width: 7, height: 7)
                .shadow(color: online ? Theme.violet : Theme.danger, radius: 4)
                .overlay {
                    Circle()
                        .stroke(online ? Theme.violetLight : Theme.danger, lineWidth: 1.5)
                        .scaleEffect(pulse ? 2.8 : 1)
                        .opacity(pulse ? 0 : 0.7)
                }
            Text(online ? "En direct" : "Hors ligne")
                .font(.footnote.weight(.medium))
                .foregroundStyle(online ? Theme.text2 : Theme.danger)
                .contentTransition(.opacity)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular.tint(online ? .clear : Theme.danger.opacity(0.2)), in: .capsule)
        .animation(Theme.spring, value: online)
        .onAppear {
            withAnimation(.easeOut(duration: 2.2).repeatForever(autoreverses: false)) { pulse = true }
        }
    }
}

/// Un etat vide qui ne fait pas "erreur" : une icone qui flotte doucement.
struct EmptyStateView: View {
    let symbol: String
    let title: String
    var subtitle: String? = nil
    var positive: Bool = false

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(positive ? Theme.violetLight : Theme.text3)
                .frame(width: 56, height: 56)
                .glassEffect(positive ? .regular.tint(Theme.violet.opacity(0.35)) : .regular, in: .rect(cornerRadius: 18))
                .symbolEffect(.breathe, options: .repeat(.continuous))
                .padding(.bottom, 4)
            Text(title)
                .font(.headline)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
    }
}

/// Le scintillement d'un chargement.
struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geo in
                    LinearGradient(colors: [.clear, Theme.violetLight.opacity(0.14), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.6)
                        .offset(x: phase * geo.size.width * 1.4)
                }
                .clipped()
            }
            .onAppear {
                withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }
}

struct SkeletonRow: View {
    var height: CGFloat = 56

    var body: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(.white.opacity(0.05))
            .frame(height: height)
            .modifier(Shimmer())
            .clipShape(.rect(cornerRadius: 14))
    }
}

/// Un bouton qui se comprime au toucher et revient en ressort.
struct PressScaleStyle: ButtonStyle {
    var scale: CGFloat = 0.96

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .brightness(configuration.isPressed ? 0.04 : 0)
            .animation(configuration.isPressed ? .easeOut(duration: 0.1) : .spring(response: 0.4, dampingFraction: 0.6), value: configuration.isPressed)
    }
}
