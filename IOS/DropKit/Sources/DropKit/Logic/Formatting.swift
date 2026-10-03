import Foundation

/// Les nombres a la francaise : "1 893,00 €", "12 colis".
public enum Format {
    private static let locale = Locale(identifier: "fr_FR")

    /// "1 893,50 €"
    public static func euro(_ valeur: Double) -> String {
        valeur.formatted(.currency(code: "EUR").locale(locale).precision(.fractionLength(2)))
    }

    /// Au-dela de 1 000 €, les centimes n'apportent rien et prennent la place :
    /// "1 893 €" ; en dessous, "37,50 €".
    public static func euroCompact(_ valeur: Double) -> String {
        abs(valeur) >= 1000 ? euroEntier(valeur) : euro(valeur)
    }

    /// "1 893 €"
    public static func euroEntier(_ valeur: Double) -> String {
        valeur.rounded().formatted(.currency(code: "EUR").locale(locale).precision(.fractionLength(0)))
    }

    /// Pour les graphiques serres : sans centimes quand ils n'apportent rien.
    public static func euroGraphe(_ valeur: Double) -> String {
        let arrondi = (valeur * 100).rounded() / 100
        return valeur >= 100 || arrondi == arrondi.rounded() ? euroEntier(valeur) : euro(valeur)
    }

    /// "12 345"
    public static func integer(_ valeur: Double) -> String {
        Int(valeur.rounded()).formatted(.number.locale(locale))
    }

    public static func integer(_ valeur: Int) -> String {
        valeur.formatted(.number.locale(locale))
    }

    /// "1 colis", "12 colis dropés" : le mot s'accorde au nombre.
    public static func count(_ n: Int, _ singulier: String, _ pluriel: String? = nil) -> String {
        "\(integer(n)) \(n > 1 ? (pluriel ?? singulier + "s") : singulier)"
    }

    /// "3,2×" : une decimale sauf pour les tres gros multiples.
    public static func multiple(_ ratio: Double) -> String {
        guard ratio.isFinite else { return "—" }
        if ratio >= 10 { return "\(Int(ratio.rounded()))×" }
        return ratio.formatted(.number.locale(locale).precision(.fractionLength(1))) + "×"
    }

    /// "1 h 12 min", "34 min", "48 s"
    public static func duration(_ secondes: Int) -> String {
        let h = secondes / 3600
        let m = (secondes % 3600) / 60
        if h > 0 { return m > 0 ? "\(h) h \(m) min" : "\(h) h" }
        if m > 0 { return "\(m) min" }
        return "\(secondes) s"
    }

    /// chrono : "mm:ss", ou "h:mm:ss" au-dela d'une heure
    public static func chrono(_ secondes: Int) -> String {
        let s = max(0, secondes)
        let h = s / 3600
        let m = (s % 3600) / 60
        let r = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, r) : String(format: "%02d:%02d", m, r)
    }
}

/// Les dates du serveur. SQLite les ecrit en UTC sans fuseau
/// ("2026-09-09 14:32:10") ; le bot de suivi en ISO avec fuseau.
public enum ServerDate {
    public static func parse(_ texte: String?) -> Date? {
        guard let texte, !texte.isEmpty else { return nil }
        if let iso = try? Date(texte, strategy: .iso8601) { return iso }
        if let fin = try? Date(texte, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return fin }
        let normalise = texte.replacingOccurrences(of: " ", with: "T") + (texte.contains("Z") || texte.contains("+") ? "" : "Z")
        if let date = try? Date(normalise, strategy: .iso8601) { return date }
        // "2026-09-09" : une journee, prise a midi pour ne jamais changer de jour
        return midday(ymd: texte)
    }

    /// "2026-09-09" -> la date a midi UTC
    public static func day(_ texte: String) -> Date? {
        midday(ymd: texte)
    }

    private static func midday(ymd texte: String) -> Date? {
        let morceaux = texte.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard morceaux.count == 3 else { return nil }
        var calendrier = Calendar(identifier: .gregorian)
        calendrier.timeZone = TimeZone(identifier: "UTC")!
        return calendrier.date(from: DateComponents(year: morceaux[0], month: morceaux[1], day: morceaux[2], hour: 12))
    }

    /// "14:32" a l'heure locale
    public static func time(_ texte: String?) -> String {
        guard let date = parse(texte) else { return texte ?? "—" }
        return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Locale(identifier: "fr_FR")))
    }

    /// "17/09 18:21"
    public static func shortDayTime(_ texte: String?) -> String {
        guard let date = parse(texte) else { return "—" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.dateFormat = "dd/MM HH:mm"
        return f.string(from: date)
    }

    /// "Mar", "Mer" : l'axe du graphique par jour
    public static func weekdayShort(_ jour: String) -> String {
        guard let date = day(jour) else { return "" }
        var calendrier = Calendar(identifier: .gregorian)
        calendrier.timeZone = TimeZone(identifier: "UTC")!
        let noms = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"]
        return noms[calendrier.component(.weekday, from: date) - 1]
    }

    /// "7 sept."
    public static func dayMonth(_ jour: String) -> String {
        guard let date = day(jour) else { return jour }
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "d MMM"
        return f.string(from: date)
    }

    /// "Mercredi 2 septembre"
    public static func longDay(_ jour: String) -> String {
        guard let date = day(jour) else { return jour }
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEEE d MMMM"
        let texte = f.string(from: date)
        return texte.prefix(1).uppercased() + texte.dropFirst()
    }
}
