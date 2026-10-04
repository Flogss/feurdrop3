import SwiftUI
import Metal
import QuartzCore

/// La sequence de lancement, dessinee par Metal sur son propre fil, a la
/// cadence de l'ecran : pendant ce temps l'interface se construit dessous
/// (sur le fil principal) sans jamais faire hoqueter la meteorite.
///
/// Une passe plein ecran pour la lumiere continue (l'espace graphite et ses
/// etoiles que la meteorite courbe, la meteorite et sa trainee, l'impact,
/// l'onde qui ouvre l'interface), puis des traits additifs calcules par la
/// carte graphique a partir du temps : les braises de la course, les
/// etincelles de l'impact, les particules qui reviennent dessiner le
/// symbole, et le symbole trace en lumiere.
///
/// Le shader est compile au lancement (Metal le fait en quelques
/// millisecondes) : pas d'outil de compilation Metal a installer.
nonisolated final class MoteurLancement: @unchecked Sendable {
    let couche = CAMetalLayer()
    private let verrou = NSLock()
    private var decor: DecorLancement?
    private var debut: CFTimeInterval = 0
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

    fileprivate func instantane() -> (DecorLancement?, Double) {
        verrou.withLock { (decor, debut) }
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
        var tampons: (decor: CGSize, particules: MTLBuffer, braises: MTLBuffer, etincelles: MTLBuffer, segments: MTLBuffer, nombres: SIMD4<Int32>)?
        let device: MTLDevice
        var premiere = true
        #if DEBUG
        var instants: [CFTimeInterval] = []
        let verrouGPU = NSLock()
        var tempsGPU: [Double] = []
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
            do {
                let bibliotheque = try device.makeLibrary(source: MoteurLancement.source, options: nil)
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = bibliotheque.makeFunction(name: "sommetPlein")
                d.fragmentFunction = bibliotheque.makeFunction(name: "lumiereLancement")
                d.colorAttachments[0].pixelFormat = .bgra8Unorm
                scene = try device.makeRenderPipelineState(descriptor: d)
                for nom in ["sommetBraise", "sommetEtincelle", "sommetParticule", "sommetNeon"] {
                    let t = MTLRenderPipelineDescriptor()
                    t.vertexFunction = bibliotheque.makeFunction(name: nom)
                    t.fragmentFunction = bibliotheque.makeFunction(name: "fragmentTrait")
                    let c = t.colorAttachments[0]!
                    c.pixelFormat = .bgra8Unorm
                    // la lumiere s'ajoute
                    c.isBlendingEnabled = true
                    c.rgbBlendOperation = .add
                    c.alphaBlendOperation = .add
                    c.sourceRGBBlendFactor = .one
                    c.destinationRGBBlendFactor = .one
                    c.sourceAlphaBlendFactor = .one
                    c.destinationAlphaBlendFactor = .one
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
            let (decorActuel, debut) = moteur.instantane()
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

            var u = uniformes(decor, t, echelle: Float(update.drawable.texture.width) / Float(max(decor.taille.width, 1)))
            var trainee = decor.trainee(t)
            u.compte = Int32(trainee.count / 4)
            u.boite = boite(trainee, decor.k)
            encodeur.setRenderPipelineState(scene)
            encodeur.setFragmentBytes(&u, length: MemoryLayout<Uniformes>.stride, index: 0)
            encodeur.setFragmentBytes(&trainee, length: trainee.count * MemoryLayout<Float>.stride, index: 1)
            encodeur.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

            // la lumiere des particules, des braises, des etincelles et du symbole
            let lots: [(String, MTLBuffer, Int32, Bool)] = [
                ("sommetBraise", tampons.braises, tampons.nombres.x, t > Scenario.depart && t < Scenario.impact + 0.8),
                ("sommetEtincelle", tampons.etincelles, tampons.nombres.y, t > Scenario.impact && t < Scenario.impact + 0.9),
                ("sommetParticule", tampons.particules, tampons.nombres.z, t > Scenario.impact && t < Scenario.logo + 0.32),
                ("sommetNeon", tampons.segments, tampons.nombres.w, t > 1.84 && t < Scenario.logo + 0.34),
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
                self.verrouGPU.withLock { self.tempsGPU.append(d) }
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

        private func uniformes(_ d: DecorLancement, _ t: Double, echelle: Float) -> Uniformes {
            let m = d.meteore(t)
            let a = t - Scenario.impact
            let s = d.secousse(a)
            let o = d.onde(t)
            return Uniformes(
                tete: SIMD4(Float(m.position.x), Float(m.position.y), Float(m.intensite), Float(m.halo)),
                mouvement: SIMD4(Float(m.direction.dx), Float(m.direction.dy), Float(m.vitesse), Float(m.profondeur)),
                impact: SIMD4(Float(a), Float(d.k), Float(s.x), Float(s.y)),
                onde: SIMD4(Float(o.rayon), Float(o.bord), Float(o.eclat), Float(lisseLancement(t / 0.45))),
                boite: .zero,
                course: SIMD4(Float(d.depart.x), Float(d.depart.y), Float(d.controle.x), Float(d.controle.y)),
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
            let m = marge * 36 + 20 * Float(k)
            return SIMD4(x0 - m, y0 - m, x1 + m, y1 + m)
        }

        /// les donnees des particules, chargees une fois par taille d'ecran
        private func tampons(_ d: DecorLancement) -> (decor: CGSize, particules: MTLBuffer, braises: MTLBuffer, etincelles: MTLBuffer, segments: MTLBuffer, nombres: SIMD4<Int32>) {
            if let t = tampons, t.decor == d.taille { return t }
            func tampon(_ valeurs: [SIMD4<Float>]) -> MTLBuffer {
                let v = valeurs.isEmpty ? [SIMD4<Float>.zero] : valeurs
                return device.makeBuffer(bytes: v, length: v.count * MemoryLayout<SIMD4<Float>>.stride)!
            }
            let n = d.donneesGPU()
            let t = (d.taille, tampon(n.particules), tampon(n.braises), tampon(n.etincelles), tampon(n.segments),
                     SIMD4(Int32(n.braises.count / 2), Int32(n.etincelles.count / 2), Int32(n.particules.count / 3), Int32(n.segments.count / 2)))
            tampons = t
            return t
        }

        #if DEBUG
        /// mesure en developpement : la regularite des images de la sequence
        private func note(_ t: Double) {
            guard moteur.fige == nil else { return }
            instants.append(CACurrentMediaTime())
            guard t > 2.9, instants.count > 2 else { return }
            let ecarts = zip(instants.dropFirst(), instants).map { ($0 - $1) * 1000 }
            let tries = ecarts.sorted()
            let gpu = verrouGPU.withLock { tempsGPU }.sorted()
            let texte = String(format: "lancement : %d images en %.2f s, moyenne %.1f ms, p95 %.1f ms, pire %.1f ms, >20 ms : %d | GPU de la sequence : moyenne %.2f ms, p95 %.2f ms, pire %.2f ms",
                               instants.count, instants.last! - instants.first!, ecarts.reduce(0, +) / Double(ecarts.count),
                               tries[Int(Double(tries.count - 1) * 0.95)], tries.last!, ecarts.filter { $0 > 20 }.count,
                               gpu.isEmpty ? 0 : gpu.reduce(0, +) / Double(gpu.count), gpu.isEmpty ? 0 : gpu[Int(Double(gpu.count - 1) * 0.95)], gpu.last ?? 0)
            try? texte.write(toFile: NSTemporaryDirectory() + "intro-perf.txt", atomically: true, encoding: .utf8)
        }
        #endif
    }

    /// les valeurs passees aux shaders (meme disposition que `Uniformes` en Metal)
    private nonisolated struct Uniformes {
        var tete: SIMD4<Float>
        var mouvement: SIMD4<Float>
        var impact: SIMD4<Float>
        var onde: SIMD4<Float>
        var boite: SIMD4<Float>
        var course: SIMD4<Float>
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

    // MARK: Les shaders

    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    constant float DEPART = \(Scenario.depart);
    constant float IMPACT = \(Scenario.impact);
    constant float LOGO = \(Scenario.logo);

    struct Uniformes {
        float4 tete;       // x, y, intensite, rayon du halo
        float4 mouvement;  // direction x, y (unitaire), vitesse 0...1, profondeur 0...1
        float4 impact;     // temps depuis l'impact (<0 avant), echelle, secousse x, y
        float4 onde;       // rayon de l'onde de revelation, largeur du bord, eclat du bord, apparition
        float4 boite;      // la boite de la trainee, lueur comprise
        float4 course;     // depart x, y, point de controle x, y
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

    static float alea(float2 p) {
        p = fract(p * float2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }

    // la lumiere sature en douceur au lieu de bruler en blanc
    static float3 doux(float3 c) {
        return 1.0 - exp(-c * 1.15);
    }

    static float lisse(float x) {
        float c = clamp(x, 0.0, 1.0);
        return c * c * (3.0 - 2.0 * c);
    }

    static float entreeSortie(float x) {
        return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0;
    }

    fragment float4 lumiereLancement(Sommet s [[stage_in]],
                                     constant Uniformes &u [[buffer(0)]],
                                     constant float4 *trainee [[buffer(1)]]) {
        float2 position = s.position.xy / u.echelle;
        // deja decouvert par l'onde : rien a calculer
        if (u.onde.x > 0.0 && length(position - u.centre) < u.onde.x - u.onde.y * 1.2) return float4(0.0);
            float k = u.impact.y;
            float2 p = position - u.impact.zw;
            float diag = length(u.taille);
            float a = u.impact.x;

            // --- le fond : graphite, une nebuleuse violette tres sombre, un vignettage
            float3 c = float3(0.027, 0.024, 0.040);
            float2 uv = p / u.taille;
            float2 ecart = (uv - float2(0.5, 0.42)) * float2(u.taille.x / u.taille.y, 1.0);
            c += float3(0.034, 0.018, 0.078) * exp(-dot(ecart, ecart) * 2.4) * u.onde.w;
            c += float3(0.020, 0.008, 0.048) * exp(-length(uv - float2(0.15, 0.1)) * 3.2) * u.onde.w;

            // --- ou lire les etoiles : la meteorite les ecarte (lentille), les ondes
            // de choc les font onduler
            float2 q = p;
            float2 dh = p - u.tete.xy;
            float dd = length(dh);
            if (u.tete.z > 0.001) {
                float portee = u.tete.w * 0.55 + 1.0;
                q -= (dh / max(dd, 0.001)) * (6.0 + 18.0 * u.mouvement.z) * k * u.mouvement.w * exp(-dd / portee);
            }
            float2 dc = p - u.centre;
            float dcl = length(dc);
            float2 radial = dc / max(dcl, 0.001);
            float anneau1 = 0.0, anneau2 = 0.0, pr1 = 0.0, pr2 = 0.0;
            if (a > 0.0) {
                pr1 = clamp(a / 0.95, 0.0, 1.0);
                float r1 = (1.0 - pow(1.0 - pr1, 3.0)) * 0.85 * diag;
                float l1 = (3.0 + 34.0 * pr1) * k;
                float x1 = (dcl - r1) / l1;
                anneau1 = exp(-x1 * x1);
                pr2 = clamp((a - 0.12) / 0.9, 0.0, 1.0);
                float r2 = (1.0 - pow(1.0 - pr2, 3.0)) * 0.6 * diag;
                float l2 = (2.0 + 22.0 * pr2) * k;
                float x2 = (dcl - r2) / l2;
                anneau2 = pr2 > 0.0 ? exp(-x2 * x2) : 0.0;
                q -= radial * (14.0 * anneau1 * (1.0 - pr1) + 8.0 * anneau2 * (1.0 - pr2)) * k;
            }

            // --- les etoiles : une par case, etirees dans le sens de la course quand
            // la meteorite file (sensation de vitesse)
            float cote = 30.0 * k;
            float2 caseId = floor(q / cote);
            float2 dansCase = q - caseId * cote;
            float tirage = alea(caseId);
            if (tirage > 0.38) {
                float2 ou = (float2(alea(caseId + 7.1), alea(caseId + 3.7)) * 0.5 + 0.25) * cote;
                float2 d = dansCase - ou;
                float2 dir = u.mouvement.xy;
                float le = dot(d, dir), tr = dot(d, float2(-dir.y, dir.x));
                le /= 1.0 + u.mouvement.z * 3.2 * step(0.001, u.tete.z);
                float r = (0.45 + alea(caseId + 1.3) * 0.75) * k;
                float scintille = 0.55 + 0.45 * sin(u.t * (1.5 + tirage * 3.0) + tirage * 40.0);
                float eclat = (tirage - 0.38) * 1.6 * scintille;
                c += float3(0.82, 0.78, 1.0) * eclat * exp(-(le * le + tr * tr) / (r * r)) * u.onde.w;
            }

            // --- la meteorite : un coeur blanc-violet, un halo, une grande lumiere
            // douce qui eclaire l'espace autour d'elle ; etiree par la vitesse
            if (u.tete.z > 0.001 && dd < max(u.tete.w * 9.0, 900.0 * k)) {
                float2 dir = u.mouvement.xy;
                float le = dot(dh, dir), tr = dot(dh, float2(-dir.y, dir.x));
                float etire = 1.0 + u.mouvement.z * 2.6;
                float2 e = float2(le / etire, tr);
                float r = u.tete.w;
                float rc = r * 0.085;
                float coeur = exp(-dot(e, e) / (rc * rc));
                float halo = exp(-length(e) / (r * 0.26));
                float large = exp(-length(e) / (r * 1.1));
                c += (float3(1.0, 0.96, 1.0) * coeur * 1.35
                      + float3(0.70, 0.58, 1.0) * halo * 0.70
                      + float3(0.40, 0.26, 0.92) * large * 0.10) * u.tete.z;
                // un fin trait anamorphique sur la tete (comme une optique de cinema)
                c += float3(0.62, 0.52, 1.0) * exp(-abs(dh.y) / (1.1 * k)) * exp(-abs(dh.x) / (r * 1.5)) * 0.4 * u.tete.z;
                // la lumiere qui baigne la nebuleuse
                c += float3(0.16, 0.08, 0.38) * exp(-dd / (170.0 * k)) * u.tete.z * 0.22;
            }

            // --- la trainee : le coeur (max) et sa lueur (somme)
            float coeurT = 0.0, lueurT = 0.0;
            bool pres = p.x > u.boite.x && p.y > u.boite.y && p.x < u.boite.z && p.y < u.boite.w;
            for (int j = 0; pres && j + 1 < u.compte; j++) {
                float4 A = trainee[j], B = trainee[j + 1];
                float2 pa = p - A.xy, ba = B.xy - A.xy;
                float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.001), 0.0, 1.0);
                float d = length(pa - ba * h);
                float l = max(mix(A.z, B.z, h), 0.25);
                float I = mix(A.w, B.w, h);
                float x = d / l;
                coeurT = max(coeurT, I * exp(-x * x));
                lueurT += I * 0.22 * exp(-d / (l * 4.0 + 2.0 * k));
            }
            c += mix(float3(0.42, 0.26, 0.95), float3(0.92, 0.88, 1.0), clamp(coeurT, 0.0, 1.0)) * coeurT * 1.25;
            c += float3(0.48, 0.32, 1.0) * lueurT * 1.3;

            // --- l'impact : un eclair contenu (jamais un ecran blanc), le trait
            // anamorphique, les deux ondes de choc, un voile qui retombe
            if (a > 0.0) {
                float f = 1.0 * exp(-a / 0.085) + 0.42 * exp(-a / 0.5);
                float xc = dcl / (20.0 * k);
                c += float3(0.92, 0.86, 1.0) * exp(-xc * xc) * f * 0.62;
                c += float3(0.60, 0.44, 1.0) * exp(-dcl / (58.0 * k)) * f * 0.6;
                c += float3(0.34, 0.20, 0.85) * exp(-dcl / (200.0 * k)) * f * 0.09;
                float an = exp(-a / 0.34);
                c += float3(0.72, 0.62, 1.0) * exp(-abs(dc.y) / (1.2 * k)) * exp(-abs(dc.x) / (0.36 * u.taille.x)) * an * 0.85;
                c += float3(0.42, 0.30, 1.0) * exp(-abs(dc.y) / (15.0 * k)) * exp(-abs(dc.x) / (0.28 * u.taille.x)) * an * 0.16;
                c += float3(0.74, 0.62, 1.0) * anneau1 * 0.5 * pow(1.0 - pr1, 1.5);
                c += float3(0.55, 0.42, 1.0) * anneau2 * 0.28 * pow(1.0 - pr2, 1.5);
                c += float3(0.03, 0.014, 0.07) * exp(-a / 0.5);
            }

            c = doux(c);

            // --- la revelation : dans l'onde, l'interface ; sur son bord, une
            // lumiere violette qui passe sur l'interface (additive)
            float opacite = 1.0;
            float3 bord = float3(0.0);
            float eclatBord = 0.0;
            if (u.onde.x > 0.0) {
                float dedans = smoothstep(u.onde.x, u.onde.x - u.onde.y, dcl);
                opacite = 1.0 - dedans;
                float x = (dcl - u.onde.x + u.onde.y * 0.35) / (u.onde.y * 0.45);
                eclatBord = exp(-x * x) * u.onde.z;
                bord = float3(0.55, 0.40, 1.0) * eclatBord * 0.6 + float3(0.95, 0.90, 1.0) * eclatBord * eclatBord * 0.25;
            }
            float3 rgb = c * opacite + bord;
            return float4(rgb, clamp(opacite + eclatBord * 0.3, 0.0, 1.0));
    }

    // --- les traits de lumiere : un segment (un point s'il est court), un
    // coeur et une lueur, ajoutes a l'image

    struct Trait {
        float4 position [[position]];
        float2 p;          // le pixel, en points
        float2 a, b;       // le segment
        float rayon, halo, alpha, degrade;
        float3 couleur, lueur;
    };

    static float2 versEcran(float2 p, constant Uniformes &u) {
        return float2(p.x / u.taille.x * 2.0 - 1.0, 1.0 - p.y / u.taille.y * 2.0);
    }

    // le rectangle qui couvre le segment et sa lueur
    static Trait trait(uint v, float2 a, float2 b, float rayon, float halo, float alpha, float3 couleur, float3 lueur, float degrade, constant Uniformes &u) {
        Trait s;
        float2 secousse = u.impact.zw;
        a += secousse; b += secousse;
        float2 d = b - a;
        float l = length(d);
        float2 axe = l > 0.01 ? d / l : float2(1.0, 0.0);
        float2 cote = float2(-axe.y, axe.x);
        float e = alpha > 0.002 ? rayon * 2.5 + halo * 4.5 : 0.0;
        float sx = (v & 1) ? 1.0 : -1.0, sy = (v & 2) ? 1.0 : -1.0;
        float2 p = (sx < 0.0 ? a - axe * e : b + axe * e) + cote * sy * e;
        s.position = float4(versEcran(p, u), 0.0, 1.0);
        s.p = p; s.a = a; s.b = b;
        s.rayon = max(rayon, 0.2); s.halo = max(halo, 0.2); s.alpha = alpha; s.degrade = degrade;
        s.couleur = couleur; s.lueur = lueur;
        return s;
    }

    fragment float4 fragmentTrait(Trait s [[stage_in]]) {
        float2 pa = s.p - s.a, ba = s.b - s.a;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
        float d = length(pa - ba * h);
        float x = d / s.rayon;
        float queue = mix(1.0, h, s.degrade);
        float3 c = (s.couleur * exp(-x * x) + s.lueur * 0.3 * exp(-d / s.halo)) * s.alpha * queue;
        return float4(c, max(c.r, max(c.g, c.b)) * 0.6);
    }

    constant float3 LILAS = float3(0.77, 0.67, 1.0);
    constant float3 BLANC = float3(1.0, 0.98, 1.0);
    constant float3 VIOLET = float3(0.57, 0.38, 1.0);

    static float2 courbe(float u, constant Uniformes &U) {
        float v = 1.0 - u;
        return v * v * U.course.xy + 2.0 * u * v * U.course.zw + u * u * U.centre;
    }

    // les braises semees pendant la course
    struct Braise { float4 a; float4 b; };   // naissance, x, y, vie ; vx, vy, rayon, eclat
    vertex Trait sommetBraise(uint v [[vertex_id]], uint i [[instance_id]],
                              constant Braise *B [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Braise b = B[i];
        float age = u.t - b.a.x;
        float alpha = 0.0;
        float2 p = b.a.yz;
        if (age > 0.0 && age < b.a.w) {
            float f = (1.0 - exp(-2.2 * age)) / 2.2;
            p += b.b.xy * f;
            alpha = b.b.w * pow(1.0 - age / b.a.w, 1.5) * 0.9;
        }
        float3 c = b.b.w > 0.85 ? BLANC : LILAS;
        return trait(v, p, p, b.b.z * 0.8, b.b.z * 1.3, alpha, c, c, 0.0, u);
    }

    // les etincelles de l'impact : des traits qui freinent, la queue s'efface
    struct Etincelle { float4 a; float4 b; };   // dx, dy, elan, vie ; largeur
    vertex Trait sommetEtincelle(uint v [[vertex_id]], uint i [[instance_id]],
                                 constant Etincelle *E [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Etincelle e = E[i];
        float age = u.t - IMPACT;
        float alpha = 0.0;
        float2 tete = u.centre, queue = u.centre;
        if (age > 0.0 && age < e.a.w) {
            float freine = exp(-5.0 * age);
            float parcours = e.a.z * (1.0 - freine) / 5.0 + 14.0 * u.k;
            tete = u.centre + e.a.xy * parcours;
            float longueur = min(e.a.z * freine * 0.045, 64.0 * u.k) + 2.0;
            queue = tete - e.a.xy * longueur;
            alpha = pow(1.0 - age / e.a.w, 1.4) * min(age / 0.06, 1.0) * 0.75;
        }
        return trait(v, queue, tete, e.b.x * 0.55, e.b.x * 1.4, alpha, BLANC, LILAS, 1.0, u);
    }

    // les fragments de l'impact, qui reviennent en spirale dessiner le symbole
    struct Particule { float4 a; float4 b; float4 c; };   // cible x, y, dir x, y ; elan, debut, duree, spirale ; rayon, blanche
    static float2 positionParticule(Particule P, float t, constant Uniformes &u) {
        float age = max(t - IMPACT, 0.0);
        float jet = P.b.x * (1.0 - exp(-3.4 * age)) / 3.4;
        float2 eclat = u.centre + P.a.zw * jet;
        float e = entreeSortie(clamp((t - P.b.y) / P.b.z, 0.0, 1.0));
        float2 cible = u.centre + P.a.xy * u.cote;
        float2 d = cible - eclat;
        float spirale = P.b.w * sin(3.14159265 * e);
        return float2(eclat.x + d.x * e - d.y * spirale, eclat.y + d.y * e + d.x * spirale);
    }
    vertex Trait sommetParticule(uint v [[vertex_id]], uint i [[instance_id]],
                                 constant Particule *P [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Particule p = P[i];
        float t = u.t;
        float age = t - IMPACT;
        float arrivee = p.b.y + p.b.z;
        float pose = t > arrivee ? 1.0 + 0.8 * exp(-(t - arrivee) / 0.12) : 1.0;
        float scintille = t > arrivee ? 0.85 + 0.15 * sin(t * 9.0 + float(i)) : 1.0;
        float alpha = age > 0.0 ? clamp(age / 0.14, 0.0, 1.0) * (1.0 - lisse((t - (LOGO + 0.02)) / 0.28)) * min(pose * scintille, 1.6) * 0.9 : 0.0;
        float2 ici = positionParticule(p, t, u);
        float2 avant = positionParticule(p, t - 1.0 / 120.0, u);
        float rayon = p.c.x * (t > arrivee ? 0.9 : 1.0);
        float3 c = (p.c.y > 0.5 || t > arrivee) ? BLANC : LILAS;
        return trait(v, avant, ici, rayon * 0.85, rayon * 1.3, alpha, c, LILAS, 0.0, u);
    }

    // le symbole se trace en lumiere pendant que les particules arrivent
    struct Segment { float4 ab; float4 info; };   // a, b ; debut et fin (part du trace), glyphe ?
    vertex Trait sommetNeon(uint v [[vertex_id]], uint i [[instance_id]],
                            constant Segment *S [[buffer(0)]], constant Uniformes &u [[buffer(1)]]) {
        Segment s = S[i];
        float f = lisse((u.t - 1.84) / 0.36);
        float alpha = f * (1.0 - lisse((u.t - (LOGO + 0.06)) / 0.26));
        float2 a = u.centre + s.ab.xy * u.cote, b = u.centre + s.ab.zw * u.cote;
        if (f <= s.info.x) alpha = 0.0;
        else if (f < s.info.y) b = mix(a, b, (f - s.info.x) / (s.info.y - s.info.x));
        bool glyphe = s.info.z > 0.5;
        return trait(v, a, b, (glyphe ? 1.15 : 0.8) * u.k, 3.2 * u.k, alpha * (glyphe ? 1.0 : 0.8), glyphe ? BLANC : LILAS, VIOLET, 0.0, u);
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
            backgroundColor = UIColor(red: 0.027, green: 0.024, blue: 0.040, alpha: 1)
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
            layer?.backgroundColor = CGColor(red: 0.027, green: 0.024, blue: 0.040, alpha: 1)
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
