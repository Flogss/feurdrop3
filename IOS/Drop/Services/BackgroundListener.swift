import AVFoundation
import DropKit

/// L'ecoute en arriere-plan. Sans compte developpeur payant, Apple interdit a
/// l'app de recevoir des notifications de son serveur. Pour sonner quand
/// meme des qu'un colis arrive, l'app reste eveillee une fois quittee : elle
/// joue un silence en boucle (inaudible, et melange a la musique sans la
/// couper), ce qui l'autorise a continuer de tourner, et relit le serveur
/// toutes les 10 secondes. Ca coute un peu de batterie, d'ou le reglage.
///
/// L'ecoute s'arrete si l'app est fermee de force (balayee dans le
/// selecteur d'apps) ou au redemarrage du telephone : le reveil periodique
/// d'iOS prend alors le relais, en moins reactif.
@MainActor
final class BackgroundListener {
    static let shared = BackgroundListener()

    static let enabledKey = "drop.ecoute"
    static var isEnabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    private var lecteur: AVAudioPlayer?
    private var boucle: Task<Void, Never>?
    private var interruptions: NSObjectProtocol?

    /// L'app vient d'etre quittee.
    func start() {
        guard Self.isEnabled, boucle == nil else { return }
        boucle = Task { [weak self] in
            // sans notifications autorisees, ecouter ne servirait a rien
            guard await NotificationService.isAuthorized() else {
                self?.boucle = nil
                return
            }
            self?.demarreSilence()
            while !Task.isCancelled {
                await Self.verifie()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    /// L'app revient au premier plan : elle se rafraichit deja toute seule.
    func stop() {
        boucle?.cancel()
        boucle = nil
        lecteur?.stop()
        lecteur = nil
        if let interruptions { NotificationCenter.default.removeObserver(interruptions) }
        interruptions = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        // retour au son "ambiant" de l'app ouverte (respecte le mode silencieux)
        try? session.setCategory(.ambient, options: [.mixWithOthers])
    }

    private func demarreSilence() {
        guard let url = Bundle.main.url(forResource: "silence", withExtension: "caf") else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, options: [.mixWithOthers])
        try? session.setActive(true)
        lecteur = try? AVAudioPlayer(contentsOf: url)
        lecteur?.numberOfLoops = -1
        lecteur?.play()
        // un appel, une alarme, une autre app coupent le son : on reprend apres
        interruptions = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { note in
            let fin = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .ended
            guard fin else { return }
            Task { @MainActor in
                try? AVAudioSession.sharedInstance().setActive(true)
                BackgroundListener.shared.lecteur?.play()
            }
        }
    }

    static func verifie() async {
        let adresse = UserDefaults.standard.string(forKey: "drop.serveur").flatMap(URL.init(string:)) ?? AppModel.defaultServer
        guard let stats = try? await DropAPI(baseURL: adresse).stats() else { return }
        await ParcelWatch.check(stats)
    }
}
