import SwiftUI
import DropKit

/// Le suivi des colis : ce que le bot de suivi a verifie, et l'ecran de
/// passage quand une verification tourne.
@Observable
final class TrackingModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var overview: TrackingOverview?
    private(set) var loaded = false
    /// la verification en cours (ou la derniere, le temps qu'elle se referme)
    private(set) var live: LiveJob?
    private(set) var liveRunning = false
    private(set) var queued = 0
    /// le compteur montre : il monte numero par numero, sans sauter
    private(set) var shownChecked = 0
    /// les trouvailles qui defilent (les introuvables ne defilent pas)
    private(set) var finds: [LiveFind] = []
    private(set) var finished = 0
    private(set) var sending = false

    @ObservationIgnored private var since = 0
    @ObservationIgnored private var cibleCompteur = 0
    @ObservationIgnored private var surveille: Task<Void, Never>?
    @ObservationIgnored private var compteur: Task<Void, Never>?

    init(app: AppModel) {
        self.app = app
    }

    var totalChecked: Int {
        overview?.totalChecked ?? overview?.summary?.reduce(0) { $0 + $1.count } ?? 0
    }

    var labels: [TrackingLabel] { overview?.labels ?? [] }

    var labelShares: [DonutSlice] {
        DonutSlice.grouped(labels.map { ($0.displayLabel, Double($0.count)) }, max: 7)
    }

    func refresh() async {
        do {
            let o = try await app.api.trackingOverview()
            app.reachedServer()
            if o != overview || !loaded {
                withAnimation(Theme.spring) {
                    overview = o
                    loaded = true
                }
            }
        } catch {
            app.report(error)
        }
    }

    // MARK: Verification en direct

    /// Tant que l'ecran est ouvert : une verification peut partir d'ailleurs
    /// (un .txt envoye au bot Telegram), l'ecran s'allume alors tout seul.
    func watch() async {
        while !Task.isCancelled {
            if surveille == nil, let etat = try? await app.api.liveCheck(since: 0), etat.running {
                startLive()
            }
            try? await Task.sleep(for: .seconds(3))
        }
        stopLive()
    }

    private func startLive() {
        since = 0
        shownChecked = 0
        cibleCompteur = 0
        finds = []
        withAnimation(Theme.spring) { liveRunning = true }
        surveille?.cancel()
        surveille = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let continuer = await self.poll()
                if !continuer { break }
                try? await Task.sleep(for: .milliseconds(700))
            }
        }
        lanceCompteur()
    }

    private func stopLive() {
        surveille?.cancel()
        surveille = nil
        compteur?.cancel()
        compteur = nil
    }

    /// Une lecture de l'etat. Rend faux quand c'est fini.
    private func poll() async -> Bool {
        guard let etat = try? await app.api.liveCheck(since: since) else { return true }
        guard let job = etat.job else {
            withAnimation(Theme.spring) { liveRunning = false; live = nil }
            surveille = nil
            return false
        }
        since = etat.seq
        queued = etat.queued
        cibleCompteur = job.checked
        withAnimation(.smooth(duration: 0.6)) { live = job }
        let nouvelles = etat.finds.filter { $0.found && $0.milestone != .notFound }
        if !nouvelles.isEmpty {
            withAnimation(Theme.bouncy) {
                finds = Array((nouvelles.reversed() + finds).prefix(4))
            }
        }
        if !etat.running {
            // on laisse le compteur finir sa course avant de refermer
            try? await Task.sleep(for: .seconds(2.5))
            if job.fatalError == nil, job.cancelled != true {
                finished += 1
                Haptics.success()
            }
            withAnimation(Theme.spring) { liveRunning = false }
            surveille = nil
            compteur?.cancel()
            await refresh()
            return false
        }
        return true
    }

    /// Le compteur monte REGULIEREMENT : chaque paquet est etale sur
    /// l'intervalle qui vient, ce qui donne un defilement continu.
    private func lanceCompteur() {
        compteur?.cancel()
        compteur = Task { [weak self] in
            var reste = 0.0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(33))
                guard let self else { return }
                let ecart = self.cibleCompteur - self.shownChecked
                guard ecart > 0 else { continue }
                reste += max(Double(ecart) / 700, 0.004) * 33
                let pas = Int(reste)
                if pas >= 1 {
                    reste -= Double(pas)
                    self.shownChecked = min(self.shownChecked + pas, self.cibleCompteur)
                }
            }
        }
    }

    /// Un fichier de numeros (un par ligne, ou en vrac) part a la verification.
    func verify(text: String, name: String) async {
        sending = true
        defer { sending = false }
        guard let r = await app.perform({ try await app.api.verify(text: text, name: name) }) else { return }
        let n = r.queued ?? r.total ?? 0
        var detail = "\(Format.count(n, "numéro", "numéros")) en vérification"
        if let d = r.duplicates, d > 0 { detail += " · \(Format.count(d, "doublon ignoré", "doublons ignorés"))" }
        app.toasts.show(detail)
        startLive()
    }

    func recheck(_ milestone: Milestone) async {
        guard await app.perform({ try await app.api.recheck(milestone) }) != nil else { return }
        app.toasts.show("Revérification lancée")
        startLive()
    }

    func cancel() async {
        guard await app.perform({ try await app.api.cancelCheck() }) != nil else { return }
        app.toasts.show("Vérification arrêtée", style: .info)
    }

    // MARK: Detail d'un libelle

    func rows(for label: TrackingLabel, offset: Int) async -> TrackingRows? {
        await app.perform { try await app.api.trackingRows(label: label.label, offset: offset) }
    }
}
