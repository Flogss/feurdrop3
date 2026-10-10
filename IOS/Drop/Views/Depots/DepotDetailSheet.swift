import SwiftUI
import DropKit

/// La chronologie d'un colis : le verdict et sa raison, FeurDrop a cote du
/// transporteur, les constats a la main (UPS, DHL... ou un colis que l'API
/// ne permet pas de trancher), et le suivi officiel.
struct DepotDetailSheet: View {
    let ouvert: DepotOuvert
    /// apres un constat dans une serie (ou « Passer ») : le colis suivant
    let suivant: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var detail: DepotDetail?
    @State private var constatEnCours: DepotConstatChoix?

    private var model: DepotsModel { app.depots }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(detail?.numero ?? "Colis")
                    .font(.title3.weight(.bold).monospaced())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let serie = ouvert.serie {
                    Text("\(ouvert.position + 1) / \(serie.count)")
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
            }
            .padding(.bottom, 14)

            ScrollView {
                if let d = detail {
                    contenu(d)
                } else {
                    VStack(spacing: 10) {
                        SkeletonRow(height: 80)
                        SkeletonRow(height: 120)
                        SkeletonRow(height: 160)
                    }
                }
            }
            .sansIndicateurs()
            .scrollBounceBehavior(.basedOnSize)

            actions
                .padding(.top, 14)
        }
        .padding(22)
        .task(id: ouvert.colisID) {
            detail = nil
            detail = await model.detail(ouvert.colisID)
        }
    }

    // MARK: Contenu

    @ViewBuilder
    private func contenu(_ d: DepotDetail) -> some View {
        let c = d.controle
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                DepotBadge(controle: c, long: true)
                Text(c.raison)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    info("FeurDrop", "Dropé le \(ServerDate.shortDayTime(d.statutInterne.dropeLe))")
                    info("Transporteur", d.transporteur.nom, point: d.transporteur.code)
                }
                GridRow {
                    info("Expéditeur", d.expediteur)
                    info("Vérification", d.manuel ? "À la main (page officielle)" : "API La Poste (officielle)")
                }
                GridRow {
                    info("Statut transporteur", c.statutTransporteur(manuel: d.manuel, verifie: d.verifieLe != nil))
                    info("Vérifié", verifie(d))
                }
            }
            if let erreur = d.erreur {
                info("Dernière erreur", erreur.message ?? erreur.code, couleur: Theme.danger)
            }

            if constatPossible(d) { constats(d) }

            VStack(alignment: .leading, spacing: 10) {
                Text("Chronologie").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text2)
                if d.evenements.isEmpty {
                    EmptyStateView(symbol: "clock", title: "Aucun événement pour l'instant",
                                   subtitle: d.manuel ? "Rien n'est lu automatiquement chez ce transporteur." : "La Poste n'a encore rien remonté pour ce numéro.")
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(d.evenements.enumerated()), id: \.element.id) { i, e in
                            evenement(e, preuve: c.preuve, premier: i == 0, dernier: i == d.evenements.count - 1)
                        }
                    }
                }
            }
        }
        .animation(Theme.spring, value: detail)
    }

    private func info(_ titre: String, _ valeur: String, point: String? = nil, couleur: Color = Theme.text) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(titre.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(Theme.text3)
            HStack(spacing: 5) {
                if let point { CarrierDot(color: .carrier(point), size: 7) }
                Text(valeur).font(.subheadline).foregroundStyle(couleur)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func verifie(_ d: DepotDetail) -> String {
        if d.manuel { return d.controle.constat.map { "constaté \(ilYa($0.le))" } ?? "jamais (à la main)" }
        var texte = ilYa(d.verifieLe ?? d.essaiLe)
        if let prochaine = d.prochaineLe { texte += " · prochaine \(ServerDate.shortDayTime(prochaine))" }
        return texte
    }

    // MARK: Constats

    private func constatPossible(_ d: DepotDetail) -> Bool {
        d.manuel || [.bloque, .aVerifier].contains(d.controle.cat) || d.controle.constat != nil
    }

    private func constats(_ d: DepotDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Constat sur la page officielle").font(.subheadline.weight(.semibold))
            Text(d.manuel
                 ? "Ouvre le suivi officiel, puis note ce que tu y vois :"
                 : "L'API La Poste ne permet pas de trancher pour ce colis : ouvre le suivi officiel, puis note ce que tu y vois :")
                .font(.footnote)
                .foregroundStyle(Theme.text2)
            HStack(spacing: 8) {
                bouton(.pris, "Pris en charge", "checkmark", .confirme)
                bouton(.pasEncore, "Pas encore", "clock", .nonConfirme)
                bouton(.probleme, "Problème", "exclamationmark.triangle.fill", .anomalie)
            }
            if let constat = d.controle.constat {
                Button("Effacer le constat (\(ilYa(constat.le)))") { Task { await constate(.annule) } }
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .buttonStyle(.plain)
                    .underline()
            }
        }
        .padding(14)
        .background(Theme.violetLight.opacity(0.06), in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.violetLight.opacity(0.22), lineWidth: 0.8))
    }

    private func bouton(_ choix: DepotConstatChoix, _ titre: String, _ symbole: String, _ cat: DepotCategorie) -> some View {
        Button {
            Task { await constate(choix) }
        } label: {
            Group {
                if constatEnCours == choix { ProgressView().controlSize(.small) } else { Label(titre, systemImage: symbole) }
            }
            .font(.footnote.weight(.bold))
            .foregroundStyle(cat.couleur)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity)
            .frame(height: 38)
            .background(cat.couleur.opacity(0.12), in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(cat.couleur.opacity(0.32), lineWidth: 0.8))
        }
        .buttonStyle(PressScaleStyle(scale: 0.95))
        .disabled(constatEnCours != nil)
    }

    private func constate(_ choix: DepotConstatChoix) async {
        constatEnCours = choix
        defer { constatEnCours = nil }
        guard let maj = await model.constate(ouvert.colisID, choix) else { return }
        if ouvert.serie != nil, choix != .annule {
            suivant()
        } else {
            withAnimation(Theme.spring) { detail = maj }
        }
    }

    // MARK: Chronologie

    private func evenement(_ e: DepotEvenement, preuve: DepotEvenementResume?, premier: Bool, dernier: Bool) -> some View {
        let estPreuve = preuve != nil && e.survenuLe == preuve?.le && e.code == preuve?.code
        let manuel = e.source == "manuel"
        let incident = e.incident != nil || e.etape == "exception"
        let couleur: Color = incident ? Theme.danger : estPreuve ? Theme.teal : manuel ? Theme.violetLight : premier ? Theme.violetBright : Theme.text3
        return HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Circle()
                    .fill(couleur)
                    .frame(width: 11, height: 11)
                    .shadow(color: couleur.opacity(premier || estPreuve || incident ? 0.8 : 0), radius: 5)
                    .padding(.top, 4)
                if !dernier {
                    Rectangle().fill(Theme.hairline).frame(width: 1.5).frame(maxHeight: .infinity)
                }
            }
            .frame(width: 12)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(e.libelle ?? e.code ?? "—")
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if estPreuve {
                        Text("preuve de dépôt")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Theme.teal)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Theme.teal.opacity(0.14), in: .capsule)
                    }
                }
                Text(ServerDate.shortDayTime(e.survenuLe) + (e.lieu.map { " · \($0)" } ?? ""))
                    .font(.caption)
                    .foregroundStyle(Theme.text2)
                Text(manuel ? "constat sur la page officielle" : "La Poste · \(e.code ?? "?")\(e.etape == "unknown" ? " (code non reconnu)" : "")")
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.text3)
            }
            .padding(.bottom, 14)
        }
    }

    // MARK: Boutons du bas

    private var actions: some View {
        HStack(spacing: 10) {
            if let lien = detail?.liens?.transporteur ?? detail?.liens?.page, let url = URL(string: lien) {
                Link(destination: url) {
                    Label("Suivi officiel", systemImage: "arrow.up.right.square")
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .boutonVerre()
            }
            if let d = detail, !d.manuel {
                let lp = model.laPoste
                Button {
                    Task {
                        if let maj = await model.verifie(d.colisId) { withAnimation(Theme.spring) { detail = maj } }
                    }
                } label: {
                    Group {
                        if model.enVerification.contains(d.colisId) {
                            ProgressView().tint(.white)
                        } else {
                            Label("Vérifier maintenant", systemImage: "arrow.clockwise")
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                }
                .boutonVerreFort(Theme.violetDeep)
                .disabled(lp?.configure != true || lp?.pause != nil || model.enVerification.contains(d.colisId))
            }
            if ouvert.serie != nil {
                Button(action: suivant) {
                    Label("Passer", systemImage: "arrow.right")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .boutonVerre()
            }
        }
    }
}
