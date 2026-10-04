import SwiftUI
import DropKit

// MARK: - Resume de tournee

/// Le resume de la derniere tournee, garde jusqu'a ce qu'on le ferme. Quand
/// il apparait (retour de tournee), c'est la fete : etincelles et taux
/// horaire qui monte depuis zero.
struct TourSummaryCard: View {
    let summary: TourSummary
    @Environment(AppModel.self) private var app

    private var secondes: Int { summary.durationSeconds }
    private var smic: Double { summary.smicHourly ?? 9.4 }
    private var taux: Double { secondes > 0 ? summary.value * 3600 / Double(secondes) : 0 }

    var body: some View {
        let model = app.dashboard
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "flag.checkered")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(Theme.accentGradient, in: .rect(cornerRadius: 13))
                    .shadow(color: Theme.violet.opacity(0.7), radius: 10)
                    .symbolEffect(.bounce, value: model.tourCelebration)
                    .overlay { SparkBurst(trigger: model.tourCelebration, count: 18, power: 1.3).frame(width: 160, height: 160) }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Tournée terminée en \(Format.duration(secondes))")
                        .font(.headline)
                    Text("\(ServerDate.time(summary.startedAt)) → \(ServerDate.time(summary.endedAt)) · \(Format.count(summary.count, "colis dropé", "colis dropés")) · \(Format.euro(summary.value))")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
                Spacer(minLength: 0)
                Button {
                    Task { await model.dismissTourSummary() }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Fermer le résumé")
            }

            HStack(alignment: .firstTextBaseline, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    AnimatedNumber(value: taux, format: Format.euro, start: CounterStart(from: 0, announces: false), delay: 0.3)
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.moneyGradient)
                        .id(model.tourCelebration)
                    Text("/h").font(.headline).foregroundStyle(Theme.text3)
                }
                let ratio = smic > 0 ? taux / smic : 0
                Text("\(Format.multiple(ratio)) le SMIC")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(ratio < 1 ? Theme.warn : Theme.violetPale)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background((ratio < 1 ? Theme.warn : Theme.violet).opacity(0.2), in: .capsule)
            }
            Text("SMIC net \(Format.euro(smic))/h")
                .font(.caption)
                .foregroundStyle(Theme.text3)

            if let jour = summary.day, jour.sessions > 1 {
                let tauxJour = jour.seconds > 0 ? jour.value * 3600 / Double(jour.seconds) : 0
                Text("Aujourd'hui : \(jour.sessions) sessions · \(Format.duration(jour.seconds)) · \(Format.euro(jour.value)) · \(Format.euro(tauxJour))/h · \(Format.multiple(tauxJour / smic)) le SMIC")
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white.opacity(0.05), in: .rect(cornerRadius: 12))
            }
        }
        .glassCard(tint: Theme.violet.opacity(0.22))
    }
}

// MARK: - Aujourd'hui / Gagne au total

struct MetricsRow: View {
    let stats: Stats
    @Environment(AppModel.self) private var app

    var body: some View {
        let starts = app.dashboard.starts
        // un conteneur de verre : iOS rend les verres voisins en une passe
        // (espacement 0 : ils ne fusionnent jamais, l'aspect ne change pas)
        GlassEffectContainer(spacing: 0) {
        HStack(spacing: 12) {
            metrique(
                titre: "Aujourd'hui", valeur: stats.todayValue, start: starts[.today], retard: 0.92,
                sous: Format.count(stats.todayCount, "colis dropé", "colis dropés"), accent: true
            )
            metrique(
                titre: "Gagné au total", valeur: stats.droppedValue, start: starts[.earned], retard: 1.0,
                sous: Format.count(stats.droppedCount, "colis dropé", "colis dropés"), accent: false
            )
        }
        }
    }

    private func metrique(titre: String, valeur: Double, start: CounterStart?, retard: Double, sous: String, accent: Bool) -> some View {
        Button {
            withAnimation(.spring(response: 0.46, dampingFraction: 0.72)) { app.tab = .stats }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(titre)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text2)
                AnimatedNumber(
                    value: valeur, format: Format.euroCompact, start: start, delay: start == nil ? 0 : retard,
                    bubble: { "+" + Format.euroCompact($0) }
                )
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(accent ? AnyShapeStyle(Theme.moneyGradient) : AnyShapeStyle(Theme.numberGradient))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                Text(sous)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .contentTransition(.numericText())
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular.tint(accent ? Theme.violet.opacity(0.28) : .black.opacity(0.25)).interactive(), in: .rect(cornerRadius: 24))
        }
        .buttonStyle(PressScaleStyle())
    }
}

// MARK: - Stock de pochettes

struct StockCard: View {
    @Environment(AppModel.self) private var app
    @State private var saisie: StockKind?
    @State private var quantite = ""

    private static let seuilBas = 5

    var body: some View {
        let stock = app.dashboard.stock ?? .init()
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Stock de pochettes")
            GlassEffectContainer(spacing: 0) {
                HStack(spacing: 12) {
                    compteur(.normal, valeur: stock.normal)
                    compteur(.bj, valeur: stock.bj)
                }
            }
        }
        .surfaceCard()
        .alert("Stock \(saisie?.label ?? "")", isPresented: Binding(get: { saisie != nil }, set: { if !$0 { saisie = nil } })) {
            TextField("Quantité", text: $quantite)
                .clavier(.nombre)
            Button("Ajouter") { valide(signe: 1) }
            Button("Retirer", role: .destructive) { valide(signe: -1) }
            Button("Annuler", role: .cancel) { quantite = "" }
        } message: {
            Text("Combien de pochettes ?")
        }
    }

    private func compteur(_ kind: StockKind, valeur: Int) -> some View {
        let bas = valeur <= Self.seuilBas
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(kind.label)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text2)
                Spacer()
                if bas {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.warn)
                        .symbolEffect(.pulse, options: .repeat(.continuous))
                        .transition(.scale.combined(with: .opacity))
                }
            }
            Button {
                quantite = ""
                saisie = kind
            } label: {
                Text(Format.integer(valeur))
                    .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(bas ? AnyShapeStyle(Theme.warn) : AnyShapeStyle(Theme.numberGradient))
                    .contentTransition(.numericText(value: Double(valeur)))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(PressScaleStyle(scale: 0.94))
            .accessibilityHint("Saisir une quantité")
            HStack(spacing: 8) {
                pas(kind, -1, symbole: "minus")
                pas(kind, 1, symbole: "plus")
            }
        }
        .padding(14)
        .background(bas ? Theme.warn.opacity(0.08) : .white.opacity(0.035), in: .rect(cornerRadius: Theme.Radius.inner))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.inner, style: .continuous).strokeBorder(bas ? Theme.warn.opacity(0.35) : Theme.hairline, lineWidth: 0.7))
        .animation(Theme.spring, value: bas)
        .animation(Theme.bouncy, value: valeur)
    }

    private func pas(_ kind: StockKind, _ delta: Int, symbole: String) -> some View {
        Button {
            Haptics.tick()
            Task { await app.dashboard.adjustStock(delta, kind) }
        } label: {
            Image(systemName: symbole)
                .font(.system(size: 15, weight: .bold))
                .frame(maxWidth: .infinity)
                .frame(height: 36)
        }
        .buttonStyle(.glass)
        .accessibilityLabel(delta > 0 ? "Ajouter une pochette \(kind.label)" : "Retirer une pochette \(kind.label)")
    }

    private func valide(signe: Int) {
        guard let kind = saisie, let n = Int(quantite.trimmingCharacters(in: .whitespaces)), n > 0 else {
            Haptics.error()
            return
        }
        quantite = ""
        Task {
            if await app.dashboard.adjustStock(signe * n, kind) {
                app.toasts.show("\(signe > 0 ? "+" : "−")\(Format.integer(n)) au stock \(kind == .normal ? "normal" : "BJ")")
            }
        }
    }
}

// MARK: - A poster, par transporteur

struct CarriersCard: View {
    let carriers: [CarrierSummary]
    @Environment(AppModel.self) private var app

    var body: some View {
        let lignes = carriers.filter { $0.pendingCount > 0 }
        let total = lignes.reduce(0) { $0 + $1.pendingCount }
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("À poster") {
                if total > 0 { Text(Format.count(total, "colis", "colis")).contentTransition(.numericText()) }
            }
            if lignes.isEmpty {
                EmptyStateView(symbol: "party.popper.fill", title: "Rien à poster", subtitle: "Tout est dropé, beau travail.", positive: true)
            } else {
                GlassEffectContainer(spacing: 0) {
                    VStack(spacing: 4) {
                        ForEach(lignes) { c in
                            ligne(c, part: total > 0 ? Double(c.pendingCount) / Double(total) : 0)
                                .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .top)), removal: .opacity.combined(with: .offset(x: 40)).combined(with: .scale(scale: 0.95))))
                        }
                    }
                }
            }
        }
        .surfaceCard()
        .animation(Theme.spring, value: lignes)
    }

    private func ligne(_ c: CarrierSummary, part: Double) -> some View {
        let couleur = Color.carrier(c.carrier)
        let occupe = app.dashboard.busy.contains("tr:" + c.carrier)
        return HStack(spacing: 12) {
            CarrierDot(color: couleur)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 5) {
                Text(Carrier.label(c.carrier))
                    .font(.subheadline.weight(.semibold))
                Text("\(Format.count(c.pendingCount, "colis", "colis")) · \(Format.euro(c.pendingValue))")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .contentTransition(.numericText())
                ShareBar(fraction: part, color: couleur)
            }
            Button {
                Task { await app.dashboard.dropCarrier(c.carrier) }
            } label: {
                Group {
                    if occupe { ProgressView().controlSize(.small) } else { Text("Dropper") }
                }
                .font(.subheadline.weight(.semibold))
                .frame(minWidth: 70)
            }
            .buttonStyle(.glass)
            .disabled(occupe)
        }
        .padding(.vertical, 8)
    }
}

// MARK: - Expediteurs

struct SendersCard: View {
    let senders: [SenderSummary]
    @Environment(AppModel.self) private var app
    @State private var confirmeTout = false
    @State private var confirmeSaufLit = false

    var body: some View {
        let stats = app.dashboard.stats
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Expéditeurs") {
                Menu {
                    Button("Tout sauf les LIT", systemImage: "tray.and.arrow.up") { confirmeSaufLit = true }
                    Button("Tout marquer dropé", systemImage: "checkmark.circle") { confirmeTout = true }
                } label: {
                    Label("Drop groupé", systemImage: "ellipsis")
                        .labelStyle(.iconOnly)
                        .font(.system(size: 15, weight: .bold))
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .disabled((stats?.pendingCount ?? 0) == 0)
            }
            if senders.isEmpty {
                EmptyStateView(symbol: "shippingbox", title: "Aucun colis pour le moment", subtitle: "Les fichiers envoyés au bot apparaîtront ici.")
            } else {
                GlassEffectContainer(spacing: 0) {
                    VStack(spacing: 2) {
                        ForEach(senders) { s in
                            SenderRow(sender: s)
                        }
                    }
                }
            }
        }
        .surfaceCard()
        .animation(Theme.spring, value: senders)
        .confirmationDialog("Tout marquer comme dropé ?", isPresented: $confirmeTout, titleVisibility: .visible) {
            Button("Tout dropper") { Task { await app.dashboard.dropAll() } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("\(Format.count(stats?.pendingCount ?? 0, "colis en attente", "colis en attente")) · \(Format.euro(stats?.pendingValue ?? 0)).")
        }
        .confirmationDialog("Tout dropper sauf les LIT ?", isPresented: $confirmeSaufLit, titleVisibility: .visible) {
            Button("Dropper") { Task { await app.dashboard.dropAllExceptLit() } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Tous les colis en attente seront marqués dropés, sauf les LIT.")
        }
    }
}

private struct SenderRow: View {
    let sender: SenderSummary
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.dashboard
        let nom = sender.senderName
        HStack(spacing: 10) {
            SenderAvatar(name: nom, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(nom)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text("\(Format.count(sender.droppedCount, "dropé", "dropés")) · \(Format.euroGraphe(sender.droppedValue))")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .contentTransition(.numericText())
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
            if sender.pendingCount > 0 {
                Button {
                    Task { await model.dropSender(nom) }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "paperplane.fill")
                            .font(.caption.weight(.bold))
                        Text(Format.integer(sender.pendingCount))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .contentTransition(.numericText(value: Double(sender.pendingCount)))
                    }
                    .fixedSize()
                }
                .buttonStyle(.glassProminent)
                .tint(Theme.violetDeep)
                .disabled(model.busy.contains("exp:" + nom))
                .accessibilityLabel("Dropper les \(sender.pendingCount) colis de \(nom)")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
            HStack(spacing: 0) {
                pas("minus", ajout: false)
                Divider().frame(height: 18)
                pas("plus", ajout: true)
            }
            .glassEffect(.regular, in: .capsule)
            .fixedSize()
        }
        .padding(.vertical, 7)
        .contentShape(.rect)
        .contextMenu {
            if sender.pendingCount > 0 {
                Button("Dropper \(Format.count(sender.pendingCount, "colis", "colis"))", systemImage: "paperplane.fill") {
                    Task { await model.dropSender(nom) }
                }
            }
            Button("Ajouter un colis", systemImage: "plus") { Task { await model.quick(nom, add: true) } }
            Button("Retirer un colis", systemImage: "minus") { Task { await model.quick(nom, add: false) } }
        }
    }

    private func pas(_ symbole: String, ajout: Bool) -> some View {
        Button {
            Haptics.tick()
            Task { await app.dashboard.quick(sender.senderName, add: ajout) }
        } label: {
            Image(systemName: symbole)
                .font(.system(size: 12, weight: .bold))
                .frame(width: 30, height: 32)
                .contentShape(.rect)
        }
        .buttonStyle(PressScaleStyle(scale: 0.85))
        .accessibilityLabel(ajout ? "Ajouter un colis à \(sender.senderName)" : "Retirer un colis à \(sender.senderName)")
    }
}

// MARK: - Outils

struct ToolsCard: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 0) {
            outil(.tracking, symbole: "magnifyingglass", couleur: Theme.info, titre: "Suivi des colis",
                  sous: app.tracking.loaded ? Format.count(app.tracking.totalChecked, "numéro vérifié", "numéros vérifiés") : "Vérifier des numéros")
            Divider().padding(.leading, 62)
            outil(.locker, symbole: "lock.fill", couleur: Theme.special, titre: "Mode locker", sous: "Codes des spéciaux",
                  pastille: app.locker.pairs.count)
            Divider().padding(.leading, 62)
            outil(.settings, symbole: "gearshape.fill", couleur: Color(white: 0.55), titre: "Réglages", sous: "Prix, dettes, notifications")
        }
        .padding(.vertical, 6)
        .glassEffect(.regular.tint(.black.opacity(0.25)), in: .rect(cornerRadius: Theme.Radius.card))
    }

    private func outil(_ route: Route, symbole: String, couleur: Color, titre: String, sous: String, pastille: Int = 0) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 14) {
                Image(systemName: symbole)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(couleur.gradient, in: .rect(cornerRadius: 10))
                    .shadow(color: couleur.opacity(0.5), radius: 6)
                VStack(alignment: .leading, spacing: 1) {
                    Text(titre).font(.body.weight(.medium)).foregroundStyle(Theme.text)
                    Text(sous).font(.caption).foregroundStyle(Theme.text3).contentTransition(.numericText())
                }
                Spacer()
                if pastille > 0 {
                    Text(Format.integer(pastille))
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Theme.special.gradient, in: .capsule)
                        .contentTransition(.numericText(value: Double(pastille)))
                }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(.rect)
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
    }
}
