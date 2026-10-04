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
    /// largeur disponible : au-dela d'un seuil (Mac, grande fenetre), les
    /// cartes se rangent sur deux colonnes
    @State private var largeur: CGFloat = 0

    private var model: DashboardModel { app.dashboard }
    private var large: Bool { largeur >= 860 }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 14) {
                    DashboardHeader()
                        .entrance(booted, index: 0)

                    if booted, let stats = model.stats {
                        if large {
                            // grande fenetre : le sac et les chiffres a gauche, ce
                            // qu'il faut poster et les expediteurs a droite
                            HStack(alignment: .top, spacing: 16) {
                                VStack(spacing: 14) { colonnePrincipale(stats) }
                                    .frame(maxWidth: .infinity)
                                VStack(spacing: 14) { colonneSecondaire(stats) }
                                    .frame(maxWidth: .infinity)
                            }
                        } else {
                            colonnePrincipale(stats)
                            colonneSecondaire(stats)
                        }
                    } else {
                        DashboardSkeleton()
                    }

                    // sur Mac, ces raccourcis sont dans la barre laterale
                    if !Platform.isMac {
                        ToolsCard()
                            .entrance(booted, index: 6)
                    }
                }
                .padding(.horizontal, large ? 24 : 16)
                .padding(.bottom, 24)
                .frame(maxWidth: 1400)
                .frame(maxWidth: .infinity)
                .tabArrival(.dashboard)
                .animation(Theme.spring, value: model.stats?.tour)
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { largeur = $0 }
            .refreshable { await model.refresh() }
            .barreDeNavigationMasquee()
            .fondVivant()
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
    private func colonnePrincipale(_ stats: Stats) -> some View {
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
    }

    @ViewBuilder
    private func colonneSecondaire(_ stats: Stats) -> some View {
        CarriersCard(carriers: stats.byCarrier)
            .entrance(booted, index: 4)
        SendersCard(senders: stats.bySender)
            .entrance(booted, index: 5)
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
        .fondVivant()
    }
}

/// En haut : la date, la marque, l'etat de la connexion, les reglages.
private struct DashboardHeader: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        PageHeader("Drop") {
            GlassEffectContainer(spacing: 0) {
            HStack(spacing: 10) {
                LivePill(online: app.isOnline)
                Group {
                #if os(macOS)
                SettingsLink {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 44, height: 44)
                }
                #else
                NavigationLink(value: Route.settings) {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 44, height: 44)
                }
                #endif
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Réglages")
            }
            }
        }
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
