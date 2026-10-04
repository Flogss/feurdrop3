#if os(macOS)
import SwiftUI
import AppKit
import DropKit

enum MacWindow {
    static let principale = "principale"
}

/// Les pages de la barre laterale.
enum MacPage: String, CaseIterable, Identifiable, Hashable {
    case dashboard, printing, stats, tracking, locker

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .printing: "Imprimé"
        case .stats: "Stats"
        case .tracking: "Suivi des colis"
        case .locker: "Mode locker"
        }
    }

    var symbol: String {
        switch self {
        case .dashboard: "house.fill"
        case .printing: "printer.fill"
        case .stats: "chart.bar.fill"
        case .tracking: "magnifyingglass"
        case .locker: "lock.fill"
        }
    }

    /// l'onglet de l'iPhone correspondant (pour les entrees animees partagees)
    var onglet: AppTab? {
        switch self {
        case .dashboard: .dashboard
        case .printing: .printing
        case .stats: .stats
        default: nil
        }
    }

    var raccourci: KeyEquivalent {
        switch self {
        case .dashboard: "1"
        case .printing: "2"
        case .stats: "3"
        case .tracking: "4"
        case .locker: "5"
        }
    }
}

/// La fenetre du Mac : barre laterale a gauche (Liquid Glass du systeme), page
/// a droite sur le meme fond vivant que l'iPhone. Les pages sont celles de
/// l'app iPhone, mises en colonnes quand la fenetre est large.
struct MacRootView: View {
    @Environment(AppModel.self) private var app
    @State private var booted = false
    @State private var arrivee = TabArrivalState()

    var body: some View {
        @Bindable var app = app
        NavigationSplitView {
            List(selection: $app.pageMac) {
                Section {
                    ligne(.dashboard)
                    ligne(.printing)
                    ligne(.stats)
                }
                Section("Outils") {
                    ligne(.tracking)
                    ligne(.locker)
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        } detail: {
            page(app.pageMac)
                .id(app.pageMac)
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: 10)),
                    removal: .opacity
                ))
                .opacity(booted ? 1 : 0)
                .blur(radius: booted ? 0 : 12)
                .scaleEffect(booted ? 1 : 1.02)
        }
        .environment(\.tabArrival, arrivee)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                LivePill(online: app.isOnline)
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Actualiser", systemImage: "arrow.clockwise") {
                    Task { await app.refreshVisible() }
                }
                .help("Actualiser (⌘R)")
            }
        }
        .overlay(alignment: .top) {
            ToastOverlay(center: app.toasts)
                .padding(.top, 8)
        }
        // le fond suit le pointeur, comme il suit l'inclinaison du telephone
        .onContinuousHover(coordinateSpace: .local) { phase in
            guard case .active(let point) = phase, let taille = NSApp.keyWindow?.contentView?.bounds.size, taille.width > 0 else { return }
            MotionParallax.shared.suit(CGPoint(x: point.x / taille.width, y: point.y / taille.height))
        }
        .onChange(of: app.pageMac) { ancien, nouveau in
            guard let onglet = nouveau.onglet else { return }
            let sens: CGFloat = (MacPage.allCases.firstIndex(of: nouveau) ?? 0) > (MacPage.allCases.firstIndex(of: ancien) ?? 0) ? 1 : -1
            arrivee = TabArrivalState(compte: arrivee.compte + 1, sens: sens, onglet: onglet, depuis: .now)
        }
        .sensoryFeedback(.selection, trigger: app.pageMac)
        .task { await demarre() }
        .task(id: app.pageMac) { await boucle() }
    }

    private func ligne(_ page: MacPage) -> some View {
        Label(page.title, systemImage: page.symbol)
            .badge(badge(page))
            .tag(page)
    }

    private func badge(_ page: MacPage) -> Int {
        switch page {
        case .printing: app.dashboard.stats?.aImprimer ?? 0
        case .locker: app.locker.pairs.count
        default: 0
        }
    }

    @ViewBuilder
    private func page(_ page: MacPage) -> some View {
        switch page {
        case .dashboard: DashboardView(booted: booted)
        case .printing: PrintView()
        case .stats: StatsView()
        case .tracking:
            NavigationStack {
                TrackingView()
                    .navigationDestination(for: Route.self) { route in
                        if case .trackingLabel(let label) = route { TrackingDetailView(label: label) }
                    }
                    .frame(maxWidth: 980)
                    .frame(maxWidth: .infinity)
                    .fondVivant()
            }
        case .locker:
            NavigationStack {
                LockerView()
                    .frame(maxWidth: 1100)
                    .frame(maxWidth: .infinity)
                    .fondVivant()
            }
        }
    }

    /// Le lancement : les premiers chiffres arrivent, puis tout entre (les
    /// compteurs partent de zero, comme sur l'iPhone).
    private func demarre() async {
        MotionParallax.shared.start()
        async let chiffres: Void = app.dashboard.refresh()
        try? await Task.sleep(for: .milliseconds(450))
        let limite = Date.now.addingTimeInterval(1.6)
        while !app.dashboard.loaded && Date.now < limite {
            try? await Task.sleep(for: .milliseconds(80))
        }
        withAnimation(.spring(response: 0.7, dampingFraction: 0.86)) { booted = true }
        await chiffres
        if !app.dashboard.loaded { app.isColdStart = false }
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

/// Les menus : aller a une page (Cmd 1 a 5), actualiser (Cmd R).
struct DropCommands: Commands {
    let app: AppModel

    var body: some Commands {
        CommandMenu("Aller") {
            ForEach(MacPage.allCases) { page in
                Button(page.title) {
                    withAnimation(Theme.spring) { app.pageMac = page }
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
        .frame(width: 620, height: 720)
        .containerBackground(for: .window) { AmbientBackground() }
    }
}
#endif
