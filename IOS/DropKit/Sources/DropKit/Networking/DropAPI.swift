import Foundation

/// Tous les points d'acces du serveur, types. Les vues et les modeles d'ecran
/// appellent ces fonctions ; aucun chemin d'URL n'existe ailleurs.
public struct DropAPI: Sendable {
    public let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public init(baseURL: URL) {
        self.init(client: APIClient(baseURL: baseURL))
    }

    // MARK: - Dashboard

    public func stats() async throws -> Stats {
        try await client.send(.get, "/api/stats")
    }

    public func stock() async throws -> Stock {
        try await client.send(.get, "/api/stock")
    }

    public func adjustStock(_ delta: Int, kind: StockKind) async throws -> Stock {
        struct Corps: Encodable, Sendable { let delta: Int; let kind: String }
        return try await client.send(.post, "/api/stock/adjust", body: Corps(delta: delta, kind: kind.rawValue), operation: true)
    }

    /// Le "+N" des notifications compte depuis la derniere fois qu'on a regarde.
    public func markSeen() async throws {
        _ = try await client.raw(.post, "/api/push/seen")
    }

    /// Les colis arrives depuis `since` ("2026-10-03 10:20:00", heure du serveur).
    public func newParcels(since: String) async throws -> NewParcels {
        try await client.send(.get, "/api/colis/nouveaux", query: [URLQueryItem(name: "depuis", value: since)])
    }

    // MARK: - Tournee

    /// Ce qu'on peut emporter (pour choisir les transporteurs avant de partir).
    public func tourChoix() async throws -> TourChoix {
        try await client.send(.get, "/api/tour/choix")
    }

    /// Depart en tournee avec les transporteurs choisis (`selection` : leurs
    /// cles, nil : tout).
    public func startTour(selection: [String]? = nil) async throws -> TourDepart {
        struct Corps: Encodable, Sendable { let selection: [String]? }
        return try await client.send(.post, "/api/tour/start", body: Corps(selection: selection))
    }

    /// L'heure de depart de la tournee que l'ecran affiche : le serveur refuse
    /// (409) de terminer ou d'annuler une tournee deja finie, ou une autre
    /// commencee depuis, au lieu de dropper des colis qui n'etaient pas du sac.
    private struct TourAffichee: Encodable, Sendable { let startedAt: String? }

    /// retour de tournee : ce qu'on avait emporte (et imprime) est drope
    public func finishTour(startedAt: String? = nil) async throws -> DropResult {
        try await client.send(.post, "/api/tour/finish", body: TourAffichee(startedAt: startedAt))
    }

    /// annulation : on referme sans rien dropper
    public func cancelTour(startedAt: String? = nil) async throws {
        _ = try await client.raw(.post, "/api/tour/end", body: TourAffichee(startedAt: startedAt))
    }

    public func dismissTourSummary() async throws {
        _ = try await client.raw(.post, "/api/tour/dismiss-summary")
    }

    // MARK: - Drops

    public func dropAll() async throws -> DropResult {
        try await client.send(.post, "/api/colis/drop-all")
    }

    /// les LIT partent sur une autre imprimante, souvent un autre jour
    public func dropAllExceptLit() async throws -> DropResult {
        try await client.send(.post, "/api/colis/drop-all-except-lit")
    }

    public func dropSender(_ name: String) async throws -> DropResult {
        try await client.send(.post, "/api/colis/drop-sender/\(segment(name))")
    }

    public func dropCarrier(_ code: String) async throws -> DropResult {
        try await client.send(.post, "/api/colis/drop-carrier/\(segment(code))")
    }

    /// annule un drop : le colis repasse en attente
    public func undrop(_ id: Int) async throws {
        _ = try await client.raw(.post, "/api/colis/\(id)/undrop")
    }

    // MARK: - Historique

    public func journal(avant: Int? = nil, filtre: FiltreJournal = .tout, limite: Int = 30) async throws -> PageJournal {
        var query = [URLQueryItem(name: "limite", value: String(limite))]
        if let avant { query.append(URLQueryItem(name: "avant", value: String(avant))) }
        if filtre != .tout { query.append(URLQueryItem(name: "filtre", value: filtre.rawValue)) }
        return try await client.send(.get, "/api/journal", query: query)
    }

    /// +n colis a la main (plusieurs appuis en une operation)
    public func quickAdd(sender: String, n: Int = 1) async throws {
        struct Corps: Encodable, Sendable { let n: Int }
        _ = try await client.raw(.post, "/api/colis/quick-add/\(segment(sender))", body: Corps(n: n), operation: true)
    }

    /// -n colis a la main ; renvoie combien ont ete retires
    @discardableResult
    public func quickRemove(sender: String, n: Int = 1) async throws -> Int {
        struct Corps: Encodable, Sendable { let n: Int }
        struct Reponse: Decodable, Sendable { let removed: Int? }
        let r: Reponse = try await client.send(.post, "/api/colis/quick-remove/\(segment(sender))", body: Corps(n: n), operation: true)
        return r.removed ?? n
    }

    // MARK: - Impression

    public func setAutoPrint(_ enabled: Bool) async throws {
        struct Corps: Encodable, Sendable { let enabled: Bool }
        _ = try await client.raw(.post, "/api/print/auto", body: Corps(enabled: enabled))
    }

    public func printSummary(scope: PrintScope) async throws -> PrintSummary {
        try await client.send(.get, "/api/print/resume", query: [URLQueryItem(name: "scope", value: scope.rawValue)])
    }

    public func parcels(category: String, scope: PrintScope) async throws -> [Parcel] {
        let page: PrintParcels = try await client.send(
            .get, "/api/print/colis",
            query: [URLQueryItem(name: "categorie", value: category), URLQueryItem(name: "scope", value: scope.rawValue)]
        )
        return page.colis
    }

    /// Construit le PDF des etiquettes : elles sont marquees imprimees au passage.
    public func buildLabels(_ request: PrintRequest) async throws -> PrintJob {
        try await client.send(.post, "/api/print/build", body: request, timeout: 120)
    }

    /// Le PDF construit, a imprimer (AirPrint) ou partager. `marquer=0` : le
    /// telechargement ne marque rien, l'app confirme apres l'impression.
    public func labelsPDF(_ job: PrintJob) async throws -> Data {
        try await client.raw(.get, job.url, query: [URLQueryItem(name: "marquer", value: "0")], timeout: 60)
    }

    /// La fenetre d'impression a confirme : les etiquettes du PDF sont
    /// marquees imprimees (une seule fois par PDF).
    public func confirmPrinted(_ job: PrintJob, par: String) async throws {
        struct Corps: Encodable, Sendable { let ids: [Int]; let par: String }
        _ = try await client.raw(.post, "/api/print/job/\(job.jobId)/imprime", body: Corps(ids: job.ids ?? [], par: par))
    }

    public func editParcel(_ id: Int, _ patch: ParcelPatch) async throws -> ParcelPatchResult {
        try await client.send(.patch, "/api/print/colis/\(id)", body: patch)
    }

    public func dropParcel(_ id: Int) async throws {
        _ = try await client.raw(.post, "/api/print/colis/\(id)/drop")
    }

    /// retire le colis et efface son fichier sur Telegram
    public func deleteParcel(_ id: Int) async throws {
        _ = try await client.raw(.delete, "/api/print/colis/\(id)")
    }

    // MARK: - Controle des depots

    /// La page : compteurs, etat de la file, lignes. Ne fait que lire la base
    /// du serveur (aucun transporteur n'est interroge).
    public func depots() async throws -> DepotsVue {
        try await client.send(.get, "/api/depots", timeout: 30)
    }

    /// les compteurs seuls, pour la pastille du dashboard
    public func depotsResume() async throws -> DepotsResume {
        try await client.send(.get, "/api/depots/resume")
    }

    public func depot(_ colisID: Int) async throws -> DepotDetail {
        try await client.send(.get, "/api/depots/\(colisID)")
    }

    /// « Vérifier » : une lecture tout de suite (refusee poliment si le
    /// transporteur a demande une pause, ou s'il se verifie a la main)
    public func verifieDepot(_ colisID: Int) async throws -> DepotDetail {
        try await client.send(.post, "/api/depots/\(colisID)/verifier", timeout: 45)
    }

    /// ce qu'on a vu sur la page officielle (UPS, DHL...)
    public func constateDepot(_ colisID: Int, _ choix: DepotConstatChoix) async throws -> DepotDetail {
        struct Corps: Encodable, Sendable { let resultat: String }
        return try await client.send(.post, "/api/depots/\(colisID)/constat", body: Corps(resultat: choix.rawValue))
    }

    /// « Relancer les vérifications en attente » : un passage en fond, au
    /// rythme de La Poste ; la reponse part tout de suite.
    public func relanceDepots() async throws {
        _ = try await client.raw(.post, "/api/depots/relancer")
    }

    // MARK: - Statistiques

    public func revenue() async throws -> RevenueSummary {
        try await client.send(.get, "/api/stats/revenue")
    }

    public func dailySeries() async throws -> [DayRevenue] {
        let serie: DailySeries = try await client.send(.get, "/api/stats/revenue/daily-series")
        return serie.days
    }

    public func weeklySeries() async throws -> [WeekRevenue] {
        let serie: WeeklySeries = try await client.send(.get, "/api/stats/revenue/weekly-series")
        return serie.weeks
    }

    // MARK: - Espaces expediteurs

    /// Cree le lien prive d'un expediteur, ou le regenere (l'ancien cesse de
    /// marcher).
    public func creePortail(senderID: Int) async throws -> Sender {
        try await client.send(.post, "/api/senders/\(senderID)/portail")
    }

    public func retirePortail(senderID: Int) async throws -> Sender {
        try await client.send(.delete, "/api/senders/\(senderID)/portail")
    }

    // MARK: - Expediteurs et dettes

    public func senders() async throws -> [Sender] {
        try await client.send(.get, "/api/senders")
    }

    public func addSender(name: String, price: Double, litPrice: Double, bjPrice: Double) async throws -> Sender {
        struct Corps: Encodable, Sendable { let name: String; let price: Double; let litPrice: Double; let bjPrice: Double }
        return try await client.send(.post, "/api/senders", body: Corps(name: name, price: price, litPrice: litPrice, bjPrice: bjPrice))
    }

    public func updatePrice(senderID: Int, field: PriceField, value: Double) async throws -> Sender {
        try await client.send(.put, "/api/senders/\(senderID)", body: [field.rawValue: value])
    }

    public func deleteSender(_ id: Int) async throws {
        _ = try await client.raw(.delete, "/api/senders/\(id)")
    }

    public func debts() async throws -> [Debt] {
        try await client.send(.get, "/api/debts")
    }

    public func markPaid(sender: String) async throws -> PayResult {
        try await client.send(.post, "/api/debts/\(segment(sender))/pay")
    }

    public func mergeCandidates() async throws -> [MergeCandidate] {
        try await client.send(.get, "/api/senders/merge-candidates")
    }

    public func mergeIntoOther(_ ids: [Int]) async throws {
        struct Corps: Encodable, Sendable { let senderIds: [Int] }
        _ = try await client.raw(.post, "/api/senders/merge-to-other", body: Corps(senderIds: ids))
    }

    /// la meme personne qui a recree un compte : tout passe sur `target`
    public func merge(source: Int, into target: Int) async throws -> MergeResult {
        struct Corps: Encodable, Sendable { let sourceId: Int; let targetId: Int }
        return try await client.send(.post, "/api/senders/merge", body: Corps(sourceId: source, targetId: target))
    }

    // MARK: - Mode locker

    public func lockerPairs() async throws -> [LockerPair] {
        let reponse: LockerPairs = try await client.send(.get, "/api/special/paires")
        return reponse.paires
    }

    public func lockerCodeImage(pairID: Int) async throws -> Data {
        try await client.raw(.get, "/api/special/code/\(pairID)", timeout: 30)
    }

    /// "Fait" sur un code seul : la paire s'en va une fois le locker ouvert
    public func completeAlonePair(_ id: Int) async throws {
        _ = try await client.raw(.post, "/api/special/paires/\(id)/fini")
    }

    // MARK: - Suivi des colis

    public func trackingOverview() async throws -> TrackingOverview {
        try await client.send(.get, "/api/suivi/overview")
    }

    public func trackingRows(label: String?, offset: Int = 0, limit: Int = 200) async throws -> TrackingRows {
        try await client.send(.get, "/api/suivi/label", query: [
            URLQueryItem(name: "label", value: label ?? ""),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ])
    }

    public func liveCheck(since: Int) async throws -> LiveCheck {
        try await client.send(.get, "/api/suivi/live", query: [URLQueryItem(name: "since", value: String(since))], timeout: 8)
    }

    public func verify(text: String, name: String) async throws -> VerifyResult {
        struct Corps: Encodable, Sendable { let text: String; let name: String }
        return try await client.send(.post, "/api/suivi/verifier", body: Corps(text: text, name: name), timeout: 60)
    }

    public func recheck(_ milestone: Milestone) async throws {
        struct Corps: Encodable, Sendable { let milestones: [String] }
        _ = try await client.raw(.post, "/api/suivi/recheck", body: Corps(milestones: [milestone.rawValue]), timeout: 60)
    }

    public func cancelCheck() async throws {
        _ = try await client.raw(.post, "/api/suivi/annuler")
    }
}
