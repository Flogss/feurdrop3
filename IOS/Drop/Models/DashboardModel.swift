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

    // le stock : ce qui est en cours d'envoi, ce qui attend son tour, la
    // derniere valeur confirmee par le serveur, l'envoi en cours
    @ObservationIgnored private var stockEnVol: [StockKind: Int] = [:]
    @ObservationIgnored private var stockAttente: [StockKind: Int] = [:]
    @ObservationIgnored private var stockServeur: Stock?
    @ObservationIgnored private var boucleStock: [StockKind: Task<Bool, Never>] = [:]
    // les colis a la main en attente d'envoi, par expediteur
    @ObservationIgnored private var colisMain: [String: (ajouts: Int, retraits: Int)] = [:]
    @ObservationIgnored private var boucleColisMain: [String: Task<Void, Never>] = [:]
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
            async let historique: Void = app.journal.refresh()
            await app.locker.refreshCount()
            await historique
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

        // n'ecrire que ce qui change : chaque ecriture fait recalculer toutes
        // les vues qui lisent la valeur, meme si elle est identique
        if let maintenant = ServerDate.parse(s.tour.now) {
            let ecart = maintenant.timeIntervalSinceNow
            if abs(ecart - clockOffset) > 0.5 { clockOffset = ecart }
        }
        if s != stats || !loaded {
            withAnimation(Theme.spring) {
                stats = s
                if !loaded { loaded = true }
            }
        }
        app.lastSeen.save(LastSeenSnapshot(pending: s.pendingCount, earned: s.droppedValue, today: s.todayValue, day: LastSeenStore.dayKey()))
        // sous les yeux : tout est vu, les notifications repartiront d'ici
        if Platform.isFrontmost { ParcelWatch.seen(s) }
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

    /// Une valeur du serveur (rafraichissement) : elle fait foi pour un stock
    /// qui n'a rien en route ; un stock en cours d'envoi garde sa valeur
    /// confirmee jusqu'a la reponse de son envoi.
    private func appliqueStock(_ serveur: Stock) {
        var base = stockServeur ?? serveur
        if stockEnVol[.normal, default: 0] == 0 && stockAttente[.normal, default: 0] == 0 && boucleStock[.normal] == nil { base.normal = serveur.normal }
        if stockEnVol[.bj, default: 0] == 0 && stockAttente[.bj, default: 0] == 0 && boucleStock[.bj] == nil { base.bj = serveur.bj }
        stockServeur = base
        if stock == nil { stock = base } else { afficheStock() }
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
    /// Le stock, appui par appui : l'affichage suit le doigt tout de suite ; le
    /// serveur recoit les appuis UN envoi a la fois par stock, ceux faits
    /// pendant un envoi sont cumules et partent juste apres. Avant, chaque
    /// appui partait de son cote : une reponse en retard ecrasait la plus
    /// recente, et un echec remettait la valeur d'avant le clic, effacant les
    /// autres appuis en route. Affiche = serveur + en cours + en attente.
    func adjustStock(_ delta: Int, _ kind: StockKind) async -> Bool {
        guard delta != 0, stock != nil else { return false }
        stockAttente[kind, default: 0] += delta
        afficheStock()
        if let boucle = boucleStock[kind] { return await boucle.value }
        let boucle = Task { await videStock(kind) }
        boucleStock[kind] = boucle
        return await boucle.value
    }

    private func videStock(_ kind: StockKind) async -> Bool {
        var ok = true
        while stockAttente[kind, default: 0] != 0 {
            let delta = stockAttente[kind, default: 0]
            stockAttente[kind] = 0
            stockEnVol[kind] = delta
            do {
                let serveur = try await app.api.adjustStock(delta, kind: kind)
                app.reachedServer()
                stockEnVol[kind] = 0
                stockServeur = serveur
            } catch {
                // seul CET envoi est mis de cote : les appuis faits depuis restent
                stockEnVol[kind] = 0
                ok = false
                app.report(error)
            }
            afficheStock()
        }
        boucleStock[kind] = nil
        // une coupure ne dit pas si le serveur a applique l'envoi : apres un
        // echec, la valeur du serveur fait foi tout de suite
        if !ok { await refresh() }
        return ok
    }

    /// serveur + ce qui est en route, stock par stock
    private func afficheStock() {
        guard var affiche = stockServeur ?? stock else { return }
        affiche.normal += stockEnVol[.normal, default: 0] + stockAttente[.normal, default: 0]
        affiche.bj += stockEnVol[.bj, default: 0] + stockAttente[.bj, default: 0]
        if affiche != stock { withAnimation(Theme.spring) { stock = affiche } }
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
    /// `drop` : le sac est poste -- seuls les colis imprimes partent, le
    /// reste attend la prochaine tournee. Sinon on referme sans rien dropper.
    func endTour(drop: Bool) async {
        if drop {
            await runDrop("tour") { try await app.api.finishTour() } message: { r in
                Self.message(r, suffixe: " · \(Format.euro(r.value ?? 0))")
            }
        } else {
            await run("tour") { try await app.api.cancelTour() } succes: { "Tournée annulée" }
        }
    }

    func dismissTourSummary() async {
        withAnimation(Theme.spring) { stats?.tour.last = nil }
        try? await app.api.dismissTourSummary()
    }

    // MARK: Drops

    // Un drop groupe ne solde que les colis deja imprimes : le message dit
    // combien sont restes en attente faute d'impression.

    func dropAll() async {
        await runDrop("tout") { try await app.api.dropAll() } message: { Self.message($0) }
    }

    func dropAllExceptLit() async {
        await runDrop("sauf-lit") { try await app.api.dropAllExceptLit() } message: { Self.message($0) }
    }

    func dropSender(_ nom: String) async {
        await runDrop("exp:" + nom) { try await app.api.dropSender(nom) } message: { Self.message($0, suffixe: " pour \(nom)") }
    }

    func dropCarrier(_ code: String) async {
        await runDrop("tr:" + code) { try await app.api.dropCarrier(code) } message: { Self.message($0, suffixe: " · \(Carrier.label(code))") }
    }

    /// "8 colis dropés · Mondial Relay · 3 pas encore imprimés restent" ; nil
    /// quand rien n'est parti
    private static func message(_ r: DropResult, suffixe: String = "") -> String? {
        guard r.count > 0 else { return nil }
        let reste = (r.restants ?? 0) > 0 ? " · " + Format.count(r.restants ?? 0, "colis pas encore imprimé reste", "colis pas encore imprimés restent") : ""
        return Format.count(r.count, "colis dropé", "colis dropés") + suffixe + reste
    }

    /// +1 / -1 colis a la main pour un expediteur : CHAQUE appui compte.
    /// Avant, un appui fait pendant l'envoi du precedent etait ignore : taper
    /// cinq fois vite pouvait n'ajouter qu'un ou deux colis. Les appuis partent
    /// un envoi a la fois par expediteur ; ceux faits pendant un envoi sont
    /// cumules et partent ensemble juste apres (+3 en une operation).
    func quick(_ nom: String, add: Bool) async {
        var e = colisMain[nom] ?? (0, 0)
        if add { e.ajouts += 1 } else { e.retraits += 1 }
        colisMain[nom] = e
        if let boucle = boucleColisMain[nom] { return await boucle.value }
        let boucle = Task { await videColisMain(nom) }
        boucleColisMain[nom] = boucle
        await boucle.value
    }

    private func videColisMain(_ nom: String) async {
        while let e = colisMain[nom], e.ajouts > 0 || e.retraits > 0 {
            colisMain[nom] = (0, 0)
            if e.ajouts > 0 {
                do {
                    try await app.api.quickAdd(sender: nom, n: e.ajouts)
                    app.toasts.show("+\(Format.count(e.ajouts, "colis", "colis")) · \(nom)")
                } catch {
                    app.toasts.show("\(Format.count(e.ajouts, "colis non ajouté", "colis non ajoutés")) pour \(nom)", style: .error)
                    app.report(error)
                }
            }
            if e.retraits > 0 {
                do {
                    let retires = try await app.api.quickRemove(sender: nom, n: e.retraits)
                    app.toasts.show("−\(Format.count(retires, "colis", "colis")) · \(nom)")
                } catch {
                    if case APIError.server(status: 404, _) = error {
                        app.toasts.show("Aucun colis en attente pour \(nom)", style: .info)
                    } else {
                        app.report(error)
                    }
                }
            }
            await refresh()
        }
        colisMain[nom] = nil
        boucleColisMain[nom] = nil
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
        } else if let reste = r.restants, reste > 0 {
            app.toasts.show("Rien de dropé : " + Format.count(reste, "colis pas encore imprimé", "colis pas encore imprimés"), style: .info)
        } else {
            app.toasts.show("Aucun colis à dropper", style: .info)
        }
        await refresh()
    }
}
