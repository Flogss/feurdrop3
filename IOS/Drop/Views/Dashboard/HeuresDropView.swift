import SwiftUI
import DropKit

/// A cote de « En direct » : l'heure ou l'on compte aller poster. « Heure de
/// drop » tant que rien n'est prevu, sinon la prochaine (« 16h », « +1 »
/// s'il y en a d'autres). Le toucher ouvre les heures : en poser, les
/// modifier, les retirer.
struct HeureDropBouton: View {
    /// l'horloge seule tant que rien n'est prevu (en-tete serre de l'iPhone)
    var compact = false
    @Environment(AppModel.self) private var app
    @State private var ouvert = false

    private var heures: [HeureDrop] { app.dashboard.heuresDrop.heures }

    var body: some View {
        let prochaine = heures.first
        Button {
            Haptics.selection()
            ouvert = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "clock")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(prochaine == nil ? Theme.text2 : (prochaine!.passee ? Theme.warn : Theme.violetLight))
                if let prochaine {
                    // (serre : l'heure seule, les autres en pastille)
                    Text("\(prochaine.demain && !compact ? "Demain " : "")\(prochaine.heureCourte)")
                        .font(.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.text)
                        .contentTransition(.numericText())
                    if heures.count > 1 && !compact {
                        Text("+\(heures.count - 1)")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(Theme.violetLight)
                    }
                } else if !compact {
                    Text("Heure de drop")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Theme.text2)
                }
            }
            .padding(.horizontal, compact ? 10 : 12)
            .padding(.vertical, 8)
            .glassEffect(.regular.tint(prochaine == nil ? .clear : Theme.violet.opacity(0.28)).interactive(), in: .capsule)
            .contentShape(.capsule)
            .overlay(alignment: .topTrailing) {
                if compact && heures.count > 1 {
                    Text(Format.integer(heures.count))
                        .font(.system(size: 10, weight: .bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 17, minHeight: 17)
                        .background(Theme.violet.gradient, in: .capsule)
                        .offset(x: 5, y: -5)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(Theme.spring, value: heures)
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .help(aide)
        .accessibilityLabel(aide)
        #if DEBUG
        // verification : `-DropOuvreHeuresDrop 1` ouvre les heures au lancement
        .task {
            guard !compact || !Platform.isMac, UserDefaults.standard.bool(forKey: "DropOuvreHeuresDrop") else { return }
            try? await Task.sleep(for: .seconds(4))
            ouvert = true
        }
        #endif
        .sheet(isPresented: $ouvert) {
            HeuresDropSheet()
                #if os(macOS)
                .frame(minWidth: 500, minHeight: 520)
                #else
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                #endif
        }
    }

    private var aide: String {
        heures.isEmpty
            ? "Heure de drop : prévoir quand tu postes"
            : "Heures de drop : " + heures.map { "\($0.transporteurs.map(\.label).joined(separator: ", ")) à \($0.demain ? "demain " : "")\($0.heureCourte)" }.joined(separator: " · ")
    }
}

/// Les heures prevues, puis le formulaire : une nouvelle heure, ou celle
/// qu'on a touchee pour la modifier. Les expediteurs concernes voient l'heure
/// sur leur espace ; elle s'efface toute seule une fois les colis postes.
struct HeuresDropSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var edition: String?
    @State private var date = HeuresDropSheet.heureParDefaut()
    @State private var selection: Set<String> = []

    private static let paris = TimeZone(identifier: "Europe/Paris") ?? .current
    private var model: DashboardModel { app.dashboard }
    private var heures: [HeureDrop] { model.heuresDrop.heures }
    private var editee: HeureDrop? { edition.flatMap { id in heures.first { $0.id == id } } }

    /// la prochaine heure pleine
    private static func heureParDefaut() -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = paris
        let maintenant = Date.now
        let h = cal.component(.hour, from: maintenant)
        return cal.date(bySettingHour: (h + 1) % 24, minute: 0, second: 0, of: maintenant) ?? maintenant
    }

    /// « 16:00 » a l'heure de Paris (celle du serveur)
    private var heureTexte: String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = Self.paris
        let c = cal.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// ceux qui ont des colis a poster d'abord, avec leur nombre
    private var options: [(CarrierOption, Int)] {
        let enAttente = Dictionary((model.stats?.byCarrier ?? []).map { ($0.carrier, $0.pendingCount) }, uniquingKeysWith: +)
        return model.heuresDrop.transporteurs
            .map { ($0, enAttente[$0.code] ?? 0) }
            .enumerated()
            .sorted { $0.element.1 != $1.element.1 ? $0.element.1 > $1.element.1 : $0.offset < $1.offset }
            .map(\.element)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Heures de drop")
                .font(.title3.weight(.bold))
                .padding(.bottom, 16)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !heures.isEmpty {
                        VStack(spacing: 6) {
                            ForEach(heures) { h in ligne(h) }
                        }
                    }
                    formulaire
                }
                .padding(.vertical, 2)
            }
            .sansIndicateurs()
            .scrollBounceBehavior(.basedOnSize)

            Divider().overlay(Theme.hairline).padding(.vertical, 14)
            resume
                .padding(.bottom, 14)

            HStack(spacing: 10) {
                Button {
                    if editee != nil { choisis(nil) } else { dismiss() }
                } label: {
                    Text(editee != nil ? "Annuler" : "Fermer")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .boutonVerre()
                Button {
                    Task {
                        let codes = model.heuresDrop.transporteurs.map(\.code).filter { selection.contains($0) }
                        if await model.enregistreHeureDrop(id: editee?.id, heure: heureTexte, transporteurs: codes) { dismiss() }
                    }
                } label: {
                    Label(editee != nil ? "Enregistrer" : "Ajouter", systemImage: editee != nil ? "checkmark" : "plus")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .boutonVerreFort(Theme.violetDeep)
                .disabled(selection.isEmpty || model.busy.contains("heure"))
            }
        }
        .padding(22)
        .sensoryFeedback(.selection, trigger: selection)
        .animation(Theme.spring, value: heures)
        .animation(Theme.spring, value: edition)
    }

    // MARK: Les heures prevues

    private func ligne(_ h: HeureDrop) -> some View {
        let active = h.id == edition
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(h.heureCourte)
                    .font(.system(size: 19, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(h.passee ? Theme.warn : Theme.text)
                if h.demain {
                    Text("demain")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.violetLight)
                }
            }
            .frame(minWidth: 52, alignment: .leading)
            FlowLayout(spacing: 5, lineSpacing: 5) {
                ForEach(h.transporteurs) { t in pastille(t) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                choisis(active ? nil : h.id)
            } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .contentShape(.circle)
            }
            .buttonStyle(PressScaleStyle(scale: 0.9))
            .foregroundStyle(active ? Theme.violetLight : Theme.text2)
            .accessibilityLabel("Modifier \(h.heureCourte)")
            Button {
                Haptics.selection()
                if active { choisis(nil) }
                Task { await model.retireHeureDrop(h) }
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .contentShape(.circle)
            }
            .buttonStyle(PressScaleStyle(scale: 0.9))
            .foregroundStyle(Theme.danger.opacity(0.85))
            .accessibilityLabel("Supprimer \(h.heureCourte)")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(active ? Theme.violet.opacity(0.14) : .white.opacity(0.03))
        }
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(active ? Theme.violetLight.opacity(0.55) : Theme.hairline, lineWidth: 1))
        .contentShape(.rect(cornerRadius: 16))
        .onTapGesture { choisis(active ? nil : h.id) }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
    }

    private func pastille(_ t: CarrierOption) -> some View {
        let couleur = Color.carrier(t.code)
        return HStack(spacing: 5) {
            Circle().fill(couleur).frame(width: 7, height: 7)
            Text(t.label).font(.caption.weight(.semibold))
        }
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 9)
        .frame(height: 26)
        .background(Capsule().fill(couleur.opacity(0.14)))
        .overlay(Capsule().strokeBorder(couleur.opacity(0.45), lineWidth: 1))
    }

    /// Le formulaire se remplit avec l'heure touchee (nil : une nouvelle).
    private func choisis(_ id: String?) {
        Haptics.selection()
        let h = id.flatMap { id in heures.first { $0.id == id } }
        edition = h?.id
        selection = Set(h?.transporteurs.map(\.code) ?? [])
        if let h, let instant = ServerDate.parse(h.a) { date = instant } else if h == nil { date = Self.heureParDefaut() }
    }

    // MARK: Le formulaire

    private var formulaire: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text((editee.map { "Modifier \($0.heureCourte)" } ?? (heures.isEmpty ? "Nouvelle heure" : "Une autre heure")).uppercased())
                .font(.caption.weight(.semibold))
                .kerning(1.2)
                .foregroundStyle(Theme.text3)
            DatePicker("Heure du drop", selection: $date, displayedComponents: .hourAndMinute)
                .labelsHidden()
                #if os(macOS)
                .datePickerStyle(.stepperField)
                #endif
                .environment(\.timeZone, Self.paris)
                .environment(\.locale, Locale(identifier: "fr_FR"))
            FlowLayout(spacing: 8, lineSpacing: 8) {
                ForEach(options, id: \.0.code) { option, n in puce(option, n) }
            }
        }
    }

    private func puce(_ t: CarrierOption, _ n: Int) -> some View {
        let actif = selection.contains(t.code)
        let couleur = Color.carrier(t.code)
        return Button {
            withAnimation(Theme.spring) {
                if actif { selection.remove(t.code) } else { selection.insert(t.code) }
            }
        } label: {
            HStack(spacing: 7) {
                Circle()
                    .fill(couleur)
                    .frame(width: 8, height: 8)
                    .shadow(color: couleur.opacity(actif ? 0.9 : 0), radius: 4)
                    .opacity(actif ? 1 : 0.4)
                Text(t.label).font(.subheadline.weight(.semibold))
                if n > 0 {
                    Text(Format.integer(n)).font(.subheadline.weight(.bold).monospacedDigit()).opacity(0.75)
                }
            }
            .foregroundStyle(actif ? Theme.text : Theme.text3)
            .padding(.horizontal, 13)
            .frame(height: 38)
            .background {
                Capsule().fill(LinearGradient(colors: [couleur.opacity(actif ? 0.22 : 0), couleur.opacity(actif ? 0.08 : 0)], startPoint: .top, endPoint: .bottom))
            }
            .overlay(Capsule().strokeBorder(actif ? couleur.opacity(0.55) : Theme.hairline, lineWidth: 1))
            .contentShape(.capsule)
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityAddTraits(actif ? .isSelected : [])
    }

    private var resume: some View {
        let noms = model.heuresDrop.transporteurs.filter { selection.contains($0.code) }.map(\.label)
        return VStack(alignment: .leading, spacing: 3) {
            if noms.isEmpty {
                Text("Choisis les transporteurs que tu vas poster.")
                    .foregroundStyle(Theme.text2)
            } else {
                Text("\(Text(noms.joined(separator: ", ")).bold().foregroundStyle(Theme.text)) à \(Text(HeureDrop.courte(heureTexte)).bold().foregroundStyle(Theme.text))")
                    .foregroundStyle(Theme.text2)
                Text("Les expéditeurs concernés la voient sur leur espace ; elle s'efface une fois les colis postés.")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            }
        }
        .font(.subheadline)
        .animation(Theme.spring, value: selection)
    }
}
