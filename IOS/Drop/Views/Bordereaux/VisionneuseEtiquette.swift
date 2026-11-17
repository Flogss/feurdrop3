#if os(macOS)
import SwiftUI
import AppKit
import PDFKit
import DropKit

/// La visionneuse d'etiquette : la page du fichier d'origine (PDF vectoriel
/// ou image), dans un NSScrollView qui zoome (pincement, Cmd + molette,
/// boutons) et se deplace (trackpad, ou glisser a la souris). Les zones des
/// codes sont des vues posees sur la page, en fraction de sa taille : elles
/// grandissent avec elle et restent sur leur code a tous les zooms. Rien
/// n'est jamais ecrit dans le fichier.
struct VisionneuseEtiquette: NSViewRepresentable {
    let document: DocumentEtiquette
    let page: Int
    let codes: [BordereauCode]
    let selection: Int?
    let trouve: Int?
    let zonesToutes: Bool
    let ajustement: BordereauxModel.Ajustement
    let commande: BordereauxModel.Commande?
    let revelation: Int
    /// le zoom affiche ; `libre` : l'utilisateur a zoome lui-meme
    var surZoom: (Double, Bool) -> Void
    var surSurvol: (BordereauxModel.Bulle?) -> Void
    var surChoix: (Int) -> Void
    var surCopie: (BordereauCode) -> Void

    final class Coordinateur {
        var parent: VisionneuseEtiquette?
        var derniereCommande = 0
        var derniereRevelation = 0
    }

    func makeCoordinator() -> Coordinateur { Coordinateur() }

    func makeNSView(context: Context) -> HoteVisionneuse {
        let hote = HoteVisionneuse()
        hote.coordinateur = context.coordinator
        context.coordinator.derniereRevelation = revelation
        // une commande deja la (aller au code trouve) est pour cette etiquette :
        // la page la remet a zero a chaque ouverture
        context.coordinator.derniereCommande = 0
        return hote
    }

    func updateNSView(_ hote: HoteVisionneuse, context: Context) {
        let c = context.coordinator
        c.parent = self
        hote.ajustement = ajustement
        hote.metContenu(document, page: page)
        hote.metZones(codes, selection: selection, trouve: trouve, toutes: zonesToutes)
        if revelation != c.derniereRevelation {
            c.derniereRevelation = revelation
            hote.revele()
        }
        if let commande, commande.numero != c.derniereCommande {
            c.derniereCommande = commande.numero
            hote.applique(commande.action)
        }
    }
}

// MARK: - L'hote : le cadre de la visionneuse

final class HoteVisionneuse: NSView {
    weak var coordinateur: VisionneuseEtiquette.Coordinateur?
    let defilement = DefilementEtiquette()
    private var feuille: FeuilleEtiquette?
    private var identite: (ObjectIdentifier, Int)?
    private var zones: [Int: ZoneCode] = [:]
    private var signatureZones = ""
    private var dernierZoom: CGFloat = 0
    var ajustement: BordereauxModel.Ajustement = .largeur {
        didSet { if ajustement != oldValue, ajustement != .libre { ajuste(ajustement, enHaut: false) } }
    }

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        defilement.drawsBackground = false
        defilement.hasVerticalScroller = true
        defilement.hasHorizontalScroller = true
        defilement.autohidesScrollers = true
        defilement.scrollerStyle = .overlay
        defilement.allowsMagnification = true
        defilement.minMagnification = 0.03
        defilement.maxMagnification = 12
        defilement.contentView = ClipCentre()
        defilement.contentView.drawsBackground = false
        defilement.contentView.postsBoundsChangedNotifications = true
        defilement.surZoomMolette = { [weak self] in self?.zoomUtilisateur() }
        addSubview(defilement)
        NotificationCenter.default.addObserver(self, selector: #selector(defile), name: NSView.boundsDidChangeNotification, object: defilement.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(finPincement), name: NSScrollView.didEndLiveMagnifyNotification, object: defilement)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        defilement.frame = bounds
        if ajustement != .libre { ajuste(ajustement, enHaut: false) }
        // une commande arrivee avant que la visionneuse ait sa taille
        if let action = enAttente, bounds.width > 40, feuille != nil {
            enAttente = nil
            DispatchQueue.main.async { [weak self] in self?.applique(action) }
        }
    }

    private var enAttente: ActionVisionneuse?

    // MARK: Contenu

    func metContenu(_ document: DocumentEtiquette, page: Int) {
        let cle: ObjectIdentifier
        let contenu: FeuilleEtiquette.Contenu
        let taille: CGSize
        switch document {
        case .pdf(let doc):
            guard let p = doc.page(at: max(0, page - 1)) else { return }
            cle = ObjectIdentifier(doc)
            contenu = .pdf(p)
            let b = p.bounds(for: .cropBox)
            taille = p.rotation % 180 == 0 ? b.size : CGSize(width: b.height, height: b.width)
        case .image(let image):
            cle = ObjectIdentifier(image)
            contenu = .image(image)
            taille = CGSize(width: image.width, height: image.height)
        }
        if let identite, identite.0 == cle, identite.1 == page { return }
        let nouvelleEtiquette = identite?.0 != cle
        identite = (cle, page)
        feuille?.removeFromSuperview()
        zones = [:]
        signatureZones = ""
        let f = FeuilleEtiquette(contenu: contenu, taille: taille)
        f.hote = self
        feuille = f
        defilement.documentView = f
        DispatchQueue.main.async { [weak self] in self?.coordinateur?.parent?.surSurvol(nil) }
        if ajustement == .libre && !nouvelleEtiquette {
            dernierZoom = 0
            styleZones()
        } else {
            ajuste(ajustement == .libre ? .largeur : ajustement, enHaut: true)
        }
        // la page arrive : elle se precise
        f.alphaValue = 0
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.35
            f.animator().alphaValue = 1
        }
    }

    func metZones(_ codes: [BordereauCode], selection: Int?, trouve: Int?, toutes: Bool) {
        guard let feuille else { return }
        let signature = codes.map { "\($0.id)" }.joined(separator: ",")
        if signature != signatureZones {
            signatureZones = signature
            zones.values.forEach { $0.removeFromSuperview() }
            zones = [:]
            for code in codes {
                let z = ZoneCode(code: code)
                z.hote = self
                feuille.addSubview(z)
                zones[code.id] = z
            }
            placeZones()
        }
        for (id, z) in zones {
            z.choisie = id == selection
            z.toutes = toutes
            let etaitTrouvee = z.trouvee
            z.trouvee = id == trouve
            if z.trouvee && !etaitTrouvee { z.pulse(echelle: defilement.magnification) }
        }
        styleZones()
    }

    private func placeZones() {
        guard let feuille else { return }
        let m = max(defilement.magnification, 0.01)
        let marge = 4 / m
        let t = feuille.bounds.size
        for z in zones.values {
            let c = z.code.zone
            z.frame = CGRect(x: c.x0 * t.width, y: c.y0 * t.height, width: (c.x1 - c.x0) * t.width, height: (c.y1 - c.y0) * t.height).insetBy(dx: -marge, dy: -marge)
        }
    }

    private func styleZones() {
        let m = defilement.magnification
        if abs(m - dernierZoom) > 0.0001 {
            dernierZoom = m
            placeZones()
        }
        zones.values.forEach { $0.style(echelle: m) }
    }

    /// Apres une lecture : chaque code s'allume un instant, l'un apres l'autre.
    func revele() {
        let ordre = zones.values.sorted { ($0.code.zone.y0, $0.code.zone.x0) < ($1.code.zone.y0, $1.code.zone.x0) }
        for (i, z) in ordre.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25 + Double(i) * 0.12) { [weak z] in z?.flash() }
        }
    }

    // MARK: Zoom et ajustement

    private func ajuste(_ mode: BordereauxModel.Ajustement, enHaut: Bool) {
        guard let feuille, bounds.width > 40, bounds.height > 40 else { return }
        let marge: CGFloat = 26
        let t = feuille.bounds.size
        let largeur = (bounds.width - 2 * marge) / t.width
        let m = mode == .page ? min(largeur, (bounds.height - 2 * marge) / t.height) : largeur
        let z = min(max(m, defilement.minMagnification), defilement.maxMagnification)
        let change = abs(z - defilement.magnification) > 0.0005
        // deja ajustee : rien a refaire (la remise en page arrive souvent)
        guard change || enHaut else { return }
        if change { defilement.magnification = z }
        if enHaut { defilement.contentView.scroll(to: defilement.contentView.constrainBoundsRect(NSRect(origin: .zero, size: defilement.contentView.bounds.size)).origin) }
        defilement.reflectScrolledClipView(defilement.contentView)
        styleZones()
        // jamais pendant la mise a jour de SwiftUI : juste apres
        DispatchQueue.main.async { [weak self] in self?.coordinateur?.parent?.surZoom(Double(z), false) }
    }

    func applique(_ action: ActionVisionneuse) {
        guard bounds.width > 40, feuille != nil else {
            enAttente = action
            needsLayout = true
            return
        }
        let m = defilement.magnification
        switch action {
        case .zoomPlus: zoome(vers: BordereauxPas.suivant(m))
        case .zoomMoins: zoome(vers: BordereauxPas.precedent(m))
        case .taille100: zoome(vers: 1)
        case .largeur: ajuste(.largeur, enHaut: true)
        case .pageEntiere: ajuste(.page, enHaut: true)
        case .montre(let id): montre(id)
        }
    }

    private func zoome(vers z: CGFloat) {
        guard let feuille else { return }
        let clip = defilement.contentView.bounds
        let centre = NSPoint(x: clip.midX, y: clip.midY)
        let cible = min(max(z, defilement.minMagnification), defilement.maxMagnification)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            ctx.allowsImplicitAnimation = true
            defilement.animator().setMagnification(cible, centeredAt: feuille.bounds.contains(centre) ? centre : NSPoint(x: feuille.bounds.midX, y: feuille.bounds.midY))
        } completionHandler: { [weak self] in
            self?.zoomUtilisateur()
        }
    }

    /// Le zoom vient de l'utilisateur : l'ajustement devient libre.
    func zoomUtilisateur() {
        styleZones()
        coordinateur?.parent?.surSurvol(nil)
        coordinateur?.parent?.surZoom(Double(defilement.magnification), true)
    }

    @objc private func finPincement() { zoomUtilisateur() }

    private var derniereOrigine = NSPoint(x: -1, y: -1)

    @objc private func defile() {
        // seul un vrai deplacement (ou un zoom) cache l'infobulle : une simple
        // remise en page (l'infobulle qui apparait) ne doit pas la chasser
        let o = defilement.contentView.bounds.origin
        let bouge = abs(o.x - derniereOrigine.x) > 0.5 || abs(o.y - derniereOrigine.y) > 0.5
        derniereOrigine = o
        let zoomChange = abs(defilement.magnification - dernierZoom) > 0.0001
        if bouge || zoomChange { coordinateur?.parent?.surSurvol(nil) }
        if zoomChange {
            styleZones()
            coordinateur?.parent?.surZoom(Double(defilement.magnification), ajustement == .libre)
        }
    }

    /// Le code au centre (sa page est deja affichee).
    private func montre(_ id: Int) {
        guard let z = zones[id] else { return }
        let clip = defilement.contentView
        let taille = clip.bounds.size
        let origine = NSPoint(x: z.frame.midX - taille.width / 2, y: z.frame.midY - taille.height / 2)
        let cible = clip.constrainBoundsRect(NSRect(origin: origine, size: taille)).origin
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.45
            ctx.allowsImplicitAnimation = true
            clip.animator().setBoundsOrigin(cible)
        } completionHandler: { [weak self] in
            guard let self else { return }
            self.defilement.reflectScrolledClipView(clip)
            z.pulse(echelle: self.defilement.magnification)
            #if DEBUG
            // verification : `-DropBordereauSurvol 1` fait comme si le pointeur passait sur le code
            if UserDefaults.standard.bool(forKey: "DropBordereauSurvol") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { z.mouseEntered(with: NSEvent()) }
            }
            #endif
        }
    }

    // MARK: Survol, choix, glisser

    func survole(_ zone: ZoneCode?) {
        guard let zone else {
            coordinateur?.parent?.surSurvol(nil)
            return
        }
        let cadre = zone.convert(zone.bounds, to: self)
        coordinateur?.parent?.surSurvol(.init(code: zone.code, cadre: cadre))
    }

    func choisit(_ zone: ZoneCode) { coordinateur?.parent?.surChoix(zone.code.id) }
    func copie(_ zone: ZoneCode) { coordinateur?.parent?.surCopie(zone.code) }

    private var depart: (souris: NSPoint, origine: NSPoint)?

    func commenceGlisse(_ e: NSEvent) {
        depart = (e.locationInWindow, defilement.contentView.bounds.origin)
    }

    func glisse(_ e: NSEvent) {
        guard let depart else { return }
        NSCursor.closedHand.set()
        let m = defilement.magnification
        let dx = e.locationInWindow.x - depart.souris.x
        let dy = e.locationInWindow.y - depart.souris.y
        let clip = defilement.contentView
        let voulu = NSPoint(x: depart.origine.x - dx / m, y: depart.origine.y + dy / m)
        clip.scroll(to: clip.constrainBoundsRect(NSRect(origin: voulu, size: clip.bounds.size)).origin)
        defilement.reflectScrolledClipView(clip)
    }

    func finGlisse() {
        depart = nil
        NSCursor.openHand.set()
    }
}

// MARK: - Le defilement (Cmd ou Ctrl + molette : zoom sous le pointeur)

final class DefilementEtiquette: NSScrollView {
    var surZoomMolette: (() -> Void)?

    override func scrollWheel(with e: NSEvent) {
        guard e.modifierFlags.contains(.command) || e.modifierFlags.contains(.control), let doc = documentView else {
            super.scrollWheel(with: e)
            return
        }
        let delta = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY : e.scrollingDeltaY * 10
        let cible = min(max(magnification * exp(delta * 0.012), minMagnification), maxMagnification)
        setMagnification(cible, centeredAt: doc.convert(e.locationInWindow, from: nil))
        surZoomMolette?()
    }
}

/// La page reste au centre quand elle est plus petite que la visionneuse.
final class ClipCentre: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var r = super.constrainBoundsRect(proposedBounds)
        guard let doc = documentView else { return r }
        if r.width > doc.frame.width { r.origin.x = (doc.frame.width - r.width) / 2 }
        if r.height > doc.frame.height { r.origin.y = (doc.frame.height - r.height) / 2 }
        return r
    }
}

// MARK: - La feuille : la page telle quelle

final class FeuilleEtiquette: NSView {
    enum Contenu {
        case pdf(PDFPage)
        case image(CGImage)
    }

    let contenu: Contenu
    let taille: CGSize
    weak var hote: HoteVisionneuse?

    init(contenu: Contenu, taille: CGSize) {
        self.contenu = contenu
        self.taille = taille
        super.init(frame: CGRect(origin: .zero, size: taille))
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.cornerRadius = 2
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.6
        layer?.shadowRadius = 30
        layer?.shadowOffset = CGSize(width: 0, height: -16)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(dirtyRect)
        ctx.saveGState()
        // la vue compte y vers le bas ; PDF et images, vers le haut
        ctx.translateBy(x: 0, y: bounds.height)
        ctx.scaleBy(x: 1, y: -1)
        switch contenu {
        case .pdf(let page):
            ctx.scaleBy(x: bounds.width / taille.width, y: bounds.height / taille.height)
            // la zone visible (CropBox) et la rotation, comme le serveur les lit
            page.draw(with: .cropBox, to: ctx)
        case .image(let image):
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(origin: .zero, size: bounds.size))
        }
        ctx.restoreGState()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    override func mouseDown(with e: NSEvent) { hote?.commenceGlisse(e) }
    override func mouseDragged(with e: NSEvent) { hote?.glisse(e) }
    override func mouseUp(with e: NSEvent) { hote?.finGlisse() }
}

// MARK: - Une zone de code

final class ZoneCode: NSView {
    let code: BordereauCode
    weak var hote: HoteVisionneuse?
    var choisie = false
    var trouvee = false
    var toutes = false
    private var survol = false
    private var bouge = false
    private var suivi: NSTrackingArea?

    init(code: BordereauCode) {
        self.code = code
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = false
        alphaValue = 0
        setAccessibilityRole(.button)
        setAccessibilityLabel(code.lisible ? "\(code.nomFormat) : \(code.valeur ?? "")" : "\(code.nomFormat) illisible")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    private var couleur: NSColor {
        switch code.role {
        case "illisible": NSColor(Theme.warn)
        case "lien": NSColor(Theme.info)
        case "suivi", "suivi-probable": NSColor(Theme.violetBright)
        default: NSColor(Theme.violetLight)
        }
    }

    func style(echelle m: CGFloat) {
        guard let layer else { return }
        let m = max(m, 0.01)
        let c = couleur
        layer.cornerRadius = 7 / m
        layer.borderWidth = (choisie ? 2.2 : 1.6) / m
        layer.borderColor = c.withAlphaComponent(0.95).cgColor
        layer.backgroundColor = c.withAlphaComponent(choisie ? 0.16 : 0.08).cgColor
        layer.shadowColor = c.cgColor
        layer.shadowOpacity = 0.85
        layer.shadowRadius = 9 / m
        layer.shadowOffset = .zero
        let cible: CGFloat = (survol || choisie || trouvee) ? 1 : (toutes ? 0.55 : 0)
        if abs(alphaValue - cible) > 0.01 {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.16
                animator().alphaValue = cible
            }
        }
    }

    /// des ondes : le code trouve par la recherche
    func pulse(echelle m: CGFloat) {
        guard let layer else { return }
        let a = CABasicAnimation(keyPath: "shadowRadius")
        a.fromValue = 6 / max(m, 0.01)
        a.toValue = 26 / max(m, 0.01)
        a.duration = 0.7
        a.autoreverses = true
        a.repeatCount = 3
        layer.add(a, forKey: "pulse")
    }

    /// apres une lecture : la zone s'allume, puis reprend son etat
    func flash() {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.25
            animator().alphaValue = 1
        } completionHandler: { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                guard let self else { return }
                self.style(echelle: self.hote?.defilement.magnification ?? 1)
            }
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let suivi { removeTrackingArea(suivi) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(t)
        suivi = t
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func mouseEntered(with event: NSEvent) {
        survol = true
        style(echelle: hote?.defilement.magnification ?? 1)
        hote?.survole(self)
    }

    override func mouseExited(with event: NSEvent) {
        survol = false
        style(echelle: hote?.defilement.magnification ?? 1)
        hote?.survole(nil)
    }

    override func mouseDown(with e: NSEvent) {
        bouge = false
        hote?.commenceGlisse(e)
    }

    override func mouseDragged(with e: NSEvent) {
        bouge = true
        hote?.glisse(e)
    }

    override func mouseUp(with e: NSEvent) {
        hote?.finGlisse()
        guard !bouge else { return }
        if e.clickCount >= 2 {
            if code.lisible { hote?.copie(self) }
        } else {
            hote?.choisit(self)
        }
    }
}

/// Les crans du zoom (boutons + et -).
enum BordereauxPas {
    static let crans: [CGFloat] = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
    static func suivant(_ z: CGFloat) -> CGFloat { crans.first { $0 > z * 1.01 } ?? z }
    static func precedent(_ z: CGFloat) -> CGFloat { crans.last { $0 < z * 0.99 } ?? z }
}
#endif
