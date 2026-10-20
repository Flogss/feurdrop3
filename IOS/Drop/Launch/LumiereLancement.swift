import SwiftUI
import Metal
import QuartzCore

/// La sequence de lancement, dessinee par Metal sur son propre fil, a la
/// cadence de l'ecran : pendant ce temps l'interface se construit dessous
/// (sur le fil principal) sans jamais faire hoqueter la meteorite.
///
/// La meme scene que le site (public/lancement-rendu.js, meme calcul de la
/// lumiere, traduit en Metal) : une passe plein ecran pour l'espace (une
/// nebuleuse qui derive, trois plans d'etoiles en parallaxe), la meteorite
/// (une vraie roche eclairee, son bord incandescent, sa gaine de plasma, ses
/// failles qui s'allument), sa trainee, la fragmentation et l'onde qui ouvre
/// l'interface ; puis des traits calcules par la carte graphique a partir du
/// temps : les braises de la trainee, les eclats de roche qui deviennent
/// energie et tracent le symbole, quelques etincelles, le symbole en lumiere.
///
/// Le shader est compile au lancement (Metal le fait en quelques
/// millisecondes) : pas d'outil de compilation Metal a installer.
nonisolated final class MoteurLancement: @unchecked Sendable {
    let couche = CAMetalLayer()
    private let verrou = NSLock()
    private var decor: DecorLancement?
    private var debut: CFTimeInterval = 0
    /// l'instant de la sequence ou cette entree commence (le fond s'y allume)
    private var instantEntree: Double = 0
    private var fige: Double?
    private var fil: Thread?
    private var lien: CAMetalDisplayLink?
    private var delegue: Delegue?
    /// appele (sur le fil principal) des que la premiere image est a l'ecran
    var surPremiereImage: (@MainActor () -> Void)?

    init() {
        couche.pixelFormat = .bgra8Unorm
        couche.isOpaque = false
        couche.framebufferOnly = true
        couche.device = MTLCreateSystemDefaultDevice()
        #if DEBUG
        fige = LaunchSequence.fige
        #endif
    }

    /// le temps de la sequence part de maintenant moins `instant`
    func recommence(a instant: Double) {
        verrou.withLock { debut = CACurrentMediaTime() - instant }
    }

    func entree(_ instant: Double) {
        verrou.withLock { instantEntree = instant }
    }

    func configure(_ decor: DecorLancement, echelle: CGFloat) {
        verrou.withLock { self.decor = decor }
        couche.contentsScale = echelle
        couche.drawableSize = CGSize(width: decor.taille.width * echelle, height: decor.taille.height * echelle)
    }

    func demarre() {
        guard fil == nil, let device = couche.device else { return }
        let delegue = Delegue(moteur: self, device: device)
        self.delegue = delegue
        nonisolated(unsafe) let lien = CAMetalDisplayLink(metalLayer: couche)
        lien.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        lien.delegate = delegue
        self.lien = lien
        let fil = Thread {
            lien.add(to: .current, forMode: .default)
            while !Thread.current.isCancelled {
                RunLoop.current.run(until: .now.addingTimeInterval(0.25))
            }
            lien.invalidate()
        }
        fil.name = "drop.lancement"
        fil.qualityOfService = .userInteractive
        self.fil = fil
        fil.start()
    }

    func arrete() {
        fil?.cancel()
        fil = nil
    }

    fileprivate func instantane() -> (DecorLancement?, Double, Double) {
        verrou.withLock { (decor, debut, instantEntree) }
    }

    fileprivate func temps(_ presentation: CFTimeInterval, debut: Double) -> Double {
        fige ?? (presentation - debut)
    }

    // MARK: Le rendu (sur le fil de la sequence)

    private nonisolated final class Delegue: NSObject, CAMetalDisplayLinkDelegate, @unchecked Sendable {
        unowned let moteur: MoteurLancement
        let file: MTLCommandQueue?
        var scene: MTLRenderPipelineState?
        var traits: [String: MTLRenderPipelineState] = [:]
        var tampons: (decor: CGSize, eclats: MTLBuffer, braises: MTLBuffer, etincelles: MTLBuffer, segments: MTLBuffer, nombres: SIMD4<Int32>)?
        let device: MTLDevice
        var premiere = true
        #if DEBUG
        var instants: [CFTimeInterval] = []
        /// le temps de la sequence a la premiere image, et la compilation
        var premierT: Double?
        var dureePreparation: Double = 0
        let verrouGPU = NSLock()
        var tempsGPU: [Double] = []
        /// (instant de la sequence, temps GPU) : ou se trouvent les pics
        var parInstant: [(Double, Double)] = []
        #endif

        init(moteur: MoteurLancement, device: MTLDevice) {
            self.moteur = moteur
            self.device = device
            file = device.makeCommandQueue()
            super.init()
        }

        /// compile les shaders (une fois, sur ce fil)
        func prepare() -> Bool {
            if scene != nil { return true }
            #if DEBUG
            let debutPreparation = CACurrentMediaTime()
            defer { dureePreparation = (CACurrentMediaTime() - debutPreparation) * 1000 }
            #endif
            do {
                let bibliotheque = try device.makeLibrary(source: MoteurLancement.source, options: nil)
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = bibliotheque.makeFunction(name: "sommetPlein")
                d.fragmentFunction = bibliotheque.makeFunction(name: "lumiereLancement")
                d.colorAttachments[0].pixelFormat = .bgra8Unorm
                scene = try device.makeRenderPipelineState(descriptor: d)
                for nom in ["sommetBraise", "sommetEtincelle", "sommetEclat", "sommetNeon"] {
                    let t = MTLRenderPipelineDescriptor()
                    t.vertexFunction = bibliotheque.makeFunction(name: nom)
                    t.fragmentFunction = bibliotheque.makeFunction(name: "fragmentTrait")
                    let c = t.colorAttachments[0]!
                    c.pixelFormat = .bgra8Unorm
                    // alpha premultiplie : la lumiere s'ajoute (alpha nul), les
                    // fragments de roche encore sombres cachent ce qui est derriere
                    c.isBlendingEnabled = true
                    c.rgbBlendOperation = .add
                    c.alphaBlendOperation = .add
                    c.sourceRGBBlendFactor = .one
                    c.destinationRGBBlendFactor = .oneMinusSourceAlpha
                    c.sourceAlphaBlendFactor = .one
                    c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
                    traits[nom] = try device.makeRenderPipelineState(descriptor: t)
                }
                return true
            } catch {
                #if DEBUG
                print("lancement : shader non compile", error)
                #endif
                return false
            }
        }

        func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
            let (decorActuel, debut, entree) = moteur.instantane()
            guard let decor = decorActuel, prepare(), let scene, let file,
                  let commandes = file.makeCommandBuffer() else { return }
            let t = moteur.temps(update.targetPresentationTimestamp, debut: debut)
            #if DEBUG
            note(t)
            #endif
            let passe = MTLRenderPassDescriptor()
            passe.colorAttachments[0].texture = update.drawable.texture
            passe.colorAttachments[0].loadAction = .dontCare
            passe.colorAttachments[0].storeAction = .store
            guard let encodeur = commandes.makeRenderCommandEncoder(descriptor: passe) else { return }
            let tampons = tampons(decor)

            let m = decor.meteore(t)
            var u = uniformes(decor, t, m, entree: entree, echelle: Float(update.drawable.texture.width) / Float(max(decor.taille.width, 1)))
            var trainee = decor.trainee(t, vitesse: m.vitesse)
            u.compte = Int32(trainee.count / 4)
            u.boite = boite(trainee, decor.k)
            encodeur.setRenderPipelineState(scene)
            encodeur.setFragmentBytes(&u, length: MemoryLayout<Uniformes>.stride, index: 0)
            encodeur.setFragmentBytes(&trainee, length: trainee.count * MemoryLayout<Float>.stride, index: 1)
            encodeur.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

            // les braises, les eclats, les etincelles et le symbole
            let lots: [(String, MTLBuffer, Int32, Bool)] = [
                ("sommetBraise", tampons.braises, tampons.nombres.x, t > Scenario.depart && t < Scenario.arrivee + 1.3),
                ("sommetEtincelle", tampons.etincelles, tampons.nombres.y, t > Scenario.eclat && t < Scenario.eclat + 0.85),
                ("sommetEclat", tampons.eclats, tampons.nombres.z, t > Scenario.eclat && t < Scenario.logo + 0.34),
                ("sommetNeon", tampons.segments, tampons.nombres.w, t > Scenario.traceDebut && t < Scenario.logo + 0.36),
            ]
            for (nom, tampon, nombre, actif) in lots where actif && nombre > 0 {
                guard let pipeline = traits[nom] else { continue }
                encodeur.setRenderPipelineState(pipeline)
                encodeur.setVertexBuffer(tampon, offset: 0, index: 0)
                encodeur.setVertexBytes(&u, length: MemoryLayout<Uniformes>.stride, index: 1)
                encodeur.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: Int(nombre))
            }
            encodeur.endEncoding()
            commandes.present(update.drawable)
            #if DEBUG
            commandes.addCompletedHandler { [weak self] c in
                guard let self else { return }
                let d = (c.gpuEndTime - c.gpuStartTime) * 1000
                self.verrouGPU.withLock {
                    self.tempsGPU.append(d)
                    self.parInstant.append((t, d))
                }
            }
            #endif
            if premiere {
                premiere = false
                let moteur = moteur
                commandes.addCompletedHandler { _ in
                    DispatchQueue.main.async { moteur.surPremiereImage?() }
                }
            }
            commandes.commit()
        }

        private func uniformes(_ d: DecorLancement, _ t: Double, _ m: DecorLancement.Meteore, entree: Double, echelle: Float) -> Uniformes {
            let a = t - Scenario.eclat
            let s = d.secousse(a)
            let o = d.onde(t)
            // l'ambiance : le fond s'allume, s'assombrit quand la roche se
            // fissure (la lumiere se concentre sur elle), puis revient
            let retient = lisseLancement((t - Scenario.arrivee) / 0.3) * (1 - lisseLancement((t - Scenario.eclat) / 0.35))
            let ambiance = lisseLancement((t - entree) / 0.5) * (1 - 0.3 * retient)
            // la camera suit un peu la meteorite et avance doucement
            let suit = m.intensite > 0 && t < Scenario.arrivee
            let cam = suit ? SIMD2(Float((m.position.x - d.centre.x) * 0.06), Float((m.position.y - d.centre.y) * 0.06)) : .zero
            let avancee = 0.035 * lisseLancement(t / 3.2) + 0.03 * lisseLancement((t - Scenario.eclat) / 0.6)
            let loin = lisseLancement((t - 0.05) / 0.6) * (1 - 0.6 * lisseLancement((t - Scenario.depart) / 0.8))
            return Uniformes(
                tete: SIMD4(Float(m.position.x), Float(m.position.y), Float(m.rayon), Float(m.intensite)),
                mouvement: SIMD4(Float(m.direction.dx), Float(m.direction.dy), Float(m.vitesse), Float(m.profondeur)),
                roche: SIMD4(Float(m.rotation), Float(m.fissures), Float(m.dissolution), Float(m.chaleur)),
                eclat: SIMD4(Float(a), Float(d.k), Float(s.x), Float(s.y)),
                onde: SIMD4(Float(o.rayon), Float(o.bord), Float(o.eclat), Float(ambiance)),
                camera: SIMD4(cam.x, cam.y, Float(avancee), Float(d.R0)),
                lointain: SIMD4(Float(d.lointain.x), Float(d.lointain.y), Float(loin), 0),
                boite: .zero,
                taille: SIMD2(Float(d.taille.width), Float(d.taille.height)),
                centre: SIMD2(Float(d.centre.x), Float(d.centre.y)),
                t: Float(t), echelle: echelle, cote: Float(d.cote), k: Float(d.k),
                compte: 0
            )
        }

        /// la boite de la trainee, elargie de sa lueur : hors d'elle, le
        /// shader ne parcourt pas ses points
        private func boite(_ trainee: [Float], _ k: CGFloat) -> SIMD4<Float> {
            guard trainee.count >= 8 else { return .zero }
            var x0 = Float.greatestFiniteMagnitude, y0 = x0, x1 = -x0, y1 = -x0, marge: Float = 0
            for i in stride(from: 0, to: trainee.count, by: 4) {
                x0 = min(x0, trainee[i]); x1 = max(x1, trainee[i])
                y0 = min(y0, trainee[i + 1]); y1 = max(y1, trainee[i + 1])
                marge = max(marge, trainee[i + 2])
            }
            let m = marge * 22 + 30 * Float(k)
            return SIMD4(x0 - m, y0 - m, x1 + m, y1 + m)
        }

        /// les donnees des particules, chargees une fois par taille d'ecran
        private func tampons(_ d: DecorLancement) -> (decor: CGSize, eclats: MTLBuffer, braises: MTLBuffer, etincelles: MTLBuffer, segments: MTLBuffer, nombres: SIMD4<Int32>) {
            if let t = tampons, t.decor == d.taille { return t }
            func tampon(_ valeurs: [SIMD4<Float>]) -> MTLBuffer {
                let v = valeurs.isEmpty ? [SIMD4<Float>.zero] : valeurs
                return device.makeBuffer(bytes: v, length: v.count * MemoryLayout<SIMD4<Float>>.stride)!
            }
            let t = (d.taille, tampon(d.eclats), tampon(d.braises), tampon(d.etincelles), tampon(d.segments),
                     SIMD4(Int32(d.braises.count / 2), Int32(d.etincelles.count / 2), Int32(d.eclats.count / 4), Int32(d.segments.count / 2)))
            tampons = t
            return t
        }

        #if DEBUG
        /// mesure en developpement : la regularite des images de la sequence
        private func note(_ t: Double) {
            guard moteur.fige == nil else { return }
            if premierT == nil { premierT = t }
            instants.append(CACurrentMediaTime())
            guard t > 4.9, instants.count > 2 else { return }
            let ecarts = zip(instants.dropFirst(), instants).map { ($0 - $1) * 1000 }
            let debutTexte = String(format: "premiere image a t=%.3f s (compilation %.0f ms) ; 12 premiers ecarts : %@\n",
                                    premierT ?? -1, dureePreparation, ecarts.prefix(12).map { String(format: "%.0f", $0) }.joined(separator: " "))
            let tries = ecarts.sorted()
            let gpu = verrouGPU.withLock { tempsGPU }.sorted()
            let texte = String(format: "lancement : %d images en %.2f s, moyenne %.1f ms, p95 %.1f ms, pire %.1f ms, >20 ms : %d | GPU de la sequence : moyenne %.2f ms, p95 %.2f ms, pire %.2f ms",
                               instants.count, instants.last! - instants.first!, ecarts.reduce(0, +) / Double(ecarts.count),
                               tries[Int(Double(tries.count - 1) * 0.95)], tries.last!, ecarts.filter { $0 > 20 }.count,
                               gpu.isEmpty ? 0 : gpu.reduce(0, +) / Double(gpu.count), gpu.isEmpty ? 0 : gpu[Int(Double(gpu.count - 1) * 0.95)], gpu.last ?? 0)
            try? (debutTexte + texte).write(toFile: NSTemporaryDirectory() + "intro-perf.txt", atomically: true, encoding: .utf8)
            let serie = verrouGPU.withLock { parInstant }.map { String(format: "%.3f;%.2f", $0.0, $0.1) }.joined(separator: "\n")
            try? serie.write(toFile: NSTemporaryDirectory() + "intro-gpu.csv", atomically: true, encoding: .utf8)
        }
        #endif
    }

    /// les valeurs passees aux shaders (meme disposition que `Uniformes` en Metal)
    private nonisolated struct Uniformes {
        var tete: SIMD4<Float>
        var mouvement: SIMD4<Float>
        var roche: SIMD4<Float>
        var eclat: SIMD4<Float>
        var onde: SIMD4<Float>
        var camera: SIMD4<Float>
        var lointain: SIMD4<Float>
        var boite: SIMD4<Float>
        var taille: SIMD2<Float>
        var centre: SIMD2<Float>
        var t: Float
        var echelle: Float
        var cote: Float
        var k: Float
        var compte: Int32
        var reserve0: Int32 = 0
        var reserve1: Int32 = 0
        var reserve2: Int32 = 0
    }

    // MARK: Les shaders (traduits de public/lancement-rendu.js)

    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    constant float DEPART = \(Scenario.depart);
    constant float ARRIVEE = \(Scenario.arrivee);
    constant float ECLAT = \(Scenario.eclat);
    constant float LOGO = \(Scenario.logo);
    constant float TRACE0 = \(Scenario.traceDebut);
    constant float TRACED = \(Scenario.traceDuree);

    struct Uniformes {
        float4 tete;       // x, y, rayon, intensite
        float4 mouvement;  // direction x, y, vitesse, profondeur
        float4 roche;      // rotation, fissures, dissolution, chaleur
        float4 eclat;      // age de l'eclat, k, secousse x, y
        float4 onde;       // rayon, bord, eclat du bord, ambiance
        float4 camera;     // decalage x, y, avancee, rayon de la roche
        float4 lointain;   // x, y, eclat
        float4 boite;      // la boite de la trainee, lueur comprise
        float2 taille;
        float2 centre;
        float t;
        float echelle;     // pixels par point
        float cote;        // cote du logo
        float k;           // echelle de l'ecran
        int compte;        // points de la trainee
        int reserve0, reserve1, reserve2;
    };

    struct Sommet { float4 position [[position]]; };

    // un seul triangle qui couvre l'ecran
    vertex Sommet sommetPlein(uint id [[vertex_id]]) {
        float2 p = float2((id << 1) & 2, id & 2);
        Sommet s;
        s.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
        return s;
    }

    static float hash12(float2 p) { float3 p3 = fract(float3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    static float hash13(float3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
    static float3 hash33(float3 p3) { p3 = fract(p3 * float3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
    static float bruit2(float2 p) {
        float2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash12(i), hash12(i + float2(1.0, 0.0)), u.x), mix(hash12(i + float2(0.0, 1.0)), hash12(i + float2(1.0, 1.0)), u.x), u.y);
    }
    static float fbm2(float2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * bruit2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
    static float bruit3(float3 p) {
        float3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        float a = mix(hash13(i), hash13(i + float3(1, 0, 0)), u.x), b = mix(hash13(i + float3(0, 1, 0)), hash13(i + float3(1, 1, 0)), u.x);
        float c = mix(hash13(i + float3(0, 0, 1)), hash13(i + float3(1, 0, 1)), u.x), d = mix(hash13(i + float3(0, 1, 1)), hash13(i + float3(1, 1, 1)), u.x);
        return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
    }
    static float fbm3(float3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * bruit3(p); p = p * 2.1 + 5.3; a *= 0.5; } return s / 0.875; }
    // les failles de la roche : distance au bord de la cellule, la cellule, distance au centre
    static float3 cellules(float3 p) {
        float3 i = floor(p), f = fract(p);
        float d1 = 8.0, d2 = 8.0; float3 id = i;
        for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            float3 g = float3(float(x), float(y), float(z));
            float3 r = g + hash33(i + g) - f;
            float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; id = i + g; } else if (d < d2) { d2 = d; }
        }
        return float3(sqrt(d2) - sqrt(d1), hash13(id + 0.37), sqrt(d1));
    }
    static float3 couche(float2 q, float cs, float seuil, float eclat_, float r0, float2 dir, float etire, float graine, float t) {
        float2 id = floor(q / cs);
        float2 f = q - id * cs;
        float h = hash12(id + graine);
        if (h < seuil) return float3(0.0);
        float2 ou = (float2(hash12(id + graine + 7.1), hash12(id + graine + 3.7)) * 0.56 + 0.22) * cs;
        float2 d = f - ou;
        float le = dot(d, dir) / etire, tr = dot(d, float2(-dir.y, dir.x));
        float r = r0 * (0.55 + hash12(id + graine + 1.3));
        float scintille = 0.62 + 0.38 * sin(t * (1.3 + h * 3.0) + h * 40.0);
        float3 teinte = mix(float3(0.74, 0.70, 1.0), float3(1.0, 0.96, 1.0), hash12(id + graine + 9.0));
        return teinte * exp(-(le * le + tr * tr) / (r * r)) * (h - seuil) / (1.0 - seuil) * eclat_ * scintille / sqrt(etire);
    }
    static float3 tourne(float3 n, float a) {
        float c = cos(a), s = sin(a);
        n = float3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
        float c2 = cos(a * 0.37 + 0.6), s2 = sin(a * 0.37 + 0.6);
        return float3(n.x, c2 * n.y - s2 * n.z, s2 * n.y + c2 * n.z);
    }
    // la lumiere sature en douceur au lieu de bruler en blanc
    static float3 doux(float3 c) { return 1.0 - exp(-c * 1.18); }
    static float lisse(float x) { float c = clamp(x, 0.0, 1.0); return c * c * (3.0 - 2.0 * c); }
    static float entreeSortie(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }

    fragment float4 lumiereLancement(Sommet s [[stage_in]],
                                     constant Uniformes &u [[buffer(0)]],
                                     constant float4 *trainee [[buffer(1)]]) {
        float2 position = s.position.xy / u.echelle;
        float2 dcR = position - u.centre;
        // deja decouvert par l'onde : rien a calculer
        if (u.onde.x > 0.0 && length(dcR) < u.onde.x - u.onde.y * 1.35) return float4(0.0);
        float k = u.eclat.y;
        float a = u.eclat.x;
        float amb = u.onde.w;
        float t = u.t;
        float2 p = position - u.eclat.zw;
        float2 dc = p - u.centre;
        float dcl = length(dc);
        float diag = length(u.taille);
        float R0 = u.camera.w;
        float v = u.mouvement.z;
        float2 dir = u.mouvement.xy;

        // --- l'espace : graphite profond, une nebuleuse violette qui derive
        float2 uv = (p - 0.5 * u.taille) / u.taille.y;
        float3 c = float3(0.021, 0.019, 0.032);
        float n1 = fbm2(uv * 1.6 + float2(0.022 * t, -0.012 * t) + u.camera.xy * 0.0006);
        float n2 = fbm2(uv * 3.3 - float2(0.016 * t, 0.025 * t) + n1 * 1.4);
        c += float3(0.044, 0.019, 0.092) * smoothstep(0.45, 0.98, n1 + 0.3 * n2);
        c += float3(0.016, 0.008, 0.040) * n2 * n2;
        // la lumiere violette au loin, d'ou vient la meteorite
        float2 dl = (p - u.lointain.xy) / u.taille.y;
        c += float3(0.10, 0.045, 0.24) * exp(-length(dl) * 3.0) * (0.4 + 0.6 * u.lointain.z);
        c *= amb;

        // --- ou lire les etoiles : la meteorite courbe la lumiere, les ondes de
        // choc la font onduler, la camera la suit et avance
        float2 q = p;
        float2 dh = p - u.tete.xy;
        float dd = length(dh);
        if (u.tete.w > 0.001 && a <= 0.0) {
            float portee = u.tete.z * 2.4 + 2.0;
            q -= (dh / max(dd, 0.001)) * (3.0 + 11.0 * v) * k * min(u.mouvement.w, 1.0) * exp(-dd / portee);
        }
        float2 radial = dc / max(dcl, 0.001);
        float anneau1 = 0.0, anneau2 = 0.0, pr1 = 0.0, pr2 = 0.0;
        if (a > 0.0) {
            pr1 = clamp(a / 1.1, 0.0, 1.0);
            float r1 = (1.0 - pow(1.0 - pr1, 3.0)) * 0.8 * diag;
            float x1 = (dcl - r1) / ((4.0 + 40.0 * pr1) * k);
            anneau1 = exp(-x1 * x1);
            pr2 = clamp((a - 0.14) / 1.0, 0.0, 1.0);
            float r2 = (1.0 - pow(1.0 - pr2, 3.0)) * 0.55 * diag;
            float x2 = (dcl - r2) / ((3.0 + 26.0 * pr2) * k);
            anneau2 = pr2 > 0.0 ? exp(-x2 * x2) : 0.0;
            q -= radial * (12.0 * anneau1 * (1.0 - pr1) + 6.0 * anneau2 * (1.0 - pr2)) * k;
        }
        float3 etoiles = float3(0.0);
        etoiles += couche(u.centre + (q - u.centre) / (1.0 + 0.9 * u.camera.z) - u.camera.xy * 0.22, 46.0 * k, 0.72, 1.05, 1.2 * k, dir, 1.0 + v * 2.3, 11.0, t);
        etoiles += couche(u.centre + (q - u.centre) / (1.0 + 0.45 * u.camera.z) - u.camera.xy * 0.1, 28.0 * k, 0.56, 0.8, 0.85 * k, dir, 1.0 + v * 1.3, 23.0, t);
        etoiles += couche(q - u.camera.xy * 0.04, 17.0 * k, 0.46, 0.55, 0.62 * k, dir, 1.0 + v * 0.5, 37.0, t);
        c += etoiles * amb;

        // --- la trainee : son coeur, sa lueur, qui ondule et s'effiloche
        float coeurT = 0.0, lueurT = 0.0;
        bool pres = p.x > u.boite.x && p.y > u.boite.y && p.x < u.boite.z && p.y < u.boite.w;
        for (int j = 0; pres && j + 1 < u.compte; j++) {
            float4 A = trainee[j], B = trainee[j + 1];
            float2 pa = p - A.xy, ba = B.xy - A.xy;
            float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.001), 0.0, 1.0);
            float d = length(pa - ba * h);
            float l = max(mix(A.z, B.z, h), 0.3);
            float I = mix(A.w, B.w, h);
            float fj = float(j) + h;
            float ondule = 0.78 + 0.22 * sin(fj * 1.9 - t * 26.0) * sin(fj * 0.7 + t * 9.0);
            float x = d / (l * ondule);
            coeurT = max(coeurT, I * exp(-x * x));
            lueurT += I * 0.2 * exp(-d / (l * 3.2 + 2.0 * k)) * (0.7 + 0.3 * ondule);
        }
        c += mix(float3(0.46, 0.28, 1.0), float3(0.95, 0.91, 1.0), clamp(coeurT * 0.9, 0.0, 1.0)) * coeurT * 1.15;
        c += mix(float3(0.20, 0.09, 0.52), float3(0.52, 0.34, 1.0), clamp(lueurT * 1.4, 0.0, 1.0)) * lueurT * 1.35;

        // --- la meteorite
        if (u.tete.w > 0.001) {
            float2 perp = float2(-dir.y, dir.x);
            float R = max(u.tete.z, 0.5);
            // la lumiere s'etire derriere elle (le flou de mouvement), a peine devant
            float lon = dot(dh, dir);
            float2 e = float2(lon / (lon < 0.0 ? 1.0 + v * 2.2 : 1.0 + v * 0.25), dot(dh, perp));
            float le = length(e);
            float I = u.tete.w;
            float vie = 1.0 - u.roche.z;
            c += float3(0.20, 0.09, 0.48) * exp(-dd / (240.0 * k)) * I * 0.11 * vie;
            c += float3(0.44, 0.28, 1.0) * exp(-le / (R * 2.4 + 3.0 * k)) * I * 0.34 * vie;
            c += float3(0.82, 0.74, 1.0) * exp(-le / (R * 0.8 + 1.2 * k)) * I * 0.22 * vie;
            // au loin : un point, et ses aigrettes
            float loin = 1.0 - smoothstep(1.5, 7.0, R);
            if (loin > 0.0) {
                float aigrette = exp(-abs(dh.x) / (0.8 * k)) * exp(-abs(dh.y) / (24.0 * k)) + exp(-abs(dh.y) / (0.8 * k)) * exp(-abs(dh.x) / (24.0 * k));
                c += float3(0.72, 0.62, 1.0) * aigrette * loin * I * 0.45;
                c += float3(0.95, 0.9, 1.0) * exp(-dd * dd / (2.2 * k * k)) * loin * I * 1.1;
            }
            // l'onde de choc devant elle, et sa gaine de plasma
            float2 uu = e / R;
            if (v > 0.01 && le < R * 4.0) {
                float front = uu.x - (1.08 - 0.36 * uu.y * uu.y);
                float choc = exp(-abs(front) * 4.5) * smoothstep(2.1, 0.5, abs(uu.y)) * smoothstep(-1.6, -0.4, uu.x);
                c += float3(0.62, 0.50, 1.0) * choc * v * u.roche.w * 0.75 * I;
                float lu = length(uu);
                float gaine = exp(-max(lu - 1.0, 0.0) / 0.22) * pow(max(uu.x / max(lu, 0.001), 0.0), 1.5) * step(1.0, lu);
                c += float3(0.85, 0.78, 1.0) * gaine * v * u.roche.w * 0.9 * I;
            }
            // le corps : une roche eclairee (relief, crateres), son bord
            // incandescent du cote de la course, ses failles ; a peine etiree ;
            // a l'eclat, chaque piece se detache a son tour
            float2 ec = float2(dot(dh, dir) / (1.0 + v * 0.28), dot(dh, perp)) / R;
            float lc = length(ec);
            float2 sens = ec / max(lc, 0.001);
            float ca = cos(u.roche.x * 0.8), sa = sin(u.roche.x * 0.8);
            float bosse = bruit2(float2(ca * sens.x - sa * sens.y, sa * sens.x + ca * sens.y) * 1.7 + 4.0) - 0.5;
            float rr = lc / (1.0 + 0.16 * bosse);
            float couvre = (1.0 - smoothstep(1.0 - 1.6 / R, 1.0, rr)) * (1.0 - loin);
            if (couvre > 0.0) {
                float3 n = float3(ec / (1.0 + 0.16 * bosse), 0.0);
                n.z = sqrt(max(1.0 - dot(n.xy, n.xy), 0.0));
                float3 tn = tourne(n, u.roche.x);
                float relief = fbm3(tn * 3.4 + 3.1);
                float rx = fbm3((tn + float3(0.04, 0.0, 0.0)) * 3.4 + 3.1), ry = fbm3((tn + float3(0.0, 0.04, 0.0)) * 3.4 + 3.1);
                float3 cr = cellules(tn * 2.2 + 7.3);
                float cratere = 1.0 - smoothstep(0.12, 0.32, cr.z);
                float3 nb = normalize(n + float3(relief - rx, relief - ry, 0.0) * 9.0 + float3(sens * cratere * 0.35, 0.0) * step(0.55, cr.y));
                float3 L = normalize(float3(0.62, -0.42, 0.66));
                float diff = clamp(dot(nb, L), 0.0, 1.0);
                float3 albedo = mix(float3(0.040, 0.036, 0.058), float3(0.26, 0.23, 0.32), smoothstep(0.3, 0.78, relief)) * (1.0 - 0.45 * cratere * step(0.55, cr.y));
                float3 col = albedo * (0.1 + 1.2 * pow(diff, 1.3));
                float avant = clamp(dot(nb, normalize(float3(1.0, 0.0, 0.3))), 0.0, 1.0);
                col += mix(float3(0.5, 0.3, 1.0), float3(1.0, 0.94, 1.0), pow(avant, 6.0)) * pow(avant, 2.6) * u.roche.w * (0.3 + 1.05 * v) * (0.55 + 0.9 * relief);
                col += float3(0.48, 0.32, 1.0) * pow(1.0 - n.z, 2.4) * (0.45 + 0.6 * u.roche.w);
                float3 vo = cellules(tn * 2.7 + 1.7);
                float fis = (1.0 - smoothstep(0.0, 0.03 + 0.07 * u.roche.y, vo.x)) * u.roche.y;
                col += mix(float3(0.55, 0.35, 1.0), float3(1.0, 0.95, 1.0), u.roche.y * u.roche.y) * fis * 2.4;
                col += float3(0.30, 0.16, 0.85) * u.roche.y * u.roche.y * (1.0 - relief) * 0.9;
                float partie = smoothstep(vo.y - 0.05, vo.y + 0.05, u.roche.z * 1.12);
                col += float3(0.7, 0.55, 1.0) * smoothstep(0.0, 0.5, u.roche.z) * (1.0 - partie) * 0.6;
                couvre *= (1.0 - partie) * min(I * 1.6, 1.0);
                c = mix(c, col, couvre);
            }
        }

        // --- l'eclat : une lumiere violette qui se libere (pas d'eclair blanc),
        // un trait anamorphique, deux ondes de choc
        if (a > 0.0) {
            float f = 0.85 * exp(-a / 0.24) + 0.22 * exp(-a / 0.9);
            c += float3(0.60, 0.44, 1.0) * exp(-dcl / (R0 * 1.5)) * f * 0.85;
            c += float3(0.90, 0.85, 1.0) * exp(-dcl * dcl / (R0 * R0 * 0.3)) * exp(-a / 0.11) * 0.5;
            c += float3(0.30, 0.16, 0.80) * exp(-dcl / (230.0 * k)) * f * 0.13;
            float an = exp(-a / 0.3);
            c += float3(0.68, 0.58, 1.0) * exp(-abs(dc.y) / (1.1 * k)) * exp(-abs(dc.x) / (0.3 * u.taille.x)) * an * 0.55;
            c += float3(0.40, 0.28, 1.0) * exp(-abs(dc.y) / (14.0 * k)) * exp(-abs(dc.x) / (0.24 * u.taille.x)) * an * 0.12;
            c += float3(0.70, 0.60, 1.0) * anneau1 * 0.34 * pow(1.0 - pr1, 1.6);
            c += float3(0.50, 0.38, 1.0) * anneau2 * 0.2 * pow(1.0 - pr2, 1.6);
        }
        c = doux(c);
        // un vignettage doux et un grain de pellicule, a peine
        float2 vg = (position / u.taille - 0.5) * float2(u.taille.x / u.taille.y, 1.0);
        c *= 1.0 - 0.32 * smoothstep(0.3, 1.0, length(vg) * 1.15);
        c += (hash12(s.position.xy + fract(t * 7.13) * 400.0) - 0.5) * 0.014 * amb;

        // --- la revelation : dans l'onde, l'interface ; sur son bord, une
        // lumiere violette qui se diffracte
        float opacite = 1.0;
        float3 bord = float3(0.0);
        float eclatBord = 0.0;
        if (u.onde.x > 0.0) {
            float lr = length(dcR);
            float r = lr + (bruit2(dcR / max(lr, 0.001) * 2.6 + t * 1.7) - 0.5) * u.onde.y * 0.16;
            opacite = 1.0 - smoothstep(u.onde.x, u.onde.x - u.onde.y, r);
            float x = (r - u.onde.x + u.onde.y * 0.35) / (u.onde.y * 0.42);
            eclatBord = exp(-x * x) * u.onde.z;
            float x2 = (r - u.onde.x + u.onde.y * 0.12) / (u.onde.y * 0.22);
            bord = float3(0.55, 0.40, 1.0) * eclatBord * 0.55 + float3(0.92, 0.88, 1.0) * eclatBord * eclatBord * 0.2 + float3(0.32, 0.42, 1.0) * exp(-x2 * x2) * u.onde.z * 0.1;
        }
        return float4(c * opacite + bord, clamp(opacite + eclatBord * 0.3, 0.0, 1.0));
    }

    // --- les traits de lumiere : un segment (un point s'il est court), un
    // coeur et une lueur qui s'eteint avant le bord du quadrilatere (jamais de
    // carre) ; les eclats de roche ont en plus leur forme

    struct Trait {
        float4 position [[position]];
        float2 p;          // le pixel, en points
        float2 a, b;       // le segment
        float rayon, halo, alpha, degrade, etendue, forme, angle, graine;
        float3 couleur, lueur;
    };

    static float2 versEcran(float2 p, constant Uniformes &u) {
        return float2(p.x / u.taille.x * 2.0 - 1.0, 1.0 - p.y / u.taille.y * 2.0);
    }

    static Trait trait(uint v, float2 a, float2 b, float rayon, float halo, float alpha, float3 couleur, float3 lueur, float degrade, float forme, float angle, float graine, constant Uniformes &u) {
        Trait s;
        a += u.eclat.zw; b += u.eclat.zw;
        float2 d = b - a;
        float l = length(d);
        float2 axe = l > 0.01 ? d / l : float2(1.0, 0.0);
        float2 cote = float2(-axe.y, axe.x);
        float e = alpha > 0.002 ? rayon * 2.6 + halo * 5.0 : 0.0;
        float sx = (v & 1) ? 1.0 : -1.0, sy = (v & 2) ? 1.0 : -1.0;
        float2 p = (sx < 0.0 ? a - axe * e : b + axe * e) + cote * sy * e;
        s.position = float4(versEcran(p, u), 0.0, 1.0);
        s.p = p; s.a = a; s.b = b;
        s.rayon = max(rayon, 0.2); s.halo = max(halo, 0.2); s.alpha = alpha; s.degrade = degrade; s.etendue = max(e, 0.5);
        s.forme = forme; s.angle = angle; s.graine = graine;
        s.couleur = couleur; s.lueur = lueur;
        return s;
    }

    // un eclat de roche : un polygone irregulier (trois ou quatre faces)
    static float eclatForme(float2 p, float g) {
        float d = -1e3;
        float faces = fract(g * 13.7) < 0.5 ? 3.0 : 4.0;
        for (int i = 0; i < 4; i++) {
            float fi = float(i);
            if (fi >= faces) break;
            float ang = fi * 6.2831853 / faces + 0.7 * (fract(g * (3.1 + fi * 5.3)) - 0.5);
            float o = 0.42 + 0.3 * fract(g * (7.7 + fi * 2.9));
            d = max(d, dot(p, float2(cos(ang), sin(ang))) - o);
        }
        return d;
    }

    fragment float4 fragmentTrait(Trait s [[stage_in]]) {
        float2 pa = s.p - s.a, ba = s.b - s.a;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
        float d = length(pa - ba * h);
        float x = d / s.rayon;
        float queue = mix(1.0, h, s.degrade);
        float fenetre = 1.0 - smoothstep(s.etendue * 0.55, s.etendue * 0.98, d);
        float3 c = (s.couleur * exp(-x * x) + s.lueur * 0.3 * exp(-d / s.halo)) * queue * fenetre;
        float couvre = 0.0;
        if (s.forme > 0.001) {
            // tant que c'est un fragment : un corps de roche sombre, un fil
            // incandescent sur ses aretes, la lumiere violette qui en sort
            float2 l = s.p - s.b;
            float ca = cos(s.angle), sa = sin(s.angle);
            l = float2(ca * l.x - sa * l.y, sa * l.x + ca * l.y) / (s.rayon * 2.4);
            float tr = eclatForme(l, s.graine);
            float corps = 1.0 - smoothstep(-0.03, 0.04, tr);
            float arete = exp(-abs(min(tr, 0.0)) * 22.0) * corps;
            float3 roche = float3(0.07, 0.06, 0.1) + float3(0.16, 0.09, 0.36) * smoothstep(-0.5, 0.0, tr);
            float3 morceau = roche * corps + mix(s.lueur, s.couleur, 0.5) * arete * 0.9 + s.lueur * 0.22 * exp(-max(tr, 0.0) * 4.0) * fenetre;
            c = mix(c, morceau, s.forme);
            couvre = corps * s.forme * 0.9;
        }
        c *= s.alpha;
        return float4(c, clamp(max(max(c.r, max(c.g, c.b)) * 0.5, couvre * s.alpha), 0.0, 1.0));
    }

    constant float3 LILAS = float3(0.77, 0.67, 1.0);
    constant float3 BLANC = float3(1.0, 0.98, 1.0);
    constant float3 VIOLET = float3(0.55, 0.36, 1.0);

    // les braises semees par la trainee
    struct Braise { float4 a; float4 b; };   // naissance, x, y, vie ; vx, vy, rayon, eclat
    static float2 positionBraise(Braise b, float age, constant Uniformes &u) {
        float2 p = b.a.yz + b.b.xy * (1.0 - exp(-2.4 * age)) / 2.4;
        return p + float2(sin(age * 7.0 + b.a.x * 40.0), cos(age * 5.5 + b.a.x * 23.0)) * 5.0 * u.k * age;
    }
    vertex Trait sommetBraise(uint v [[vertex_id]], uint i [[instance_id]],
                              constant Braise *B [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Braise b = B[i];
        float age = u.t - b.a.x;
        float alpha = 0.0;
        float2 p = b.a.yz, avant = p;
        if (age > 0.0 && age < b.a.w) {
            p = positionBraise(b, age, u);
            avant = positionBraise(b, max(age - 0.022, 0.0), u);
            alpha = b.b.w * pow(1.0 - age / b.a.w, 1.4) * min(age / 0.05, 1.0) * 0.95;
        }
        float froid = clamp(age / b.a.w, 0.0, 1.0);
        float3 c = mix(b.b.w > 0.8 ? BLANC : LILAS, VIOLET, froid);
        return trait(v, avant, p, b.b.z * 0.75, b.b.z * 1.5, alpha, c, VIOLET, 1.0, 0.0, 0.0, 1.0, u);
    }

    // quelques etincelles a l'eclat
    struct Etincelle { float4 a; float4 b; };   // dx, dy, elan, vie ; largeur
    vertex Trait sommetEtincelle(uint v [[vertex_id]], uint i [[instance_id]],
                                 constant Etincelle *E [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Etincelle e = E[i];
        float age = u.t - ECLAT - 0.03;
        float alpha = 0.0;
        float2 tete = u.centre, queue = u.centre;
        if (age > 0.0 && age < e.a.w) {
            float freine = exp(-5.0 * age);
            tete = u.centre + e.a.xy * (e.a.z * (1.0 - freine) / 5.0 + u.camera.w * 0.8);
            queue = tete - e.a.xy * (min(e.a.z * freine * 0.05, 60.0 * u.k) + 2.0);
            alpha = pow(1.0 - age / e.a.w, 1.5) * min(age / 0.05, 1.0) * 0.6;
        }
        return trait(v, queue, tete, e.b.x * 0.5, e.b.x * 1.4, alpha, BLANC, LILAS, 1.0, 0.0, 0.0, 1.0, u);
    }

    // les eclats de la roche : ils jaillissent, ralentissent, deviennent energie,
    // puis sont attires un par un sur le symbole, qu'ils tracent en arrivant
    struct Eclat { float4 a; float4 b; float4 c; float4 d; };
    // depart (x, y), direction (x, y) ; elan, rotation, taille, graine ;
    // cible (x, y), debut et duree de l'attraction ; courbure, blanc, rang, allongement
    static float2 rafale(Eclat E, float tt, constant Uniformes &u) {
        float age = max(tt - ECLAT, 0.0);
        float2 p = u.centre + E.a.xy * u.camera.w + E.a.zw * E.b.x * (1.0 - exp(-3.2 * age)) / 3.2;
        return p + float2(sin(age * 2.3 + E.b.w * 6.28), cos(age * 1.9 + E.b.w * 9.0)) * 7.0 * u.k * min(age, 1.0);
    }
    static float2 positionEclat(Eclat E, float tt, constant Uniformes &u) {
        float2 b = rafale(E, tt, u);
        float e = entreeSortie(clamp((tt - E.c.z) / E.c.w, 0.0, 1.0));
        float2 cible = u.centre + E.c.xy * u.cote;
        float2 d = cible - b;
        float2 ctrl = (b + cible) * 0.5 + float2(-d.y, d.x) * E.d.x;
        float w = 1.0 - e;
        return w * w * b + 2.0 * e * w * ctrl + e * e * cible;
    }
    vertex Trait sommetEclat(uint v [[vertex_id]], uint i [[instance_id]],
                             constant Eclat *T [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Eclat E = T[i];
        float t = u.t;
        float age = t - ECLAT;
        float arrivee = E.c.z + E.c.w;
        float alpha = 0.0;
        float forme = lisse((age - 0.05) / 0.3);
        if (age > 0.0) {
            float pose = t > arrivee ? 1.0 + 1.1 * exp(-(t - arrivee) / 0.09) : 1.0;
            float scintille = t > arrivee ? 0.86 + 0.14 * sin(t * 10.0 + E.b.w * 50.0) : 1.0;
            alpha = min(age / 0.06, 1.0) * (1.0 - lisse((t - (LOGO + 0.02)) / 0.3)) * min(pose * scintille, 1.8);
        }
        float2 p = positionEclat(E, t, u), avant = positionEclat(E, t - 1.0 / 60.0, u);
        float taille = E.b.z * mix(1.0, 0.42, forme) * (t > arrivee ? 0.85 : 1.0);
        float3 c = (E.d.y > 0.5 || t > arrivee) ? BLANC : LILAS;
        return trait(v, avant, p, taille * 0.55, taille * 1.25 + 1.2 * u.k, alpha, c, VIOLET, 1.0, 1.0 - forme, E.b.y * age + E.b.w * 6.28, E.b.w, u);
    }

    // le symbole se trace en lumiere au rythme ou les eclats arrivent
    struct Segment { float4 ab; float4 info; };   // a, b ; debut et fin (part du trace), glyphe ?
    vertex Trait sommetNeon(uint v [[vertex_id]], uint i [[instance_id]],
                            constant Segment *S [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Segment s = S[i];
        float f = clamp((u.t - TRACE0) / TRACED, 0.0, 1.0);
        float alpha = (1.0 - lisse((u.t - (LOGO + 0.04)) / 0.3)) * lisse((u.t - TRACE0) / 0.12);
        float2 a = u.centre + s.ab.xy * u.cote, b = u.centre + s.ab.zw * u.cote;
        if (f <= s.info.x) alpha = 0.0;
        else if (f < s.info.y) b = mix(a, b, (f - s.info.x) / (s.info.y - s.info.x));
        bool glyphe = s.info.z > 0.5;
        return trait(v, a, b, (glyphe ? 1.15 : 0.85) * u.k, 3.4 * u.k, alpha * (glyphe ? 1.0 : 0.8), glyphe ? BLANC : LILAS, VIOLET, 0.0, 0.0, 0.0, 1.0, u);
    }
    """
}

// MARK: - La vue qui porte la couche Metal

/// La couche Metal du lancement dans l'interface : graphite tant que la
/// premiere image n'est pas la, puis transparente la ou l'onde est passee.
struct LumiereLancement {
    let moteur: MoteurLancement
}

#if os(iOS)
extension LumiereLancement: UIViewRepresentable {
    final class Hote: UIView {
        let moteur: MoteurLancement
        init(moteur: MoteurLancement) {
            self.moteur = moteur
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            backgroundColor = UIColor(red: 0.021, green: 0.019, blue: 0.032, alpha: 1)
            layer.addSublayer(moteur.couche)
            moteur.surPremiereImage = { [weak self] in self?.backgroundColor = .clear }
        }
        required init?(coder: NSCoder) { fatalError() }

        override func layoutSubviews() {
            super.layoutSubviews()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            moteur.couche.frame = bounds
            CATransaction.commit()
        }
    }

    func makeUIView(context: Context) -> Hote { Hote(moteur: moteur) }
    func updateUIView(_ vue: Hote, context: Context) {}
}
#else
extension LumiereLancement: NSViewRepresentable {
    final class Hote: NSView {
        let moteur: MoteurLancement
        init(moteur: MoteurLancement) {
            self.moteur = moteur
            super.init(frame: .zero)
            wantsLayer = true
            layer?.backgroundColor = CGColor(red: 0.021, green: 0.019, blue: 0.032, alpha: 1)
            layer?.addSublayer(moteur.couche)
            moteur.surPremiereImage = { [weak self] in self?.layer?.backgroundColor = .clear }
        }
        required init?(coder: NSCoder) { fatalError() }

        override var isFlipped: Bool { true }

        override func layout() {
            super.layout()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            moteur.couche.frame = bounds
            CATransaction.commit()
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> Hote { Hote(moteur: moteur) }
    func updateNSView(_ vue: Hote, context: Context) {}
}
#endif
