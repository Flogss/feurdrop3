import SwiftUI
#if os(iOS)
import CoreMotion
#endif

/// Le fond vivant, derriere tout : une nappe de degrades violets qui ondule
/// lentement (MeshGradient), des particules tres discretes qui montent en
/// scintillant, et une parallaxe legere qui suit l'inclinaison du telephone.
/// C'est lui que le verre des barres et des cartes refracte.
struct AmbientBackground: View {
    private let motion = MotionParallax.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { contexte in
            let t = contexte.date.timeIntervalSinceReferenceDate
            ZStack {
                Theme.background
                nappe(t)
                    .offset(x: motion.x * 18, y: motion.y * 18)
                    .scaleEffect(1.12)
                particules(t)
                    .offset(x: motion.x * 8, y: motion.y * 8)
            }
        }
        .ignoresSafeArea()
        .onAppear { motion.start() }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// 3 x 3 points de couleur dont ceux du milieu derivent doucement.
    private func nappe(_ t: Double) -> some View {
        let d = { (vitesse: Double, phase: Double) in Float(sin(t * vitesse + phase) * 0.12) }
        let noir = Theme.background
        return MeshGradient(
            width: 3, height: 3,
            points: [
                [0, 0], [0.5 + d(0.11, 0), 0], [1, 0],
                [0, 0.45 + d(0.09, 1)], [0.5 + d(0.13, 2), 0.5 + d(0.1, 3)], [1, 0.5 + d(0.08, 4)],
                [0, 1], [0.5 + d(0.07, 5), 1], [1, 1],
            ],
            colors: [
                Theme.violetDark.opacity(0.95), Theme.violetDeep.opacity(0.55), Color(red: 0.18, green: 0.06, blue: 0.32),
                noir, Theme.violetDark.opacity(0.55), Color(red: 0.25, green: 0.08, blue: 0.42).opacity(0.7),
                noir, noir, Color(red: 0.08, green: 0.06, blue: 0.22),
            ],
            smoothsColors: true
        )
        .opacity(0.9)
    }

    /// Des points de lumiere qui montent lentement et scintillent. Leur
    /// position ne depend que du temps : rien a memoriser, rien a recalculer.
    private func particules(_ t: Double) -> some View {
        Canvas(rendersAsynchronously: true) { ctx, taille in
            for i in 0..<38 {
                let graine = Double(i) * 12.9898
                let alea = { (k: Double) in (sin(graine * k) * 43758.5453).truncatingRemainder(dividingBy: 1).magnitude }
                let vitesse = 8 + alea(1.3) * 18
                let x = alea(2.1) * taille.width + sin(t * 0.3 + graine) * 10
                let y = taille.height - ((t * vitesse + alea(3.7) * taille.height).truncatingRemainder(dividingBy: taille.height + 40)) + 20
                let rayon = 0.6 + alea(4.4) * 1.4
                let scintille = 0.5 + 0.5 * sin(t * (0.8 + alea(5.1)) + graine)
                let alpha = (0.15 + alea(6.3) * 0.45) * scintille
                let blanc = alea(7.9) < 0.3
                let couleur = blanc ? Color.white : Theme.violetLight
                ctx.fill(Path(ellipseIn: CGRect(x: x - rayon * 3, y: y - rayon * 3, width: rayon * 6, height: rayon * 6)), with: .color(couleur.opacity(alpha * 0.18)))
                ctx.fill(Path(ellipseIn: CGRect(x: x - rayon, y: y - rayon, width: rayon * 2, height: rayon * 2)), with: .color(couleur.opacity(alpha)))
            }
        }
    }
}

/// L'inclinaison du telephone (ou, sur Mac, la position du pointeur), lissee,
/// pour une parallaxe de quelques points.
@Observable
final class MotionParallax {
    /// un seul capteur pour toute l'app (Apple le recommande)
    static let shared = MotionParallax()

    var x: Double = 0
    var y: Double = 0

    #if os(macOS)
    @ObservationIgnored private var cibleX: Double = 0
    @ObservationIgnored private var cibleY: Double = 0
    @ObservationIgnored private var minuteur: Timer?

    func start() {
        guard minuteur == nil else { return }
        // le fond glisse doucement vers la position du pointeur
        minuteur = Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let nx = self.x * 0.88 + self.cibleX * 0.12
                let ny = self.y * 0.88 + self.cibleY * 0.12
                if abs(nx - self.x) > 0.0005 || abs(ny - self.y) > 0.0005 {
                    self.x = nx
                    self.y = ny
                }
            }
        }
    }

    /// position du pointeur dans la fenetre (0...1 sur chaque axe)
    func suit(_ fraction: CGPoint) {
        cibleX = max(-1, min(1, (fraction.x - 0.5) * 2))
        cibleY = max(-1, min(1, (fraction.y - 0.5) * 2))
    }

    func stop() {
        minuteur?.invalidate()
        minuteur = nil
    }
    #else
    @ObservationIgnored private let manager = CMMotionManager()

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1 / 30
        manager.startDeviceMotionUpdates(to: .main) { [weak self] mouvement, _ in
            guard let self, let gravite = mouvement?.gravity else { return }
            // lissage : on ne garde qu'une part de chaque nouvelle mesure
            self.x = self.x * 0.88 + max(-1, min(1, gravite.x)) * 0.12
            self.y = self.y * 0.88 + max(-1, min(1, gravite.y + 0.6)) * 0.12
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
    }
    #endif
}
