import SwiftUI
import DropKit

/// Les reglages, en formulaire natif : notifications, impression auto, ce
/// qu'on nous doit, prix, fusions, serveur.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmeAuto = false
    @State private var dettePayee: Debt?
    @State private var source: Int?
    @State private var cible: Int?
    @State private var confirmeFusion = false
    @State private var adresse = ""
    @AppStorage(ParcelWatch.newParcelsKey) private var notifColis = true
    @AppStorage(ParcelWatch.tourKey) private var notifTournee = true
    #if os(iOS)
    @AppStorage(BackgroundListener.enabledKey) private var ecoute = true
    #else
    // sur Mac, la veille tourne toujours (l'app reste ouverte)
    private let ecoute = true
    #endif

    private var model: SettingsModel { app.settings }

    var body: some View {
        Form {
            notifications
            impressionAuto
            dettes
            expediteurs
            fusion
            serveur
        }
        .scrollContentBackground(.hidden)
        .toggleStyle(.switch)
        .navigationTitle("Réglages")
        .task { await model.refresh() }
        .refreshable { await model.refresh() }
        .sensoryFeedback(.success, trigger: model.celebration)
        .onAppear { adresse = app.serverURL.absoluteString }
        .confirmationDialog("Activer l'impression auto ?", isPresented: $confirmeAuto, titleVisibility: .visible) {
            Button("Activer") { Task { await model.setAutoPrint(true) } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Les colis déjà en attente ne seront pas imprimés, seulement les prochains.")
        }
        .confirmationDialog(
            "\(dettePayee?.senderName ?? "") a payé ?",
            isPresented: Binding(get: { dettePayee != nil }, set: { if !$0 { dettePayee = nil } }),
            titleVisibility: .visible, presenting: dettePayee
        ) { dette in
            Button("Marquer payé") { Task { await model.markPaid(dette) } }
            Button("Annuler", role: .cancel) {}
        } message: { dette in
            Text("\(Format.euro(dette.owed)) seront marqués comme payés.")
        }
        .confirmationDialog(titreFusion, isPresented: $confirmeFusion, titleVisibility: .visible) {
            Button("Fusionner", role: .destructive) {
                guard let s = expediteur(source), let c = expediteur(cible) else { return }
                Task { await model.merge(source: s, into: c) }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Tous ses colis et gains seront transférés, et « \(expediteur(source)?.name ?? "") » sera supprimé.")
        }
    }

    // MARK: Sections

    private var notifications: some View {
        Section {
            switch model.notificationStatus {
            case .authorized, .provisional, .ephemeral:
                Toggle(isOn: $notifColis) {
                    Label("Nouveaux colis", systemImage: "shippingbox.fill")
                }
                Toggle(isOn: $notifTournee) {
                    Label("Tournée", systemImage: "box.truck.fill")
                }
                #if os(iOS)
                Toggle(isOn: $ecoute) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Écoute en arrière-plan", systemImage: "antenna.radiowaves.left.and.right")
                        Text(ecoute ? "Notification dans les 10 s, app fermée" : "Notification quand iOS réveille l'app")
                            .font(.caption)
                            .foregroundStyle(ecoute ? Theme.violetLight : Theme.text3)
                            .contentTransition(.interpolate)
                    }
                }
                #endif
                Button {
                    Task { await model.testNotification() }
                } label: {
                    Label("Tester le cha-ching", systemImage: "speaker.wave.2.fill")
                }
            case .denied:
                Label("Refusées", systemImage: "bell.slash.fill")
                    .foregroundStyle(Theme.warn)
                Button("Ouvrir les Réglages d'iOS", systemImage: "gear") {
                    Platform.openNotificationSettings()
                }
            default:
                Button {
                    Task { await model.enableNotifications() }
                } label: {
                    Label("Activer les notifications", systemImage: "bell.fill")
                }
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text(piedNotifications)
        }
        .tint(Theme.violet)
        .animation(Theme.spring, value: ecoute)
    }

    private var piedNotifications: String {
        guard model.notificationStatus == .authorized || model.notificationStatus == .provisional else {
            return "Un cha-ching dès que des colis arrivent, même app fermée."
        }
        var texte = "Chaque notification fait cha-ching. "
        if Platform.isMac {
            return texte + "Drop surveille les nouveaux colis toutes les 10 s tant qu'il est ouvert, même fenêtre fermée (il reste dans la barre des menus)."
        }
        texte += ecoute
            ? "L'écoute garde l'app éveillée une fois quittée et consomme un peu de batterie. Elle s'arrête si tu fermes l'app de force (balayée vers le haut)."
            : "Sans l'écoute, iOS réveille l'app quand il veut (de 15 min à quelques heures)."
        texte += " Si le site est aussi installé sur cet iPhone avec ses notifications, coupe-les là-bas pour ne pas tout recevoir en double."
        return texte
    }

    private var impressionAuto: some View {
        Section {
            Toggle(isOn: Binding(
                get: { model.autoPrint.enabled },
                set: { actif in
                    if actif {
                        confirmeAuto = true
                    } else {
                        Task { await model.setAutoPrint(false) }
                    }
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Impression automatique")
                    Text(model.autoPrint.enabled ? "Activée" : "Désactivée")
                        .font(.caption)
                        .foregroundStyle(model.autoPrint.enabled ? Theme.violetLight : Theme.text3)
                        .contentTransition(.interpolate)
                }
            }
            .tint(Theme.violet)
            .disabled(model.isBusy("auto"))
        } footer: {
            if model.autoPrint.enabled {
                Text("\(Format.count(model.autoPrint.pending, "étiquette", "étiquettes")) en attente · les LIT restent à la main")
            } else {
                Text("Le Mac imprime chaque nouvelle étiquette dès qu'elle arrive.")
            }
        }
    }

    private var dettes: some View {
        Section {
            if model.debts.isEmpty {
                Label("Personne ne vous doit rien", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(Theme.violetLight)
            } else {
                ForEach(model.debts) { d in
                    HStack(spacing: 12) {
                        SenderAvatar(name: d.senderName, size: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(d.senderName).font(.body.weight(.medium))
                            Text("\(Format.euro(d.owed)) · \(Format.count(d.count, "colis", "colis"))")
                                .font(.caption)
                                .foregroundStyle(Theme.warn)
                        }
                        Spacer()
                        Button("Payé") {
                            Haptics.warning()
                            dettePayee = d
                        }
                        .boutonVerre()
                        .disabled(model.isBusy("paye:" + d.senderName))
                    }
                    .swipeActions {
                        Button("Payé", systemImage: "eurosign.circle.fill") { dettePayee = d }
                            .tint(Theme.violet)
                    }
                }
            }
        } header: {
            HStack {
                Text("Ce qu'on nous doit")
                Spacer()
                if model.totalOwed > 0 {
                    Text(Format.euro(model.totalOwed))
                        .foregroundStyle(Theme.warn)
                        .contentTransition(.numericText(value: model.totalOwed))
                }
            }
        }
    }

    private var expediteurs: some View {
        Section("Expéditeurs") {
            NavigationLink(value: Route.prices) {
                Label {
                    HStack {
                        Text("Prix par expéditeur")
                        Spacer()
                        Text(Format.integer(model.senders.count)).foregroundStyle(Theme.text3)
                    }
                } icon: {
                    Image(systemName: "eurosign.circle.fill").foregroundStyle(Theme.violet)
                }
            }
            NavigationLink(value: Route.portails) {
                Label {
                    HStack {
                        Text("Espaces expéditeurs")
                        Spacer()
                        let actifs = model.senders.filter { $0.portail?.lien != nil }.count
                        if actifs > 0 {
                            Text(Format.count(actifs, "lien", "liens")).foregroundStyle(Theme.text3)
                        }
                    }
                } icon: {
                    Image(systemName: "link.circle.fill").foregroundStyle(Theme.teal)
                }
            }
            NavigationLink(value: Route.mergeOther) {
                Label {
                    Text("Regrouper en « Autre »")
                } icon: {
                    Image(systemName: "square.stack.3d.down.right.fill").foregroundStyle(Theme.info)
                }
            }
        }
    }

    private var fusion: some View {
        Section {
            Picker("Fusionner", selection: $source) {
                Text("Choisir…").tag(Int?.none)
                ForEach(model.senders) { s in Text(s.name).tag(Optional(s.id)) }
            }
            Picker("Dans", selection: $cible) {
                Text("Choisir…").tag(Int?.none)
                ForEach(model.senders.filter { $0.id != source }) { s in Text(s.name).tag(Optional(s.id)) }
            }
            Button("Fusionner les deux", systemImage: "arrow.triangle.merge") {
                Haptics.warning()
                confirmeFusion = true
            }
            .disabled(source == nil || cible == nil || source == cible)
        } header: {
            Text("Fusionner deux expéditeurs")
        } footer: {
            Text("La même personne qui a recréé un compte : tout passe sur le second.")
        }
    }

    private var serveur: some View {
        Section {
            TextField("https://…", text: $adresse)
                .clavier(.url)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit(appliqueAdresse)
            if adresse != app.serverURL.absoluteString {
                Button("Utiliser cette adresse", systemImage: "checkmark") { appliqueAdresse() }
            }
            if app.serverURL != AppModel.defaultServer {
                Button("Revenir au serveur Railway", systemImage: "arrow.uturn.backward") {
                    adresse = AppModel.defaultServer.absoluteString
                    appliqueAdresse()
                }
            }
        } header: {
            Text("Serveur")
        } footer: {
            Text("Drop \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") · \(app.isOnline ? "connecté" : "hors ligne")")
        }
    }

    // MARK: Outils

    private var titreFusion: String {
        "Fusionner « \(expediteur(source)?.name ?? "") » dans « \(expediteur(cible)?.name ?? "") » ?"
    }

    private func expediteur(_ id: Int?) -> Sender? {
        model.senders.first { $0.id == id }
    }

    private func appliqueAdresse() {
        let propre = adresse.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: propre), url.scheme?.hasPrefix("http") == true, let hote = url.host() else {
            app.toasts.show("Adresse invalide", style: .error)
            return
        }
        // iOS n'autorise le http en clair que sur le reseau local (ATS) : une
        // adresse publique en http ne repondrait jamais, autant le dire ici
        if url.scheme == "http", !Self.estLocale(hote) {
            app.toasts.show("En http, seulement une adresse du réseau local : utilise https", style: .error)
            return
        }
        app.serverURL = url
        adresse = url.absoluteString
        app.toasts.show("Serveur enregistré")
        Task { await model.refresh() }
    }

    /// localhost, machine.local, nom sans point, ou adresse IP privee : ce que
    /// NSAllowsLocalNetworking laisse joindre en http.
    static func estLocale(_ hote: String) -> Bool {
        let h = hote.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h.contains(":") { return h == "::1" || h.hasPrefix("fe80") }
        if h == "localhost" || h.hasSuffix(".local") || !h.contains(".") { return true }
        let octets = h.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        switch (octets[0], octets[1]) {
        case (10, _), (127, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        default: return false
        }
    }
}
