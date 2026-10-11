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
            case .categorie(let c): c == .aVerifier ? "À vérifier" : c == .bloque ? "Bloquées" : c == .confirme ? "Postés confirmés" : "Non confirmés"
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
                    if let c = nouvelle.etat.campagne, campagne == nil || c.active || campagne?.active == true { campagne = c }
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
        var tour = 0
        while !Task.isCancelled {
            // pendant « Tout vérifier » : la progression toutes les 2 s
            let campagneActive = campagne?.active == true
            try? await Task.sleep(for: .seconds(campagneActive ? 2 : vue?.etat.enCours == true ? 3 : 15))
            if Task.isCancelled { break }
            tour += 1
            if campagneActive {
                await relisCampagne()
                if tour % 5 == 0 { await refresh() }
            } else {
                await refresh()
            }
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

    // MARK: « Tout vérifier »

    /// la campagne en cours (ou la derniere), relue toutes les 2 s pendant
    private(set) var campagne: DepotCampagneEtat?
    private(set) var lancement = false
    /// la derniere campagne masquee par l'utilisateur
    var campagneMasquee: Int?

    /// « Tout vérifier » : l'API La Poste part aussitot sur le serveur ; les
    /// pages officielles attendent l'app du Mac (qui s'y met d'elle-meme, et
    /// sur ce Mac tout de suite).
    func toutVerifier() async {
        guard !lancement else { return }
        lancement = true
        defer { lancement = false }
        campagneMasquee = nil
        guard let etat = await app.perform({ try await app.api.lanceCampagne() }) else { return }
        withAnimation(Theme.spring) { campagne = etat }
        let total = etat.compteurs?.total ?? 0
        app.toasts.show(total > 0 ? "\(Format.count(total, "colis à vérifier", "colis à vérifier")) : c'est parti" : "Rien à vérifier : tout est déjà confirmé ou lu à l'instant", style: total > 0 ? .success : .info)
        #if os(macOS)
        if etat.attendMac == true { app.verificateur.demarre() }
        #endif
        await refresh()
    }

    func annuleCampagne() async {
        guard let etat = await app.perform({ try await app.api.annuleCampagne() }) else { return }
        withAnimation(Theme.spring) { campagne = etat }
        #if os(macOS)
        app.verificateur.arrete()
        #endif
        app.toasts.show("Vérification annulée : ce qui a été lu est gardé", style: .info)
        await refresh()
    }

    /// la progression, relue pendant une campagne
    func relisCampagne() async {
        guard let etat = try? await app.api.campagne() else { return }
        let avant = campagne?.compteurs?.verifies
        let finie = campagne?.active == true && !etat.active
        if etat != campagne { withAnimation(Theme.spring) { campagne = etat } }
        if etat.compteurs?.verifies != avant || finie { await refresh() }
        if finie, let n = etat.compteurs {
            celebration += 1
            app.toasts.show("Vérification terminée : \(Format.count(n.confirmes, "posté confirmé", "postés confirmés")), \(Format.count(n.nonConfirmes, "non confirmé", "non confirmés"))" + (n.bloques > 0 ? ", \(Format.count(n.bloques, "bloqué", "bloqués"))" : ""))
        }
    }

    /// Couper ou rallumer la lecture automatique d'un transporteur sur le Mac.
    func lecture(_ code: String, active: Bool) async {
        guard await app.perform({ try await app.api.lectureDepots(code, active: active) }) != nil else { return }
        app.toasts.show(active ? "Lecture automatique rallumée" : "Lecture automatique coupée : constat à la main", style: .info)
        await refresh()
    }

    /// « Vérifier » : une lecture tout de suite. Renvoie le detail a jour.
    @discardableResult
    func verifie(_ colisID: Int) async -> DepotDetail? {
        guard !enVerification.contains(colisID) else { return nil }
        enVerification.insert(colisID)
        defer { enVerification.remove(colisID) }
        guard let detail = await app.perform({ try await app.api.verifieDepot(colisID) }) else { return nil }
        if detail.enAttenteDuMac == true {
            app.toasts.show("\(detail.numero) : le Mac va lire la page officielle", style: .info)
            #if os(macOS)
            app.verificateur.demarre()
            #endif
            await relisCampagne()
        } else {
            app.toasts.show("\(detail.numero) : \(detail.controle.libelle.lowercased())")
        }
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
