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
        return try await client.send(.post, "/api/stock/adjust", body: Corps(delta: delta, kind: kind.rawValue))
    }

    /// Le "+N" des notifications compte depuis la derniere fois qu'on a regarde.
    public func markSeen() async throws {
        _ = try await client.raw(.post, "/api/push/seen")
    }

    // MARK: - Tournee

    public func startTour() async throws {
        _ = try await client.raw(.post, "/api/tour/start")
    }

    /// retour de tournee : ce qu'on avait emporte est drope
    public func finishTour() async throws {
        _ = try await client.raw(.post, "/api/tour/finish")
    }

    /// annulation : on referme sans rien dropper
    public func cancelTour() async throws {
        _ = try await client.raw(.post, "/api/tour/end")
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

    public func quickAdd(sender: String) async throws {
        _ = try await client.raw(.post, "/api/colis/quick-add/\(segment(sender))")
    }

    public func quickRemove(sender: String) async throws {
        _ = try await client.raw(.post, "/api/colis/quick-remove/\(segment(sender))")
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

    /// Le PDF construit, a imprimer (AirPrint) ou partager.
    public func labelsPDF(_ job: PrintJob) async throws -> Data {
        try await client.raw(.get, job.url, timeout: 60)
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
