import AVFoundation
import UserNotifications

/// Le "cha-ching" des nouveaux colis, comme le son de vente Shopify : le
/// meme dans la notification (app fermee) et dans l'app (ouverte).
@MainActor
enum Sounds {
    /// le fichier, dans les ressources de l'app
    static let newParcelsFile = "cha-ching.caf"
    static var newParcelsNotification: UNNotificationSound {
        UNNotificationSound(named: UNNotificationSoundName(newParcelsFile))
    }

    private static var lecteur: AVAudioPlayer?

    /// Joue le son tout de suite. Categorie "ambiante" : il respecte le mode
    /// silencieux et se mele a la musique sans la couper.
    static func chaChing() {
        if lecteur == nil, let url = Bundle.main.url(forResource: "cha-ching", withExtension: "caf") {
            try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
            lecteur = try? AVAudioPlayer(contentsOf: url)
            lecteur?.prepareToPlay()
        }
        lecteur?.currentTime = 0
        lecteur?.play()
    }
}
