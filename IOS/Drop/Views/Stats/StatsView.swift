import SwiftUI
import DropKit

/// L'onglet Stats : les chiffres cles, puis les revenus par jour, par
/// semaine, et par expediteur. Arriver sur l'onglet rejoue la revelation.
struct StatsView: View {
    @Environment(AppModel.self) private var app
    @State private var plageJours = "—"
    @State private var plageSemaines = "—"

    private var model: StatsModel { app.stats }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if model.loaded {
                        metriques
                        carteGraphe("Revenus par jour", plage: plageJours) {
                            if model.days.isEmpty {
                                EmptyStateView(symbol: "chart.xyaxis.line", title: "Pas encore de données")
                            } else {
                                RevenueCurveChart(days: model.days, reveal: model.reveal, range: $plageJours)
                            }
                        }
                        carteGraphe("Revenus par semaine", plage: plageSemaines) {
                            if model.weeks.isEmpty {
                                EmptyStateView(symbol: "chart.bar", title: "Pas encore de données")
                            } else {
                                WeeklyBarsChart(weeks: model.weeks, reveal: model.reveal, range: $plageSemaines)
                            }
                        }
                        carteGraphe("Gains par expéditeur", plage: model.senderShares.isEmpty ? "" : "Touche une part") {
                            if model.senderShares.isEmpty {
                                EmptyStateView(symbol: "chart.pie", title: "Pas encore de gains")
                            } else {
                                DonutChart(slices: model.senderShares, reveal: model.reveal)
                            }
                        }
                    } else {
                        SkeletonRow(height: 130)
                        SkeletonRow(height: 280)
                        SkeletonRow(height: 280)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .tabArrival(.stats)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .navigationTitle("Stats")
            .refreshable { await model.refresh(animated: true) }
            .containerBackground(for: .navigation) { AmbientBackground() }
        }
    }

    // MARK: Chiffres cles

    private var metriques: some View {
        VStack(spacing: 12) {
            meilleureJournee
            HStack(spacing: 12) {
                carte("Moyenne par jour", valeur: model.dailyAverage, retard: 0.26) {
                    Text(model.days.isEmpty ? "Pas encore de données" : "sur \(Format.count(model.days.count, "jour", "jours"))")
                }
                carte("Cette semaine", valeur: model.thisWeek?.value ?? 0, retard: 0.34) {
                    semaine
                }
            }
        }
    }

    private var meilleureJournee: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Meilleure journée", systemImage: "crown.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.violetPale)
                .symbolEffect(.bounce, value: model.reveal)
            if let best = model.revenue?.bestDay {
                AnimatedNumber(value: best.value, format: Format.euro, start: CounterStart(from: 0, announces: false), delay: 0.18)
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.moneyGradient)
                    .id(model.reveal)
                Text("\(ServerDate.longDay(best.date)) · \(Format.count(best.count, "colis", "colis"))")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
            } else {
                Text("—").font(.system(size: 40, weight: .bold, design: .rounded))
                Text("Pas encore de données").font(.subheadline).foregroundStyle(Theme.text3)
            }
        }
        .padding(Theme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RadialGradient(colors: [Theme.violet.opacity(0.5), .clear], center: .topTrailing, startRadius: 0, endRadius: 260)
                .clipShape(.rect(cornerRadius: Theme.Radius.card))
        }
        .glassEffect(.regular.tint(Theme.violetDark.opacity(0.4)), in: .rect(cornerRadius: Theme.Radius.card))
        .overlay(alignment: .topTrailing) {
            Image(systemName: "trophy.fill")
                .font(.system(size: 54))
                .foregroundStyle(LinearGradient(colors: [Theme.violetPale.opacity(0.35), Theme.violet.opacity(0.05)], startPoint: .top, endPoint: .bottom))
                .rotationEffect(.degrees(12))
                .padding(18)
                .allowsHitTesting(false)
        }
    }

    private func carte<Sous: View>(_ titre: String, valeur: Double, retard: Double, @ViewBuilder sous: () -> Sous) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(titre)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.text2)
            AnimatedNumber(value: valeur, format: Format.euroCompact, start: CounterStart(from: 0, announces: false), delay: retard)
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.numberGradient)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .id(model.reveal)
            sous()
                .font(.caption)
                .foregroundStyle(Theme.text3)
                .lineLimit(2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
        .glassEffect(.regular.tint(.black.opacity(0.25)), in: .rect(cornerRadius: 24))
    }

    @ViewBuilder
    private var semaine: some View {
        if let en = model.thisWeek {
            if let avant = model.lastWeek {
                let gain = model.weekGain.map { Text(" · +\($0) %").foregroundStyle(Theme.violetLight).bold() } ?? Text("")
                Text("\(Format.count(en.count, "colis", "colis")) · passée \(Format.euroGraphe(avant.value))\(gain)")
            } else {
                Text(Format.count(en.count, "colis", "colis"))
            }
        } else {
            Text("—")
        }
    }

    private func carteGraphe<Contenu: View>(_ titre: String, plage: String, @ViewBuilder contenu: () -> Contenu) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(titre) {
                Text(plage)
                    .contentTransition(.numericText())
                    .animation(.snappy, value: plage)
            }
            contenu()
        }
        .surfaceCard()
    }
}
