import SwiftUI
import QuartzCore

// Les animations sans fin de l'interface (la pastille « En direct », les
// halos du sac, le reflet du logo, le point de la tournee, le battement de la
// courbe, les icones qui respirent) confiees a Core Animation.
//
// Pourquoi : une animation SwiftUI `repeatForever` fait recalculer l'interface
// AU FIL PRINCIPAL a chaque image, pour toujours -- et le verre Liquid Glass
// autour d'elle avec. Mesure sur le Mac, app au repos : 28-31 % d'un coeur
// avec ces boucles, 5 % sans. Une animation Core Animation tourne dans le
// serveur de rendu du systeme : meme courbe (easeOut / easeInOut de SwiftUI =
// ceux de Core Animation), meme duree, mais plus aucun travail pour l'app.

#if os(iOS)
typealias VuePlateforme = UIView
typealias CouleurPlateforme = UIColor
#else
typealias VuePlateforme = NSView
typealias CouleurPlateforme = NSColor
#endif

/// Une vue a calques : `pose` construit ses calques et leurs animations ; elle
/// est rejouee a chaque entree dans une fenetre et a chaque changement de
/// taille (iOS retire les animations d'une app passee en arriere-plan).
final class VueBoucle: VuePlateforme {
    var pose: (CALayer, CGRect) -> Void = { _, _ in }
    private let racine = CALayer()
    private var dernier: CGRect = .null

    init() {
        super.init(frame: .zero)
        #if os(iOS)
        isUserInteractionEnabled = false
        layer.addSublayer(racine)
        NotificationCenter.default.addObserver(self, selector: #selector(revient), name: UIApplication.willEnterForegroundNotification, object: nil)
        #else
        wantsLayer = true
        layer?.masksToBounds = false
        layer?.addSublayer(racine)
        #endif
        racine.masksToBounds = false
    }

    required init?(coder: NSCoder) { nil }

    #if os(iOS)
    override func layoutSubviews() {
        super.layoutSubviews()
        reconstruit(force: false)
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { reconstruit(force: true) }
    }
    @objc private func revient() { reconstruit(force: true) }
    #else
    override var isFlipped: Bool { true }
    override func layout() {
        super.layout()
        reconstruit(force: false)
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { reconstruit(force: true) }
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    #endif

    /// (re)construit les calques : seulement si la taille change, ou apres un
    /// retour a l'ecran
    func reconstruit(force: Bool) {
        guard bounds.width > 0 || bounds.height > 0 || force else { return }
        guard force || bounds != dernier else { return }
        dernier = bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        racine.frame = bounds
        racine.sublayers?.forEach { $0.removeFromSuperlayer() }
        pose(racine, bounds)
        CATransaction.commit()
    }
}

/// La representation SwiftUI : `cle` change (une couleur...) -> on reconstruit.
struct Boucle: View {
    var cle: AnyHashable = 0
    let pose: (CALayer, CGRect) -> Void

    var body: some View { Hote(cle: cle, pose: pose).allowsHitTesting(false).accessibilityHidden(true) }

    #if os(iOS)
    struct Hote: UIViewRepresentable {
        let cle: AnyHashable
        let pose: (CALayer, CGRect) -> Void
        final class Coordinator { var cle: AnyHashable? }
        func makeCoordinator() -> Coordinator { Coordinator() }
        func makeUIView(context: Context) -> VueBoucle {
            let v = VueBoucle()
            v.pose = pose
            context.coordinator.cle = cle
            return v
        }
        func updateUIView(_ v: VueBoucle, context: Context) {
            v.pose = pose
            if context.coordinator.cle != cle {
                context.coordinator.cle = cle
                v.reconstruit(force: true)
            }
        }
    }
    #else
    struct Hote: NSViewRepresentable {
        let cle: AnyHashable
        let pose: (CALayer, CGRect) -> Void
        final class Coordinator { var cle: AnyHashable? }
        func makeCoordinator() -> Coordinator { Coordinator() }
        func makeNSView(context: Context) -> VueBoucle {
            let v = VueBoucle()
            v.pose = pose
            context.coordinator.cle = cle
            return v
        }
        func updateNSView(_ v: VueBoucle, context: Context) {
            v.pose = pose
            if context.coordinator.cle != cle {
                context.coordinator.cle = cle
                v.reconstruit(force: true)
            }
        }
    }
    #endif
}

// MARK: - Les animations

enum AnimCA {
    static let easeOut = CAMediaTimingFunction(name: .easeOut)
    static let easeInOut = CAMediaTimingFunction(name: .easeInEaseOut)

    /// une animation qui ne s'arrete jamais (et ne disparait pas toute seule)
    static func sansFin(_ cle: String, de: Any, a: Any, duree: Double, courbe: CAMediaTimingFunction, aller: Bool = false) -> CABasicAnimation {
        let a2 = CABasicAnimation(keyPath: cle)
        a2.fromValue = de
        a2.toValue = a
        a2.duration = duree
        a2.timingFunction = courbe
        a2.autoreverses = aller
        a2.repeatCount = .infinity
        a2.isRemovedOnCompletion = false
        return a2
    }

    /// plusieurs proprietes ensemble, sans fin
    static func groupe(_ animations: [CAAnimation], duree: Double) -> CAAnimationGroup {
        let g = CAAnimationGroup()
        g.animations = animations
        g.duration = duree
        g.repeatCount = .infinity
        g.isRemovedOnCompletion = false
        return g
    }

    static func cg(_ c: Color) -> CGColor { CouleurPlateforme(c).cgColor }
}

/// Un anneau qui s'agrandit en s'effacant, sans fin (la pastille « En direct »,
/// la tete de la courbe des revenus) : `Circle().stroke().scaleEffect().opacity()`
/// + `.easeOut(duration:).repeatForever(autoreverses: false)`.
struct AnneauPulse: View {
    let couleur: Color
    let diametre: CGFloat
    let epaisseur: CGFloat
    let echelle: CGFloat
    let opacite: Double
    let duree: Double

    var body: some View {
        Boucle(cle: "\(couleur)") { racine, cadre in
            let anneau = CAShapeLayer()
            anneau.frame = CGRect(x: (cadre.width - diametre) / 2, y: (cadre.height - diametre) / 2, width: diametre, height: diametre)
            anneau.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: diametre, height: diametre), transform: nil)
            anneau.fillColor = nil
            anneau.strokeColor = AnimCA.cg(couleur)
            anneau.lineWidth = epaisseur
            anneau.opacity = 0
            anneau.add(AnimCA.groupe([
                AnimCA.sansFin("transform.scale", de: 1, a: echelle, duree: duree, courbe: AnimCA.easeOut),
                AnimCA.sansFin("opacity", de: opacite, a: 0, duree: duree, courbe: AnimCA.easeOut),
            ], duree: duree), forKey: "pulse")
            racine.addSublayer(anneau)
        }
        .frame(width: diametre, height: diametre)
    }
}

/// Un point qui bat (la tournee en cours) : `scaleEffect(0.9 <-> 1.25)` et
/// `shadow(radius: 2 <-> 6)`, `.easeInOut(duration: 0.9).repeatForever()`.
struct PointBattant: View {
    let couleur: Color
    let diametre: CGFloat

    var body: some View {
        Boucle(cle: "\(couleur)") { racine, cadre in
            let point = CAShapeLayer()
            point.frame = CGRect(x: (cadre.width - diametre) / 2, y: (cadre.height - diametre) / 2, width: diametre, height: diametre)
            point.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: diametre, height: diametre), transform: nil)
            point.fillColor = AnimCA.cg(couleur)
            point.shadowColor = AnimCA.cg(couleur)
            point.shadowOpacity = 1
            point.shadowOffset = .zero
            point.shadowRadius = 2
            point.add(AnimCA.groupe([
                AnimCA.sansFin("transform.scale", de: 0.9, a: 1.25, duree: 0.9, courbe: AnimCA.easeInOut, aller: true),
                AnimCA.sansFin("shadowRadius", de: 2, a: 6, duree: 0.9, courbe: AnimCA.easeInOut, aller: true),
            ], duree: 1.8), forKey: "bat")
            racine.addSublayer(point)
        }
        .frame(width: diametre, height: diametre)
    }
}

/// Un degrade radial qui derive doucement (les halos du sac).
struct HaloDerive: Hashable {
    let couleur: Color
    let rayon: CGFloat
    /// centre au repos, en part de la largeur / hauteur
    let x: CGFloat
    let y: CGFloat
    /// derive (en part de la largeur / hauteur) et sa demi-periode
    let dx: CGFloat
    let dy: CGFloat
    let duree: Double
}

struct HalosDerivants: View {
    let halos: [HaloDerive]

    var body: some View {
        Boucle(cle: halos) { racine, cadre in
            for h in halos {
                let g = CAGradientLayer()
                g.type = .radial
                // vers la meme couleur transparente : pas de liseré sombre
                // (comme le degrade premultiplie de SwiftUI vers .clear)
                g.colors = [AnimCA.cg(h.couleur), AnimCA.cg(h.couleur.opacity(0))]
                g.startPoint = CGPoint(x: 0.5, y: 0.5)
                g.endPoint = CGPoint(x: 1, y: 1)
                g.bounds = CGRect(x: 0, y: 0, width: h.rayon * 2, height: h.rayon * 2)
                let centre = CGPoint(x: cadre.width * h.x, y: cadre.height * h.y)
                g.position = centre
                if h.dx != 0 {
                    g.add(AnimCA.sansFin("position.x", de: centre.x - h.dx * cadre.width, a: centre.x + h.dx * cadre.width, duree: h.duree, courbe: AnimCA.easeInOut, aller: true), forKey: "derive")
                }
                if h.dy != 0 {
                    g.add(AnimCA.sansFin("position.y", de: centre.y - h.dy * cadre.height, a: centre.y + h.dy * cadre.height, duree: h.duree, courbe: AnimCA.easeInOut, aller: true), forKey: "houle")
                }
                racine.addSublayer(g)
            }
        }
    }
}

/// Le reflet qui passe sur le logo : une bande claire inclinee de 20°, qui
/// traverse en 1,4 s (easeInOut) apres 1,6 s d'attente, sans fin.
struct RefletPassant: View {
    let largeur: CGFloat
    let course: CGFloat
    let arrondi: CGFloat

    var body: some View {
        Boucle { racine, cadre in
            let cadreClip = CALayer()
            cadreClip.frame = cadre
            cadreClip.cornerRadius = arrondi
            cadreClip.masksToBounds = true
            let bande = CAGradientLayer()
            bande.colors = [CGColor(gray: 1, alpha: 0), CGColor(gray: 1, alpha: 0.5), CGColor(gray: 1, alpha: 0)]
            bande.startPoint = CGPoint(x: 0, y: 0.5)
            bande.endPoint = CGPoint(x: 1, y: 0.5)
            bande.bounds = CGRect(x: 0, y: 0, width: largeur, height: cadre.height)
            bande.position = CGPoint(x: cadre.midX, y: cadre.midY)
            bande.setAffineTransform(CGAffineTransform(rotationAngle: 20 * .pi / 180))
            let traverse = CAKeyframeAnimation(keyPath: "transform.translation.x")
            traverse.values = [-course, -course, course]
            traverse.keyTimes = [0, NSNumber(value: 1.6 / 3.0), 1]
            traverse.timingFunctions = [CAMediaTimingFunction(name: .linear), AnimCA.easeInOut]
            traverse.duration = 3.0
            traverse.repeatCount = .infinity
            traverse.isRemovedOnCompletion = false
            bande.add(traverse, forKey: "reflet")
            cadreClip.addSublayer(bande)
            racine.addSublayer(cadreClip)
        }
    }
}

/// Une icone SF Symbols animee par Core Animation : `pulse` (l'opacite bat)
/// ou `respire` (elle gonfle doucement) -- a la place de `symbolEffect`
/// en boucle, recalcule par SwiftUI a chaque image.
struct SymboleAnime: View {
    enum Effet: Hashable { case pulse, respire }
    let nom: String
    let taille: CGFloat
    var poids: Font.Weight = .regular
    let couleur: Color
    let effet: Effet

    var body: some View {
        Boucle(cle: "\(nom)\(couleur)\(taille)\(effet)") { racine, cadre in
            guard let image = Self.image(nom, taille, poids) else { return }
            let calque = CALayer()
            let taillePt = Self.taille(image)
            calque.frame = CGRect(x: (cadre.width - taillePt.width) / 2, y: (cadre.height - taillePt.height) / 2, width: taillePt.width, height: taillePt.height)
            calque.contents = Self.contenu(image)
            calque.contentsGravity = .resizeAspect
            // l'icone prend la couleur : un masque de la forme, rempli
            let teinte = CALayer()
            teinte.frame = calque.frame
            teinte.backgroundColor = AnimCA.cg(couleur)
            let masque = CALayer()
            masque.frame = CGRect(origin: .zero, size: calque.frame.size)
            masque.contents = calque.contents
            masque.contentsGravity = .resizeAspect
            teinte.mask = masque
            #if os(iOS)
            masque.contentsScale = UIScreen.main.scale
            #else
            masque.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            #endif
            switch effet {
            case .pulse:
                teinte.add(AnimCA.sansFin("opacity", de: 1, a: 0.35, duree: 0.85, courbe: AnimCA.easeInOut, aller: true), forKey: "pulse")
            case .respire:
                teinte.add(AnimCA.groupe([
                    AnimCA.sansFin("transform.scale", de: 1, a: 1.1, duree: 1.4, courbe: AnimCA.easeInOut, aller: true),
                    AnimCA.sansFin("opacity", de: 1, a: 0.72, duree: 1.4, courbe: AnimCA.easeInOut, aller: true),
                ], duree: 2.8), forKey: "respire")
            }
            racine.addSublayer(teinte)
        }
        .frame(width: taille * 1.3, height: taille * 1.3)
    }

    #if os(iOS)
    static func image(_ nom: String, _ taille: CGFloat, _ poids: Font.Weight) -> UIImage? {
        UIImage(systemName: nom, withConfiguration: UIImage.SymbolConfiguration(pointSize: taille, weight: poidsUI(poids)))
    }
    static func taille(_ i: UIImage) -> CGSize { i.size }
    static func contenu(_ i: UIImage) -> Any? { i.withTintColor(.black, renderingMode: .alwaysOriginal).cgImage }
    static func poidsUI(_ p: Font.Weight) -> UIImage.SymbolWeight {
        switch p { case .medium: .medium; case .semibold: .semibold; case .bold: .bold; default: .regular }
    }
    #else
    static func image(_ nom: String, _ taille: CGFloat, _ poids: Font.Weight) -> NSImage? {
        NSImage(systemSymbolName: nom, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: taille, weight: poidsAK(poids)))
    }
    static func taille(_ i: NSImage) -> CGSize { i.size }
    static func contenu(_ i: NSImage) -> Any? {
        var r = CGRect(origin: .zero, size: i.size)
        return i.cgImage(forProposedRect: &r, context: nil, hints: [.ctm: AffineTransform(scale: NSScreen.main?.backingScaleFactor ?? 2)])
    }
    static func poidsAK(_ p: Font.Weight) -> NSFont.Weight {
        switch p { case .medium: .medium; case .semibold: .semibold; case .bold: .bold; default: .regular }
    }
    #endif
}
