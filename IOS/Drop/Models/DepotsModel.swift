import SwiftUI
import DropKit

/// Le controle des depots : ce que les transporteurs disent des colis dropes.
/// Le serveur verifie a son rythme (API La Poste) ; la page ne fait que lire
/// sa base -- seuls « Vérifier » et « Relancer » font interroger La Poste.
@Observable
final class DepotsModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var vue: DepotsVue?
    private(set) var loadError: String?
    /// les compteurs de la pastille du dashboard (relus au plus une fois par minute)
    private(set) var resume: DepotsCompteurs?
    @ObservationIgnored private var resumeLu: Date = .distantPast

    // les filtres de la liste
    var filtre: Filtre = .tous
    var transporteur: String?
    var expediteur: String?
    var recherche = ""

    /// les colis en cours de verification (« Vérifier »)
    private(set) var enVerification: Set<Int> = []
    private(set) var relance = false
    private(set) var celebration = 0

    enum Filtre: Hashable {
        case tous, attention
        case categorie(DepotCategorie)

        var libelle: String {
            switch self {
            case .tous: "Tous"
            case .attention: "À regarder"
            case .categorie(let c): c == .aVerifier ? "Vérif. nécessaire" : c == .bloque ? "Bloquées" : c == .anomalie ? "Anomalies" : c == .confirme ? "Confirmés" : "Non confirmés"
            }
        }

        static let tousLesFiltres: [Filtre] = [.tous, .attention] + DepotCategorie.allCases.map { .categorie($0) }
    }

    init(app: AppModel) {
        self.app = app
    }

    var loaded: Bool { vue != nil }
    var laPoste: DepotMethode? { vue?.etat.laPoste }

    /// la liste filtree
    var lignes: [DepotLigne] {
        guard let vue else { return [] }
        let q = recherche.replacingOccurrences(of: " ", with: "").uppercased()
        return vue.lignes.filter { l in
            switch filtre {
            case .tous: break
            case .attention: if !l.attention { return false }
            case .categorie(let c): if l.controle.cat != c { return false }
            }
            if let transporteur, l.transporteur.code != transporteur { return false }
            if let expediteur, l.expediteur != expediteur { return false }
            if !q.isEmpty, !l.numero.contains(q) { return false }
            return true
        }
    }

    var filtreActif: Bool { filtre != .tous || transporteur != nil || expediteur != nil || !recherche.isEmpty }

    var transporteursPresents: [(code: String, nom: String)] {
        var vus: [String: String] = [:]
        for l in vue?.lignes ?? [] { vus[l.transporteur.code] = l.transporteur.nom }
        return vus.map { (code: $0.key, nom: $0.value) }.sorted { $0.nom.localizedCompare($1.nom) == .orderedAscending }
    }

    var expediteursPresents: [String] {
        Set((vue?.lignes ?? []).map(\.expediteur)).sorted { $0.localizedCompare($1) == .orderedAscending }
    }

    /// les colis a constater sur la page officielle, dans l'ordre de la liste
    var aConstater: [DepotLigne] { (vue?.lignes ?? []).filter { $0.aConstater == true } }

    // MARK: Chargement

    func refresh() async {
        do {
            let nouvelle = try await app.api.depots()
            app.reachedServer()
            if nouvelle != vue || loadError != nil {
                withAnimation(vue == nil ? nil : Theme.spring) {
                    vue = nouvelle
                    resume = nouvelle.compteurs
                    loadError = nil
                }
            }
            resumeLu = .now
        } catch {
            if vue == nil { loadError = (error as? LocalizedError)?.errorDescription ?? "Contrôle indisponible" }
            app.report(error)
        }
    }

    /// La page ouverte se relit toutes les 15 s (plus vite pendant un passage).
    func surveille() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(vue?.etat.enCours == true ? 3 : 15))
            if Task.isCancelled { break }
            await refresh()
        }
    }

    /// La pastille du dashboard : legere, et pas plus d'une fois par minute.
    func refreshResume() async {
        guard Date.now.timeIntervalSince(resumeLu) > 60 else { return }
        resumeLu = .now
        guard let r = try? await app.api.depotsResume() else { return }
        if r.compteurs != resume { withAnimation(Theme.spring) { resume = r.compteurs } }
    }

    // MARK: Actions

    /// « Vérifier » : une lecture tout de suite. Renvoie le detail a jour.
    @discardableResult
    func verifie(_ colisID: Int) async -> DepotDetail? {
        guard !enVerification.contains(colisID) else { return nil }
        enVerification.insert(colisID)
        defer { enVerification.remove(colisID) }
        guard let detail = await app.perform({ try await app.api.verifieDepot(colisID) }) else { return nil }
        app.toasts.show("\(detail.numero) : \(detail.controle.libelle.lowercased())")
        await refresh()
        return detail
    }

    /// Ce qu'on a vu sur la page officielle (UPS, DHL...).
    func constate(_ colisID: Int, _ choix: DepotConstatChoix) async -> DepotDetail? {
        guard let detail = await app.perform({ try await app.api.constateDepot(colisID, choix) }) else { return nil }
        if choix != .annule {
            celebration += 1
            app.toasts.show("\(detail.numero) : \(detail.controle.libelle.lowercased())")
        }
        await refresh()
        return detail
    }

    func detail(_ colisID: Int) async -> DepotDetail? {
        await app.perform { try await app.api.depot(colisID) }
    }

    /// « Relancer les vérifications en attente » : un passage en fond ; la
    /// page suit son avancement.
    func relancer() async {
        guard !relance else { return }
        relance = true
        defer { relance = false }
        guard await app.perform({ try await app.api.relanceDepots() }) != nil else { return }
        app.toasts.show("Vérifications relancées, au rythme de La Poste", style: .info)
        await refresh()
    }
}
