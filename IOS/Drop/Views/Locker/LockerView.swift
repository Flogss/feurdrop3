import SwiftUI
import DropKit

/// Le mode locker : la liste des paires (code-barre + colis), puis la
/// visionneuse plein ecran devant le locker.
struct LockerView: View {
    @Environment(AppModel.self) private var app
    @State private var ouvert: LockerStart?

    private var model: LockerModel { app.locker }

    struct LockerStart: Identifiable {
        let index: Int
        var id: Int { index }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.summary)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText())

                Button {
                    Haptics.soft()
                    ouvert = LockerStart(index: 0)
                } label: {
                    Label(model.pairs.first.map { "Commencer au #\($0.numero)" } ?? "Commencer", systemImage: "play.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .buttonStyle(.glassProminent)
                .tint(Theme.special)
                .disabled(model.pairs.isEmpty)

                if !model.loaded {
                    LazyVGrid(columns: colonnes, spacing: 12) {
                        ForEach(0..<4, id: \.self) { _ in SkeletonRow(height: 190) }
                    }
                } else if model.pairs.isEmpty {
                    EmptyStateView(symbol: "key.fill", title: "Aucun code en attente", subtitle: "Les codes postés dans le topic spécial arriveront ici.")
                } else {
                    LazyVGrid(columns: colonnes, spacing: 12) {
                        ForEach(Array(model.pairs.enumerated()), id: \.element.id) { i, paire in
                            Button {
                                Haptics.soft()
                                ouvert = LockerStart(index: i)
                            } label: {
                                PairCard(pair: paire)
                            }
                            .buttonStyle(PressScaleStyle())
                            .transition(.scale(scale: 0.85).combined(with: .opacity))
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .navigationTitle("Mode locker")
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        #if os(iOS)
        .fullScreenCover(item: $ouvert) { depart in
            LockerViewer(startIndex: depart.index)
        }
        #else
        .sheet(item: $ouvert) { depart in
            LockerViewer(startIndex: depart.index)
                .frame(minWidth: 520, minHeight: 760)
        }
        #endif
    }

    private var colonnes: [GridItem] { [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)] }
}

/// Une paire : son numero, son etat, la vignette du code.
private struct PairCard: View {
    let pair: LockerPair
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("#\(pair.numero)")
                    .font(.system(size: 22, weight: .heavy, design: .rounded))
                    .foregroundStyle(pair.isIncomplete ? Theme.danger : Theme.special)
                Spacer()
                etat
            }
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(pair.code ? Color.white : Color.white.opacity(0.05))
                if let image = app.locker.images[pair.id] {
                    Image(platformImage: image)
                        .resizable()
                        .interpolation(.none)
                        .scaledToFit()
                        .padding(8)
                        .transition(.opacity)
                } else if pair.code {
                    ProgressView().tint(.gray)
                } else {
                    Image(systemName: "key.slash").font(.title2).foregroundStyle(Theme.text3)
                }
            }
            .frame(height: 86)
            .task(id: pair.id) { await app.locker.image(for: pair) }
            Text(pair.colis?.fileName ?? (pair.seul ? "Sans colis" : "PDF pas encore arrivé"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(pair.sender ?? " ")
                .font(.caption2)
                .foregroundStyle(Theme.text3)
                .lineLimit(1)
        }
        .padding(12)
        .glassEffect(.regular.tint(pair.isIncomplete ? Theme.danger.opacity(0.18) : .black.opacity(0.25)).interactive(), in: .rect(cornerRadius: 20))
        .overlay {
            if pair.isIncomplete {
                RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.danger.opacity(0.5), lineWidth: 1)
            }
        }
    }

    @ViewBuilder
    private var etat: some View {
        switch pair.state {
        case .missingCode: badge("Code manquant", Theme.danger)
        case .missingParcel: badge("PDF manquant", Theme.danger)
        case .alone: badge("Code seul", Theme.text2)
        case .printed: badge("Imprimé", Theme.violetLight)
        case .toPrint: badge("À imprimer", Theme.warn)
        }
    }

    private func badge(_ texte: String, _ couleur: Color) -> some View {
        Text(texte)
            .font(.system(size: 9.5, weight: .bold))
            .foregroundStyle(couleur)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(couleur.opacity(0.15), in: .capsule)
    }
}
