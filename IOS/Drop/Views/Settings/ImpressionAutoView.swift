import SwiftUI
import DropKit

/// L'impression automatique pilotee depuis le telephone : l'interrupteur, ce
/// qui s'imprime (categories, transporteurs, expediteurs), l'etat de l'agent
/// du Mac et ses dernieres taches. Le telephone n'imprime rien lui-meme : il
/// ecrit des reglages sur le serveur, l'agent les execute, et une tache n'est
/// montree « imprimée » qu'apres SA confirmation.
struct ImpressionAutoView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmeAuto = false

    private var model: SettingsModel { app.settings }

    var body: some View {
        Form {
            if let etat = model.impression {
                interrupteur(etat)
                agent(etat)
                filtres(etat)
                taches(etat)
            } else if let erreur = model.impressionErreur {
                ChargementImpossible(titre: "Impression auto indisponible", message: erreur) {
                    Task { await model.chargeImpression() }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .scrollContentBackground(.hidden)
        .interrupteursDrop()
        .navigationTitle("Impression auto")
        // relu toutes les 5 s tant que l'ecran est ouvert
        .task {
            while !Task.isCancelled {
                await model.chargeImpression()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .refreshable { await model.chargeImpression() }
        .confirmationDialog("Activer l'impression auto ?", isPresented: $confirmeAuto, titleVisibility: .visible) {
            Button("Activer") { Task { await model.setAutoPrint(true) } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Les étiquettes déjà en attente restent à imprimer à la main : seules les prochaines partent toutes seules.")
        }
    }

    private func interrupteur(_ etat: ImpressionAuto) -> some View {
        Section {
            Toggle(isOn: Binding(
                get: { etat.enabled },
                set: { actif in
                    if actif { confirmeAuto = true } else { Task { await model.setAutoPrint(false) } }
                }
            )) {
                Text("Impression automatique")
            }
            .tint(Theme.violet)
            .disabled(model.isBusy("auto"))
        } footer: {
            Text(etat.enabled
                 ? "\(Format.count(etat.pending, "étiquette", "étiquettes")) en attente pour l'agent · les LIT restent à la main"
                 : "Le Mac imprime chaque nouvelle étiquette dès qu'elle arrive.")
        }
    }

    private func agent(_ etat: ImpressionAuto) -> some View {
        Section("Mac d'impression") {
            HStack(spacing: 10) {
                Circle()
                    .fill(etat.agent.enLigne ? Color.green : Theme.text3)
                    .frame(width: 9, height: 9)
                VStack(alignment: .leading, spacing: 2) {
                    Text(etat.agent.enLigne ? "Agent connecté" : "Agent hors ligne")
                    Text(detailAgent(etat))
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                }
            }
            if etat.enCours > 0 {
                Label("\(Format.count(etat.enCours, "étiquette envoyée", "étiquettes envoyées")) · en attente de confirmation du Mac",
                      systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
            }
            if etat.enabled && !etat.agent.enLigne && etat.pending > 0 {
                Label("\(Format.count(etat.pending, "étiquette attend", "étiquettes attendent")) que le Mac revienne",
                      systemImage: "hourglass")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
            }
        }
    }

    private func detailAgent(_ etat: ImpressionAuto) -> String {
        var morceaux: [String] = []
        if let imprimante = etat.agent.imprimante { morceaux.append(imprimante) }
        if let vu = etat.agent.vu.flatMap(Self.date) {
            morceaux.append("vu \(vu.formatted(.relative(presentation: .named)))")
        } else {
            morceaux.append("aucun contact depuis le dernier démarrage du serveur")
        }
        return morceaux.joined(separator: " · ")
    }

    private func filtres(_ etat: ImpressionAuto) -> some View {
        Section {
            ForEach(etat.options.categories) { c in
                coche(c.nom, actif: etat.filtres.categories.contains(c.code)) {
                    var f = etat.filtres
                    f.categories = bascule(f.categories, c.code)
                    return f
                }
            }
            DisclosureGroup("Transporteurs · \(resume(etat.filtres.transporteurs.count))") {
                ForEach(etat.options.transporteurs) { t in
                    coche(t.nom, actif: etat.filtres.transporteurs.contains(t.code)) {
                        var f = etat.filtres
                        f.transporteurs = bascule(f.transporteurs, t.code)
                        return f
                    }
                }
            }
            DisclosureGroup("Expéditeurs · \(resume(etat.filtres.expediteurs.count))") {
                ForEach(etat.options.expediteurs, id: \.self) { nom in
                    coche(nom, actif: etat.filtres.expediteurs.contains(nom)) {
                        var f = etat.filtres
                        f.expediteurs = bascule(f.expediteurs, nom)
                        return f
                    }
                }
            }
            if etat.filtres != .init() {
                Button("Tout imprimer (retirer les filtres)") {
                    Task { await model.regleFiltres(.init()) }
                }
            }
        } header: {
            Text("Ce qui s'imprime")
        } footer: {
            Text("Rien de coché dans un groupe : tout ce groupe s'imprime. Les choix sont gardés par le serveur et appliqués par le Mac à son prochain passage.")
        }
        .disabled(model.isBusy("filtres"))
    }

    private func coche(_ titre: String, actif: Bool, _ nouveau: @escaping () -> ImpressionAuto.Filtres) -> some View {
        Button {
            Task { await model.regleFiltres(nouveau()) }
        } label: {
            HStack {
                Text(titre).foregroundStyle(Theme.text)
                Spacer()
                Image(systemName: actif ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(actif ? Theme.violetLight : Theme.text3)
                    .contentTransition(.symbolEffect(.replace))
            }
        }
    }

    private func bascule(_ liste: [String], _ valeur: String) -> [String] {
        liste.contains(valeur) ? liste.filter { $0 != valeur } : liste + [valeur]
    }

    private func resume(_ n: Int) -> String { n == 0 ? "tous" : "\(n) choisi\(n > 1 ? "s" : "")" }

    private func taches(_ etat: ImpressionAuto) -> some View {
        Section("Dernières tâches") {
            if etat.taches.isEmpty {
                Text("Aucune tâche pour l'instant").foregroundStyle(Theme.text3)
            }
            ForEach(etat.taches) { t in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: Self.symbole(t.etat))
                        .foregroundStyle(Self.couleur(t.etat))
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(Format.count(t.etiquettes, "étiquette", "étiquettes")) · \(Self.libelle(t.etat))")
                        if let erreur = t.erreur {
                            Text(erreur).font(.caption).foregroundStyle(Theme.text2)
                        }
                        if let d = Self.date(t.finie ?? t.creee) {
                            Text(d.formatted(.relative(presentation: .named)))
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                    }
                }
            }
        }
    }

    private static func libelle(_ etat: String) -> String {
        switch etat {
        case "imprimee": "imprimée (confirmée par le Mac)"
        case "envoyee": "envoyée, en attente de confirmation"
        case "echec": "échec, remise dans la file"
        case "expiree": "sans réponse du Mac, remise dans la file"
        default: etat
        }
    }

    private static func symbole(_ etat: String) -> String {
        switch etat {
        case "imprimee": "checkmark.circle.fill"
        case "envoyee": "clock"
        default: "exclamationmark.triangle.fill"
        }
    }

    private static func couleur(_ etat: String) -> Color {
        switch etat {
        case "imprimee": Theme.violetLight
        case "envoyee": Theme.text2
        default: .orange
        }
    }

    private static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
