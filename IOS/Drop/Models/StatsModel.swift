import SwiftUI
import DropKit

/// Les statistiques de revenus : par jour, par semaine, par expediteur.
@Observable
final class StatsModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var revenue: RevenueSummary?
    private(set) var days: [DayRevenue] = []
    private(set) var weeks: [WeekRevenue] = []
    private(set) var loaded = false
    /// chaque arrivee sur l'onglet rejoue la revelation des graphiques
    private(set) var reveal = 0

    init(app: AppModel) {
        self.app = app
    }

    /// moyenne sur tous les jours enregistres, jours sans revenu compris :
    /// le revenu d'une journee type
    var dailyAverage: Double {
        days.isEmpty ? 0 : days.reduce(0) { $0 + $1.value } / Double(days.count)
    }

    var thisWeek: WeekRevenue? { weeks.last }
    var lastWeek: WeekRevenue? { weeks.dropLast().last }

    /// La semaine en cours n'est pas finie : la comparer en pourcentage a une
    /// semaine complete serait trompeur. On ne le dit que quand elle l'a depassee.
    var weekGain: Int? {
        guard let a = thisWeek, let b = lastWeek, b.value > 0 else { return nil }
        let ecart = Int((((a.value - b.value) / b.value) * 100).rounded())
        return ecart > 0 ? ecart : nil
    }

    /// les gains par expediteur, du plus gros au plus petit
    var senderShares: [DonutSlice] {
        let lignes = (app.dashboard.stats?.bySender ?? [])
            .filter { $0.droppedValue > 0 }
            .sorted { $0.droppedValue > $1.droppedValue }
        return DonutSlice.grouped(lignes.map { ($0.senderName, $0.droppedValue) }, max: 7)
    }

    func refresh(animated: Bool) async {
        do {
            async let r = app.api.revenue()
            async let d = app.api.dailySeries()
            async let w = app.api.weeklySeries()
            let (rev, jours, semaines) = try await (r, d, w)
            app.reachedServer()
            if rev != revenue { revenue = rev }
            if jours != days { days = jours }
            if semaines != weeks { weeks = semaines }
            if !loaded { withAnimation(Theme.spring) { loaded = true } }
            if animated { reveal += 1 }
        } catch {
            app.report(error)
        }
        // l'anneau par expediteur vit dans les chiffres du dashboard
        await app.dashboard.refresh()
    }

    func replay() {
        reveal += 1
    }
}

/// Une part d'anneau. Au-dela de `max` parts, les plus petites se regroupent
/// en "Autres" : un anneau de vingt parts ne se lit plus.
struct DonutSlice: Identifiable, Equatable {
    let id: String
    let label: String
    let value: Double
    let color: Color

    static func grouped(_ valeurs: [(String, Double)], max: Int) -> [DonutSlice] {
        let tete = valeurs.prefix(max)
        let reste = valeurs.dropFirst(max).reduce(0) { $0 + $1.1 }
        var parts = tete.enumerated().map { i, v in
            DonutSlice(id: v.0, label: v.0, value: v.1, color: Theme.categorical[i % Theme.categorical.count])
        }
        if reste > 0 {
            parts.append(DonutSlice(id: "__autres", label: "Autres", value: reste, color: Color(white: 0.42)))
        }
        return parts
    }
}
