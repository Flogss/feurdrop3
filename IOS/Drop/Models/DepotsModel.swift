import SwiftUI
import DropKit

/// Le controle des depots : ce que les transporteurs disent des colis dropes.
/// Le serveur verifie a son rythme (API officielles) et l'app du Mac lit les
/// pages officielles ; la page ne fait que lire la base. La liste ne garde que
/// ce qui reste a trancher ; les depots prouves et les numeros retires sont
/// dans l'historique.
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
    var tri: Tri = .pasEncore

    /// l'ordre de la liste
    enum Tri: String, CaseIterable, Identifiable {
        /// ce qui attend son premier scan d'abord (le plus ancien drop en tete)
        case pasEncore
        case recents
        case anciens
        /// la verification la plus ancienne d'abord
        case verification

        var id: String { rawValue }
        var libelle: String {
            switch self {
            case .pasEncore: "Pas encore scannés d'abord"
            case .recents: "Drops les plus récents"
            case .anciens: "Drops les plus anciens"
            case .verification: "Vérifiés il y a le plus longtemps"
            }
        }
    }

    /// les colis en cours de verification (« Vérifier »)
    private(set) var enVerification: Set<Int> = []
    private(set) var relance = false
    private(set) var celebration = 0

    enum Filtre: Hashable {
        case tous, attention
        case categorie(DepotCategorie)
        /// l'historique : les depots prouves, les numeros retires
        case confirmes, retires

        var libelle: String {
            switch self {
            case .tous: "Tous"
            case .attention: "À regarder"
            case .categorie(let c): c == .aVerifier ? "À vérifier" : c == .bloque ? "Bloquées" : c == .enAttente ? "En attente" : c == .confirme ? "Postés confirmés" : c == .incorrect ? "Numéros incorrects" : "Pas encore scannés"
            case .confirmes: "Confirmés"
            case .retires: "Retirés"
            }
        }

        var historique: Bool { self == .confirmes || self == .retires }

        static let tousLesFiltres: [Filtre] = [.tous, .attention, .categorie(.nonConfirme), .categorie(.aVerifier), .categorie(.incorrect), .categorie(.enAttente), .categorie(.bloque), .confirmes, .retires]
    }

    init(app: AppModel) {
        self.app = app
    }

    var loaded: Bool { vue != nil }
    var laPoste: DepotMethode? { vue?.etat.laPoste }

    private var q: String { recherche.replacingOccurrences(of: " ", with: "").uppercased() }

    /// la liste filtree, dans l'ordre choisi
    var lignes: [DepotLigne] {
        guard let vue, !filtre.historique else { return [] }
        let q = q
        let filtrees = vue.lignes.filter { l in
            switch filtre {
            case .tous: break
            case .attention: if !l.attention { return false }
            case .categorie(let c): if l.controle.cat != c { return false }
            case .confirmes, .retires: return false
            }
            if let transporteur, l.transporteur.code != transporteur { return false }
            if let expediteur, l.expediteur != expediteur { return false }
            if !q.isEmpty, !l.numero.contains(q) { return false }
            return true
        }
        let drope = { (l: DepotLigne) in l.statutInterne.dropeLe ?? "" }
        switch tri {
        case .recents: return filtrees.sorted { drope($0) > drope($1) }
        case .anciens: return filtrees.sorted { drope($0) < drope($1) }
        case .verification: return filtrees.sorted { ($0.verifieLe ?? "", drope($0)) < ($1.verifieLe ?? "", drope($1)) }
        case .pasEncore: return filtrees.sorted { ($0.controle.cat.rang, drope($0)) < ($1.controle.cat.rang, drope($1)) }
        }
    }

    /// une recherche sur « Tous » fouille aussi l'historique : un numero se
    /// retrouve ou qu'il soit (confirme, retire)
    var historiqueTrouve: [DepotHistorique] {
        guard filtre == .tous, !q.isEmpty, let h = vue?.historique else { return [] }
        let q = q
        return (h.confirmes + h.retires).filter { l in
            if let transporteur, l.transporteur.code != transporteur { return false }
            if let expediteur, l.expediteur != expediteur { return false }
            return l.numero.contains(q)
        }
    }

    /// l'historique filtre (confirmes ou retires)
    var historique: [DepotHistorique] {
        guard let h = vue?.historique else { return [] }
        let liste: [DepotHistorique] = switch filtre {
        case .confirmes: h.confirmes
        case .retires: h.retires
        default: []
        }
        let q = q
        return liste.filter { l in
            if let transporteur, l.transporteur.code != transporteur { return false }
            if let expediteur, l.expediteur != expediteur { return false }
            if !q.isEmpty, !l.numero.contains(q) { return false }
            return true
        }
    }

    var filtreActif: Bool { (filtre != .tous && !filtre.historique) || transporteur != nil || expediteur != nil || !recherche.isEmpty }

    private var tousLesColis: [(code: String, nom: String, expediteur: String)] {
        let actifs = (vue?.lignes ?? []).map { (code: $0.transporteur.code, nom: $0.transporteur.nom, expediteur: $0.expediteur) }
        let h = vue?.historique
        let anciens = ((h?.confirmes ?? []) + (h?.retires ?? [])).map { (code: $0.transporteur.code, nom: $0.transporteur.nom, expediteur: $0.expediteur) }
        return actifs + anciens
    }

    var transporteursPresents: [(code: String, nom: String)] {
        var vus: [String: String] = [:]
        for l in tousLesColis { vus[l.code] = l.nom }
        return vus.map { (code: $0.key, nom: $0.value) }.sorted { $0.nom.localizedCompare($1.nom) == .orderedAscending }
    }

    var expediteursPresents: [String] {
        Set(tousLesColis.map(\.expediteur)).sorted { $0.localizedCompare($1) == .orderedAscending }
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

    /// « Tout vérifier » : les API officielles partent aussitot sur le
    /// serveur ; les pages officielles attendent l'app du Mac (qui s'y met
    /// d'elle-meme, et sur ce Mac tout de suite, fenetre visible).
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
        if etat.attendMac == true { app.verificateur.demarre(visible: true) }
        #endif
        await refresh()
        #if os(macOS)
        // UPS (sans API, lecture automatisee interdite) : le Mac enchaine les
        // pages officielles dans le navigateur, on note ce qu'on y voit
        demandeSerieAConstater()
        #endif
    }

    /// les colis de la campagne a constater sur la page officielle, dans
    /// l'ordre de la liste ; la vue des depots ouvre la serie
    private(set) var serieDemandee: SerieConstats?

    struct SerieConstats: Equatable {
        let ids: [Int]
        let jeton = UUID()
    }

    var numerosAConstater: [String] { campagne?.numerosAConstater ?? [] }

    /// la campagne a montrer : en cours, ou finie depuis moins de 6 h (et pas masquee)
    var campagneVisible: Bool {
        guard let etat = campagne, let c = etat.campagne else { return false }
        if etat.active { return true }
        guard campagneMasquee != c.id, let fin = ServerDate.parse(c.finLe ?? c.creeLe) else { return false }
        return Date.now.timeIntervalSince(fin) < 6 * 3600
    }

    func demandeSerieAConstater() {
        let numeros = Set(numerosAConstater)
        // un numero, une page : un meme numero sur deux colis ne s'ouvre qu'une fois
        var vus = Set<String>()
        let ids = (vue?.lignes ?? []).filter { numeros.contains($0.numero) && vus.insert($0.numero).inserted }.map(\.colisId)
        let serie = ids.isEmpty ? aConstater.map(\.colisId) : ids
        guard !serie.isEmpty else { return }
        serieDemandee = SerieConstats(ids: serie)
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
            app.toasts.show("Vérification terminée : \(Format.count(n.confirmes, "posté confirmé", "postés confirmés")), \(Format.count(n.nonConfirmes, "pas encore scanné", "pas encore scannés"))"
                + ((n.incorrects ?? 0) > 0 ? ", \(Format.count(n.incorrects ?? 0, "numéro incorrect", "numéros incorrects"))" : "")
                + (n.bloques > 0 ? ", \(Format.count(n.bloques, "bloqué", "bloqués"))" : ""))
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
            app.verificateur.demarre(visible: true)
            #endif
            await relisCampagne()
        } else {
            app.toasts.show("\(detail.numero) : \(detail.controle.libelle.lowercased())" + (detail.controle.cat == .confirme ? " (dans l'historique)" : ""))
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

    /// « Redrop » : le colis a ete oublie. Il revient dans « À poster » a 0 € ;
    /// son suivi et son historique restent, rien d'autre ne bouge. Rejoue, le
    /// serveur rend le meme (jamais deux).
    private(set) var enRedrop: Set<Int> = []

    func redrop(_ colisID: Int) async -> DepotDetail? {
        guard !enRedrop.contains(colisID) else { return nil }
        enRedrop.insert(colisID)
        defer { enRedrop.remove(colisID) }
        guard let r = await app.perform({ try await app.api.redropDepot(colisID) }) else { return nil }
        celebration += 1
        app.toasts.show(r.deja ? "\(r.detail.numero) : déjà de retour dans « À poster »" : "\(r.detail.numero) : de retour dans « À poster » (0 €)")
        await refresh()
        // « À poster » suit
        Task { await app.dashboard.refresh() }
        return r.detail
    }

    /// « Relancer les vérifications en attente » : un passage en fond ; la
    /// page suit son avancement.
    func relancer() async {
        guard !relance else { return }
        relance = true
        defer { relance = false }
        guard await app.perform({ try await app.api.relanceDepots() }) != nil else { return }
        app.toasts.show("Vérifications relancées, au rythme de chaque transporteur", style: .info)
        await refresh()
    }
}
