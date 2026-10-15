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
            // un jeton par serveur : celui de ce serveur, s'il y en a un
            api = DropAPI(baseURL: serverURL)
            connecte = api.client.jeton != nil
        }
    }

    /// Une session est ouverte sur cet appareil (son jeton est dans le
    /// trousseau). Le serveur reste juge : une session expiree (72 h) ou
    /// revoquee repond 401, et l'ecran de connexion revient.
    var connecte = false
    /// pourquoi l'ecran de connexion est revenu ("Session expirée…")
    var messageConnexion: String?
    /// le mot de passe vient d'etre accepte : le lancement reprend au coeur
    /// de la meteorite (la ou l'ecran de connexion l'a laissee)
    var vientDeSeConnecter = false
    /// cette session : jusqu'a quand, combien d'appareils (les reglages)
    private(set) var session: InfoSession?

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
    @ObservationIgnored lazy var depots = DepotsModel(app: self)
    #if os(macOS)
    /// Ce Mac lit les pages officielles (Mondial Relay, GLS...) : tout seul,
    /// tant que l'app est ouverte -- sa veille est lancee au demarrage
    /// (AppDelegate), pas par une fenetre.
    @ObservationIgnored lazy var verificateur = VerificateurPages(app: self)
    #endif

    /// `feurdrop://depots/verifier` (le bouton du site « Ouvrir l'app Drop du
    /// Mac ») : la page du controle, et la verification.
    func ouvre(_ url: URL) {
        guard url.scheme == "feurdrop", connecte else { return }
        if url.host() == "depots" {
            #if os(macOS)
            pageMac = .depots
            if url.path().contains("verifier") { verificateur.demarre(visible: true) }
            #endif
        }
    }

    init() {
        let enregistre = UserDefaults.standard.string(forKey: "drop.serveur").flatMap(URL.init(string:))
        let adresse = enregistre ?? Self.defaultServer
        serverURL = adresse
        api = DropAPI(baseURL: adresse)
        #if DEBUG
        // verification contre un serveur LOCAL de test :
        // `-drop.serveur http://localhost:3001 -DropJetonTest <jeton>` pose, en
        // memoire seulement, une session que ce serveur a deja delivree (rien
        // n'est contourne : il la verifie a chaque requete). Jamais pour un
        // autre serveur.
        if let jeton = UserDefaults.standard.string(forKey: "DropJetonTest"), adresse.host() == "localhost" || adresse.host() == "127.0.0.1" {
            api.client.definitJeton(jeton)
        }
        #endif
        connecte = api.client.jeton != nil
        #if DEBUG
        // verification au simulateur : `-DropOnglet stats` ouvre un onglet
        if let depart = UserDefaults.standard.string(forKey: "DropOnglet"), let onglet = AppTab(rawValue: depart) {
            tab = onglet
        }
        #endif
    }

    // MARK: Connexion

    /// Le mot de passe contre une session (72 h). Renvoie le message d'erreur
    /// a afficher, ou nil si c'est bon.
    func seConnecte(motDePasse: String) async -> String? {
        do {
            let s = try await api.connexion(motDePasse: motDePasse, appareil: Platform.nomAppareil)
            Trousseau.garde(s.jeton, pour: serverURL)
            api.client.definitJeton(s.jeton)
            reachedServer()
            messageConnexion = nil
            // le jeton est garde : l'ecran de connexion joue sa sortie, puis
            // appelle `entreApresConnexion`
            return nil
        } catch {
            if let erreur = error as? APIError, erreur.isNetwork { return "Serveur injoignable. Vérifie la connexion et réessaie." }
            return (error as? LocalizedError)?.errorDescription ?? "Connexion impossible"
        }
    }

    /// Apres la sortie de l'ecran de connexion : le dashboard, et son lancement.
    func entreApresConnexion() {
        guard api.client.jeton != nil else { return }
        vientDeSeConnecter = true
        connecte = true
    }

    /// Se deconnecter (cet appareil), ou fermer toutes les sessions partout.
    func seDeconnecte(partout: Bool = false) async {
        if partout {
            guard await perform({ try await api.deconnexionPartout() }) != nil else { return }
        } else {
            try? await api.deconnexion()
        }
        oublieSession(message: partout ? "Tous les appareils ont été déconnectés." : nil)
    }

    /// Le jeton ne vaut plus rien (ou plus du tout) : on l'oublie, et l'ecran
    /// de connexion revient.
    func oublieSession(message: String?) {
        Trousseau.efface(pour: serverURL)
        api.client.definitJeton(nil)
        session = nil
        messageConnexion = message
        withAnimation(Theme.spring) { connecte = false }
    }

    func chargeSession() async {
        if let s = await perform({ try await api.session() }) { session = s }
    }

    /// Ce que l'onglet visible relit toutes les 5 secondes.
    func refreshVisible() async {
        guard connecte else { return }
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
        case .settings, .historique:
            await dashboard.refresh()
        case .depots:
            // la page se relit elle-meme (toutes les 15 s) : ici, les colis seulement
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
        // session expiree (72 h), revoquee, ou mot de passe change : la connexion
        if let api = error as? APIError, api.exigeConnexion {
            if connecte {
                oublieSession(message: "Ta session a expiré : entre le mot de passe pour continuer.")
                #if os(macOS)
                // la lecture de Mondial Relay s'arrete : on le dit, meme fenetre fermee
                Task { await NotificationService.sessionExpireeLecture() }
                #endif
            }
            return
        }
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

    /// Ce qu'un ecran dit d'un premier chargement rate (nil : une annulation,
    /// rien a dire -- l'ecran garde son squelette, un nouvel essai suit).
    func messageEchec(_ error: any Error) -> String? {
        if error is CancellationError { return nil }
        if let api = error as? APIError, api.exigeConnexion { return nil }
        return (error as? LocalizedError)?.errorDescription ?? "Chargement impossible"
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
