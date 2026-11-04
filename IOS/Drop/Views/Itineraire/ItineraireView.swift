import SwiftUI
import MapKit
import DropKit

/// « Créer un itinéraire — Boîtes jaunes » : le depart, la zone, le nombre de
/// boites, puis la tournee sur une vraie carte (Apple Plans) : depart, arrets
/// numerotes dans l'ordre, trajet routier, temps et distances du routeur.
/// Sur iPhone, tout se suit dans la page ; sur Mac (fenetre large), les
/// reglages et la liste a gauche, la carte a droite.
struct ItineraireView: View {
    @Environment(AppModel.self) private var app
    @State private var largeur: CGFloat = 0

    private var model: ItineraireModel { app.itineraire }
    private var large: Bool { largeur >= 900 }

    var body: some View {
        Group {
            if large {
                HStack(alignment: .top, spacing: 16) {
                    ScrollView {
                        colonne
                            .padding(.bottom, 24)
                    }
                    .frame(width: 430)
                    .scrollEdgeEffectStyle(.soft, for: .top)
                    carte
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.bottom, 16)
                }
                .padding(.horizontal, 16)
            } else {
                ScrollViewReader { defilement in
                    ScrollView {
                        VStack(spacing: 14) {
                            ItineraireReglages()
                            if model.resultat != nil || model.erreur != nil {
                                erreur
                                carte.frame(height: 400).id("carte")
                                if let r = model.resultat { ItineraireResultat(resultat: r) }
                            } else {
                                carte.frame(height: 260).id("carte")
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 24)
                    }
                    .scrollEdgeEffectStyle(.soft, for: .top)
                    // la tournee calculee : la page descend sur la carte
                    .onChange(of: model.resultat?.calculeLe) {
                        guard model.resultat != nil else { return }
                        withAnimation(.smooth(duration: 0.6)) { defilement.scrollTo("carte", anchor: .top) }
                    }
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { largeur = $0 }
        .navigationTitle("Itinéraire")
        .task {
            #if DEBUG
            if UserDefaults.standard.string(forKey: "DropItineraireDepart") != nil {
                await model.departDeTest()
                return
            }
            #endif
            if model.mode == .gps, model.position == nil { await model.localise() }
        }
    }

    private var colonne: some View {
        VStack(spacing: 14) {
            ItineraireReglages()
            erreur
            if let r = model.resultat { ItineraireResultat(resultat: r) }
        }
    }

    @ViewBuilder
    private var erreur: some View {
        if let message = model.erreur {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warn)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(14)
            .glassEffect(.regular.tint(Theme.warn.opacity(0.12)), in: .rect(cornerRadius: 18))
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    private var carte: some View {
        ItineraireCarte()
            .clipShape(.rect(cornerRadius: Theme.Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card).strokeBorder(Theme.hairline, lineWidth: 1))
    }
}

// MARK: - Reglages

private struct ItineraireReglages: View {
    @Environment(AppModel.self) private var app
    @State private var texte = ""
    @FocusState private var champ: Bool

    private var model: ItineraireModel { app.itineraire }

    var body: some View {
        @Bindable var model = app.itineraire
        VStack(alignment: .leading, spacing: 18) {
            section("Départ") {
                HStack(spacing: 8) {
                    puce("Ma position", symbole: "location.fill", actif: model.mode == .gps) {
                        model.mode = .gps
                        if model.position == nil { Task { await model.localise() } }
                    }
                    puce("Adresse", symbole: "mappin.and.ellipse", actif: model.mode == .adresse) {
                        model.mode = .adresse
                        champ = true
                    }
                }
                if model.mode == .gps { etatPosition } else { adresse }
            }

            section("Zone de recherche") {
                HStack(spacing: 8) {
                    ForEach(ItineraireModel.rayons, id: \.self) { r in
                        puce("\(Int(r)) km", actif: model.rayonKm == r) { model.rayonKm = r }
                    }
                }
            }

            section("Nombre de boîtes") {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        nombres
                        Spacer(minLength: 8)
                        pas
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        nombres
                        pas
                    }
                }
            }

            Toggle(isOn: $model.leveeAVenir) {
                Text("Seulement les boîtes pas encore levées aujourd'hui")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
            }
            .tint(Theme.violet)

            Button {
                Task { await model.nouvelle() }
            } label: {
                HStack(spacing: 8) {
                    if model.enCalcul {
                        ProgressView().controlSize(.small).tint(.white)
                    } else {
                        Image(systemName: "map.fill")
                    }
                    Text(model.enCalcul ? "Calcul de la tournée…" : "Créer l'itinéraire")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
            }
            .boutonVerreFort(Theme.violetDeep)
            .disabled(model.depart == nil || model.enCalcul)
        }
        .padding(18)
        .glassEffect(.regular.tint(.black.opacity(0.25)), in: .rect(cornerRadius: Theme.Radius.card))
        .sensoryFeedback(.selection, trigger: model.rayonKm)
        .sensoryFeedback(.selection, trigger: model.nombre)
    }

    private var nombres: some View {
        HStack(spacing: 8) {
            ForEach(ItineraireModel.nombres, id: \.self) { n in
                puce("\(n)", actif: app.itineraire.nombre == n) { app.itineraire.nombre = n }
            }
        }
    }

    private var pas: some View {
        HStack(spacing: 2) {
            boutonPas("minus", desactive: app.itineraire.nombre <= 1) { app.itineraire.nombre -= 1 }
            Text("\(app.itineraire.nombre)")
                .font(.title3.weight(.bold).monospacedDigit())
                .contentTransition(.numericText(value: Double(app.itineraire.nombre)))
                .frame(minWidth: 34)
                .animation(Theme.spring, value: app.itineraire.nombre)
            boutonPas("plus", desactive: app.itineraire.nombre >= 25) { app.itineraire.nombre += 1 }
        }
        .padding(3)
        .background(.white.opacity(0.05), in: .capsule)
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Nombre de boîtes : \(app.itineraire.nombre)")
        .accessibilityAdjustableAction { sens in
            switch sens {
            case .increment: app.itineraire.nombre = min(25, app.itineraire.nombre + 1)
            case .decrement: app.itineraire.nombre = max(1, app.itineraire.nombre - 1)
            @unknown default: break
            }
        }
    }

    private func boutonPas(_ symbole: String, desactive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbole)
                .font(.system(size: 13, weight: .bold))
                .frame(width: 34, height: 34)
                .contentShape(.circle)
        }
        .buttonStyle(PressScaleStyle(scale: 0.88))
        .buttonRepeatBehavior(.enabled)
        .foregroundStyle(desactive ? Theme.text3.opacity(0.5) : Theme.text)
        .disabled(desactive)
    }

    @ViewBuilder
    private var etatPosition: some View {
        let etat = model.etatPosition
        HStack(spacing: 10) {
            Group {
                switch etat {
                case .recherche: ProgressView().controlSize(.small)
                case .trouvee: Image(systemName: "location.fill").foregroundStyle(Theme.violetLight)
                case .erreur: Image(systemName: "location.slash.fill").foregroundStyle(Theme.warn)
                case .inconnue: Image(systemName: "location").foregroundStyle(Theme.text3)
                }
            }
            .frame(width: 18)
            Group {
                switch etat {
                case .recherche: Text("Recherche de ta position…")
                case .trouvee:
                    if let p = model.position {
                        Text("\(p.label ?? "Position trouvée") · à \(Int(p.precision.rounded())) m près")
                    }
                case .erreur(let message): Text(message).foregroundStyle(Theme.warn)
                case .inconnue: Text("Ta position sera demandée à l'appareil.")
                }
            }
            .font(.subheadline)
            .foregroundStyle(Theme.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
            if case .erreur = etat {
                Button("Réessayer") { Task { await model.localise() } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.violetLight)
                    .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(.white.opacity(0.03), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.hairline, lineWidth: 1))
        .animation(Theme.spring, value: etat)
    }

    private var adresse: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.text3)
                TextField("12 rue Jean Jaurès, Villejuif", text: $texte)
                    .textFieldStyle(.plain)
                    .focused($champ)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .submitLabel(.search)
                    #endif
                    .onSubmit { if let premier = model.suggestions.first { choisit(premier) } }
                if model.adresse != nil {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.violetLight)
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            .background(.black.opacity(0.25), in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(champ ? Theme.violetLight.opacity(0.6) : Theme.hairline, lineWidth: 1))
            .task(id: texte) { await model.cherche(texte) }
            .onAppear { if let a = model.adresse { texte = a.label } }

            if !model.suggestions.isEmpty {
                VStack(spacing: 2) {
                    ForEach(model.suggestions) { lieu in
                        Button { choisit(lieu) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "mappin").foregroundStyle(Theme.violetLight)
                                Text(lieu.label).font(.subheadline).foregroundStyle(Theme.text).lineLimit(2)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .contentShape(.rect)
                        }
                        .buttonStyle(PressScaleStyle(scale: 0.98))
                    }
                }
                .padding(4)
                .glassEffect(.regular.tint(.black.opacity(0.3)), in: .rect(cornerRadius: 16))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func choisit(_ lieu: ItineraireLieu) {
        model.choisit(lieu)
        texte = lieu.label
        champ = false
    }

    private func section<Contenu: View>(_ titre: String, @ViewBuilder contenu: () -> Contenu) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(titre.uppercased())
                .font(.caption.weight(.semibold))
                .kerning(1.2)
                .foregroundStyle(Theme.text3)
            contenu()
        }
    }

    private func puce(_ titre: String, symbole: String? = nil, actif: Bool, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.selection()
            withAnimation(Theme.spring) { action() }
        } label: {
            HStack(spacing: 6) {
                if let symbole { Image(systemName: symbole).font(.caption.weight(.bold)) }
                Text(titre).font(.subheadline.weight(.semibold).monospacedDigit())
            }
            .foregroundStyle(actif ? Theme.text : Theme.text2)
            .padding(.horizontal, 14)
            .frame(minWidth: 48)
            .frame(height: 38)
            .background {
                Capsule().fill(LinearGradient(colors: [Theme.violet.opacity(actif ? 0.32 : 0), Theme.violet.opacity(actif ? 0.12 : 0)], startPoint: .top, endPoint: .bottom))
            }
            .overlay(Capsule().strokeBorder(actif ? Theme.violetLight.opacity(0.6) : Theme.hairline, lineWidth: 1))
            .shadow(color: actif ? Theme.violet.opacity(0.5) : .clear, radius: 8, y: 4)
            .contentShape(.capsule)
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityAddTraits(actif ? .isSelected : [])
    }
}

// MARK: - Resultat

private struct ItineraireResultat: View {
    let resultat: Itineraire
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL

    private var model: ItineraireModel { app.itineraire }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                chiffre(ItineraireFormat.duree(resultat.total.duree), "en voiture")
                chiffre(ItineraireFormat.distance(resultat.total.distance), "au total")
                chiffre("\(resultat.arrets.count)", resultat.arrets.count > 1 ? "boîtes" : "boîte")
            }

            ForEach(resultat.avertissements, id: \.self) { a in
                Label(a, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.warn)
            }

            VStack(alignment: .leading, spacing: 8) {
                Label("LANCER LA NAVIGATION", systemImage: "location.north.line.fill")
                    .font(.caption.weight(.semibold))
                    .kerning(1.2)
                    .foregroundStyle(Theme.text3)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
                    ForEach(Array(resultat.liens.applePlans.enumerated()), id: \.offset) { i, lien in
                        bouton(resultat.liens.applePlans.count > 1 ? "Apple Plans \(i + 1)/\(resultat.liens.applePlans.count)" : "Apple Plans", symbole: "map.fill", fort: true, lien: lien)
                    }
                    ForEach(Array(resultat.liens.googleMaps.enumerated()), id: \.offset) { i, lien in
                        bouton(resultat.liens.googleMaps.count > 1 ? "Google Maps \(i + 1)/\(resultat.liens.googleMaps.count)" : "Google Maps", symbole: "globe", fort: false, lien: lien)
                    }
                }
                Button {
                    Task { await model.recalcule() }
                } label: {
                    HStack(spacing: 8) {
                        if model.enCalcul {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text(model.enCalcul ? "Calcul…" : "Recalculer")
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                }
                .boutonVerre()
                .disabled(model.enCalcul)
            }

            VStack(spacing: 6) {
                ForEach(Array(resultat.arrets.enumerated()), id: \.element.id) { i, a in
                    ligne(a, index: i)
                }
            }

            Text(sources)
                .font(.caption)
                .foregroundStyle(Theme.text3)
        }
        .padding(18)
        .glassEffect(.regular.tint(.black.opacity(0.25)), in: .rect(cornerRadius: Theme.Radius.card))
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
    }

    private var sources: String {
        let maj = resultat.sources.boites.miseAJour.flatMap { ServerDate.parse($0) }.map { " du \($0.formatted(.dateTime.day().month().year().locale(Locale(identifier: "fr_FR"))))" } ?? ""
        var t = "Temps et distances : \(resultat.sources.routage.nom), sur les vraies routes"
        if !resultat.sources.routage.trafic { t += ", sans trafic en temps réel (la navigation en tient compte)" }
        t += ". Boîtes : \(resultat.sources.boites.nom)\(maj) · \(Format.count(resultat.zone.arrets, "arrêt possible", "arrêts possibles")) dans \(Format.integer(resultat.rayonKm)) km"
        if resultat.zone.arrets > resultat.zone.comparees { t += " (les \(resultat.zone.comparees) plus proches comparés par la route)" }
        if resultat.zone.imprecises > 0 { t += ", \(Format.count(resultat.zone.imprecises, "position douteuse écartée", "positions douteuses écartées"))" }
        if resultat.variantes > 1 { t += " · tournée \(resultat.variante + 1) sur \(resultat.variantes)" }
        return t + "."
    }

    private func chiffre(_ valeur: String, _ unite: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(valeur)
                .font(.system(size: 22, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(Theme.numberGradient)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .contentTransition(.numericText())
            Text(unite).font(.caption).foregroundStyle(Theme.text3)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(LinearGradient(colors: [Theme.violet.opacity(0.16), Theme.violet.opacity(0.04)], startPoint: .top, endPoint: .bottom))
        }
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.violetLight.opacity(0.18), lineWidth: 1))
    }

    private func bouton(_ titre: String, symbole: String, fort: Bool, lien: String) -> some View {
        Button {
            Haptics.selection()
            if let url = URL(string: lien) { openURL(url) }
        } label: {
            Label(titre, systemImage: symbole)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
        }
        .modifier(StyleBouton(fort: fort))
    }

    private func ligne(_ a: Itineraire.Arret, index: Int) -> some View {
        let actif = model.choisi == index
        return HStack(spacing: 12) {
            MarqueurArret(numero: a.ordre, actif: false, apres: a.apresLimite == true, taille: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(a.adresse ?? "Adresse inconnue")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    if a.boites > 1 {
                        Text("\(a.boites) boîtes")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Theme.violetPale)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.violet.opacity(0.18), in: .capsule)
                    }
                }
                Text([a.cp, a.commune].compactMap { $0 }.joined(separator: " "))
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                ItineraireLevee(arret: a)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text("+\(ItineraireFormat.duree(a.depuisPrecedent.duree))")
                    .font(.footnote.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Theme.text)
                Text(ItineraireFormat.distance(a.depuisPrecedent.distance))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.text3)
            }
            Button {
                Task { await model.evite(a) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 30, height: 30)
                    .contentShape(.circle)
            }
            .buttonStyle(PressScaleStyle(scale: 0.88))
            .foregroundStyle(Theme.text3)
            .help("Éviter cette boîte et recalculer")
            .accessibilityLabel("Éviter cette boîte")
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(actif ? Theme.violet.opacity(0.16) : .white.opacity(0.03))
        }
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(actif ? Theme.violetLight.opacity(0.55) : Theme.hairline, lineWidth: 1))
        .contentShape(.rect(cornerRadius: 16))
        .onTapGesture {
            Haptics.selection()
            withAnimation(Theme.spring) { model.choisi = actif ? nil : index }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Arrêt \(a.ordre) : \(a.adresse ?? "boîte")")
        .accessibilityAction(.default) { model.choisi = index }
    }
}

private struct StyleBouton: ViewModifier {
    let fort: Bool
    func body(content: Content) -> some View {
        if fort { content.boutonVerreFort(Theme.violetDeep) } else { content.boutonVerre() }
    }
}

struct ItineraireLevee: View {
    let arret: Itineraire.Arret

    var body: some View {
        if arret.limiteSemaine != nil || arret.limiteSamedi != nil {
            HStack(spacing: 4) {
                Text(texte).foregroundStyle(Theme.text2)
                if arret.apresLimite == true {
                    Text("· après la levée d'aujourd'hui").foregroundStyle(Theme.warn).fontWeight(.semibold)
                } else if arret.apresLimite == false {
                    Text("· avant la levée").foregroundStyle(Theme.teal).fontWeight(.semibold)
                }
            }
            .font(.caption)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
    }

    private var texte: String {
        let semaine = ItineraireFormat.heure(arret.limiteSemaine)
        if let samedi = arret.limiteSamedi, samedi != arret.limiteSemaine { return "Levée \(semaine) · sam. \(ItineraireFormat.heure(samedi))" }
        return "Levée \(semaine)"
    }
}

enum ItineraireFormat {
    /// « 7 min », « 1 h 05 »
    static func duree(_ secondes: Double) -> String {
        let min = max(1, Int((secondes / 60).rounded()))
        return min < 60 ? "\(min) min" : "\(min / 60) h \(String(format: "%02d", min % 60))"
    }

    /// « 3,6 km », « 450 m »
    static func distance(_ metres: Double) -> String {
        if metres < 950 { return "\(max(10, Int((metres / 10).rounded()) * 10)) m" }
        let km = metres / 1000
        return km.formatted(.number.locale(Locale(identifier: "fr_FR")).precision(.fractionLength(km < 9.95 ? 1 : 0))) + " km"
    }

    /// « 09:00 » -> « 9h00 »
    static func heure(_ hhmm: String?) -> String {
        guard let hhmm, let h = Int(hhmm.prefix(2)) else { return "—" }
        return "\(h)h\(hhmm.suffix(2))"
    }
}

// MARK: - Carte

struct MarqueurArret: View {
    let numero: Int
    var actif = false
    var apres = false
    var taille: CGFloat = 34

    var body: some View {
        Text("\(numero)")
            .font(.system(size: taille * 0.42, weight: .heavy).monospacedDigit())
            .foregroundStyle(apres ? Color(red: 0.16, green: 0.1, blue: 0.02) : .white)
            .frame(width: taille, height: taille)
            .background {
                Circle().fill(LinearGradient(
                    colors: apres ? [Color(red: 1, green: 0.77, blue: 0.43), Theme.warn] : [Theme.violetLight, Theme.violet, Theme.violetDeep],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ))
            }
            .overlay(Circle().strokeBorder(.white.opacity(0.9), lineWidth: taille > 30 ? 2 : 0))
            .shadow(color: (apres ? Theme.warn : Theme.violet).opacity(0.8), radius: actif ? 10 : 5)
            .scaleEffect(actif ? 1.22 : 1)
            .animation(Theme.bouncy, value: actif)
    }
}

private struct ItineraireCarte: View {
    @Environment(AppModel.self) private var app
    @State private var camera: MapCameraPosition = .automatic

    private var model: ItineraireModel { app.itineraire }

    var body: some View {
        let r = model.resultat
        Map(position: $camera) {
            if let r {
                // les autres boites de la zone, en fond
                ForEach(Array(r.autres.prefix(250).enumerated()), id: \.offset) { _, p in
                    Annotation("", coordinate: CLLocationCoordinate2D(latitude: p[0], longitude: p[1]), anchor: .center) {
                        Circle().fill(Color.yellow.opacity(0.45)).frame(width: 6, height: 6)
                    }
                    .annotationTitles(.hidden)
                }
                let trace = r.geometrie.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) }
                MapPolyline(coordinates: trace)
                    .stroke(Theme.violetDeep.opacity(0.35), style: StrokeStyle(lineWidth: 12, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: trace)
                    .stroke(Theme.violetLight, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                Annotation("Départ", coordinate: CLLocationCoordinate2D(latitude: r.depart.lat, longitude: r.depart.lon), anchor: .center) {
                    PointDepart()
                }
                .annotationTitles(.hidden)
                ForEach(Array(r.arrets.enumerated()), id: \.element.id) { i, a in
                    Annotation(a.adresse ?? "Boîte", coordinate: CLLocationCoordinate2D(latitude: a.lat, longitude: a.lon), anchor: .center) {
                        MarqueurArret(numero: a.ordre, actif: model.choisi == i, apres: a.apresLimite == true)
                            .onTapGesture {
                                Haptics.selection()
                                withAnimation(Theme.spring) { model.choisi = model.choisi == i ? nil : i }
                            }
                            .accessibilityLabel("Arrêt \(a.ordre)")
                    }
                    .annotationTitles(.hidden)
                }
            } else if let d = model.depart {
                Annotation("Départ", coordinate: CLLocationCoordinate2D(latitude: d.lat, longitude: d.lon), anchor: .center) {
                    PointDepart()
                }
                .annotationTitles(.hidden)
                MapCircle(center: CLLocationCoordinate2D(latitude: d.lat, longitude: d.lon), radius: model.rayonKm * 1000)
                    .foregroundStyle(Theme.violet.opacity(0.08))
                    .stroke(Theme.violetLight.opacity(0.5), lineWidth: 1.5)
            }
        }
        .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))
        .mapControls {
            MapCompass()
            MapScaleView()
            #if os(macOS)
            MapZoomStepper()
            #endif
        }
        .environment(\.colorScheme, .dark)
        .overlay(alignment: .bottom) {
            if let r, let i = model.choisi, r.arrets.indices.contains(i) {
                detail(r.arrets[i], index: i)
                    .padding(12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .overlay {
            if r == nil && model.depart == nil {
                VStack(spacing: 10) {
                    Image(systemName: "map")
                        .font(.system(size: 26, weight: .medium))
                        .foregroundStyle(Theme.violetPale)
                        .frame(width: 58, height: 58)
                        .glassEffect(.regular.tint(Theme.violet.opacity(0.3)), in: .rect(cornerRadius: 18))
                    Text("Choisis ton départ, la zone et le nombre de boîtes : la tournée s'affiche ici.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .allowsHitTesting(false)
            }
        }
        .animation(Theme.spring, value: model.choisi)
        .onChange(of: r?.arrets.map(\.id), initial: true) { cadre() }
        .onChange(of: model.depart?.lat) { if model.resultat == nil { cadre() } }
        .onChange(of: model.rayonKm) { if model.resultat == nil { cadre() } }
        .onChange(of: model.choisi) {
            guard let r = model.resultat, let i = model.choisi, r.arrets.indices.contains(i) else { return }
            let a = r.arrets[i]
            withAnimation(.smooth(duration: 0.6)) {
                camera = .camera(MapCamera(centerCoordinate: CLLocationCoordinate2D(latitude: a.lat, longitude: a.lon), distance: 900))
            }
        }
    }

    /// Le cadre : toute la tournee, ou la zone autour du depart.
    private func cadre() {
        var points: [CLLocationCoordinate2D] = []
        if let r = model.resultat {
            points = [CLLocationCoordinate2D(latitude: r.depart.lat, longitude: r.depart.lon)] + r.arrets.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        } else if let d = model.depart {
            let centre = CLLocationCoordinate2D(latitude: d.lat, longitude: d.lon)
            let rayon = model.rayonKm * 1000 * 1.15
            withAnimation(.smooth(duration: 0.7)) {
                camera = .region(MKCoordinateRegion(center: centre, latitudinalMeters: rayon * 2, longitudinalMeters: rayon * 2))
            }
            return
        }
        guard !points.isEmpty else { return }
        var rect = MKMapRect.null
        for p in points {
            let m = MKMapPoint(p)
            rect = rect.union(MKMapRect(x: m.x, y: m.y, width: 1, height: 1))
        }
        let marge = max(rect.width, rect.height) * 0.18 + 400
        withAnimation(.smooth(duration: 0.8)) {
            camera = .rect(rect.insetBy(dx: -marge, dy: -marge))
        }
    }

    private func detail(_ a: Itineraire.Arret, index: Int) -> some View {
        HStack(alignment: .top, spacing: 12) {
            MarqueurArret(numero: a.ordre, apres: a.apresLimite == true, taille: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(a.adresse ?? "Boîte").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                Text([a.cp, a.commune].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(Theme.text3)
                ItineraireLevee(arret: a)
                Text("+\(ItineraireFormat.duree(a.depuisPrecedent.duree)) · \(ItineraireFormat.distance(a.depuisPrecedent.distance)) depuis \(index == 0 ? "le départ" : "l'arrêt \(index)")")
                    .font(.caption)
                    .foregroundStyle(Theme.text2)
                Text("Boîte \(a.ids.joined(separator: ", "))")
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.text3)
            }
            Spacer(minLength: 0)
            Button {
                withAnimation(Theme.spring) { model.choisi = nil }
            } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).frame(width: 28, height: 28)
            }
            .buttonStyle(PressScaleStyle(scale: 0.9))
            .foregroundStyle(Theme.text2)
            .accessibilityLabel("Fermer")
        }
        .padding(14)
        .frame(maxWidth: 480)
        .glassEffect(.regular.tint(.black.opacity(0.35)), in: .rect(cornerRadius: 20))
    }
}

private struct PointDepart: View {
    var body: some View {
        ZStack {
            Circle().fill(Theme.violet.opacity(0.35)).frame(width: 30, height: 30)
                .overlay { AnneauPulse(couleur: Theme.violetLight, diametre: 16, epaisseur: 2, echelle: 2.6, opacite: 0.7, duree: 2.2) }
            Circle().fill(.white).frame(width: 16, height: 16)
                .overlay(Circle().strokeBorder(Theme.violet, lineWidth: 4))
                .shadow(color: Theme.violet, radius: 6)
        }
        .accessibilityLabel("Départ")
    }
}
