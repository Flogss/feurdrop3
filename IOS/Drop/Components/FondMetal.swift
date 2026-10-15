import SwiftUI
import Metal
import QuartzCore

/// Le fond vivant, dessine par la carte graphique sur son propre fil (comme la
/// meteorite du lancement) : la nappe de degrades, les aurores, la lueur sous
/// le pointeur, les etoiles, les particules et les etoiles filantes.
///
/// Pourquoi : l'ancienne version (SwiftUI `TimelineView` + `Canvas`) recalculait
/// tout le fond SUR LE PROCESSEUR a chaque image -- des millions de pixels de
/// degrades -- puis renvoyait une image plein ecran a la carte graphique, et
/// faisait recalculer l'interface au fil principal a chaque image. Sur le Mac,
/// l'app au repos prenait ~28 % d'un coeur et le WindowServer ~32 %.
///
/// Ici le dessin est le MEME (memes tirages pseudo-aleatoires, memes vitesses,
/// memes phases, memes couleurs, memes melanges) : les tirages de chaque etoile
/// et de chaque particule sont calcules une fois, en double precision, comme
/// avant ; leur mouvement est calcule par la carte graphique a partir du
/// temps ; les cinq aurores et les etoiles filantes (quelques sinus par image)
/// sur le fil du fond. Le fil principal n'a plus rien a faire.
nonisolated final class MoteurFond: @unchecked Sendable {
    enum Variante: Sendable { case mac, telephone }

    let couche = CAMetalLayer()
    let variante: Variante
    private let verrou = NSLock()
    private var taille: CGSize = .zero
    private var echelle: CGFloat = 2
    private var fige = false
    /// la fenetre est-elle recouverte (Mac) ? alors rien n'est dessine
    private var recouvert = false
    private var fil: Thread?
    private var delegue: Delegue?

    init(variante: Variante) {
        self.variante = variante
        couche.pixelFormat = .bgra8Unorm
        couche.isOpaque = true
        couche.framebufferOnly = true
        // les couleurs du theme sont en sRGB : la couche aussi (comme SwiftUI)
        couche.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        couche.device = MoteurFond.device
        couche.contentsGravity = .resize
        #if DEBUG
        fige = UserDefaults.standard.bool(forKey: "DropFondFige")
        #endif
    }

    /// une seule carte graphique pour tous les fonds (nil : pas de Metal, le
    /// fond SwiftUI d'origine prend le relais)
    static let device: MTLDevice? = MTLCreateSystemDefaultDevice()

    func configure(taille: CGSize, echelle: CGFloat) {
        guard taille.width > 0, taille.height > 0 else { return }
        verrou.withLock {
            self.taille = taille
            self.echelle = echelle
        }
        couche.contentsScale = echelle
        couche.drawableSize = CGSize(width: (taille.width * echelle).rounded(), height: (taille.height * echelle).rounded())
    }

    /// mouvements reduits : une image, puis plus rien
    func figeMouvement(_ oui: Bool) {
        verrou.withLock { fige = oui || fige }
    }

    /// la vue est a l'ecran : le fond s'anime ; cachee (autre onglet, fenetre
    /// recouverte, app en arriere-plan) : plus aucune image
    func visible(_ oui: Bool) {
        if oui { demarre() } else { arrete() }
    }

    /// une fenetre recouverte, miniaturisee ou sur un autre bureau : la boucle
    /// tourne a vide, sans rien dessiner
    func recouverte(_ oui: Bool) {
        verrou.withLock { recouvert = oui }
    }

    private func demarre() {
        guard fil == nil, let device = couche.device else { return }
        let delegue = Delegue(moteur: self, device: device)
        self.delegue = delegue
        nonisolated(unsafe) let lien = CAMetalDisplayLink(metalLayer: couche)
        // le fond n'a pas besoin de 120 images par seconde : 60 sur Mac, 30 sur
        // iPhone (les cadences de l'ancien fond)
        let cadence: Float = variante == .mac ? 60 : 30
        lien.preferredFrameRateRange = CAFrameRateRange(minimum: cadence / 2, maximum: cadence, preferred: cadence)
        lien.delegate = delegue
        let fil = Thread {
            lien.add(to: .current, forMode: .default)
            while !Thread.current.isCancelled {
                RunLoop.current.run(until: .now.addingTimeInterval(0.25))
            }
            lien.invalidate()
        }
        fil.name = "drop.fond"
        fil.qualityOfService = .userInitiated
        self.fil = fil
        fil.start()
    }

    private func arrete() {
        fil?.cancel()
        fil = nil
    }

    fileprivate func instantane() -> (CGSize, CGFloat, Bool, Bool) {
        verrou.withLock { (taille, echelle, fige, recouvert) }
    }

    // MARK: Le rendu (sur le fil du fond)

    private nonisolated final class Delegue: NSObject, CAMetalDisplayLinkDelegate, @unchecked Sendable {
        unowned let moteur: MoteurFond
        let device: MTLDevice
        let file: MTLCommandQueue?
        var pipelines: (nappe: MTLRenderPipelineState, aurores: MTLRenderPipelineState, taches: MTLRenderPipelineState, plus: MTLRenderPipelineState)?
        /// l'origine des temps : les phases sont recalees dessus (en double
        /// precision) pour que la carte graphique ne travaille qu'avec de
        /// petits nombres
        var t0: Double
        var tailleCalculee: CGSize = .zero
        var etoiles: MTLBuffer?
        var particules: MTLBuffer?
        var nEtoiles = 0
        var nParticules = 0
        var lissage = (x: 0.0, y: 0.0, temps: 0.0)
        var derniere: Double = -1
        var imageFigee = false

        init(moteur: MoteurFond, device: MTLDevice) {
            self.moteur = moteur
            self.device = device
            file = device.makeCommandQueue()
            t0 = Date.now.timeIntervalSinceReferenceDate
            super.init()
        }

        func prepare() -> Bool {
            if pipelines != nil { return true }
            guard let bibliotheque = MoteurFond.bibliotheque(device) else { return false }
            func pipeline(_ sommet: String, _ fragment: String, plus: Bool = false) throws -> MTLRenderPipelineState {
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = bibliotheque.makeFunction(name: sommet)
                d.fragmentFunction = bibliotheque.makeFunction(name: fragment)
                let c = d.colorAttachments[0]!
                c.pixelFormat = .bgra8Unorm
                c.isBlendingEnabled = true
                c.rgbBlendOperation = .add
                c.alphaBlendOperation = .add
                c.sourceRGBBlendFactor = .one
                c.sourceAlphaBlendFactor = .one
                // « over » en alpha premultiplie ; « plusLighter » : on ajoute
                c.destinationRGBBlendFactor = plus ? .one : .oneMinusSourceAlpha
                c.destinationAlphaBlendFactor = plus ? .one : .oneMinusSourceAlpha
                return try device.makeRenderPipelineState(descriptor: d)
            }
            do {
                pipelines = (
                    try pipeline("sommetNappe", "fragmentNappe"),
                    try pipeline("sommetPlein", "fragmentAurores"),
                    try pipeline("sommetTache", "fragmentTache"),
                    try pipeline("sommetTache", "fragmentTache", plus: true)
                )
                return true
            } catch {
                #if DEBUG
                print("fond : pipeline", error)
                #endif
                return false
            }
        }

        func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
            let (taille, echelle, fige, recouvert) = moteur.instantane()
            guard !recouvert, taille.width > 0, prepare(), let pipelines, let file else { return }
            // fige (mouvements reduits) : une image, redessinee seulement si la taille change
            if fige && imageFigee && taille == tailleCalculee { return }
            var t = fige ? 1000 : Date.now.timeIntervalSinceReferenceDate
            if fige { t0 = 1000 }
            // recalage des phases toutes les heures (precision des flottants)
            if t - t0 > 3600 { t0 = t; tailleCalculee = .zero }
            if taille != tailleCalculee { calculeTirages(taille) }
            let dt = Float(t - t0)

            guard let commandes = file.makeCommandBuffer() else { return }
            let passe = MTLRenderPassDescriptor()
            passe.colorAttachments[0].texture = update.drawable.texture
            passe.colorAttachments[0].loadAction = .clear
            // le fond du theme (graphite tres sombre)
            passe.colorAttachments[0].clearColor = MTLClearColor(red: 0.031, green: 0.027, blue: 0.043, alpha: 1)
            passe.colorAttachments[0].storeAction = .store
            guard let encodeur = commandes.makeRenderCommandEncoder(descriptor: passe) else { return }

            let mac = moteur.variante == .mac
            let parallaxe = pointeur(t, mac: mac)
            var commun = Commun(
                taille: SIMD2(Float(taille.width), Float(taille.height)),
                echelle: Float(echelle),
                dt: dt,
                parallaxe: SIMD2(Float(parallaxe.0), Float(parallaxe.1)),
                pointeur: SIMD2(Float((parallaxe.0 + 1) / 2 * taille.width), Float((parallaxe.1 + 1) / 2 * taille.height))
            )

            // 1. la nappe (MeshGradient d'origine : memes points, memes couleurs)
            var nappe = Self.nappe(t, mac: mac, parallaxe: parallaxe)
            encodeur.setRenderPipelineState(pipelines.nappe)
            encodeur.setVertexBytes(&commun, length: MemoryLayout<Commun>.stride, index: 0)
            encodeur.setVertexBytes(&nappe, length: MemoryLayout<Nappe>.stride, index: 1)
            let cotes = mac ? 4 : 3
            let mailles = (cotes - 1) * Self.finesse
            encodeur.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: mailles * mailles * 6)

            if mac {
                // 2. les aurores et la lueur sous le pointeur (plusLighter, puis
                // posees sur la nappe comme le calque du Canvas d'origine)
                var aurores = Self.aurores(t, taille, parallaxe)
                encodeur.setRenderPipelineState(pipelines.aurores)
                encodeur.setFragmentBytes(&commun, length: MemoryLayout<Commun>.stride, index: 0)
                encodeur.setFragmentBytes(&aurores, length: MemoryLayout<Aurores>.stride, index: 1)
                encodeur.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            }

            // 3. les etoiles (Mac) et les particules, dans l'ordre d'origine
            encodeur.setRenderPipelineState(pipelines.taches)
            encodeur.setVertexBytes(&commun, length: MemoryLayout<Commun>.stride, index: 0)
            if mac, let etoiles, nEtoiles > 0 {
                var genre: Int32 = 0
                encodeur.setVertexBuffer(etoiles, offset: 0, index: 1)
                encodeur.setVertexBytes(&genre, length: 4, index: 2)
                // un disque et les deux branches de sa croix par etoile
                encodeur.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 18, instanceCount: nEtoiles)
            }
            if let particules, nParticules > 0 {
                var genre: Int32 = mac ? 1 : 2
                encodeur.setVertexBuffer(particules, offset: 0, index: 1)
                encodeur.setVertexBytes(&genre, length: 4, index: 2)
                // le halo puis le coeur de chaque particule
                encodeur.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 12, instanceCount: nParticules)
            }

            // 4. les etoiles filantes (plusLighter)
            if mac {
                var filantes = Self.filantes(t, taille)
                if filantes.nombre > 0 {
                    var genre: Int32 = 3
                    encodeur.setRenderPipelineState(pipelines.plus)
                    encodeur.setVertexBytes(&filantes, length: MemoryLayout<Filantes>.stride, index: 1)
                    encodeur.setVertexBytes(&genre, length: 4, index: 2)
                    encodeur.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 12, instanceCount: Int(filantes.nombre))
                }
            }

            encodeur.endEncoding()
            commandes.present(update.drawable)
            commandes.commit()
            if fige { imageFigee = true }
        }

        /// le pointeur (Mac) ou l'inclinaison (iPhone), lisse comme avant
        private func pointeur(_ t: Double, mac: Bool) -> (Double, Double) {
            let cible = ParallaxePartagee.lis()
            guard mac else { return cible }
            // lissage exponentiel a chaque image (0,35 s), comme `FondMac.Lissage`
            let dt = lissage.temps == 0 ? 1 : min(max(t - lissage.temps, 0), 0.1)
            lissage.temps = t
            let k = 1 - exp(-dt / 0.35)
            lissage.x += (cible.0 - lissage.x) * k
            lissage.y += (cible.1 - lissage.y) * k
            return (lissage.x, lissage.y)
        }

        // MARK: Les tirages, calcules une fois (et a chaque taille de fenetre)

        private func calculeTirages(_ taille: CGSize) {
            tailleCalculee = taille
            let w = Double(taille.width), h = Double(taille.height)
            let deuxPi = 2 * Double.pi
            func phase(_ x: Double) -> Float { Float(x.truncatingRemainder(dividingBy: deuxPi)) }
            func modulo(_ x: Double, _ m: Double) -> Float {
                var r = x.truncatingRemainder(dividingBy: m)
                if r < 0 { r += m }
                return Float(r)
            }
            var etoilesT: [SIMD4<Float>] = []
            var particulesT: [SIMD4<Float>] = []
            if moteur.variante == .mac {
                let alea = DessinFondTirages.alea
                // 140 etoiles (FondMac.etoiles)
                let boucle = w + 40
                for i in 0..<140 {
                    let d = Double(i) + 100
                    let v = 1.5 + alea(d, 2.2) * 2.5
                    let w2 = 0.6 + alea(d, 4.4) * 1.6
                    etoilesT.append(SIMD4(modulo(alea(d, 1.1) * boucle - t0 * v, boucle), Float(v), Float(alea(d, 3.3)), Float(w2)))
                    etoilesT.append(SIMD4(phase(t0 * w2 + d * 3), Float(0.12 + alea(d, 5.5) * 0.25), Float(0.45 + alea(d, 6.6) * 0.7), alea(d, 7.7) < 0.35 ? 1 : 0))
                }
                // 120 particules (FondMac.particules)
                let haut = h + 60
                for i in 0..<120 {
                    let d = Double(i)
                    let z = 0.35 + alea(d, 0.7) * 0.65
                    let vitesse = (6 + alea(d, 1.3) * 16) * (0.5 + z)
                    let scint = 0.8 + alea(d, 5.1)
                    let tirage = alea(d, 7.9)
                    particulesT.append(SIMD4(Float(alea(d, 2.1)), modulo(t0 * vitesse + alea(d, 3.7) * haut, haut), Float(vitesse), Float(z)))
                    particulesT.append(SIMD4(phase(t0 * 0.3 + d), Float((0.5 + alea(d, 4.4) * 1.5) * (0.6 + z * 0.7)), Float(scint), phase(t0 * scint + d)))
                    particulesT.append(SIMD4(Float(0.15 + alea(d, 6.3) * 0.45), tirage < 0.3 ? 0 : (tirage < 0.85 ? 1 : 2), 0, 0))
                }
            } else {
                // 38 particules (AmbientBackground.particules, iPhone)
                for i in 0..<38 {
                    let graine = Double(i) * 12.9898
                    let alea = { (k: Double) in (sin(graine * k) * 43758.5453).truncatingRemainder(dividingBy: 1).magnitude }
                    let vitesse = 8 + alea(1.3) * 18
                    let scint = 0.8 + alea(5.1)
                    particulesT.append(SIMD4(Float(alea(2.1)), modulo(t0 * vitesse + alea(3.7) * h, h + 40), Float(vitesse), 1))
                    particulesT.append(SIMD4(phase(t0 * 0.3 + graine), Float(0.6 + alea(4.4) * 1.4), Float(scint), phase(t0 * scint + graine)))
                    particulesT.append(SIMD4(Float(0.15 + alea(6.3) * 0.45), alea(7.9) < 0.3 ? 0 : 3, 0, 0))
                }
            }
            nEtoiles = etoilesT.count / 2
            nParticules = particulesT.count / 3
            etoiles = etoilesT.isEmpty ? nil : device.makeBuffer(bytes: etoilesT, length: etoilesT.count * MemoryLayout<SIMD4<Float>>.stride)
            particules = particulesT.isEmpty ? nil : device.makeBuffer(bytes: particulesT, length: particulesT.count * MemoryLayout<SIMD4<Float>>.stride)
        }

        // MARK: Ce qui change a chaque image (quelques sinus, en double precision)

        static let finesse = 24

        /// les points de la nappe (FondMac.nappe / AmbientBackground.nappe)
        static func nappe(_ t: Double, mac: Bool, parallaxe: (Double, Double)) -> Nappe {
            var n = Nappe()
            if mac {
                let d = { (vitesse: Double, phase: Double) in Float(sin(t * vitesse + phase) * 0.1) }
                let p: [SIMD2<Float>] = [
                    [0, 0], [0.33 + d(0.11, 0), 0], [0.66 + d(0.09, 1), 0], [1, 0],
                    [0, 0.33 + d(0.08, 2)], [0.33 + d(0.13, 3), 0.33 + d(0.1, 4)], [0.66 + d(0.12, 5), 0.33 + d(0.09, 6)], [1, 0.33 + d(0.07, 7)],
                    [0, 0.66 + d(0.1, 8)], [0.33 + d(0.09, 9), 0.66 + d(0.12, 10)], [0.66 + d(0.11, 11), 0.66 + d(0.08, 12)], [1, 0.66 + d(0.1, 13)],
                    [0, 1], [0.33 + d(0.07, 14), 1], [0.66 + d(0.1, 15), 1], [1, 1],
                ]
                withUnsafeMutableBytes(of: &n.points) { $0.copyMemory(from: UnsafeRawBufferPointer(start: p, count: p.count * MemoryLayout<SIMD2<Float>>.stride)) }
                n.couleurs = PaletteFond.mac
                n.cotes = 4
                n.decalage = SIMD2(Float(parallaxe.0 * 22), Float(parallaxe.1 * 22))
                n.zoom = 1.15
                n.opacite = 0.92
            } else {
                let d = { (vitesse: Double, phase: Double) in Float(sin(t * vitesse + phase) * 0.12) }
                let p: [SIMD2<Float>] = [
                    [0, 0], [0.5 + d(0.11, 0), 0], [1, 0],
                    [0, 0.45 + d(0.09, 1)], [0.5 + d(0.13, 2), 0.5 + d(0.1, 3)], [1, 0.5 + d(0.08, 4)],
                    [0, 1], [0.5 + d(0.07, 5), 1], [1, 1],
                ]
                withUnsafeMutableBytes(of: &n.points) { $0.copyMemory(from: UnsafeRawBufferPointer(start: p, count: p.count * MemoryLayout<SIMD2<Float>>.stride)) }
                n.couleurs = PaletteFond.telephone
                n.cotes = 3
                n.decalage = SIMD2(Float(parallaxe.0 * 18), Float(parallaxe.1 * 18))
                n.zoom = 1.12
                n.opacite = 0.9
            }
            return n
        }

        /// les cinq aurores et la lueur sous le pointeur (FondMac.aurores, lueurPointeur)
        static func aurores(_ t: Double, _ taille: CGSize, _ parallaxe: (Double, Double)) -> Aurores {
            let w = Double(taille.width), h = Double(taille.height)
            let base = max(w, h)
            let alea = DessinFondTirages.alea
            var a = Aurores()
            var liste: [SIMD4<Float>] = []
            for i in 0..<5 {
                let d = Double(i) + 1
                let rayon = base * (0.3 + alea(d, 1.7) * 0.22)
                let vx = 0.05 + alea(d, 2.3) * 0.07
                let vy = 0.04 + alea(d, 3.1) * 0.06
                let profondeur = 24 + d * 7
                let cx = w * (0.5 + 0.44 * sin(t * vx + d * 1.9)) + parallaxe.0 * profondeur
                let cy = h * (0.45 + 0.4 * cos(t * vy + d * 2.7)) + parallaxe.1 * profondeur
                let souffle = 0.72 + 0.28 * sin(t * (0.15 + d * 0.03) + d)
                let o = (0.09 + alea(d, 4.1) * 0.08) * souffle
                liste.append(SIMD4(Float(cx), Float(cy), Float(rayon), Float(o)))
            }
            withUnsafeMutableBytes(of: &a.aurores) { $0.copyMemory(from: UnsafeRawBufferPointer(start: liste, count: liste.count * MemoryLayout<SIMD4<Float>>.stride)) }
            return a
        }

        /// une etoile filante toutes les quelques secondes (FondMac.filantes)
        static func filantes(_ t: Double, _ taille: CGSize) -> Filantes {
            let w = Double(taille.width), h = Double(taille.height)
            let alea = DessinFondTirages.alea
            var f = Filantes()
            var liste: [SIMD4<Float>] = []
            var presences: [Float] = []
            let periode = 6.5
            let n = (t / periode).rounded(.down)
            for k in [n - 1, n] {
                let graine = k.truncatingRemainder(dividingBy: 9973) + 1
                guard alea(graine, 0.37) < 0.7 else { continue }
                let debut = k * periode + alea(graine, 1.9) * 3
                let u = (t - debut) / 1.15
                guard u > 0, u < 1 else { continue }
                let versDroite = alea(graine, 2.8) < 0.6
                let angle = 0.3 + alea(graine, 3.9) * 0.28
                let dx = cos(angle) * (versDroite ? 1 : -1), dy = sin(angle)
                let x0 = versDroite ? w * (0.05 + alea(graine, 4.6) * 0.5) : w * (0.45 + alea(graine, 4.6) * 0.5)
                let y0 = h * (0.04 + alea(graine, 5.3) * 0.35)
                let avance = 1 - pow(1 - u, 2)
                let parcours = w * 0.42
                let tx = x0 + dx * parcours * avance, ty = y0 + dy * parcours * avance
                let longueur = (140 + alea(graine, 6.1) * 120) * (0.35 + 0.65 * sin(.pi * min(u * 1.4, 1)))
                liste.append(SIMD4(Float(tx - dx * longueur), Float(ty - dy * longueur), Float(tx), Float(ty)))
                presences.append(Float(sin(.pi * u)))
            }
            f.nombre = Int32(liste.count)
            for (i, v) in liste.enumerated() {
                if i == 0 { f.a = v; f.presence.x = presences[i] } else { f.b = v; f.presence.y = presences[i] }
            }
            return f
        }
    }

    // MARK: Ce que la carte graphique recoit

    struct Commun {
        var taille: SIMD2<Float>
        var echelle: Float
        var dt: Float
        var parallaxe: SIMD2<Float>
        var pointeur: SIMD2<Float>
    }

    struct Nappe {
        var points: (SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>,
                     SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>, SIMD2<Float>) =
            (.zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero)
        var couleurs: PaletteFond.Seize = PaletteFond.vide
        var decalage: SIMD2<Float> = .zero
        var zoom: Float = 1
        var opacite: Float = 1
        var cotes: Int32 = 4
        var finesse: Int32 = Int32(Delegue.finesse)
    }

    struct Aurores {
        var aurores: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>) = (.zero, .zero, .zero, .zero, .zero)
    }

    struct Filantes {
        var a: SIMD4<Float> = .zero
        var b: SIMD4<Float> = .zero
        var presence: SIMD2<Float> = .zero
        var nombre: Int32 = 0
    }

    // MARK: Les shaders (compiles une fois, au premier fond)

    private static let verrouBibliotheque = NSLock()
    nonisolated(unsafe) private static var bibliothequeCompilee: MTLLibrary?

    static func bibliotheque(_ device: MTLDevice) -> MTLLibrary? {
        verrouBibliotheque.withLock {
            if let b = bibliothequeCompilee { return b }
            do {
                let b = try device.makeLibrary(source: source, options: nil)
                bibliothequeCompilee = b
                return b
            } catch {
                #if DEBUG
                print("fond : shader non compile", error)
                #endif
                return nil
            }
        }
    }

    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct Commun { float2 taille; float echelle; float dt; float2 parallaxe; float2 pointeur; };
    struct Nappe { float2 points[16]; float4 couleurs[16]; float2 decalage; float zoom; float opacite; int cotes; int finesse; };
    struct Aurores { float4 aurores[5]; };
    struct Filantes { float4 a; float4 b; float2 presence; int nombre; };

    // --- La nappe : la grille de MeshGradient, surface bicubique (Catmull-Rom)
    // sur les points et sur les couleurs (smoothsColors) ---------------------------

    struct SommetNappe { float4 position [[position]]; float4 couleur; };

    template <typename T> T cr(T p0, T p1, T p2, T p3, float f) {
        float f2 = f * f, f3 = f2 * f;
        return 0.5f * ((2.0f * p1) + (-p0 + p2) * f + (2.0f * p0 - 5.0f * p1 + 4.0f * p2 - p3) * f2 + (-p0 + 3.0f * p1 - 3.0f * p2 + p3) * f3);
    }

    template <typename T> T surface(constant T *v, int n, float u, float w) {
        int iu = clamp(int(floor(u)), 0, n - 2), iw = clamp(int(floor(w)), 0, n - 2);
        float fu = u - float(iu), fw = w - float(iw);
        T lignes[4];
        for (int k = 0; k < 4; k++) {
            int r = clamp(iw - 1 + k, 0, n - 1);
            T a = v[r * n + clamp(iu - 1, 0, n - 1)], b = v[r * n + iu], c = v[r * n + iu + 1], d = v[r * n + clamp(iu + 2, 0, n - 1)];
            lignes[k] = cr(a, b, c, d, fu);
        }
        return cr(lignes[0], lignes[1], lignes[2], lignes[3], fw);
    }

    vertex SommetNappe sommetNappe(uint vid [[vertex_id]], constant Commun &c [[buffer(0)]], constant Nappe &n [[buffer(1)]]) {
        const int2 coins[6] = { int2(0, 0), int2(1, 0), int2(0, 1), int2(1, 0), int2(1, 1), int2(0, 1) };
        int cote = (n.cotes - 1) * n.finesse;
        int maille = int(vid) / 6;
        int2 ij = int2(maille % cote, maille / cote) + coins[vid % 6];
        float u = float(ij.x) / float(n.finesse), w = float(ij.y) / float(n.finesse);
        float2 p = surface(n.points, n.cotes, u, w);
        float4 col = surface(n.couleurs, n.cotes, u, w);
        // la vue de la nappe : agrandie autour du centre, decalee par la parallaxe
        float2 pt = (p * c.taille - c.taille * 0.5f) * n.zoom + c.taille * 0.5f + n.decalage;
        float2 clip = float2(pt.x / c.taille.x * 2.0f - 1.0f, 1.0f - pt.y / c.taille.y * 2.0f);
        SommetNappe s;
        s.position = float4(clip, 0, 1);
        s.couleur = col * n.opacite;
        return s;
    }

    // un tramage d'un demi-niveau : les grands degrades sombres ne font pas de
    // marches en 8 bits (l'ancien rendu travaillait en 16 bits)
    float trame(float2 p) { return fract(52.9829189f * fract(dot(p, float2(0.06711056f, 0.00583715f)))) - 0.5f; }

    fragment float4 fragmentNappe(SommetNappe s [[stage_in]]) {
        float4 c = s.couleur;
        c.rgb = max(c.rgb + trame(s.position.xy) / 255.0f * c.a, float3(0));
        return c;
    }

    // --- Les aurores et la lueur du pointeur (plusLighter dans le calque) --------

    struct Plein { float4 position [[position]]; };

    vertex Plein sommetPlein(uint vid [[vertex_id]]) {
        float2 p = float2((vid << 1) & 2, vid & 2);
        Plein s; s.position = float4(p * 2.0f - 1.0f, 0, 1); return s;
    }

    float rampe(float r, float a0, float a1) {
        // trois arrets : a0 au centre, a1 a 45 %, 0 au bord
        if (r < 0.45f) return mix(a0, a1, r / 0.45f);
        return mix(a1, 0.0f, clamp((r - 0.45f) / 0.55f, 0.0f, 1.0f));
    }

    fragment float4 fragmentAurores(Plein f [[stage_in]], constant Commun &c [[buffer(0)]], constant Aurores &a [[buffer(1)]]) {
        float2 p = f.position.xy / c.echelle;
        const float3 teintes[5] = { float3(110, 64, 240) / 255.0f, float3(170, 90, 255) / 255.0f, float3(80, 96, 255) / 255.0f, float3(200, 80, 230) / 255.0f, float3(140, 110, 255) / 255.0f };
        float4 somme = 0;
        for (int i = 0; i < 5; i++) {
            float4 au = a.aurores[i];
            float r = distance(p, au.xy) / au.z;
            if (r >= 1.0f) continue;
            float o = rampe(r, au.w, au.w * 0.45f);
            somme += float4(teintes[i] * o, o);
        }
        // la lueur sous le pointeur : violet vif, 11 % -> 4 % (a 40 %) -> 0, rayon 460
        float rp = distance(p, c.pointeur) / 460.0f;
        if (rp < 1.0f) {
            float o = rp < 0.4f ? mix(0.11f, 0.04f, rp / 0.4f) : mix(0.04f, 0.0f, (rp - 0.4f) / 0.6f);
            somme += float4(float3(170, 132, 255) / 255.0f * o, o);
        }
        somme = min(somme, float4(1));
        if (somme.a > 0.0f) somme.rgb = max(somme.rgb + trame(f.position.xy + 17.0f) / 255.0f, float3(0));
        return somme;
    }

    // --- Les taches : etoiles, croix, particules, etoiles filantes -------------

    struct Tache {
        float4 position [[position]];
        float2 ici;        // ce pixel, en points
        float2 a;          // centre (disque) ou debut (trait)
        float2 b;          // fin du trait
        float rayon;       // rayon (disque) ou demi-largeur (trait)
        float forme;       // 0 disque plein, 1 trait, 2 trait en degrade, 3 disque en degrade
        float4 couleur;    // premultipliee
        float4 couleur2;   // second arret (degrades)
        float presence;
    };

    float4 versClip(float2 pt, constant Commun &c) {
        return float4(pt.x / c.taille.x * 2.0f - 1.0f, 1.0f - pt.y / c.taille.y * 2.0f, 0, 1);
    }

    float pmod(float x, float m) { return x - m * floor(x / m); }

    // un quad autour d'un disque, ou le long d'un trait
    Tache carre(uint coin, float2 a, float2 b, float rayon, float forme, constant Commun &c) {
        const float2 coins[6] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(1, -1), float2(1, 1), float2(-1, 1) };
        float2 q = coins[coin];
        float marge = rayon + 1.5f / c.echelle;
        float2 pt;
        if (forme == 0.0f || forme == 3.0f) {
            pt = a + q * marge;
        } else {
            float2 axe = b - a; float l = max(length(axe), 1e-4f); float2 dir = axe / l; float2 nor = float2(-dir.y, dir.x);
            pt = mix(a, b, q.x * 0.5f + 0.5f) + dir * q.x * marge + nor * q.y * marge;
        }
        Tache t;
        t.position = versClip(pt, c); t.ici = pt; t.a = a; t.b = b; t.rayon = rayon; t.forme = forme;
        t.couleur = 0; t.couleur2 = 0; t.presence = 0;
        return t;
    }

    Tache rien() { Tache t; t.position = float4(2, 2, 2, 1); t.ici = 0; t.a = 0; t.b = 0; t.rayon = 0; t.forme = 0; t.couleur = 0; t.couleur2 = 0; t.presence = 0; return t; }

    vertex Tache sommetTache(uint vid [[vertex_id]], uint inst [[instance_id]], constant Commun &c [[buffer(0)]], constant float4 *d [[buffer(1)]], constant int &genre [[buffer(2)]]) {
        uint morceau = vid / 6, coin = vid % 6;
        float w = c.taille.x, h = c.taille.y;
        float px = c.parallaxe.x, py = c.parallaxe.y;

        if (genre == 0) {
            // une etoile : c, v, y, w2 | phase, base, r, croix
            float4 e0 = d[inst * 2], e1 = d[inst * 2 + 1];
            float boucle = w + 40.0f;
            float x = pmod(e0.x - c.dt * e0.y, boucle);
            float2 p = float2(x - 20.0f + px * 5.0f, e0.z * h + py * 5.0f);
            float eclat = pow(max(0.0f, sin(c.dt * e0.w + e1.x)), 4.0f);
            float al = e1.y * (0.35f + 0.65f * eclat);
            if (morceau == 0) {
                Tache t = carre(coin, p, p, e1.z, 0, c);
                t.couleur = float4(al, al, al, al);
                return t;
            }
            if (!(eclat > 0.8f && e1.w > 0.5f)) return rien();
            float l = 3.0f + e1.z * 5.0f * eclat;
            float2 a = morceau == 1 ? p - float2(l, 0) : p - float2(0, l);
            float2 b = morceau == 1 ? p + float2(l, 0) : p + float2(0, l);
            Tache t = carre(coin, a, b, 0.3f, 1, c);
            float ac = al * 0.55f;
            t.couleur = float4(ac, ac, ac, ac);
            return t;
        }

        if (genre == 1 || genre == 2) {
            // une particule : ax, cy, vitesse, z | phx, rayon, scint, phs | base, teinte
            float4 p0 = d[inst * 3], p1 = d[inst * 3 + 1], p2 = d[inst * 3 + 2];
            const float3 teintes[4] = { float3(1), float3(196, 170, 255) / 255.0f, float3(120, 176, 255) / 255.0f, float3(196, 170, 255) / 255.0f };
            float3 teinte = teintes[int(p2.y)];
            float2 p; float al; float halo; float rayon = p1.y;
            if (genre == 1) {
                // Mac : trois profondeurs, elles s'allument pres du pointeur
                float z = p0.w;
                float haut = h + 60.0f;
                float x = p0.x * w + sin(c.dt * 0.3f + p1.x) * 12.0f * z + px * 16.0f * z;
                float y = h + 30.0f - pmod(p0.y + c.dt * p0.z, haut) + py * 16.0f * z;
                p = float2(x, y);
                float scint = 0.5f + 0.5f * sin(c.dt * p1.z + p1.w);
                float proche = max(0.0f, 1.0f - distance(p, c.pointeur) / 220.0f);
                al = min(1.0f, p2.x * scint * (0.5f + z * 0.6f) * (1.0f + proche * 1.8f));
                halo = rayon * (3.2f + proche * 2.0f);
                if (morceau == 0) { Tache t = carre(coin, p, p, halo, 0, c); float o = al * 0.2f; t.couleur = float4(teinte * o, o); return t; }
            } else {
                // iPhone : la meme formule que l'ancien fond, deplacee par l'inclinaison
                float x = p0.x * w + sin(c.dt * 0.3f + p1.x) * 10.0f + px * 8.0f;
                float y = h - pmod(p0.y + c.dt * p0.z, h + 40.0f) + 20.0f + py * 8.0f;
                p = float2(x, y);
                float scint = 0.5f + 0.5f * sin(c.dt * p1.z + p1.w);
                al = p2.x * scint;
                halo = rayon * 3.0f;
                if (morceau == 0) { Tache t = carre(coin, p, p, halo, 0, c); float o = al * 0.18f; t.couleur = float4(teinte * o, o); return t; }
            }
            Tache t = carre(coin, p, p, rayon, 0, c);
            t.couleur = float4(teinte * al, al);
            return t;
        }

        // genre 3 : une etoile filante (queue, tete) -- le trait, puis sa tete
        constant Filantes &f = *(constant Filantes *)d;
        float4 ft = inst == 0 ? f.a : f.b;
        float pres = inst == 0 ? f.presence.x : f.presence.y;
        float2 queue = ft.xy, tete = ft.zw;
        if (morceau == 0) {
            Tache t = carre(coin, queue, tete, 0.8f, 2, c);
            t.presence = pres;
            return t;
        }
        Tache t = carre(coin, tete, tete, 7.0f, 3, c);
        t.presence = pres;
        return t;
    }

    fragment float4 fragmentTache(Tache t [[stage_in]], constant Commun &c [[buffer(0)]]) {
        float px = 1.0f / c.echelle;
        if (t.forme == 0.0f) {
            // un disque, bord lisse sur un pixel
            float couverture = clamp((t.rayon - distance(t.ici, t.a)) / px + 0.5f, 0.0f, 1.0f);
            return t.couleur * couverture;
        }
        float2 axe = t.b - t.a; float l = max(length(axe), 1e-4f); float2 dir = axe / l;
        float s = dot(t.ici - t.a, dir);
        if (t.forme == 1.0f) {
            // un trait fin, bouts droits
            float dist = abs(dot(t.ici - t.a, float2(-dir.y, dir.x)));
            float dans = (s >= 0.0f && s <= l) ? 1.0f : 0.0f;
            return t.couleur * clamp((t.rayon - dist) / px + 0.5f, 0.0f, 1.0f) * dans;
        }
        if (t.forme == 2.0f) {
            // le trait de l'etoile filante : blanc transparent -> lilas -> blanc, bouts ronds
            float u = clamp(s / l, 0.0f, 1.0f);
            float2 proche = t.a + dir * clamp(s, 0.0f, l);
            float couverture = clamp((t.rayon - distance(t.ici, proche)) / px + 0.5f, 0.0f, 1.0f);
            float3 lilas = float3(196, 170, 255) / 255.0f;
            float4 c0 = float4(1, 1, 1, 0), c1 = float4(lilas, 0.35f * t.presence), c2 = float4(1, 1, 1, 0.9f * t.presence);
            float4 col = u < 0.5f ? mix(c0, c1, u / 0.5f) : mix(c1, c2, (u - 0.5f) / 0.5f);
            return float4(col.rgb * col.a, col.a) * couverture;
        }
        // la tete : blanc -> lilas -> transparent
        float r = distance(t.ici, t.a) / t.rayon;
        if (r >= 1.0f) return 0;
        float3 lilas = float3(196, 170, 255) / 255.0f;
        float4 c0 = float4(1, 1, 1, 0.85f * t.presence), c1 = float4(lilas, 0.25f * t.presence), c2 = float4(1, 1, 1, 0);
        float4 col = r < 0.5f ? mix(c0, c1, r / 0.5f) : mix(c1, c2, (r - 0.5f) / 0.5f);
        return float4(col.rgb * col.a, col.a);
    }
    """
}

// MARK: - Les tirages pseudo-aleatoires (ceux de l'ancien fond, a l'identique)

nonisolated enum DessinFondTirages {
    /// un nombre pseudo-aleatoire stable dans 0...1 (FondMac `DessinFond.alea`)
    static let alea: @Sendable (Double, Double) -> Double = { i, k in
        (sin(i * 12.9898 * k + k * 78.233) * 43758.5453).truncatingRemainder(dividingBy: 1).magnitude
    }
}

// MARK: - Les couleurs de la nappe (premultipliees, sRGB)

nonisolated enum PaletteFond {
    typealias Seize = (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>,
                       SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>)
    static let vide: Seize = (.zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero)

    /// une couleur (0...1) et son opacite, premultipliee
    static func c(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> SIMD4<Float> {
        SIMD4(Float(r * a), Float(g * a), Float(b * a), Float(a))
    }

    static let noir = c(0.031, 0.027, 0.043)
    static let violetDark = (50.0 / 255, 28.0 / 255, 112.0 / 255)
    static let violetDeep = (110.0 / 255, 64.0 / 255, 240.0 / 255)

    /// FondMac.nappe, ligne par ligne
    static let mac: Seize = (
        c(violetDark.0, violetDark.1, violetDark.2, 0.95), c(violetDeep.0, violetDeep.1, violetDeep.2, 0.5), c(0.22, 0.07, 0.38), c(0.13, 0.05, 0.29),
        c(0.06, 0.04, 0.14), c(violetDark.0, violetDark.1, violetDark.2, 0.6), c(0.30, 0.10, 0.50, 0.55), c(0.25, 0.08, 0.42, 0.7),
        noir, c(0.10, 0.05, 0.25), c(violetDark.0, violetDark.1, violetDark.2, 0.5), c(0.08, 0.06, 0.22),
        noir, noir, c(0.05, 0.05, 0.16), c(0.10, 0.06, 0.26)
    )

    /// AmbientBackground.nappe (iPhone), 3 x 3 (le reste inutilise)
    static let telephone: Seize = (
        c(violetDark.0, violetDark.1, violetDark.2, 0.95), c(violetDeep.0, violetDeep.1, violetDeep.2, 0.55), c(0.18, 0.06, 0.32),
        noir, c(violetDark.0, violetDark.1, violetDark.2, 0.55), c(0.25, 0.08, 0.42, 0.7),
        noir, noir, c(0.08, 0.06, 0.22),
        .zero, .zero, .zero, .zero, .zero, .zero, .zero
    )
}

// MARK: - La parallaxe, lue par le fil du fond

/// Ou est le pointeur (Mac, -1...1) ou l'inclinaison lissee (iPhone) : ecrit
/// par le fil principal, lu par le fil du fond a chaque image.
nonisolated enum ParallaxePartagee {
    private static let verrou = NSLock()
    nonisolated(unsafe) private static var valeur = (0.0, 0.0)

    static func ecris(_ x: Double, _ y: Double) {
        verrou.withLock { valeur = (x, y) }
    }

    static func lis() -> (Double, Double) {
        verrou.withLock { valeur }
    }
}

// MARK: - La vue

/// Le fond Metal dans SwiftUI. Il ne s'anime que lorsqu'il est a l'ecran : un
/// onglet cache, une fenetre recouverte ou une app en arriere-plan ne
/// dessinent plus rien.
struct FondMetalVue: View {
    let variante: MoteurFond.Variante
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // (un GeometryReader qui ignore les marges, comme la meteorite : pose
        // directement sur la vue AppKit/UIKit, `ignoresSafeArea` ne la fait
        // pas passer sous la barre de titre -- les etoiles se decalaient)
        GeometryReader { geo in
            Hote(variante: variante, reduceMotion: reduceMotion)
                .frame(width: geo.size.width, height: geo.size.height)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    #if os(iOS)
    struct Hote: UIViewRepresentable {
        let variante: MoteurFond.Variante
        let reduceMotion: Bool

        final class Vue: UIView {
            let moteur: MoteurFond
            init(moteur: MoteurFond) {
                self.moteur = moteur
                super.init(frame: .zero)
                isUserInteractionEnabled = false
                layer.addSublayer(moteur.couche)
                NotificationCenter.default.addObserver(self, selector: #selector(actif), name: UIApplication.didBecomeActiveNotification, object: nil)
                NotificationCenter.default.addObserver(self, selector: #selector(inactif), name: UIApplication.didEnterBackgroundNotification, object: nil)
            }
            required init?(coder: NSCoder) { nil }
            override func layoutSubviews() {
                super.layoutSubviews()
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                moteur.couche.frame = bounds
                CATransaction.commit()
                moteur.configure(taille: bounds.size, echelle: min(window?.screen.scale ?? 3, 2))
            }
            override func didMoveToWindow() {
                super.didMoveToWindow()
                moteur.visible(window != nil && UIApplication.shared.applicationState != .background)
            }
            @objc private func actif() { moteur.visible(window != nil) }
            @objc private func inactif() { moteur.visible(false) }
            deinit { moteur.visible(false) }
        }

        func makeUIView(context: Context) -> Vue {
            let v = Vue(moteur: MoteurFond(variante: variante))
            v.moteur.figeMouvement(reduceMotion)
            return v
        }
        func updateUIView(_ vue: Vue, context: Context) { vue.moteur.figeMouvement(reduceMotion) }
    }
    #else
    struct Hote: NSViewRepresentable {
        let variante: MoteurFond.Variante
        let reduceMotion: Bool

        final class Vue: NSView {
            let moteur: MoteurFond
            init(moteur: MoteurFond) {
                self.moteur = moteur
                super.init(frame: .zero)
                wantsLayer = true
                layer?.addSublayer(moteur.couche)
            }
            required init?(coder: NSCoder) { nil }
            override func layout() {
                super.layout()
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                moteur.couche.frame = bounds
                CATransaction.commit()
                moteur.configure(taille: bounds.size, echelle: window?.backingScaleFactor ?? 2)
            }
            override func viewDidMoveToWindow() {
                super.viewDidMoveToWindow()
                NotificationCenter.default.removeObserver(self)
                if let window {
                    NotificationCenter.default.addObserver(self, selector: #selector(occlusion), name: NSWindow.didChangeOcclusionStateNotification, object: window)
                }
                // dans une fenetre : la boucle tourne ; elle ne dessine que si la
                // fenetre est visible (l'etat arrive par notification)
                moteur.visible(window != nil)
            }
            /// une fenetre recouverte, miniaturisee ou sur un autre bureau ne dessine plus
            @objc private func occlusion() {
                moteur.recouverte(window?.occlusionState.contains(.visible) == false)
            }
            override func hitTest(_ point: NSPoint) -> NSView? { nil }
            deinit { moteur.visible(false) }
        }

        func makeNSView(context: Context) -> Vue {
            let v = Vue(moteur: MoteurFond(variante: variante))
            v.moteur.figeMouvement(reduceMotion)
            return v
        }
        func updateNSView(_ vue: Vue, context: Context) { vue.moteur.figeMouvement(reduceMotion) }
    }
    #endif
}
