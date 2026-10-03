import SwiftUI
import DropKit

/// L'ecran principal : le sac a dropper, la tournee, les gains, le stock de
/// pochettes, et les drops groupes.
@Observable
final class DashboardModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var stats: Stats?
    /// le stock affiche : il suit le doigt tout de suite, le serveur confirme
    private(set) var stock: Stock?
    private(set) var loaded = false

    /// Le depart de chaque grand compteur au premier affichage : l'ancienne
    /// valeur de CET appareil (avec bulle "+N") s'il y a du nouveau, sinon
    /// zero pour la grande entree. Vide une fois l'entree jouee.
    private(set) var starts: [Counter: CounterStart] = [:]
    /// du nouveau depuis la derniere visite : le cha-ching attend la bulle "+N"
    @ObservationIgnored private var annonceAuLancement = false
    enum Counter: Hashable { case pending, pendingValue, today, earned, bj }

    /// une gerbe d'etincelles sur la carte principale
    private(set) var celebration = 0
    /// la fete du retour de tournee (taux horaire qui monte, etincelles)
    private(set) var tourCelebration = 0
    /// ecart entre l'horloge du serveur et celle du telephone, pour le chrono
    private(set) var clockOffset: TimeInterval = 0
    /// les gestes deja partis (un double appui ne doit rien doubler)
    private(set) var busy: Set<String> = []

    @ObservationIgnored private var stockEnVol: [StockKind: Int] = [:]
    @ObservationIgnored private var dernierVu: Date = .distantPast
    @ObservationIgnored private var dernierResume: String?

    init(app: AppModel) {
        self.app = app
    }

    var isTouring: Bool { stats?.tour.isActive ?? false }

    // MARK: Chargement

    func refresh() async {
        do {
            async let s = app.api.stats()
            async let k = app.api.stock()
            let (nouvelles, stockServeur) = try await (s, k)
            app.reachedServer()
            applique(nouvelles)
            appliqueStock(stockServeur)
            await app.locker.refreshCount()
            markSeenIfNeeded()
        } catch {
            app.report(error)
        }
    }

    private func applique(_ s: Stats) {
        let premier = !loaded
        if premier { prepareStarts(s) }

        // de nouveaux colis pendant que l'app est ouverte : cha-ching, quel que
        // soit l'onglet
        if let avant = stats, s.pendingCount > avant.pendingCount { Sounds.chaChing() }

        // le resume de tournee qui APPARAIT pendant qu'on regarde : c'est la fete
        let resume = s.tour.last.map { "\($0.endedAt)|\($0.value)" }
        if loaded, resume != nil, resume != dernierResume { tourCelebration += 1 }
        dernierResume = resume

        if let maintenant = ServerDate.parse(s.tour.now) {
            clockOffset = maintenant.timeIntervalSinceNow
        }
        withAnimation(Theme.spring) {
            stats = s
            loaded = true
        }
        app.lastSeen.save(LastSeenSnapshot(pending: s.pendingCount, earned: s.droppedValue, today: s.todayValue, day: LastSeenStore.dayKey()))
        // sous les yeux : tout est vu, les notifications repartiront d'ici
        ParcelWatch.seen(s)
    }

    /// La memoire de l'appareil decide d'ou partent les compteurs.
    private func prepareStarts(_ s: Stats) {
        let souvenir = app.lastSeen.load()
        let flourish = app.isColdStart
        let memeJour = souvenir?.day == LastSeenStore.dayKey()
        starts = [
            .pending: LastSeenStore.start(remembered: souvenir.map { Double($0.pending) }, current: Double(s.pendingCount), bootFlourish: flourish),
            .today: LastSeenStore.start(remembered: memeJour ? souvenir?.today : nil, current: s.todayValue, bootFlourish: flourish),
            .earned: LastSeenStore.start(remembered: souvenir?.earned, current: s.droppedValue, bootFlourish: flourish),
            .pendingValue: CounterStart(from: flourish ? 0 : nil, announces: false),
            .bj: CounterStart(from: flourish ? 0 : nil, announces: false),
        ]
        annonceAuLancement = starts[.pending]?.announces == true
        app.isColdStart = false
        Task { @MainActor in
            // l'entree jouee, les compteurs recrees partent de leur valeur
            try? await Task.sleep(for: .seconds(4))
            starts = [:]
        }
    }

    private func appliqueStock(_ serveur: Stock) {
        var affiche = stock ?? serveur
        // un appui en cours d'envoi : la valeur serveur, en retard, ne doit
        // pas ecraser celle qu'on a deja montree
        if stockEnVol[.normal, default: 0] == 0 { affiche.normal = serveur.normal }
        if stockEnVol[.bj, default: 0] == 0 { affiche.bj = serveur.bj }
        if affiche != stock { stock = affiche }
    }

    /// Appele quand le dashboard apparait au lancement : le son part avec la
    /// bulle "+N colis" (le compteur attend que la carte soit entree).
    func playLaunchAnnouncement() {
        guard annonceAuLancement else { return }
        annonceAuLancement = false
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(0.55))
            Sounds.chaChing()
        }
    }

    /// Le "+N" des notifications compte depuis la derniere fois qu'on a
    /// regarde : on le dit au serveur, une fois toutes les 30 s au plus.
    func markSeenIfNeeded(force: Bool = false) {
        guard Date.now.timeIntervalSince(dernierVu) > (force ? 2 : 30) else { return }
        dernierVu = .now
        let api = app.api
        Task { try? await api.markSeen() }
    }

    // MARK: Stock

    /// Optimiste : l'affichage bouge tout de suite ; en cas d'echec il revient.
    @discardableResult
    func adjustStock(_ delta: Int, _ kind: StockKind) async -> Bool {
        guard delta != 0, var local = stock else { return false }
        let precedent = kind == .normal ? local.normal : local.bj
        if kind == .normal { local.normal += delta } else { local.bj += delta }
        withAnimation(Theme.spring) { stock = local }
        stockEnVol[kind, default: 0] += 1
        do {
            let serveur = try await app.api.adjustStock(delta, kind: kind)
            app.reachedServer()
            stockEnVol[kind, default: 1] -= 1
            appliqueStock(serveur)
            return true
        } catch {
            stockEnVol[kind, default: 1] -= 1
            var retour = stock ?? local
            if kind == .normal { retour.normal = precedent } else { retour.bj = precedent }
            withAnimation(Theme.bouncy) { stock = retour }
            app.report(error)
            return false
        }
    }

    // MARK: Tournee

    func startTour() async {
        let sac = stats?.pendingCount ?? 0
        await run("tour") {
            try await app.api.startTour()
        } succes: {
            "Bonne tournée ! \(Format.count(sac, "colis", "colis")) dans le sac."
        }
    }

    /// `drop` : le sac est poste. Sinon on referme sans rien dropper.
    func endTour(drop: Bool) async {
        let n = stats?.pendingCount ?? 0
        let v = stats?.pendingValue ?? 0
        await run("tour") {
            if drop { try await app.api.finishTour() } else { try await app.api.cancelTour() }
        } succes: {
            drop ? "\(Format.count(n, "colis dropé", "colis dropés")) · \(Format.euro(v))" : "Tournée annulée"
        }
        if drop { celebration += 1 }
    }

    func dismissTourSummary() async {
        withAnimation(Theme.spring) { stats?.tour.last = nil }
        try? await app.api.dismissTourSummary()
    }

    // MARK: Drops

    func dropAll() async {
        await runDrop("tout") { try await app.api.dropAll() } message: { Format.count($0.count, "colis dropé", "colis dropés") }
    }

    func dropAllExceptLit() async {
        await runDrop("sauf-lit") { try await app.api.dropAllExceptLit() } message: { r in
            r.count == 0 ? nil : Format.count(r.count, "colis dropé", "colis dropés")
        }
    }

    func dropSender(_ nom: String) async {
        await runDrop("exp:" + nom) { try await app.api.dropSender(nom) } message: {
            "\(Format.count($0.count, "colis dropé", "colis dropés")) pour \(nom)"
        }
    }

    func dropCarrier(_ code: String) async {
        await runDrop("tr:" + code) { try await app.api.dropCarrier(code) } message: {
            "\(Format.count($0.count, "colis dropé", "colis dropés")) · \(Carrier.label(code))"
        }
    }

    /// +1 / -1 colis a la main pour un expediteur
    func quick(_ nom: String, add: Bool) async {
        let cle = (add ? "+" : "-") + nom
        guard !busy.contains(cle) else { return }
        busy.insert(cle)
        defer { busy.remove(cle) }
        do {
            if add { try await app.api.quickAdd(sender: nom) } else { try await app.api.quickRemove(sender: nom) }
            app.toasts.show("\(add ? "+1" : "−1") colis · \(nom)")
        } catch {
            if !add, case APIError.server = error {
                app.toasts.show("Aucun colis en attente pour \(nom)", style: .info)
            } else {
                app.report(error)
            }
        }
        await refresh()
    }

    // MARK: Outils

    private func run(_ cle: String, _ action: () async throws -> Void, succes: () -> String) async {
        guard !busy.contains(cle) else { return }
        busy.insert(cle)
        defer { busy.remove(cle) }
        let ok = await app.perform { try await action() } != nil
        if ok {
            app.toasts.show(succes())
            await refresh()
        }
    }

    private func runDrop(_ cle: String, _ action: () async throws -> DropResult, message: (DropResult) -> String?) async {
        guard !busy.contains(cle) else { return }
        busy.insert(cle)
        defer { busy.remove(cle) }
        guard let r = await app.perform({ try await action() }) else { return }
        if let texte = message(r) {
            app.toasts.show(texte)
            celebration += 1
        } else {
            app.toasts.show("Aucun colis à dropper en dehors des LIT.", style: .info)
        }
        await refresh()
    }
}
