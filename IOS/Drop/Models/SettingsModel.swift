import SwiftUI
import UserNotifications
import DropKit

/// Les reglages : notifications, impression auto, dettes, prix, fusions.
@Observable
final class SettingsModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var debts: [Debt] = []
    private(set) var senders: [Sender] = []
    private(set) var candidates: [MergeCandidate] = []
    private(set) var loaded = false
    private(set) var loadError: String?
    private(set) var notificationStatus: UNAuthorizationStatus = .notDetermined
    private(set) var busy: Set<String> = []
    private(set) var celebration = 0
    /// l'etat detaille de l'impression auto (agent, taches, filtres)
    private(set) var impression: ImpressionAuto?
    private(set) var impressionErreur: String?

    init(app: AppModel) {
        self.app = app
    }

    var totalOwed: Double { debts.reduce(0) { $0 + $1.owed } }
    var autoPrint: AutoPrint { app.dashboard.stats?.autoPrint ?? .init() }

    func refresh() async {
        do {
            async let d = app.api.debts()
            async let s = app.api.senders()
            async let c = app.api.mergeCandidates()
            let (dettes, expediteurs, candidats) = try await (d, s, c)
            app.reachedServer()
            loadError = nil
            withAnimation(Theme.spring) {
                if dettes != debts { debts = dettes }
                if expediteurs != senders { senders = expediteurs }
                if candidats != candidates { candidates = candidats }
                loaded = true
            }
        } catch {
            if !loaded { loadError = app.messageEchec(error) }
            app.report(error)
        }
        notificationStatus = await NotificationService.status()
        await app.dashboard.refresh()
    }

    // MARK: Notifications

    func enableNotifications() async {
        await NotificationService.requestAuthorization()
        notificationStatus = await NotificationService.status()
        if notificationStatus == .authorized {
            app.toasts.show("Notifications activées")
        } else if notificationStatus == .denied {
            app.toasts.show("Refusées · autorise Drop dans Réglages > Notifications", style: .info)
        }
    }

    func testNotification() async {
        await NotificationService.sendTest()
        app.toasts.show("Notification d'essai dans 2 secondes", style: .info)
    }

    // MARK: Impression auto

    /// Activer ne vide pas un stock entier d'un coup : le serveur considere ce
    /// qui est deja en attente comme deja imprime.
    func setAutoPrint(_ actif: Bool) async {
        let ok = await act("auto") {
            try await app.api.setAutoPrint(actif)
        } succes: {
            actif ? "Impression auto activée" : "Impression auto désactivée"
        }
        if ok && actif { celebration += 1 }
        await app.dashboard.refresh()
        await chargeImpression()
    }

    /// Relu regulierement tant que l'ecran est ouvert : ce que l'agent du Mac
    /// a vraiment fait, jamais une supposition.
    func chargeImpression() async {
        do {
            let etat = try await app.api.impressionAuto()
            impressionErreur = nil
            if etat != impression { withAnimation(Theme.spring) { impression = etat } }
        } catch {
            if impression == nil { impressionErreur = app.messageEchec(error) }
        }
    }

    func regleFiltres(_ filtres: ImpressionAuto.Filtres) async {
        guard !busy.contains("filtres") else { return }
        busy.insert("filtres")
        defer { busy.remove("filtres") }
        if let etat = await app.perform({ try await app.api.regleImpressionAuto(filtres: filtres) }) {
            withAnimation(Theme.spring) { impression = etat }
            await app.dashboard.refresh()
        }
    }

    // MARK: Dettes

    func markPaid(_ dette: Debt) async {
        let ok = await act("paye:" + dette.senderName) {
            _ = try await app.api.markPaid(sender: dette.senderName, owed: dette.owed)
        } succes: {
            "Paiement de \(dette.senderName) enregistré"
        }
        if ok { celebration += 1 }
    }

    // MARK: Expediteurs

    func addSender(name: String, price: Double, litPrice: Double, bjPrice: Double) async -> Bool {
        let nom = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !nom.isEmpty else { return false }
        let ok = await app.perform({ try await app.api.addSender(name: nom, price: price, litPrice: litPrice, bjPrice: bjPrice) }) != nil
        if ok {
            app.toasts.show("\(nom) ajouté")
            celebration += 1
            await refresh()
        }
        return ok
    }

    func updatePrice(_ sender: Sender, _ champ: PriceField, _ valeur: Double) async -> Bool {
        guard valeur >= 0, valeur != champ.value(in: sender) else { return true }
        guard let maj = await app.perform({ try await app.api.updatePrice(senderID: sender.id, field: champ, value: valeur) }) else { return false }
        if let i = senders.firstIndex(where: { $0.id == maj.id }) { senders[i] = maj }
        Haptics.tick()
        return true
    }

    func delete(_ sender: Sender) async {
        guard await app.perform({ try await app.api.deleteSender(sender.id) }) != nil else { return }
        withAnimation(Theme.spring) { senders.removeAll { $0.id == sender.id } }
        app.toasts.show("\(sender.name) supprimé")
        await refresh()
    }

    // MARK: Espaces expediteurs

    func lienPortail(_ sender: Sender) -> URL? {
        sender.portail?.url(sur: app.serverURL)
    }

    /// Cree le lien prive d'un expediteur (ou le regenere) et le copie.
    func creePortail(_ sender: Sender) async {
        let cle = "portail:\(sender.id)"
        guard !busy.contains(cle) else { return }
        busy.insert(cle)
        defer { busy.remove(cle) }
        let regenere = sender.portail?.lien != nil
        guard let maj = await app.perform({ try await app.api.creePortail(senderID: sender.id) }) else { return }
        withAnimation(Theme.spring) {
            if let i = senders.firstIndex(where: { $0.id == maj.id }) { senders[i] = maj }
        }
        if let lien = lienPortail(maj) { Platform.copy(lien.absoluteString) }
        app.toasts.show(regenere ? "Nouveau lien copié · l'ancien ne marche plus" : "Espace de \(sender.name) créé · lien copié")
        celebration += 1
    }

    func retirePortail(_ sender: Sender) async {
        guard let maj = await app.perform({ try await app.api.retirePortail(senderID: sender.id) }) else { return }
        withAnimation(Theme.spring) {
            if let i = senders.firstIndex(where: { $0.id == maj.id }) { senders[i] = maj }
        }
        app.toasts.show("Espace de \(sender.name) désactivé")
    }

    // MARK: Fusions

    func merge(source: Sender, into cible: Sender) async {
        guard let r = await app.perform({ try await app.api.merge(source: source.id, into: cible.id) }) else { return }
        app.toasts.show("\(Format.count(r.moved, "colis transféré", "colis transférés")) vers « \(r.target) »")
        celebration += 1
        await refresh()
    }

    func mergeIntoOther(_ ids: Set<Int>) async -> Bool {
        guard !ids.isEmpty else { return false }
        let ok = await app.perform({ try await app.api.mergeIntoOther(Array(ids)) }) != nil
        if ok {
            app.toasts.show("Expéditeurs regroupés en « Autre »")
            await refresh()
        }
        return ok
    }

    // MARK: Outils

    func isBusy(_ cle: String) -> Bool { busy.contains(cle) }

    @discardableResult
    private func act(_ cle: String, _ action: () async throws -> Void, succes: () -> String) async -> Bool {
        guard !busy.contains(cle) else { return false }
        busy.insert(cle)
        defer { busy.remove(cle) }
        // un refus (montant change, conflit) se relit aussi : l'ecran montre
        // alors la valeur a jour au lieu de l'ancienne
        guard await app.perform({ try await action() }) != nil else {
            await refresh()
            return false
        }
        app.toasts.show(succes())
        await refresh()
        return true
    }
}
