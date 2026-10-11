import Foundation
import Security

/// Le jeton de session de l'app, dans le trousseau (Keychain) -- jamais dans
/// UserDefaults ni dans un fichier. Un jeton par serveur. Lisible apres le
/// premier deverrouillage de l'appareil (les verifications en arriere-plan en
/// ont besoin), et jamais copie ailleurs (ni iCloud, ni sauvegarde).
///
/// Le jeton expire 72 h apres la connexion, cote serveur : le garder plus
/// longtemps ici ne sert a rien, le serveur le refusera (401) et l'app
/// redemandera le mot de passe.
public enum Trousseau {
    static let service = "com.flogas.drop.session"

    public static func jeton(pour serveur: URL) -> String? {
        var requete = base(serveur)
        requete[kSecReturnData as String] = true
        requete[kSecMatchLimit as String] = kSecMatchLimitOne
        var resultat: CFTypeRef?
        var statut = SecItemCopyMatching(requete as CFDictionary, &resultat)
        #if os(macOS)
        if statut == errSecMissingEntitlement {
            requete.removeValue(forKey: kSecUseDataProtectionKeychain as String)
            statut = SecItemCopyMatching(requete as CFDictionary, &resultat)
        }
        #endif
        guard statut == errSecSuccess, let donnees = resultat as? Data else { return nil }
        return String(data: donnees, encoding: .utf8)
    }

    public static func garde(_ jeton: String, pour serveur: URL) {
        efface(pour: serveur)
        var requete = base(serveur)
        requete[kSecValueData as String] = Data(jeton.utf8)
        requete[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var statut = SecItemAdd(requete as CFDictionary, nil)
        #if os(macOS)
        if statut == errSecMissingEntitlement {
            requete.removeValue(forKey: kSecUseDataProtectionKeychain as String)
            statut = SecItemAdd(requete as CFDictionary, nil)
        }
        #endif
        _ = statut
    }

    public static func efface(pour serveur: URL) {
        let requete = base(serveur)
        SecItemDelete(requete as CFDictionary)
        #if os(macOS)
        var ancien = requete
        ancien.removeValue(forKey: kSecUseDataProtectionKeychain as String)
        SecItemDelete(ancien as CFDictionary)
        #endif
    }

    /// "feurdrop3-production.up.railway.app:443" : un jeton par serveur
    private static func compte(_ serveur: URL) -> String {
        let hote = serveur.host(percentEncoded: false) ?? serveur.absoluteString
        let port = serveur.port ?? (serveur.scheme == "http" ? 80 : 443)
        return "\(hote):\(port)"
    }

    private static func base(_ serveur: URL) -> [String: Any] {
        var requete: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: compte(serveur),
        ]
        #if os(macOS)
        // le trousseau moderne du Mac (celui de l'iPhone), sans fenetre d'autorisation
        requete[kSecUseDataProtectionKeychain as String] = true
        #endif
        return requete
    }
}
