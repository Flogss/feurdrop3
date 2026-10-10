#if os(macOS)
import SwiftUI
import AppKit
import DropKit

/// La barre du haut, comme sur le site en version ordinateur : la marque a
/// gauche (apres les boutons de la fenetre), le menu en Liquid Glass au
/// centre, l'etat de la connexion et les outils a droite. On deplace la
/// fenetre en la tirant par cette barre.
struct MacTopBar: View {
    static let hauteur: CGFloat = 74

    @Binding var selection: MacPage
    /// le logo est arrive du lancement (avant, c'est celui de la meteorite)
    var marquePosee = true
    var surCadreMarque: (CGRect) -> Void = { _ in }
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            // le fond de la barre : on tire la fenetre par la
            Color.clear
                .contentShape(.rect)
                .gesture(WindowDragGesture())

            MacTabBar(selection: $selection, badges: [.printing: app.dashboard.stats?.aImprimer ?? 0])

            HStack(spacing: 0) {
                Marque(posee: marquePosee, surCadre: surCadreMarque)
                    .padding(.leading, 86) // les trois boutons de la fenetre
                Spacer()
                GlassEffectContainer(spacing: 0) {
                    HStack(spacing: 10) {
                        LivePill(online: app.isOnline)
                        outil(.tracking, aide: "Suivi des colis (⌘4)")
                        outil(.depots, aide: "Contrôle des dépôts (⌘7)", pastille: app.depots.resume?.attention ?? 0, teinte: Theme.teal)
                        outil(.historique, aide: "Historique (⌘8)")
                        outil(.locker, aide: "Mode locker (⌘5)", pastille: app.locker.pairs.count)
                        outil(.settings, aide: "Réglages (⌘6)")
                    }
                }
                .padding(.trailing, 22)
            }
        }
        .frame(height: Self.hauteur)
        .padding(.top, 4)
        .background(alignment: .top) {
            // un voile tres leger : la barre reste lisible quand la page defile dessous
            LinearGradient(colors: [Theme.background.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: Self.hauteur + 30)
                .allowsHitTesting(false)
        }
    }

    /// Un bouton rond en verre ; allume (teinte violette) quand sa page est ouverte.
    private func outil(_ page: MacPage, aide: String, pastille: Int = 0, teinte: Color = Theme.special) -> some View {
        let actif = selection == page
        return Button {
            selection = actif ? .dashboard : page
        } label: {
            Image(systemName: actif ? page.symboleActif : page.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(actif ? .white : Theme.text2)
                .frame(width: 40, height: 40)
                .contentTransition(.symbolEffect(.replace))
                .overlay(alignment: .topTrailing) {
                    if pastille > 0 {
                        Text(Format.integer(pastille))
                            .font(.system(size: 10, weight: .bold).monospacedDigit())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 17, minHeight: 17)
                            .background(teinte.gradient, in: .capsule)
                            .offset(x: 6, y: -4)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
        }
        .buttonStyle(VerreRond(actif: actif))
        .help(aide)
        .accessibilityLabel(page.title)
    }
}

/// La marque : le logo violet et "DROP.ctrl", comme sur le site. Au
/// lancement, le logo forme par la meteorite vient s'y poser.
private struct Marque: View {
    var posee = true
    var surCadre: (CGRect) -> Void = { _ in }
    @State private var reflet = false

    var body: some View {
        HStack(spacing: 10) {
            MarqueDrop(cote: 34)
                .overlay {
                    // un reflet passe sur le logo, de temps en temps
                    LinearGradient(colors: [.clear, .white.opacity(0.5), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 18)
                        .rotationEffect(.degrees(20))
                        .offset(x: reflet ? 34 : -34)
                        .clipShape(.rect(cornerRadius: 10))
                }
                .clipShape(.rect(cornerRadius: 34 * ContourMarque.arrondi, style: .continuous))
                .shadow(color: Theme.violet.opacity(0.75), radius: 10, y: 4)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { surCadre($0) }
                // il se pose : un petit rebond et un eclat
                .keyframeAnimator(initialValue: 1.0, trigger: posee) { vue, e in
                    vue.scaleEffect(e).brightness((e - 1) * 1.5)
                } keyframes: { _ in
                    KeyframeTrack {
                        SpringKeyframe(1.16, duration: 0.14, spring: .snappy)
                        SpringKeyframe(1.0, duration: 0.5, spring: .bouncy)
                    }
                }
                .opacity(posee ? 1 : 0)
            Text("\(Text("DROP").font(.system(size: 17, weight: .heavy, design: .rounded)).foregroundStyle(.white))\(Text(".ctrl").font(.system(size: 15, weight: .medium, design: .monospaced)).foregroundStyle(Theme.text3))")
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).delay(1.6).repeatForever(autoreverses: false)) { reflet = true }
        }
    }
}

/// Le style des boutons ronds : du verre qui s'allume au survol, se comprime
/// au clic, et se teinte de violet quand sa page est ouverte.
private struct VerreRond: ButtonStyle {
    let actif: Bool
    @State private var survol = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .glassEffect(
                actif ? .regular.tint(Theme.violet.opacity(0.55)).interactive() : .regular.interactive(),
                in: .circle
            )
            .overlay {
                Circle().strokeBorder(.white.opacity(survol ? 0.35 : 0.12), lineWidth: 0.8)
            }
            .shadow(color: actif ? Theme.violet.opacity(0.7) : .clear, radius: 12)
            .scaleEffect(configuration.isPressed ? 0.9 : (survol ? 1.06 : 1))
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
            .animation(.spring(response: 0.35, dampingFraction: 0.7), value: survol)
            .animation(Theme.spring, value: actif)
            .onHover { survol = $0 }
    }
}

/// Le menu central : une capsule de Liquid Glass, et dedans une goutte de
/// verre violette sous l'onglet actif. Changer d'onglet fait couler la goutte
/// (meme identite de verre a chaque place : elle se deforme en chemin), qui
/// s'ecrase un peu en arrivant. Au survol, une pastille claire suit la
/// souris ; on peut aussi glisser sur la capsule pour changer d'onglet.
struct MacTabBar: View {
    @Binding var selection: MacPage
    var badges: [MacPage: Int] = [:]

    @Namespace private var verre
    @Namespace private var survolNS
    @State private var survol: MacPage?
    @State private var arrivees = 0
    @State private var appuye: MacPage?

    private let largeurOnglet: CGFloat = 138

    var body: some View {
        GlassEffectContainer(spacing: 18) {
            HStack(spacing: 2) {
                ForEach(MacPage.onglets) { onglet in
                    item(onglet)
                }
            }
            .padding(5)
            // le verre de la capsule n'est pas interactif : seuls les onglets
            // (et la goutte) reagissent au pointeur, pas les espaces entre eux
            .glassEffect(.regular, in: .capsule)
            .overlay { reflet }
        }
        .shadow(color: Theme.violet.opacity(0.3), radius: 22, y: 8)
        .shadow(color: .black.opacity(0.3), radius: 14, y: 8)
        .coordinateSpace(name: "menu")
        .simultaneousGesture(
            DragGesture(minimumDistance: 8, coordinateSpace: .named("menu"))
                .onChanged { v in
                    let i = Int(((v.location.x - 5) / (largeurOnglet + 2)).rounded(.down))
                    let onglets = MacPage.onglets
                    let cible = onglets[min(max(i, 0), onglets.count - 1)]
                    if cible != selection {
                        selection = cible
                        arrivees += 1
                    }
                }
        )
    }

    private func item(_ onglet: MacPage) -> some View {
        let actif = selection == onglet
        return Button {
            guard !actif else { return }
            selection = onglet
            arrivees += 1
        } label: {
            HStack(spacing: 8) {
                Image(systemName: actif ? onglet.symbol + ".fill" : onglet.symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .symbolEffect(.bounce.up.byLayer, value: actif ? arrivees : 0)
                    .contentTransition(.symbolEffect(.replace))
                Text(onglet.title)
                    .font(.system(size: 14, weight: .semibold))
                if let n = badges[onglet], n > 0 {
                    Text(n > 99 ? "99+" : "\(n)")
                        .font(.system(size: 11, weight: .bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 18)
                        .background(Theme.accentGradient, in: .capsule)
                        .contentTransition(.numericText(value: Double(n)))
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .foregroundStyle(actif ? AnyShapeStyle(.white) : AnyShapeStyle(Theme.text2))
            .shadow(color: actif ? Theme.violetLight.opacity(0.8) : .clear, radius: 8)
            .frame(width: largeurOnglet, height: 40)
            .contentShape(.capsule)
            .background {
                if actif {
                    goutte
                } else if survol == onglet {
                    Capsule()
                        .fill(.white.opacity(0.09))
                        .matchedGeometryEffect(id: "survol", in: survolNS)
                        .transition(.opacity)
                }
            }
            .scaleEffect(appuye == onglet ? 0.93 : 1)
        }
        .buttonStyle(.plain)
        .onHover { dedans in
            withAnimation(.spring(response: 0.32, dampingFraction: 0.8)) {
                if dedans { survol = onglet } else if survol == onglet { survol = nil }
            }
        }
        .onLongPressGesture(minimumDuration: 0, maximumDistance: 6) {
        } onPressingChanged: { presse in
            withAnimation(.spring(response: 0.25, dampingFraction: 0.6)) { appuye = presse ? onglet : nil }
        }
        .animation(.spring(response: 0.42, dampingFraction: 0.72), value: selection)
        .help("\(onglet.title) (⌘\(String(onglet.raccourci.character)))")
        .accessibilityAddTraits(actif ? .isSelected : [])
    }

    /// La goutte : du verre teinte de violet, avec la meme identite a chaque
    /// place pour que le systeme la fasse couler d'un onglet a l'autre.
    private var goutte: some View {
        Capsule()
            .fill(.clear)
            .glassEffect(.regular.tint(Theme.violet.opacity(0.6)).interactive(), in: .capsule)
            .glassEffectID("goutte", in: verre)
            .overlay {
                Capsule()
                    .strokeBorder(
                        LinearGradient(colors: [.white.opacity(0.6), .white.opacity(0.05), Theme.violetLight.opacity(0.45)], startPoint: .top, endPoint: .bottom),
                        lineWidth: 0.8
                    )
            }
            .shadow(color: Theme.violet.opacity(0.6), radius: 12, y: 3)
            .keyframeAnimator(initialValue: Ecrasement(), trigger: arrivees) { vue, e in
                vue.scaleEffect(x: e.x, y: e.y)
            } keyframes: { _ in
                KeyframeTrack(\.x) {
                    SpringKeyframe(1.14, duration: 0.16, spring: .snappy)
                    SpringKeyframe(0.96, duration: 0.18, spring: .bouncy)
                    SpringKeyframe(1, duration: 0.26, spring: .smooth)
                }
                KeyframeTrack(\.y) {
                    SpringKeyframe(0.88, duration: 0.16, spring: .snappy)
                    SpringKeyframe(1.04, duration: 0.18, spring: .bouncy)
                    SpringKeyframe(1, duration: 0.26, spring: .smooth)
                }
            }
    }

    /// la lumiere qui tombe sur le verre de la capsule
    private var reflet: some View {
        Capsule()
            .strokeBorder(
                LinearGradient(
                    colors: [.white.opacity(0.4), .white.opacity(0.03), .clear, Theme.violetLight.opacity(0.3)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ),
                lineWidth: 0.8
            )
            .allowsHitTesting(false)
    }

    private struct Ecrasement {
        var x: CGFloat = 1
        var y: CGFloat = 1
    }
}
#endif
