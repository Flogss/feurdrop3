import SwiftUI
import UniformTypeIdentifiers
import DropKit

/// Le suivi des colis : envoyer une liste de numeros a verifier, suivre la
/// verification en direct, et lire ce que les transporteurs disent.
struct TrackingView: View {
    @Environment(AppModel.self) private var app
    @State private var importe = false

    private var model: TrackingModel { app.tracking }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if model.loaded, model.overview?.ready == false {
                    EmptyStateView(symbol: "exclamationmark.triangle", title: "Base du bot de suivi introuvable", subtitle: "Indique son chemin dans la variable SUIVI_DB_PATH.")
                        .surfaceCard()
                } else {
                    verification
                    if let resume = model.overview?.summary, !resume.isEmpty {
                        parStatut(resume)
                    }
                    if !model.labels.isEmpty {
                        libelles
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeader("Répartition des actualisations")
                            DonutChart(slices: model.labelShares, reveal: 1, centerLabel: "numéros", format: { Format.integer($0) })
                        }
                        .surfaceCard()
                    }
                    if !model.loaded {
                        SkeletonRow(height: 160)
                        SkeletonRow(height: 220)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .navigationTitle("Suivi des colis")
        .navigationSubtitle(model.loaded ? Format.count(model.totalChecked, "numéro vérifié", "numéros vérifiés") : "")
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .task { await model.watch() }
        .fileImporter(isPresented: $importe, allowedContentTypes: [.plainText, .commaSeparatedText, .text]) { resultat in
            guard case .success(let url) = resultat else { return }
            Task { await envoie(url) }
        }
    }

    // MARK: Verification

    private var verification: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Vérification") {
                if model.liveRunning, let job = model.live {
                    Text(job.source + (model.queued > 0 ? " · \(model.queued) en attente" : "")).lineLimit(1)
                }
            }
            if model.liveRunning, let job = model.live {
                LiveProgress(job: job, shown: model.shownChecked, finds: model.finds, celebration: model.finished) {
                    Task { await model.cancel() }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            } else {
                VStack(spacing: 10) {
                    Text("Un fichier .txt avec des numéros de suivi, un par ligne ou en vrac.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 10) {
                        Button {
                            importe = true
                        } label: {
                            Label("Choisir un fichier", systemImage: "doc.text.magnifyingglass")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .frame(height: 48)
                        }
                        .boutonVerreFort(Theme.violetDeep)
                        PasteButton(payloadType: String.self) { textes in
                            guard let texte = textes.first else { return }
                            Task { await model.verify(text: texte, name: "presse-papiers.txt") }
                        }
                        .labelStyle(.iconOnly)
                        .buttonBorderShape(.circle)
                        .tint(Theme.violet)
                    }
                    .disabled(model.sending)
                }
                .transition(.opacity)
            }
        }
        .surfaceCard()
        .animation(Theme.spring, value: model.liveRunning)
    }

    private func envoie(_ url: URL) async {
        let acces = url.startAccessingSecurityScopedResource()
        defer { if acces { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            app.toasts.show("Fichier illisible", style: .error)
            return
        }
        let texte = String(decoding: data, as: UTF8.self)
        await model.verify(text: texte, name: url.lastPathComponent)
    }

    // MARK: Par statut

    private func parStatut(_ resume: [MilestoneCount]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Par statut")
            ForEach(resume) { m in
                HStack(spacing: 12) {
                    CarrierDot(color: Theme.milestone(m.milestone), size: 9)
                        .frame(width: 18)
                    Text(m.milestoneLabel ?? m.milestone.label)
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text(Format.integer(m.count))
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .contentTransition(.numericText(value: Double(m.count)))
                    if m.milestone.isRecheckable {
                        Button {
                            Task { await model.recheck(m.milestone) }
                        } label: {
                            Image(systemName: "arrow.clockwise").font(.footnote.weight(.bold)).frame(width: 30, height: 30)
                        }
                        .boutonVerre(.rond)
                        .disabled(model.liveRunning)
                        .accessibilityLabel("Revérifier ces \(m.count) numéros")
                    } else {
                        Color.clear.frame(width: 42, height: 30)
                    }
                }
                .padding(.vertical, 3)
                .ligneSurvol()
            }
        }
        .surfaceCard()
    }

    // MARK: Libelles

    private var libelles: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader("Dernières actualisations") {
                Text(Format.count(model.labels.count, "libellé", "libellés"))
            }
            ForEach(model.labels.prefix(60)) { l in
                NavigationLink(value: Route.trackingLabel(l)) {
                    HStack(spacing: 12) {
                        CarrierDot(color: Theme.milestone(l.milestone), size: 8)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(l.displayLabel)
                                .font(.subheadline)
                                .foregroundStyle(Theme.text)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            Text("Dernière le \(ServerDate.shortDayTime(l.lastEventAt))")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                        Spacer()
                        Text(Format.integer(l.count))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(Theme.text2)
                        ChevronLigne()
                    }
                    .padding(.vertical, 6)
                    .contentShape(.rect)
                    .ligneSurvol()
                }
                .buttonStyle(PressScaleStyle(scale: 0.98))
            }
        }
        .surfaceCard()
    }
}

/// L'ecran de passage : le compteur qui defile numero par numero, la jauge
/// avec sa tete lumineuse, et les trouvailles qui passent.
private struct LiveProgress: View {
    let job: LiveJob
    let shown: Int
    let finds: [LiveFind]
    let celebration: Int
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Format.integer(shown))
                    .font(.system(size: 44, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Theme.numberGradient)
                    .contentTransition(.numericText(value: Double(shown)))
                    .animation(.snappy(duration: 0.2), value: shown)
                    .overlay { SparkBurst(trigger: celebration, count: 18, power: 1.2) }
                Text("/ \(Format.integer(job.total))")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                Spacer()
                Text(pourcent)
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(Theme.violetLight)
                    .contentTransition(.numericText())
            }

            GeometryReader { geo in
                let largeur = geo.size.width * CGFloat(min(max(job.percent / 100, 0), 1))
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.07))
                    Capsule()
                        .fill(Theme.accentGradient)
                        .frame(width: max(8, largeur))
                        .shadow(color: Theme.violet, radius: 8)
                    Circle()
                        .fill(.white)
                        .frame(width: 12, height: 12)
                        .shadow(color: Theme.violetBright, radius: 10)
                        .offset(x: max(0, largeur - 6))
                }
            }
            .frame(height: 10)
            .animation(.smooth(duration: 0.7), value: job.percent)

            Text(sousTitre)
                .font(.footnote)
                .foregroundStyle(Theme.text2)

            if let comptes = job.counts, !comptes.isEmpty {
                FlowLayout(spacing: 8, lineSpacing: 6) {
                    ForEach(comptes.sorted { $0.value > $1.value }, id: \.key) { cle, n in
                        let m = Milestone(rawValue: cle) ?? .unknown
                        HStack(spacing: 5) {
                            Circle().fill(Theme.milestone(m)).frame(width: 6, height: 6)
                            Text(m.label).foregroundStyle(Theme.text2)
                            Text(Format.integer(n)).bold().contentTransition(.numericText(value: Double(n)))
                        }
                        .font(.caption)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Theme.milestone(m).opacity(0.12), in: .capsule)
                    }
                }
            }

            VStack(spacing: 6) {
                ForEach(finds) { f in
                    HStack(spacing: 8) {
                        Circle().fill(Theme.milestone(f.milestone)).frame(width: 7, height: 7)
                        Text(f.number).font(.caption.monospaced()).lineLimit(1)
                        Spacer()
                        Text(f.label ?? f.milestone.label).font(.caption).foregroundStyle(Theme.text3).lineLimit(1)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .glassEffect(.regular.tint(Theme.milestone(f.milestone).opacity(0.15)), in: .rect(cornerRadius: 12))
                    .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity).combined(with: .scale(scale: 0.9)), removal: .opacity))
                }
            }

            Button("Arrêter", systemImage: "stop.fill", role: .destructive, action: onCancel)
                .boutonVerre()
        }
    }

    private var pourcent: String {
        let p = job.percent
        return p.formatted(.number.locale(Locale(identifier: "fr_FR")).precision(.fractionLength(p < 10 ? 1 : 0))) + " %"
    }

    private var sousTitre: String {
        if let erreur = job.fatalError { return "Erreur : \(erreur)" }
        if job.cancelled == true { return "Arrêté après \(Format.duration(job.elapsed))" }
        let reste = job.eta.map { " · reste ~\(Format.duration($0))" } ?? ""
        return "\(job.rate.formatted(.number.precision(.fractionLength(0...1)))) /s · \(Format.duration(job.elapsed)) écoulées\(reste)"
    }
}
