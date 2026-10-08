import SwiftUI
import DropKit

/// Les espaces expediteurs : un lien prive par expediteur, ou il voit
/// uniquement ses colis et ou ils en sont. Ici on les cree, on les copie ou
/// les partage (Telegram...), on les ouvre, on les regenere (l'ancien lien
/// cesse de marcher) ou on les desactive.
struct PortailsView: View {
    @Environment(AppModel.self) private var app
    @State private var aRegenerer: Sender?
    @State private var aCouper: Sender?

    private var model: SettingsModel { app.settings }

    var body: some View {
        Form {
            Section {
                ForEach(model.senders) { sender in
                    LignePortail(sender: sender, regenere: { aRegenerer = sender }, coupe: { aCouper = sender })
                }
            } footer: {
                Text("L'expéditeur voit seulement ses colis, leur statut (pas imprimé, imprimé, en cours de drop, drop) et le bouton de suivi du transporteur. Jamais le dashboard, ni les colis des autres.")
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Espaces expéditeurs")
        .task { await model.refresh() }
        .refreshable { await model.refresh() }
        .confirmationDialog(
            "Nouveau lien pour \(aRegenerer?.name ?? "") ?",
            isPresented: Binding(get: { aRegenerer != nil }, set: { if !$0 { aRegenerer = nil } }),
            titleVisibility: .visible, presenting: aRegenerer
        ) { sender in
            Button("Régénérer") { Task { await model.creePortail(sender) } }
            Button("Annuler", role: .cancel) {}
        } message: { _ in
            Text("L'ancien lien cessera de marcher immédiatement. Il faudra lui envoyer le nouveau.")
        }
        .confirmationDialog(
            "Désactiver l'espace de \(aCouper?.name ?? "") ?",
            isPresented: Binding(get: { aCouper != nil }, set: { if !$0 { aCouper = nil } }),
            titleVisibility: .visible, presenting: aCouper
        ) { sender in
            Button("Désactiver", role: .destructive) { Task { await model.retirePortail(sender) } }
            Button("Annuler", role: .cancel) {}
        } message: { _ in
            Text("Son lien cessera de marcher. Tu pourras en recréer un plus tard.")
        }
    }
}

private struct LignePortail: View {
    let sender: Sender
    let regenere: () -> Void
    let coupe: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL

    private var model: SettingsModel { app.settings }
    private var lien: URL? { model.lienPortail(sender) }
    private var possible: Bool { sender.portail?.possible ?? false }

    var body: some View {
        HStack(spacing: 12) {
            SenderAvatar(name: sender.name, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(sender.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(sousTitre)
                    .font(.caption)
                    .foregroundStyle(lien != nil ? Theme.teal : Theme.text3)
                    .contentTransition(.interpolate)
            }
            Spacer(minLength: 8)
            actions
        }
        .animation(Theme.spring, value: lien)
    }

    private var sousTitre: String {
        guard possible else { return "Plusieurs expéditeurs : pas d'espace" }
        guard lien != nil else { return "Pas encore de lien" }
        if let date = ServerDate.parse(sender.portail?.creeLe) {
            return "Lien actif depuis le \(date.formatted(.dateTime.day().month(.abbreviated).locale(Locale(identifier: "fr_FR"))))"
        }
        return "Lien actif"
    }

    @ViewBuilder
    private var actions: some View {
        if let lien {
            HStack(spacing: 6) {
                ShareLink(item: lien, message: Text("Ton espace pour suivre tes colis")) {
                    Image(systemName: "square.and.arrow.up")
                        .frame(width: 34, height: 34)
                }
                .boutonVerre(.rond)
                .accessibilityLabel("Partager le lien de \(sender.name)")

                Menu {
                    Button("Copier le lien", systemImage: "doc.on.doc") {
                        Platform.copy(lien.absoluteString)
                        app.toasts.show("Lien de \(sender.name) copié")
                    }
                    Button("Ouvrir son espace", systemImage: "safari") { openURL(lien) }
                    Divider()
                    Button("Régénérer le lien", systemImage: "arrow.clockwise", action: regenere)
                    Button("Désactiver", systemImage: "xmark.circle", role: .destructive, action: coupe)
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 34, height: 34)
                }
                .menuIndicator(.hidden)
                .boutonVerre(.rond)
                .accessibilityLabel("Actions pour \(sender.name)")
            }
        } else if possible {
            Button {
                Task { await model.creePortail(sender) }
            } label: {
                Label("Créer", systemImage: "link.badge.plus")
                    .font(.subheadline.weight(.semibold))
            }
            .boutonVerre()
            .disabled(model.isBusy("portail:\(sender.id)"))
        }
    }
}
