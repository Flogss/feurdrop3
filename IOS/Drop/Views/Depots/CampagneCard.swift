import SwiftUI
import DropKit

/// « Tout vérifier », comme sur le site : le bouton, puis la progression en
/// direct -- combien de colis, verifies, restants, postes confirmes, non
/// confirmes, bloques, erreurs, a constater -- transporteur par transporteur,
/// et ce que fait le Mac. Sur le Mac, c'est cette app qui lit les pages
/// officielles (une fenetre « Vérification des dépôts » montre la page lue).
struct CampagneCard: View {
    @Environment(AppModel.self) private var app

    private var model: DepotsModel { app.depots }

    var body: some View {
        let etat = model.campagne
        let c = etat?.campagne
        let visible = c != nil && (etat?.active == true || model.campagneMasquee != c?.id) && recente(etat)
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(titre(etat, visible: visible))
                        .font(.headline)
                    Text(sousTitre(etat, visible: visible))
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if etat?.active == true {
                    Button("Annuler") { Task { await model.annuleCampagne() } }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.text2)
                } else {
                    if visible, let id = c?.id {
                        Button {
                            withAnimation(Theme.spring) { model.campagneMasquee = id }
                        } label: {
                            Image(systemName: "xmark").font(.caption.weight(.bold)).frame(width: 28, height: 28)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.text3)
                        .accessibilityLabel("Masquer")
                    }
                    Button {
                        Task { await model.toutVerifier() }
                    } label: {
                        HStack(spacing: 6) {
                            if model.lancement { ProgressView().controlSize(.small).tint(.white) } else { Image(systemName: "checkmark.seal.fill") }
                            Text("Tout vérifier")
                        }
                        .font(.subheadline.weight(.bold))
                        .padding(.horizontal, 8)
                        .frame(height: 40)
                    }
                    .boutonVerreFort(Theme.violetDeep)
                    .disabled(model.lancement)
                }
            }

            if visible, let etat, let n = etat.compteurs {
                progression(etat, n)
            }
        }
        .surfaceCard()
        .overlay {
            // pendant la campagne : une lueur violette passe lentement
            if etat?.active == true { LueurCampagne().allowsHitTesting(false) }
        }
        .animation(Theme.spring, value: etat)
    }

    private func recente(_ etat: DepotCampagneEtat?) -> Bool {
        guard let c = etat?.campagne else { return false }
        if c.statut == "active" { return true }
        guard let fin = ServerDate.parse(c.finLe ?? c.creeLe) else { return false }
        return Date.now.timeIntervalSince(fin) < 6 * 3600
    }

    private func titre(_ etat: DepotCampagneEtat?, visible: Bool) -> String {
        guard visible, let c = etat?.campagne else { return "Vérifier tous les dépôts" }
        switch c.statut {
        case "active": return "Vérification en cours…"
        case "annulee": return "Vérification annulée"
        default: return "Vérification terminée"
        }
    }

    private func sousTitre(_ etat: DepotCampagneEtat?, visible: Bool) -> String {
        guard visible, let etat, let c = etat.campagne else {
            return "La Poste, Colissimo, Chronopost et DPD par l'API officielle ; Mondial Relay, GLS (et DHL sans clé d'API) lus sur le Mac ; UPS par son API si elle est posée, sinon à la main."
        }
        if c.statut == "active" {
            #if os(macOS)
            if app.verificateur.enCours {
                if case .lecture(let nom, let numero) = app.verificateur.etat { return "Ce Mac lit la page officielle \(nom) du colis \(numero)…" }
                return "Ce Mac lit les pages officielles (une à la fois, au rythme d'une personne)."
            }
            #endif
            if etat.attendMac == true {
                return etat.agent?.actif == true ? "L'app Drop du Mac lit les pages officielles (\(etat.agent?.nom ?? "Mac"))…" : "En attente de l'app Drop sur le Mac : les pages officielles (Mondial Relay, GLS…) seront lues dès qu'elle sera ouverte."
            }
            return "Les API officielles vérifient leurs colis…"
        }
        let n = etat.compteurs
        return "\(c.statut == "annulee" ? "Arrêtée" : "Finie") \(ilYa(c.finLe)) · \(Format.count(n?.verifies ?? 0, "colis vérifié", "colis vérifiés"))"
    }

    @ViewBuilder
    private func progression(_ etat: DepotCampagneEtat, _ n: DepotCampagneCompteurs) -> some View {
        BarreCampagne(avancee: n.avancee, active: etat.active)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], spacing: 8) {
            chiffre(n.total, "colis", nil)
            chiffre(n.verifies, "vérifiés", nil)
            chiffre(n.restants, "restants", nil)
            chiffre(n.confirmes, "postés confirmés", DepotCategorie.confirme.couleur)
            chiffre(n.nonConfirmes, "non confirmés", DepotCategorie.nonConfirme.couleur)
            chiffre(n.bloques, "bloqués", DepotCategorie.bloque.couleur)
            chiffre(n.erreurs, "erreurs techniques", DepotCategorie.aVerifier.couleur)
            chiffre(n.aConstater, "à constater (UPS)", DepotCategorie.bloque.couleur)
        }
        if let lignes = etat.parTransporteur, !lignes.isEmpty {
            VStack(spacing: 6) {
                ForEach(lignes) { t in ligne(t, active: etat.active) }
            }
        }
    }

    private func chiffre(_ valeur: Int, _ libelle: String, _ couleur: Color?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Format.integer(valeur))
                .font(.system(size: 20, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(couleur ?? Theme.text)
                .contentTransition(.numericText(value: Double(valeur)))
            Text(libelle).font(.caption).foregroundStyle(Theme.text2).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background((couleur ?? .white).opacity(0.06), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder((couleur ?? .white).opacity(0.12), lineWidth: 0.8))
        .opacity(valeur == 0 && couleur != nil ? 0.5 : 1)
    }

    private func ligne(_ t: DepotCampagneTransporteur, active: Bool) -> some View {
        let methode = t.methode == "navigateur" ? "Mac" : t.methode == "laposte" ? "API" : "à la main"
        let detail: String = t.restants > 0
            ? "\(t.faits) / \(t.total)"
            : [t.faits > 0 ? "\(t.faits) vérifié\(t.faits > 1 ? "s" : "")" : nil,
               t.bloques > 0 ? "\(t.bloques) bloqué\(t.bloques > 1 ? "s" : "")" : nil,
               t.erreurs > 0 ? "\(t.erreurs) erreur\(t.erreurs > 1 ? "s" : "")" : nil,
               t.aConstater > 0 ? "\(t.aConstater) à constater" : nil].compactMap(\.self).joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                CarrierDot(color: .carrier(t.code), size: 7)
                Text(t.nom).font(.footnote.weight(.semibold))
                Spacer(minLength: 8)
                Text(methode).font(.caption).foregroundStyle(Theme.text3)
                if t.restants > 0 && active {
                    Circle().fill(Theme.violetLight).frame(width: 6, height: 6).symbolEffect(.pulse)
                }
                Text(detail.isEmpty ? "—" : detail).font(.footnote.monospacedDigit()).foregroundStyle(Theme.text2)
            }
            if let message = t.message {
                Text(message).font(.caption).foregroundStyle(Theme.violetLight).lineLimit(2)
            }
            GeometryReader { geo in
                Capsule().fill(Theme.accentGradient)
                    .frame(width: geo.size.width * (t.total > 0 ? Double(t.total - t.restants) / Double(t.total) : 1))
                    .animation(.easeOut(duration: 0.6), value: t.restants)
            }
            .frame(height: 2)
            .opacity(0.8)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.white.opacity(0.03), in: .rect(cornerRadius: 10))
        .overlay(alignment: .leading) {
            if t.bloques > 0 { Capsule().fill(Theme.violetLight).frame(width: 2).padding(.vertical, 4) }
        }
    }
}

/// la barre d'avancement : elle avance en douceur, un reflet la parcourt
/// tant que la campagne tourne
private struct BarreCampagne: View {
    let avancee: Double
    let active: Bool

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.06))
                Capsule()
                    .fill(Theme.accentGradient)
                    .frame(width: max(geo.size.width * avancee, 8))
                    .shadow(color: Theme.violet.opacity(0.8), radius: 7)
                    .overlay {
                        if active {
                            TimelineView(.animation) { contexte in
                                let p = contexte.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                                LinearGradient(colors: [.clear, .white.opacity(0.45), .clear], startPoint: .leading, endPoint: .trailing)
                                    .frame(width: 60)
                                    .offset(x: -60 + (geo.size.width * avancee + 60) * p)
                            }
                            .clipShape(.capsule)
                        }
                    }
                    .animation(.easeOut(duration: 0.7), value: avancee)
            }
        }
        .frame(height: 8)
    }
}

/// une lueur violette qui passe lentement sur la carte pendant la campagne
private struct LueurCampagne: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { contexte in
            let p = contexte.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.8) / 2.8
            GeometryReader { geo in
                LinearGradient(colors: [.clear, Theme.violet.opacity(0.1), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: geo.size.width * 0.5)
                    .offset(x: -geo.size.width * 0.5 + geo.size.width * 1.5 * p)
            }
        }
        .clipShape(.rect(cornerRadius: Theme.Radius.card))
    }
}
