import SwiftUI
import DropKit

/// Les pages qu'on ouvre depuis le dashboard (balayage depuis le bord pour
/// revenir).
enum Route: Hashable {
    case settings
    case prices
    case mergeOther
    case tracking
    case trackingLabel(TrackingLabel)
    case locker
}

struct DashboardView: View {
    let booted: Bool
    @Environment(AppModel.self) private var app
    @State private var path: [Route] = []

    private var model: DashboardModel { app.dashboard }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 14) {
                    DashboardHeader()
                        .entrance(booted, index: 0)

                    if booted, let stats = model.stats {
                        HeroCard(stats: stats)
                            .entrance(booted, index: 1)
                        if !stats.tour.isActive, let last = stats.tour.last {
                            TourSummaryCard(summary: last)
                                .transition(.asymmetric(
                                    insertion: .scale(scale: 0.9, anchor: .top).combined(with: .opacity).combined(with: AnyTransition(.blurReplace)),
                                    removal: .scale(scale: 0.92).combined(with: .opacity)
                                ))
                        }
                        MetricsRow(stats: stats)
                            .entrance(booted, index: 2)
                        StockCard()
                            .entrance(booted, index: 3)
                        CarriersCard(carriers: stats.byCarrier)
                            .entrance(booted, index: 4)
                        SendersCard(senders: stats.bySender)
                            .entrance(booted, index: 5)
                    } else {
                        DashboardSkeleton()
                    }

                    ToolsCard()
                        .entrance(booted, index: 6)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                .animation(Theme.spring, value: model.stats?.tour)
            }
            .tabArrival(.dashboard)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .refreshable { await model.refresh() }
            .toolbarVisibility(.hidden, for: .navigationBar)
            .containerBackground(for: .navigation) { AmbientBackground() }
            .navigationDestination(for: Route.self) { route in
                destination(route)
            }
        }
        #if DEBUG
        // verification au simulateur : `-DropPage locker` ouvre une page
        .onAppear {
            let pages: [String: Route] = ["settings": .settings, "prices": .prices, "merge": .mergeOther, "tracking": .tracking, "locker": .locker]
            if path.isEmpty, let nom = UserDefaults.standard.string(forKey: "DropPage"), let route = pages[nom] { path = [route] }
        }
        #endif
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        Group {
            switch route {
            case .settings: SettingsView()
            case .prices: PricesView()
            case .mergeOther: MergeOtherView()
            case .tracking: TrackingView()
            case .trackingLabel(let label): TrackingDetailView(label: label)
            case .locker: LockerView()
            }
        }
        .containerBackground(for: .navigation) { AmbientBackground() }
    }
}

/// En haut : la date, la marque, l'etat de la connexion, les reglages.
private struct DashboardHeader: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Locale(identifier: "fr_FR"))).uppercased())
                    .font(.caption.weight(.semibold))
                    .tracking(0.8)
                    .foregroundStyle(Theme.text3)
                Text("Drop")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.numberGradient)
                    .shadow(color: Theme.violet.opacity(0.45), radius: 16)
            }
            Spacer()
            HStack(spacing: 10) {
                LivePill(online: app.isOnline)
                NavigationLink(value: Route.settings) {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Réglages")
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 4)
    }
}

private struct DashboardSkeleton: View {
    var body: some View {
        VStack(spacing: 14) {
            SkeletonRow(height: 300)
            HStack(spacing: 12) {
                SkeletonRow(height: 110)
                SkeletonRow(height: 110)
            }
            SkeletonRow(height: 160)
        }
    }
}
