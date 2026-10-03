import Foundation
import BackgroundTasks
import DropKit

/// Le reveil periodique d'iOS : de temps en temps (au mieux toutes les 15
/// minutes, selon l'usage et la batterie), iOS reveille l'app quelques
/// secondes. Elle relit le serveur et annonce ce qui est nouveau. C'est le
/// filet de securite quand l'ecoute en arriere-plan ne tourne pas (app
/// fermee de force, telephone redemarre).
enum BackgroundRefresh {
    static let identifier = "com.flogas.drop.refresh"

    static func schedule() {
        let demande = BGAppRefreshTaskRequest(identifier: identifier)
        demande.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(demande)
    }

    /// Appele par la scene (`.backgroundTask(.appRefresh)`).
    static func run() async {
        // le prochain reveil est demande d'abord : meme si celui-ci echoue
        schedule()
        await BackgroundListener.verifie()
    }
}
