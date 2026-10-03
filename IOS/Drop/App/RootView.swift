import SwiftUI
import DropKit

/// La charpente : le fond vivant, les trois onglets dans la barre d'onglets
/// native d'iOS -- du vrai Liquid Glass : le verre refracte le fond, et on peut
/// appuyer sur l'onglet actif puis le faire glisser vers un autre, la lentille
/// de verre suit le doigt en se deformant -- et les messages en haut.
///
/// Chaque onglet garde sa pile de navigation (et son defilement). Pas de
/// balayage entre onglets : le doigt reste aux listes. L'ecran qui arrive se
/// precise (flou -> net) au lieu d'apparaitre d'un coup.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var booted = false
    @State private var arrivee = TabArrivalState()

    var body: some View {
        @Bindable var app = app
        ZStack {
            AmbientBackground()

            TabView(selection: $app.tab) {
                Tab(AppTab.dashboard.title, systemImage: AppTab.dashboard.symbol, value: AppTab.dashboard) {
                    DashboardView(booted: booted)
                }
                Tab(AppTab.printing.title, systemImage: AppTab.printing.symbol, value: AppTab.printing) {
                    PrintView()
                }
                .badge(badgeImprime)
                Tab(AppTab.stats.title, systemImage: AppTab.stats.symbol, value: AppTab.stats) {
                    StatsView()
                }
            }
            .opacity(booted ? 1 : 0)
            .scaleEffect(booted ? 1 : 1.04)
            .blur(radius: booted ? 0 : 12)
        }
        .environment(\.tabArrival, arrivee)
        .sensoryFeedback(.selection, trigger: app.tab)
        .onChange(of: app.tab) { ancien, nouveau in
            arrivee = TabArrivalState(compte: arrivee.compte + 1, sens: nouveau.index > ancien.index ? 1 : -1, onglet: nouveau)
        }
        .overlay(alignment: .top) {
            ToastOverlay(center: app.toasts)
                .padding(.top, 4)
        }
        .overlay {
            if !booted {
                BootView()
                    .transition(.asymmetric(insertion: .identity, removal: .opacity.combined(with: .scale(scale: 1.3))))
            }
        }
        .task { await demarre() }
        .task(id: TacheRafraichissement(phase: scenePhase, onglet: app.tab)) {
            await boucle()
        }
    }

    /// les etiquettes jamais imprimees (LIT compris)
    private var badgeImprime: Int {
        app.dashboard.stats?.aImprimer ?? app.printing.pending?.total ?? 0
    }

    // MARK: Sequence de lancement

    /// Le logo s'allume, les premiers chiffres arrivent (ou au plus tard apres
    /// un court instant), puis le contenu entre en cascade.
    private func demarre() async {
        async let chiffres: Void = app.dashboard.refresh()
        try? await Task.sleep(for: .milliseconds(900))
        let limite = Date.now.addingTimeInterval(1.6)
        while !app.dashboard.loaded && Date.now < limite {
            try? await Task.sleep(for: .milliseconds(80))
        }
        withAnimation(.spring(response: 0.7, dampingFraction: 0.86)) { booted = true }
        Haptics.soft()
        if app.tab == .dashboard { app.dashboard.playLaunchAnnouncement() }
        await chiffres
        if !app.dashboard.loaded { app.isColdStart = false }
    }

    private struct TacheRafraichissement: Equatable {
        let phase: ScenePhase
        let onglet: AppTab
    }

    /// Tant que l'app est au premier plan : l'onglet visible se relit toutes
    /// les 5 secondes. Revenir sur l'app ou changer d'onglet relit tout de suite.
    private func boucle() async {
        guard scenePhase == .active else { return }
        app.dashboard.markSeenIfNeeded(force: true)
        if app.tab == .stats {
            await app.stats.refresh(animated: true)
        } else if app.tab != .dashboard || booted {
            // au lancement, le dashboard est deja charge par la sequence d'entree
            await app.refreshVisible()
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            if Task.isCancelled { break }
            await app.refreshVisible()
        }
    }
}

/// L'onglet qui arrive : son contenu glisse depuis le cote d'ou l'on vient,
/// en se precisant (flou -> net) et en se posant d'un ressort. Seul le
/// contenu bouge : le fond reste en place. (Animer tout l'ecran, fond
/// compris, decouvrait le noir de la barre d'onglets en haut.)
struct TabArrivalState: Equatable {
    var compte = 0
    var sens: CGFloat = 1
    var onglet: AppTab = .dashboard
}

extension EnvironmentValues {
    @Entry var tabArrival = TabArrivalState()
}

extension View {
    /// a poser sur le contenu defilant de la page racine d'un onglet
    func tabArrival(_ onglet: AppTab) -> some View {
        modifier(TabArrival(onglet: onglet))
    }
}

private struct TabArrival: ViewModifier {
    let onglet: AppTab
    @Environment(\.tabArrival) private var etat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// cache des qu'on quitte l'onglet : au retour, la premiere image est
    /// deja le debut de l'entree (pas d'eclair de l'etat final)
    @State private var visible = false
    /// l'arrivee deja jouee (apparition et changement d'onglet arrivent
    /// parfois ensemble : une seule entree)
    @State private var jouee = -1

    func body(content: Content) -> some View {
        content
            // le glissement et le flou se posent d'un ressort...
            .blur(radius: visible ? 0 : 10)
            .scaleEffect(visible ? 1 : 0.975, anchor: .top)
            .offset(x: visible ? 0 : 36 * etat.sens)
            .animation(reduceMotion ? nil : .spring(response: 0.4, dampingFraction: 0.82), value: visible)
            // ...pendant que le contenu apparait tout de suite : pas d'ecran vide
            .opacity(visible ? 1 : 0.15)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: visible)
            .onAppear {
                if etat.onglet == onglet { entre() }
            }
            .onChange(of: etat.compte) {
                if etat.onglet == onglet {
                    entre()
                } else {
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) { visible = false }
                }
            }
    }

    private func entre() {
        guard jouee != etat.compte else { return }
        jouee = etat.compte
        visible = true
    }
}

/// L'ecran de lancement : la marque se leve dans un halo violet.
private struct BootView: View {
    @State private var allume = false

    var body: some View {
        ZStack {
            VStack(spacing: 18) {
                ZStack {
                    Circle()
                        .fill(Theme.violet.opacity(0.55))
                        .frame(width: 150, height: 150)
                        .blur(radius: 50)
                        .scaleEffect(allume ? 1.25 : 0.4)
                    Image(systemName: "shippingbox.fill")
                        .font(.system(size: 46, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 96, height: 96)
                        .glassEffect(.regular.tint(Theme.violet.opacity(0.75)), in: .rect(cornerRadius: 28))
                        .symbolEffect(.bounce.up, options: .nonRepeating, value: allume)
                        .scaleEffect(allume ? 1 : 0.6)
                        .shadow(color: Theme.violet.opacity(0.9), radius: allume ? 30 : 0)
                }
                Text("Drop")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.numberGradient)
                    .opacity(allume ? 1 : 0)
                    .offset(y: allume ? 0 : 12)
                    .blur(radius: allume ? 0 : 6)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.8, dampingFraction: 0.7)) { allume = true }
        }
    }
}
