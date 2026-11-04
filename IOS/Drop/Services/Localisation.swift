import CoreLocation

/// La position de l'appareil, une fois, pour le depart d'un itineraire.
/// CoreLocation demande l'autorisation « pendant l'utilisation » la premiere
/// fois (sur Mac aussi) ; un refus se dit clairement, sans bloquer : on peut
/// toujours choisir une adresse.
enum Localisation {
    enum Erreur: LocalizedError, Equatable {
        case refusee
        case desactivee
        case restreinte
        case introuvable

        var errorDescription: String? {
            switch self {
            case .refusee:
                #if os(macOS)
                "Localisation refusée : autorise Drop dans Réglages Système › Confidentialité › Service de localisation, ou choisis une adresse."
                #else
                "Localisation refusée : autorise Drop dans Réglages › Confidentialité › Service de localisation, ou choisis une adresse."
                #endif
            case .desactivee: "Le service de localisation est coupé sur cet appareil : choisis une adresse."
            case .restreinte: "La localisation n'est pas permise sur cet appareil : choisis une adresse."
            case .introuvable: "Position introuvable pour l'instant : réessaie, ou choisis une adresse."
            }
        }
    }

    /// La position actuelle : la premiere a 100 m pres, ou la meilleure obtenue
    /// en 12 secondes.
    static func positionActuelle() async throws -> CLLocation {
        #if os(iOS)
        // garde l'autorisation demandee le temps de la lecture
        let session = CLServiceSession(authorization: .whenInUse)
        defer { session.invalidate() }
        #else
        // sur Mac : la demande d'autorisation passe par un gestionnaire, garde
        // en vie le temps de la lecture
        let gestionnaire = CLLocationManager()
        if gestionnaire.authorizationStatus == .notDetermined { gestionnaire.requestWhenInUseAuthorization() }
        defer { withExtendedLifetime(gestionnaire) {} }
        if !CLLocationManager.locationServicesEnabled() { throw Erreur.desactivee }
        #endif
        return try await withThrowingTaskGroup(of: CLLocation?.self) { groupe in
            groupe.addTask {
                var meilleure: CLLocation?
                let debut = Date.now
                for try await maj in CLLocationUpdate.liveUpdates() {
                    if maj.authorizationDenied { throw Erreur.refusee }
                    if maj.authorizationDeniedGlobally { throw Erreur.desactivee }
                    if maj.authorizationRestricted { throw Erreur.restreinte }
                    if let l = maj.location, l.horizontalAccuracy >= 0 {
                        if meilleure == nil || l.horizontalAccuracy < meilleure!.horizontalAccuracy { meilleure = l }
                        if l.horizontalAccuracy <= 100 || Date.now.timeIntervalSince(debut) > 6 { return meilleure }
                    }
                }
                return meilleure
            }
            groupe.addTask {
                try await Task.sleep(for: .seconds(12))
                return nil
            }
            defer { groupe.cancelAll() }
            // la premiere tache qui repond : une position, ou le delai
            while let resultat = try await groupe.next() {
                if let position = resultat { return position }
                break
            }
            throw Erreur.introuvable
        }
    }
}
