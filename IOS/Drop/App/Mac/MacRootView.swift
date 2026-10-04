#if os(macOS)
import SwiftUI
import AppKit
import DropKit

enum MacWindow {
    static let principale = "principale"
}

/// Les pages de la fenetre : trois onglets (comme le site), et les outils
/// ouverts depuis les boutons de droite.
enum MacPage: String, CaseIterable, Identifiable, Hashable {
    case dashboard, printing, stats, tracking, locker, settings

    var id: String { rawValue }

    static let onglets: [MacPage] = [.dashboard, .printing, .stats]

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .printing: "Imprimé"
        case .stats: "Stats"
        case .tracking: "Suivi des colis"
        case .locker: "Mode locker"
        case .settings: "Réglages"
        }
    }

    var symbol: String {
        switch self {
        case .dashboard: "house"
        case .printing: "printer"
        case .stats: "chart.bar"
        case .tracking: "magnifyingglass"
        case .locker: "lock"
        case .settings: "gearshape"
        }
    }

    /// l'icone pleine quand la page est ouverte (la loupe n'en a pas)
    var symboleActif: String {
        self == .tracking ? symbol : symbol + ".fill"
    }

    /// l'ordre pour le sens des transitions : les onglets de gauche a droite,
    /// les outils "plus loin"
    var rang: Int { MacPage.allCases.firstIndex(of: self) ?? 0 }

    var raccourci: KeyEquivalent {
        switch self {
        case .dashboard: "1"
        case .printing: "2"
        case .stats: "3"
        case .tracking: "4"
        case .locker: "5"
        case .settings: "6"
        }
    }
}

/// La fenetre du Mac, comme la version ordinateur du site : une barre en
/// haut (la marque, le menu en Liquid Glass au centre, les outils a droite),
/// le fond vivant sur toute la fenetre, et des pages qui arrivent du cote
/// d'ou l'on vient.
struct MacRootView: View {
    @Environment(AppModel.self) private var app
    @State private var booted = false
    @State private var sens: CGFloat = 1
    /// la meteorite du lancement, puis le logo qui rejoint la marque
    @State private var lancement = true
    @State private var cadreMarque: CGRect?
    @State private var marquePosee = false

    var body: some View {
        @Bindable var app = app
        ZStack(alignment: .top) {
            AmbientBackground()

            ZStack {
                page(app.pageMac)
                    .id(app.pageMac)
                    .transition(.pageMac(sens: sens))
            }
            .padding(.top, MacTopBar.hauteur)
            // prete sous la sequence de lancement ; l'onde la decouvre et elle
            // se pose (un peu grande et floue, puis nette)
            .blur(radius: booted ? 0 : 12)
            .scaleEffect(booted ? 1 : 1.03)

            MacTopBar(
                selection: Binding(get: { app.pageMac }, set: { va(vers: $0) }),
                marquePosee: marquePosee,
                surCadreMarque: { cadreMarque = $0 }
            )
        }
        .ignoresSafeArea(.container, edges: .top)
        .controlSize(.large)
        // pas de barres de defilement, meme avec une souris : on defile a la
        // molette (glissement doux) ou au trackpad, comme sur le site
        .scrollIndicators(.never)
        .overlay(alignment: .top) {
            ToastOverlay(center: app.toasts)
                .padding(.top, MacTopBar.hauteur + 6)
        }
        .overlay {
            if lancement {
                LaunchSequence(
                    cible: cadreMarque,
                    onRevelation: revele,
                    onLogoPose: { marquePosee = true },
                    onFin: {
                        marquePosee = true
                        lancement = false
                    }
                )
            }
        }
        // le fond suit le pointeur, comme il suit l'inclinaison du telephone
        .onContinuousHover(coordinateSpace: .local) { phase in
            guard case .active(let point) = phase, let taille = NSApp.keyWindow?.contentView?.bounds.size, taille.width > 0 else { return }
            MotionParallax.shared.suit(CGPoint(x: point.x / taille.width, y: point.y / taille.height))
        }
        .sensoryFeedback(.selection, trigger: app.pageMac)
        .task { await demarre() }
        .task(id: app.pageMac) { await boucle() }
        .onReceive(NotificationCenter.default.publisher(for: .dropAllerA)) { note in
            if let page = note.object as? MacPage { va(vers: page) }
        }
    }

    /// Changer de page : la nouvelle arrive du cote ou elle se trouve.
    private func va(vers page: MacPage) {
        guard page != app.pageMac else { return }
        sens = page.rang > app.pageMac.rang ? 1 : -1
        withAnimation(.spring(response: 0.5, dampingFraction: 0.84)) { app.pageMac = page }
    }

    @ViewBuilder
    private func page(_ page: MacPage) -> some View {
        switch page {
        case .dashboard: DashboardView(booted: booted)
        case .printing: PrintViewMac()
        case .stats: StatsView()
        case .tracking:
            NavigationStack {
                TrackingView()
                    .safeAreaInset(edge: .top, spacing: 0) { enTete("Suivi des colis", largeur: 980) }
                    .navigationDestination(for: Route.self) { route in
                        if case .trackingLabel(let label) = route { TrackingDetailView(label: label) }
                    }
                    .frame(maxWidth: 980)
                    .frame(maxWidth: .infinity)
            }
        case .locker:
            NavigationStack {
                LockerView()
                    .safeAreaInset(edge: .top, spacing: 0) { enTete("Mode locker", largeur: 1100) }
                    .frame(maxWidth: 1100)
                    .frame(maxWidth: .infinity)
            }
        case .settings:
            NavigationStack {
                SettingsView()
                    .safeAreaInset(edge: .top, spacing: 0) { enTete("Réglages", largeur: 760) }
                    .navigationDestination(for: Route.self) { route in
                        switch route {
                        case .prices: PricesView()
                        case .mergeOther: MergeOtherView()
                        default: EmptyView()
                        }
                    }
                    .formStyle(.grouped)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    /// l'en-tete des pages d'outils (date + titre), aligne sur leur contenu
    private func enTete(_ titre: String, largeur: CGFloat) -> some View {
        PageHeader(titre)
            .padding(.horizontal, 16)
            .frame(maxWidth: largeur)
            .frame(maxWidth: .infinity)
    }

    /// Les premiers chiffres se chargent pendant la sequence de lancement ;
    /// c'est son onde qui ouvre l'interface (`revele`).
    private func demarre() async {
        MotionParallax.shared.start()
        await app.dashboard.refresh()
        if !app.dashboard.loaded { app.isColdStart = false }
    }

    /// L'onde de la meteorite ouvre la fenetre : la page se pose, les cartes
    /// entrent en cascade, les compteurs partent de zero.
    private func revele() {
        withAnimation(.spring(response: 0.9, dampingFraction: 0.86)) { booted = true }
        if app.pageMac == .dashboard { app.dashboard.playLaunchAnnouncement() }
    }

    /// La page affichee se relit toutes les 5 secondes tant que la fenetre est
    /// ouverte ; changer de page relit tout de suite.
    private func boucle() async {
        if app.pageMac == .stats {
            await app.stats.refresh(animated: true)
        } else if booted || app.pageMac != .dashboard {
            await app.refreshVisible()
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            if Task.isCancelled { break }
            await app.refreshVisible()
        }
    }
}

extension Notification.Name {
    /// demande d'aller a une page (menus, barre des menus)
    static let dropAllerA = Notification.Name("drop.allerA")
}

// MARK: - Transition de page

private struct PageMacEffet: ViewModifier {
    let decalage: CGFloat
    let flou: CGFloat
    let opacite: Double
    let echelle: CGFloat

    func body(content: Content) -> some View {
        content
            .offset(x: decalage)
            .blur(radius: flou)
            .opacity(opacite)
            .scaleEffect(echelle)
    }
}

extension AnyTransition {
    /// La page qui arrive glisse du cote ou elle se trouve en se precisant ;
    /// celle qui part s'efface vers l'autre cote.
    static func pageMac(sens: CGFloat) -> AnyTransition {
        .asymmetric(
            insertion: .modifier(
                active: PageMacEffet(decalage: 70 * sens, flou: 16, opacite: 0, echelle: 0.985),
                identity: PageMacEffet(decalage: 0, flou: 0, opacite: 1, echelle: 1)
            ),
            removal: .modifier(
                active: PageMacEffet(decalage: -50 * sens, flou: 12, opacite: 0, echelle: 0.99),
                identity: PageMacEffet(decalage: 0, flou: 0, opacite: 1, echelle: 1)
            )
        )
    }
}

// MARK: - Menus

/// Les menus : aller a une page (Cmd 1 a 6), actualiser (Cmd R).
struct DropCommands: Commands {
    let app: AppModel

    var body: some Commands {
        CommandMenu("Aller") {
            ForEach(MacPage.allCases) { page in
                Button(page.title) {
                    NotificationCenter.default.post(name: .dropAllerA, object: page)
                }
                .keyboardShortcut(page.raccourci, modifiers: .command)
            }
            Divider()
            Button("Actualiser") {
                Task { await app.refreshVisible() }
            }
            .keyboardShortcut("r", modifiers: .command)
        }
    }
}

/// Les reglages dans leur fenetre (Cmd ,), avec leurs sous-pages.
struct MacSettingsView: View {
    var body: some View {
        NavigationStack {
            SettingsView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .prices: PricesView()
                    case .mergeOther: MergeOtherView()
                    default: EmptyView()
                    }
                }
        }
        .formStyle(.grouped)
        .controlSize(.large)
        .scrollIndicators(.never)
        .frame(width: 620, height: 720)
        .background { AmbientBackground() }
    }
}
#endif
