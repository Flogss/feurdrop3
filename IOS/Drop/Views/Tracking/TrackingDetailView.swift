import SwiftUI
import DropKit

/// Les numeros qui ont recu un meme libelle. On copie une ligne (numero, date,
/// libelle : ce qui se colle dans un message) ou toute la liste.
struct TrackingDetailView: View {
    let label: TrackingLabel
    @Environment(AppModel.self) private var app
    @State private var rows: [TrackingRow] = []
    @State private var total = 0
    @State private var chargee = false
    @State private var copie = 0

    var body: some View {
        List {
            Section {
                Text(label.displayLabel)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .listRowBackground(Color.clear)
            }
            Section {
                if !chargee {
                    ForEach(0..<5, id: \.self) { _ in SkeletonRow(height: 36) }
                } else if rows.isEmpty {
                    EmptyStateView(symbol: "tray", title: "Aucun numéro")
                }
                ForEach(rows) { r in
                    HStack(spacing: 12) {
                        CarrierDot(color: Theme.milestone(r.milestone), size: 8)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.trackingNumber).font(.subheadline.monospaced())
                            Text(ServerDate.shortDayTime(r.lastEventAt)).font(.caption).foregroundStyle(Theme.text3)
                        }
                        Spacer()
                        Button {
                            copier(r.shareLine, message: "\(r.trackingNumber) copié")
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Copier \(r.trackingNumber)")
                    }
                    .contextMenu {
                        Button("Copier la ligne", systemImage: "doc.on.doc") { copier(r.shareLine, message: "\(r.trackingNumber) copié") }
                        Button("Copier le numéro", systemImage: "number") { copier(r.trackingNumber, message: "\(r.trackingNumber) copié") }
                        ShareLink(item: r.shareLine)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Copier", systemImage: "doc.on.doc") { copier(r.shareLine, message: "\(r.trackingNumber) copié") }
                            .tint(Theme.violet)
                    }
                }
                if rows.count < total {
                    Button("Charger plus") { Task { await charge(reset: false) } }
                        .frame(maxWidth: .infinity)
                }
            } header: {
                if chargee { Text("\(Format.integer(rows.count)) sur \(Format.count(total, "numéro", "numéros"))") }
            }
            .listRowBackground(Theme.surface.opacity(0.78))
        }
        .scrollContentBackground(.hidden)
        .navigationTitle(label.milestone.label)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Copier tout", systemImage: "doc.on.doc") {
                        copier(rows.map(\.shareLine).joined(separator: "\n"), message: Format.count(rows.count, "ligne copiée", "lignes copiées"))
                    }
                    Button("Copier les numéros", systemImage: "number") {
                        copier(rows.map(\.trackingNumber).joined(separator: "\n"), message: Format.count(rows.count, "numéro copié", "numéros copiés"))
                    }
                    ShareLink(item: rows.map(\.shareLine).joined(separator: "\n"))
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(rows.isEmpty)
            }
        }
        .sensoryFeedback(.success, trigger: copie)
        .task { await charge(reset: true) }
        .refreshable { await charge(reset: true) }
    }

    private func charge(reset: Bool) async {
        guard let page = await app.tracking.rows(for: label, offset: reset ? 0 : rows.count) else { return }
        withAnimation(Theme.spring) {
            rows = reset ? page.rows : rows + page.rows
            total = page.total
            chargee = true
        }
    }

    private func copier(_ texte: String, message: String) {
        Platform.copy(texte)
        copie += 1
        app.toasts.show(message)
    }
}
