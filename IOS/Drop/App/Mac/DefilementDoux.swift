#if os(macOS)
import AppKit
import QuartzCore

/// Une souris a molette crantee fait sauter les vues AppKit d'un cran a
/// l'autre : la page avance par a-coups. Ici, comme dans Safari ou Chrome,
/// chaque cran devient un glissement anime, qui se rallonge si l'on continue
/// de tourner et repart tout de suite dans l'autre sens. Le trackpad (et la
/// Magic Mouse), deja continus, ne sont pas touches.
@MainActor
final class DefilementDoux: NSObject {
    static let shared = DefilementDoux()

    /// la distance d'un cran, celle des navigateurs
    private let pasParCran: CGFloat = 40
    /// la constante de temps du glissement : il s'acheve en ~4 fois ce temps
    private let tau: Double = 0.07

    private var moniteur: Any?
    private weak var vue: NSScrollView?
    private var position: CGPoint = .zero
    private var cible: CGPoint = .zero
    /// la derniere origine posee : si elle a change sans nous (trackpad,
    /// clavier, glisser), on repart de la vraie position
    private var posee: CGPoint = .zero
    private var lien: CADisplayLink?
    private var dernier: CFTimeInterval = 0

    func demarre() {
        guard moniteur == nil else { return }
        // les moniteurs locaux sont appeles sur le fil principal
        moniteur = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            nonisolated(unsafe) let e = event
            return MainActor.assumeIsolated { DefilementDoux.shared.prend(e) } ? nil : event
        }
    }

    /// Prend un cran de molette ; `false` laisse AppKit faire comme d'habitude.
    private func prend(_ event: NSEvent) -> Bool {
        guard !event.hasPreciseScrollingDeltas, event.phase.isEmpty, event.momentumPhase.isEmpty else { return false }
        let dx = event.scrollingDeltaX, dy = event.scrollingDeltaY
        guard dx != 0 || dy != 0, let cadre = event.window?.contentView?.superview else { return false }
        let vertical = abs(dy) >= abs(dx)
        guard let sv = defilable(sous: cadre.hitTest(event.locationInWindow), vertical: vertical) else { return false }
        pousse(sv, de: CGPoint(x: vertical ? 0 : -dx * pasParCran, y: vertical ? -dy * pasParCran : 0))
        return true
    }

    /// Ajoute un deplacement a la destination de `sv` et lance le glissement.
    func pousse(_ sv: NSScrollView, de delta: CGPoint) {
        let clip = sv.contentView
        let flip: CGFloat = (sv.documentView?.isFlipped ?? true) ? 1 : -1
        let delta = CGPoint(x: delta.x, y: delta.y * flip)
        if sv !== vue || lien == nil || clip.bounds.origin != posee {
            vue = sv
            position = clip.bounds.origin
            cible = position
        }
        // changer de sens repart d'ou l'on est, sans finir le glissement d'avant
        if delta.x * (cible.x - position.x) < 0 { cible.x = position.x }
        if delta.y * (cible.y - position.y) < 0 { cible.y = position.y }
        let voulue = NSRect(origin: CGPoint(x: cible.x + delta.x, y: cible.y + delta.y), size: clip.bounds.size)
        cible = clip.constrainBoundsRect(voulue).origin
        guard cible != position else { return }
        if lien == nil {
            dernier = 0
            let l = sv.displayLink(target: self, selector: #selector(image(_:)))
            l.add(to: .main, forMode: .common)
            lien = l
        }
    }

    @objc private func image(_ l: CADisplayLink) {
        guard let sv = vue else { arrete(); return }
        let maintenant = l.targetTimestamp
        let dt = dernier == 0 ? max(l.targetTimestamp - l.timestamp, 1.0 / 120) : min(maintenant - dernier, 1.0 / 20)
        dernier = maintenant
        let k = CGFloat(1 - exp(-dt / tau))
        position.x += (cible.x - position.x) * k
        position.y += (cible.y - position.y) * k
        let fini = abs(cible.x - position.x) < 0.3 && abs(cible.y - position.y) < 0.3
        if fini { position = cible }
        // aligne sur les pixels de l'ecran : le texte reste net en mouvement
        let echelle = sv.window?.backingScaleFactor ?? 2
        let origine = CGPoint(x: (position.x * echelle).rounded() / echelle, y: (position.y * echelle).rounded() / echelle)
        let clip = sv.contentView
        clip.scroll(to: origine)
        sv.reflectScrolledClipView(clip)
        posee = clip.bounds.origin
        if fini { arrete() }
    }

    private func arrete() {
        lien?.invalidate()
        lien = nil
    }

    /// La premiere vue qui peut defiler dans ce sens, en remontant depuis le
    /// pointeur (la molette verticale sur un graphique horizontal fait
    /// defiler la page).
    private func defilable(sous depart: NSView?, vertical: Bool) -> NSScrollView? {
        var v = depart
        while let courante = v {
            if let sv = courante as? NSScrollView, let doc = sv.documentView {
                let visible = sv.contentView.bounds.size
                let encarts = sv.contentView.contentInsets
                let marge = vertical
                    ? doc.frame.height + encarts.top + encarts.bottom - visible.height
                    : doc.frame.width + encarts.left + encarts.right - visible.width
                if marge > 1 { return sv }
            }
            v = courante.superview
        }
        return nil
    }

    #if DEBUG
    /// Mesure en developpement (`-DropTestDefilement 1`) : des crans de
    /// molette vers le bas puis vers le haut sur la page, et la regularite
    /// des images pendant ce temps.
    func testeDefilement(chemin: String) async {
        guard let fenetre = NSApp.windows.first(where: { $0.isVisible && $0.frame.width > 600 }),
              let cadre = fenetre.contentView?.superview else { return }
        let centre = CGPoint(x: fenetre.frame.width / 2, y: fenetre.frame.height / 2)
        guard let sv = defilable(sous: cadre.hitTest(centre), vertical: true) else {
            try? "pas de vue defilable".write(toFile: chemin, atomically: true, encoding: .utf8)
            return
        }
        let sonde = SondeImages(vue: sv)
        sonde.demarre()
        for sens in [-1.0, 1.0] {
            for _ in 0..<14 {
                pousse(sv, de: CGPoint(x: 0, y: -sens * 3 * pasParCran))
                try? await Task.sleep(for: .milliseconds(90))
            }
            try? await Task.sleep(for: .milliseconds(600))
        }
        try? sonde.rapport().write(toFile: chemin, atomically: true, encoding: .utf8)
    }
    #endif
}

#if DEBUG
/// Note l'intervalle entre deux images de l'ecran (via un lien d'affichage
/// sur le fil principal) : un intervalle long est une image manquee.
@MainActor
final class SondeImages: NSObject {
    private weak var vue: NSView?
    private var lien: CADisplayLink?
    private var temps: [CFTimeInterval] = []
    private var attendu: CFTimeInterval = 1.0 / 60

    init(vue: NSView) { self.vue = vue }

    func demarre() {
        guard let vue else { return }
        let l = vue.displayLink(target: self, selector: #selector(image(_:)))
        l.add(to: .main, forMode: .common)
        lien = l
    }

    @objc private func image(_ l: CADisplayLink) {
        attendu = l.targetTimestamp - l.timestamp
        temps.append(l.timestamp)
    }

    func rapport() -> String {
        lien?.invalidate()
        let ecarts = zip(temps.dropFirst(), temps).map { $0 - $1 }
        guard !ecarts.isEmpty else { return "aucune image" }
        let manquees = ecarts.reduce(0) { $0 + max(0, Int(($1 / attendu).rounded()) - 1) }
        let pire = ecarts.max() ?? 0
        let tries = ecarts.sorted()
        let p95 = tries[Int(Double(tries.count - 1) * 0.95)]
        return String(format: "images %d  attendu %.1f ms  manquees %d  pire %.1f ms  p95 %.1f ms  moyenne %.2f ms",
                      ecarts.count, attendu * 1000, manquees, pire * 1000, p95 * 1000, ecarts.reduce(0, +) / Double(ecarts.count) * 1000)
    }
}
#endif
#endif

#if os(macOS) && DEBUG
extension Double {
    var nonZero: Double? { self == 0 ? nil : self }
}
#endif
