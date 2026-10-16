#if os(iOS)
import SwiftUI
import LocalAuthentication

/// Face ID a l'ouverture -- COUPE par defaut, interrupteur dans les Reglages
/// (protection locale, EN PLUS de la session serveur de
/// 72 h, qui reste la seule autorisation) : tant que l'appareil n'a pas
/// reconnu son proprietaire, l'ecran prive est cache.
///
/// - verrouille au lancement et a chaque passage en arriere-plan ;
/// - dans le selecteur d'apps, un cache (l'apercu ne montre rien de prive) ;
/// - Face ID, puis le code de l'appareil en secours (`deviceOwnerAuthentication`,
///   l'API native : aucune donnee biometrique ne passe par l'app) ;
/// - un echec ou une annulation laisse verrouille, avec « Réessayer » ;
/// - sans Face ID ni code sur l'appareil : le mot de passe FeurDrop (on se
///   deconnecte, l'ecran de connexion le demande).
@Observable
final class VerrouFaceID {
    static let shared = VerrouFaceID()

    /// le contenu prive est cache
    private(set) var verrouille = true
    /// une demande est en cours (pas de double demande)
    private(set) var enCours = false
    private(set) var message: String?
    /// l'app est passee en arriere-plan (ou dans le selecteur) : cache immediat
    private(set) var masque = false

    /// `-DropSansFaceID 1` (developpement, simulateur sans visage enrole)
    var actif: Bool {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "DropSansFaceID") { return false }
        #endif
        return UserDefaults.standard.object(forKey: Self.cle) as? Bool ?? false
    }
    /// coupe par defaut (a la demande) : a rallumer dans les Reglages. Nouvelle
    /// cle, pour qu'un ancien choix enregistre ne le rallume pas.
    static let cle = "drop.faceid.actif"

    /// la methode disponible, dite a l'ecran
    var nomMethode: String {
        let c = LAContext()
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch c.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "le code de l'iPhone"
        }
    }

    func deverrouilleApresConnexion() {
        verrouille = false
        message = nil
    }

    func phase(_ p: ScenePhase) {
        switch p {
        case .background:
            if actif { verrouille = true }
            masque = true
        case .inactive:
            masque = true
        case .active:
            masque = false
            if actif && verrouille { Task { await deverrouille() } }
            if !actif { verrouille = false }
        @unknown default:
            break
        }
    }

    /// Face ID (ou le code de l'appareil). Ne rend jamais la main sans
    /// resultat : reussite, echec, annulation ou indisponibilite.
    @MainActor
    func deverrouille() async {
        guard actif else { verrouille = false; return }
        guard !enCours else { return }
        enCours = true
        defer { enCours = false }
        let contexte = LAContext()
        contexte.localizedCancelTitle = "Annuler"
        var erreur: NSError?
        guard contexte.canEvaluatePolicy(.deviceOwnerAuthentication, error: &erreur) else {
            // ni Face ID ni code sur l'appareil : le mot de passe FeurDrop
            message = "Face ID et le code de l'iPhone ne sont pas disponibles : entre le mot de passe FeurDrop."
            await AppModel.shared.seDeconnecte()
            verrouille = false
            return
        }
        do {
            let ok = try await contexte.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Déverrouiller Drop")
            if ok {
                withAnimation(Theme.spring) { verrouille = false }
                message = nil
            }
        } catch let e as LAError {
            switch e.code {
            case .userCancel, .systemCancel, .appCancel: message = "Déverrouillage annulé."
            case .authenticationFailed: message = "Visage non reconnu."
            case .biometryLockout: message = "Face ID est bloqué : utilise le code de l'iPhone."
            default: message = e.localizedDescription
            }
        } catch {
            message = error.localizedDescription
        }
    }
}

/// L'ecran verrouille (ou le cache du selecteur d'apps) : le fond, le logo,
/// et le bouton pour reessayer -- jamais un chargement sans fin.
struct EcranVerrouille: View {
    let verrou: VerrouFaceID
    let appli: AppModel

    var body: some View {
        ZStack {
            AmbientBackground()
            VStack(spacing: 18) {
                Image(systemName: "faceid")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(Theme.violetLight)
                Text("Drop est verrouillé").font(.title3.weight(.semibold))
                if let m = verrou.message, !verrou.masque {
                    Text(m).font(.subheadline).foregroundStyle(Theme.text2).multilineTextAlignment(.center)
                }
                if !verrou.masque {
                    Button {
                        Task { await verrou.deverrouille() }
                    } label: {
                        HStack {
                            if verrou.enCours { ProgressView().controlSize(.small) }
                            Text("Déverrouiller avec \(verrou.nomMethode)")
                        }
                        .font(.headline)
                        .padding(.horizontal, 22)
                        .frame(height: 50)
                    }
                    .boutonVerreFort(Theme.violetDeep)
                    .disabled(verrou.enCours)
                    Button("Utiliser le mot de passe FeurDrop") {
                        Task { await appli.seDeconnecte() }
                    }
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                }
            }
            .padding(32)
        }
        .ignoresSafeArea()
    }
}
#endif
