import SwiftUI
import DropKit

/// La file d'impression : ce qui n'est jamais sorti, et ce qui est sorti mais
/// pas encore poste. Les etiquettes partent en PDF vers AirPrint.
@Observable
final class PrintModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var pending: PrintSummary?
    private(set) var printed: PrintSummary?
    private(set) var loadError: String?
    /// les categories depliees ("new:MR") : elles le restent au rafraichissement
    var expanded: Set<String> = []
    private(set) var parcels: [String: [Parcel]] = [:]
    private(set) var loadingCategories: Set<String> = []
    /// les impressions en cours de construction
    private(set) var building: Set<String> = []
    /// le dernier PDF construit : on peut le relancer sans le reconstruire
    private(set) var lastPDF: LastPDF?
    /// ce que le bot a appris d'une correction de transporteur
    private(set) var notice: String?
    private(set) var celebration = 0

    struct LastPDF: Equatable {
        let job: PrintJob
        let file: URL

        var detail: String {
            job.roll
                ? "\(Format.count(job.count, "étiquette", "étiquettes")) · \(Format.integer(job.lengthMm ?? 0)) mm de rouleau"
                : "\(Format.count(job.count, "étiquette", "étiquettes")) · \(Format.count(job.pages ?? 1, "page", "pages"))"
        }
    }

    init(app: AppModel) {
        self.app = app
    }

    static func key(_ code: String, _ scope: PrintScope) -> String { "\(scope.rawValue):\(code)" }

    /// "Tout imprimer" ne couvre que la thermique 4x6 : les LIT sortent sur
    /// le rouleau 210 mm, dans un PDF a part.
    var thermalCount: Int {
        pending?.categories.filter { !$0.roll }.reduce(0) { $0 + $1.count } ?? 0
    }

    var carriers: [CarrierOption] { pending?.transporteurs ?? [] }

    // MARK: Chargement

    func refresh() async {
        do {
            async let a = app.api.printSummary(scope: .new)
            async let b = app.api.printSummary(scope: .printed)
            let (nouveau, deja) = try await (a, b)
            app.reachedServer()
            withAnimation(Theme.spring) {
                pending = nouveau
                printed = deja
                loadError = nil
            }
            for cle in expanded { await loadParcels(cle) }
        } catch {
            if pending == nil { loadError = (error as? LocalizedError)?.errorDescription ?? "Erreur de chargement" }
            app.report(error)
        }
    }

    func toggle(_ code: String, _ scope: PrintScope) {
        let cle = Self.key(code, scope)
        withAnimation(Theme.spring) {
            if expanded.contains(cle) { expanded.remove(cle) } else { expanded.insert(cle) }
        }
        if expanded.contains(cle) { Task { await loadParcels(cle) } }
    }

    func loadParcels(_ cle: String) async {
        let morceaux = cle.split(separator: ":", maxSplits: 1).map(String.init)
        guard morceaux.count == 2, let scope = PrintScope(rawValue: morceaux[0]) else { return }
        if parcels[cle] == nil { loadingCategories.insert(cle) }
        defer { loadingCategories.remove(cle) }
        do {
            let liste = try await app.api.parcels(category: morceaux[1], scope: scope)
            if liste != parcels[cle] {
                withAnimation(Theme.spring) { parcels[cle] = liste }
            }
        } catch {
            app.report(error)
        }
    }

    // MARK: Impression

    /// Construit le PDF puis ouvre la feuille d'impression d'iOS.
    func print(_ request: PrintRequest, key: String) async {
        guard !building.contains(key) else { return }
        building.insert(key)
        defer { building.remove(key) }
        do {
            let job = try await app.api.buildLabels(request)
            let data = try await app.api.labelsPDF(job)
            let fichier = FileManager.default.temporaryDirectory.appending(path: "etiquettes-\(job.jobId).pdf")
            try data.write(to: fichier, options: .atomic)
            app.reachedServer()
            withAnimation(Theme.bouncy) { lastPDF = LastPDF(job: job, file: fichier) }
            celebration += 1
            app.toasts.show("PDF prêt · \(lastPDF?.detail ?? "")")
            Printer.present(fichier, name: "Étiquettes Drop")
            await refresh()
            await app.dashboard.refresh()
        } catch {
            app.toasts.show("Impression impossible : \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)", style: .error)
        }
    }

    func reprint() {
        guard let lastPDF else { return }
        Printer.present(lastPDF.file, name: "Étiquettes Drop")
    }

    // MARK: Colis

    func save(_ parcel: Parcel, patch: ParcelPatch) async -> Bool {
        guard !patch.isEmpty else { return true }
        guard let r = await app.perform({ try await app.api.editParcel(parcel.id, patch) }) else { return false }
        app.toasts.show("Colis modifié")
        if let appris = r.appris { showNotice(appris) }
        await refresh()
        return true
    }

    func drop(_ parcel: Parcel, scope: PrintScope) async {
        guard await app.perform({ try await app.api.dropParcel(parcel.id) }) != nil else { return }
        retire(parcel)
        celebration += 1
        app.toasts.show("Colis dropé · \(Format.euro(parcel.price))")
        await refresh()
        await app.dashboard.refresh()
    }

    func delete(_ parcel: Parcel) async {
        guard await app.perform({ try await app.api.deleteParcel(parcel.id) }) != nil else { return }
        retire(parcel)
        app.toasts.show("Colis retiré")
        await refresh()
    }

    /// la ligne part tout de suite, sans attendre le rafraichissement
    private func retire(_ parcel: Parcel) {
        withAnimation(Theme.spring) {
            for (cle, liste) in parcels {
                parcels[cle] = liste.filter { $0.id != parcel.id }
            }
        }
    }

    private func showNotice(_ texte: String) {
        withAnimation(Theme.bouncy) { notice = texte }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(7))
            if notice == texte { withAnimation(Theme.spring) { notice = nil } }
        }
    }

    func dismissNotice() {
        withAnimation(Theme.spring) { notice = nil }
    }
}
