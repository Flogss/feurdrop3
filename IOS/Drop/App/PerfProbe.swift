#if DEBUG
import QuartzCore
import os

/// Sonde de performance (versions de developpement seulement, lancee par
/// l'argument `-DropPerf 1`) : chaque seconde, images affichees, images en
/// retard, pire image, et nombre de recalculs de chaque vue suivie.
@MainActor
final class PerfProbe: NSObject {
    static let shared = PerfProbe()
    static var isOn: Bool { UserDefaults.standard.bool(forKey: "DropPerf") }

    private let journal = Logger(subsystem: "com.flogas.drop", category: "perf")
    private var lien: CADisplayLink?
    private var precedente: CFTimeInterval = 0
    private var debut: CFTimeInterval = 0
    private var images = 0
    private var lentes = 0
    private var pire: CFTimeInterval = 0
    private var corps: [String: Int] = [:]

    func start() {
        guard Self.isOn, lien == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tic))
        l.add(to: .main, forMode: .common)
        lien = l
    }

    func count(_ nom: String) {
        guard Self.isOn else { return }
        corps[nom, default: 0] += 1
    }

    @objc private func tic(_ l: CADisplayLink) {
        let t = l.timestamp
        if precedente > 0 {
            let dt = t - precedente
            images += 1
            if dt > (l.targetTimestamp - l.timestamp) * 1.6 + 0.004 { lentes += 1 }
            pire = max(pire, dt)
        } else {
            debut = t
        }
        precedente = t
        if t - debut >= 1 {
            let detail = corps.sorted { $0.value > $1.value }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
            journal.log("PERF images=\(self.images) lentes=\(self.lentes) pire=\(Int(self.pire * 1000))ms corps: \(detail, privacy: .public)")
            images = 0
            lentes = 0
            pire = 0
            corps = [:]
            debut = t
        }
    }
}

@MainActor
func perf(_ nom: String) -> Bool {
    PerfProbe.shared.count(nom)
    return true
}
#else
@inline(__always) func perf(_ nom: String) -> Bool { true }
#endif
