#if canImport(UIKit)
import UIKit

/// Le retour tactile, la ou il aide : un onglet choisi, une action terminee,
/// une suppression confirmee, une erreur. Pas de vibration a chaque appui.
@MainActor
enum Haptics {
    private static let selectionGenerator = UISelectionFeedbackGenerator()
    private static let notificationGenerator = UINotificationFeedbackGenerator()
    private static let lightGenerator = UIImpactFeedbackGenerator(style: .light)
    private static let softGenerator = UIImpactFeedbackGenerator(style: .soft)
    private static let rigidGenerator = UIImpactFeedbackGenerator(style: .rigid)

    /// un choix parmi plusieurs (onglet, selection)
    static func selection() { selectionGenerator.selectionChanged() }

    /// une action est allee au bout
    static func success() { notificationGenerator.notificationOccurred(.success) }

    /// une action a echoue
    static func error() { notificationGenerator.notificationOccurred(.error) }

    /// une action irreversible va partir (confirmation)
    static func warning() { notificationGenerator.notificationOccurred(.warning) }

    /// un petit pas : +1, -1, une case cochee
    static func tick() { lightGenerator.impactOccurred(intensity: 0.7) }

    /// un element qui se pose (feuille, carte)
    static func soft() { softGenerator.impactOccurred() }

    /// un chiffre qui monte : un leger coup sec a chaque palier
    static func rigid(_ intensite: CGFloat = 0.5) { rigidGenerator.impactOccurred(intensity: intensite) }
}

#else
import AppKit

/// Sur Mac : le retour haptique du trackpad (Force Touch), aux memes moments.
@MainActor
enum Haptics {
    private static func joue(_ motif: NSHapticFeedbackManager.FeedbackPattern) {
        NSHapticFeedbackManager.defaultPerformer.perform(motif, performanceTime: .now)
    }
    static func selection() { joue(.alignment) }
    static func success() { joue(.levelChange) }
    static func error() { joue(.generic) }
    static func warning() { joue(.generic) }
    static func tick() { joue(.alignment) }
    static func soft() { joue(.alignment) }
    static func rigid(_ intensite: CGFloat = 0.5) { joue(.levelChange) }
}
#endif
