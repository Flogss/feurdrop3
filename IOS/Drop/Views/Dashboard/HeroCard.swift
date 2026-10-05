import SwiftUI
import DropKit

/// La carte principale : combien de colis attendent, ce qu'ils valent, de
/// quoi le sac est fait, et le bouton de la tournee.
struct HeroCard: View {
    let stats: Stats
    @Environment(AppModel.self) private var app
    @State private var confirmeRetour = false
    @State private var confirmeAnnulation = false

    private var model: DashboardModel { app.dashboard }
    private var enTournee: Bool { stats.tour.isActive }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(enTournee ? "Dans le sac" : "À dropper")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.interpolate)
                Spacer()
                if enTournee, let debut = ServerDate.parse(stats.tour.startedAt) {
                    TourPill(start: debut, offset: model.clockOffset)
                        .transition(.scale(scale: 0.6, anchor: .trailing).combined(with: .opacity))
                }
            }

            chiffre

            if stats.bjPendingCount > 0 || stats.litPendingCount > 0 {
                HStack(spacing: 8) {
                    if stats.bjPendingCount > 0 {
                        Chip(color: .carrier("BJ")) {
                            Text("\(Text("\(Format.integer(stats.bjPendingCount)) BJ").bold()) · \(Format.euroCompact(stats.bjPendingValue))")
                        }
                    }
                    if stats.litPendingCount > 0 {
                        Chip(color: .carrier("LIT")) {
                            Text("\(Format.integer(stats.litPendingCount)) LIT").bold()
                        }
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
            }

            CarrierMix(carriers: stats.byCarrier)

            if enTournee {
                Text(noteTournee)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            actions
        }
        .padding(Theme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { aura }
        .glassEffect(.regular.tint(Theme.violetDark.opacity(enTournee ? 0.5 : 0.32)), in: .rect(cornerRadius: Theme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .strokeBorder(
                    LinearGradient(colors: [Theme.violetLight.opacity(enTournee ? 0.7 : 0.35), .clear, Theme.violet.opacity(0.25)], startPoint: .topLeading, endPoint: .bottomTrailing),
                    lineWidth: 1
                )
                .allowsHitTesting(false)
        }
        .lumiereSurvol()
        .overlay(alignment: .topLeading) {
            SparkBurst(trigger: model.celebration, count: 20, power: 1.4)
                .frame(width: 200, height: 200)
                .offset(x: 10, y: 10)
        }
        .shadow(color: Theme.violet.opacity(0.25), radius: 30, y: 14)
        .animation(Theme.spring, value: enTournee)
        .confirmationDialog("Tout est posté ?", isPresented: $confirmeRetour, titleVisibility: .visible) {
            Button("Oui, tout est dropé") { Task { await model.endTour(drop: true) } }
            Button("Retour", role: .cancel) {}
        } message: {
            Text("Les colis déjà imprimés seront marqués dropés. Ceux pas encore imprimés restent en attente pour la prochaine tournée.")
        }
        .confirmationDialog("Annuler la tournée ?", isPresented: $confirmeAnnulation, titleVisibility: .visible) {
            Button("Annuler la tournée", role: .destructive) { Task { await model.endTour(drop: false) } }
            Button("Continuer", role: .cancel) {}
        } message: {
            Text("Rien ne sera dropé : les colis restent en attente.")
        }
    }

    // MARK: Le chiffre

    private var chiffre: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                AnimatedNumber(
                    value: Double(stats.pendingCount),
                    start: model.starts[.pending],
                    delay: model.starts[.pending] == nil ? 0 : 0.78,
                    bubble: { "+\(Format.count(Int($0.rounded()), "colis", "colis"))" }
                )
                .font(.system(size: 84, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.numberGradient)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                Text("colis")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text3)
            }
            AnimatedNumber(
                value: stats.pendingValue,
                format: { "≈ " + Format.euro($0) },
                start: model.starts[.pendingValue],
                delay: model.starts[.pendingValue] == nil ? 0 : 0.85
            )
            .font(.title3.weight(.semibold))
            .foregroundStyle(Theme.moneyGradient)
        }
    }

    /// la lumiere violette qui respire derriere le chiffre
    private var aura: some View {
        HeroAura()
            .clipShape(.rect(cornerRadius: Theme.Radius.card))
            .allowsHitTesting(false)
    }

    private var noteTournee: String {
        let debut = ServerDate.time(stats.tour.startedAt)
        if stats.tour.arrivedCount > 0 {
            return "Parti à \(debut). \(Format.count(stats.tour.arrivedCount, "colis reçu", "colis reçus")) depuis (\(Format.euro(stats.tour.arrivedValue))) attendront la prochaine tournée."
        }
        return "Parti à \(debut). Seuls les colis présents au départ peuvent être dropés."
    }

    // MARK: Actions

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                if enTournee {
                    if stats.pendingCount == 0 {
                        Task { await model.endTour(drop: false) }
                    } else {
                        Haptics.warning()
                        confirmeRetour = true
                    }
                } else {
                    Task { await model.startTour() }
                }
            } label: {
                HStack(spacing: 8) {
                    if model.busy.contains("tour") {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: enTournee ? "checkmark.circle.fill" : "box.truck.fill")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    Text(enTournee ? "Je suis rentré" : "Je pars poster")
                        .contentTransition(.interpolate)
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
            }
            .boutonVerreFort(Theme.violetDeep)
            .disabled(model.busy.contains("tour"))

            if enTournee {
                Button("Annuler") {
                    confirmeAnnulation = true
                }
                .font(.headline)
                .frame(height: 50)
                .padding(.horizontal, 6)
                .boutonVerre()
                .transition(.scale(scale: 0.5, anchor: .leading).combined(with: .opacity))
            }
        }
        .sensoryFeedback(.success, trigger: enTournee)
    }
}

/// La lumiere qui respire derriere le chiffre : deux halos qui derivent
/// lentement (meme trajectoire qu'avant). Leur mouvement est une animation
/// de position : la vue n'est plus recalculee 20 fois par seconde, seul le
/// deplacement est anime.
private struct HeroAura: View {
    @State private var derive = false
    @State private var houle = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                halo(Theme.violet.opacity(0.55), rayon: 220)
                    .position(x: w * 0.25, y: h * 0.25)
                    .offset(x: (derive ? 0.08 : -0.08) * w)
                halo(Theme.violetDeep.opacity(0.35), rayon: 200)
                    .position(x: w * 0.9, y: h * 0.95)
                    .offset(y: (houle ? 0.05 : -0.05) * h)
            }
        }
        .onAppear {
            // demi-periodes de sin(t * 0.4) et cos(t * 0.3)
            withAnimation(.easeInOut(duration: .pi / 0.4).repeatForever(autoreverses: true)) { derive = true }
            withAnimation(.easeInOut(duration: .pi / 0.3).repeatForever(autoreverses: true)) { houle = true }
        }
    }

    private func halo(_ couleur: Color, rayon: CGFloat) -> some View {
        RadialGradient(colors: [couleur, .clear], center: .center, startRadius: 0, endRadius: rayon)
            .frame(width: rayon * 2, height: rayon * 2)
    }
}

/// "En tournee 12:34" : une pastille vivante, le chrono recale sur le serveur.
private struct TourPill: View {
    let start: Date
    let offset: TimeInterval
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(Theme.warn)
                .frame(width: 7, height: 7)
                .shadow(color: Theme.warn, radius: pulse ? 6 : 2)
                .scaleEffect(pulse ? 1.25 : 0.9)
            Text("En tournée")
                .font(.footnote.weight(.semibold))
            TimelineView(.periodic(from: .now, by: 1)) { contexte in
                let secondes = Int(contexte.date.addingTimeInterval(offset).timeIntervalSince(start))
                Text(Format.chrono(secondes))
                    .font(.footnote.weight(.bold).monospacedDigit())
                    .foregroundStyle(Theme.warn)
                    .contentTransition(.numericText(countsDown: false))
                    .animation(.snappy, value: secondes)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .glassEffect(.regular.tint(Theme.warn.opacity(0.18)), in: .capsule)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true }
        }
    }
}

/// Une pastille teintee (BJ, LIT).
struct Chip<Label: View>: View {
    let color: Color
    @ViewBuilder var label: Label

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6).shadow(color: color, radius: 3)
            label
        }
        .font(.footnote)
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(color.opacity(0.14), in: .capsule)
        .overlay(Capsule().strokeBorder(color.opacity(0.3), lineWidth: 0.6))
    }
}

/// De quoi le sac est fait : une barre segmentee aux couleurs des
/// transporteurs. Les segments poussent a l'arrivee et glissent ensuite.
private struct CarrierMix: View {
    let carriers: [CarrierSummary]
    @State private var pousse = false

    private var parts: [CarrierSummary] { carriers.filter { $0.pendingCount > 0 } }

    var body: some View {
        if !parts.isEmpty {
            let total = parts.reduce(0) { $0 + $1.pendingCount }
            VStack(alignment: .leading, spacing: 10) {
                GeometryReader { geo in
                    let largeurUtile = geo.size.width - CGFloat(parts.count - 1) * 3
                    HStack(spacing: 3) {
                        ForEach(Array(parts.enumerated()), id: \.element.id) { i, c in
                            let couleur = Color.carrier(c.carrier)
                            Capsule()
                                .fill(LinearGradient(colors: [couleur, couleur.opacity(0.7)], startPoint: .top, endPoint: .bottom))
                                .shadow(color: couleur.opacity(0.6), radius: 4)
                                .frame(width: max(4, largeurUtile * CGFloat(c.pendingCount) / CGFloat(total) * (pousse ? 1 : 0.02)))
                                .animation(.spring(response: 0.9, dampingFraction: 0.75).delay(Double(i) * 0.06), value: pousse)
                        }
                    }
                }
                .frame(height: 8)
                .animation(.spring(response: 0.8, dampingFraction: 0.8), value: parts)

                FlowLayout(spacing: 12, lineSpacing: 6) {
                    ForEach(parts) { c in
                        HStack(spacing: 5) {
                            Circle().fill(Color.carrier(c.carrier)).frame(width: 6, height: 6)
                            Text(Carrier.shortLabel(c.carrier)).foregroundStyle(Theme.text2)
                            Text(Format.integer(c.pendingCount)).bold().contentTransition(.numericText(value: Double(c.pendingCount)))
                        }
                        .font(.caption)
                    }
                }
            }
            .onAppear {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(0.9))
                    pousse = true
                }
            }
        }
    }
}

/// Une mise en page qui va a la ligne, comme un texte.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let largeur = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, ligne: CGFloat = 0, maxX: CGFloat = 0
        for vue in subviews {
            let taille = vue.sizeThatFits(.unspecified)
            if x > 0 && x + taille.width > largeur {
                y += ligne + lineSpacing
                x = 0
                ligne = 0
            }
            x += taille.width + spacing
            maxX = max(maxX, x - spacing)
            ligne = max(ligne, taille.height)
        }
        return CGSize(width: proposal.width ?? maxX, height: y + ligne)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, ligne: CGFloat = 0
        for vue in subviews {
            let taille = vue.sizeThatFits(.unspecified)
            if x > bounds.minX && x + taille.width > bounds.maxX {
                y += ligne + lineSpacing
                x = bounds.minX
                ligne = 0
            }
            vue.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(taille))
            x += taille.width + spacing
            ligne = max(ligne, taille.height)
        }
    }
}
