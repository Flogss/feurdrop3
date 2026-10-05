import SwiftUI
import DropKit

/// Les trois onglets du bas. Rien d'autre ne change de page "a plat" : le
/// reste s'ouvre en navigation (Reglages, Suivi, Locker) depuis le dashboard.
enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case dashboard, printing, stats

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .printing: "Imprimé"
        case .stats: "Stats"
        }
    }

    var symbol: String {
        switch self {
        case .dashboard: "house"
        case .printing: "printer"
        case .stats: "chart.bar"
        }
    }

    var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }
}

/// L'etat de toute l'app : le serveur, l'onglet, les messages, et un modele
/// par ecran. Les vues lisent ici ; elles ne parlent jamais au reseau
/// elles-memes.
@Observable
final class AppModel {
    static let defaultServer = URL(string: "https://feurdrop3-production.up.railway.app")!
    /// l'unique instance (la fenetre, la barre des menus et la veille du Mac la
    /// partagent)
    static let shared = AppModel()

    private(set) var api: DropAPI
    var serverURL: URL {
        didSet {
            UserDefaults.standard.set(serverURL.absoluteString, forKey: "drop.serveur")
            api = DropAPI(baseURL: serverURL)
        }
    }

    var tab: AppTab = .dashboard
    #if os(macOS)
    /// la page affichee dans la fenetre du Mac (barre laterale)
    var pageMac: MacPage = .dashboard
    #endif
    /// le dernier rafraichissement a-t-il joint le serveur ?
    var isOnline = true
    let toasts = ToastCenter()
    let lastSeen = LastSeenStore()
    /// vrai jusqu'au premier affichage des chiffres : la grande entree
    var isColdStart = true

    @ObservationIgnored lazy var dashboard = DashboardModel(app: self)
    @ObservationIgnored lazy var printing = PrintModel(app: self)
    @ObservationIgnored lazy var stats = StatsModel(app: self)
    @ObservationIgnored lazy var settings = SettingsModel(app: self)
    @ObservationIgnored lazy var locker = LockerModel(app: self)
    @ObservationIgnored lazy var tracking = TrackingModel(app: self)
    @ObservationIgnored lazy var journal = JournalModel(app: self)

    init() {
        let enregistre = UserDefaults.standard.string(forKey: "drop.serveur").flatMap(URL.init(string:))
        let adresse = enregistre ?? Self.defaultServer
        serverURL = adresse
        api = DropAPI(baseURL: adresse)
        #if DEBUG
        // verification au simulateur : `-DropOnglet stats` ouvre un onglet
        if let depart = UserDefaults.standard.string(forKey: "DropOnglet"), let onglet = AppTab(rawValue: depart) {
            tab = onglet
        }
        #endif
    }

    /// Ce que l'onglet visible relit toutes les 5 secondes.
    func refreshVisible() async {
        #if os(macOS)
        switch pageMac {
        case .dashboard: await dashboard.refresh()
        case .printing:
            async let colis: Void = dashboard.refresh()
            await printing.refresh()
            await colis
        case .stats: await stats.refresh(animated: false)
        case .tracking:
            async let colis: Void = dashboard.refresh()
            await tracking.refresh()
            await colis
        case .locker:
            async let colis: Void = dashboard.refresh()
            await locker.refresh()
            await colis
        case .settings:
            await dashboard.refresh()
        }
        #else
        switch tab {
        case .dashboard: await dashboard.refresh()
        case .printing:
            // les nouveaux colis s'entendent aussi depuis cet onglet
            async let colis: Void = dashboard.refresh()
            await printing.refresh()
            await colis
        case .stats: await stats.refresh(animated: false)
        }
        #endif
    }

    // MARK: Retours

    /// Une erreur dite simplement. Une coupure reseau se signale une fois ; son
    /// retour aussi.
    func report(_ error: any Error) {
        if error is CancellationError { return }
        if let api = error as? APIError, api.isNetwork {
            if isOnline {
                isOnline = false
                toasts.show("Connexion perdue · nouvel essai automatique", style: .error)
            }
            return
        }
        toasts.show(error.localizedDescription, style: .error)
    }

    func reachedServer() {
        if !isOnline {
            isOnline = true
            toasts.show("Connexion rétablie", style: .info)
        }
    }

    /// Le geste type : l'action part ; un echec est signale (message +
    /// vibration) et rend `nil`.
    @discardableResult
    func perform<T>(_ action: () async throws -> T) async -> T? {
        do {
            let resultat = try await action()
            reachedServer()
            return resultat
        } catch {
            report(error)
            return nil
        }
    }
}

/// Les messages ephemeres, en haut de l'ecran, sous l'ile dynamique.
@Observable
final class ToastCenter {
    enum Style { case success, error, info }

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let message: String
        let style: Style
    }

    private(set) var current: Toast?

    func show(_ message: String, style: Style = .success) {
        let toast = Toast(message: message, style: style)
        withAnimation(Theme.bouncy) { current = toast }
        switch style {
        case .success: Haptics.success()
        case .error: Haptics.error()
        case .info: Haptics.soft()
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(style == .error ? 4.5 : 3))
            if current?.id == toast.id { dismiss() }
        }
    }

    func dismiss() {
        withAnimation(Theme.spring) { current = nil }
    }
}
