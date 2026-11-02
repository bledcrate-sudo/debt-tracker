// Debty home-screen and lock-screen widget: days until debt-free, from the
// debt-free challenge in the app.
//
// The widget talks to the Debty server itself instead of reading data the
// app shares (that needs an App Group, which a re-signed sideloaded app may
// not keep). It makes a random key once, shows a 6-digit pairing code until
// the user types it into the app (Debt → Debt-free challenge → Home screen
// widget), and from then on fetches the countdown with that key.
// Server: POST /api/widget/status (app/api/widget/status/route.ts).

import Security
import SwiftUI
import WidgetKit

// MARK: - Server data

struct WidgetStatus: Codable {
    var paired: Bool
    var code: String?
    var active: Bool?
    var currency: String?
    var debtFreeDate: String?
    var daysLeft: Int?
    var totalDebt: Double?
    var startDebt: Double?
    var progress: Double?
    var monthly: Double?
    var daysAhead: Int?
    var done: Bool?

    static let preview = WidgetStatus(
        paired: true, active: true, currency: "CAD", daysLeft: 412,
        totalDebt: 8450, startDebt: 12000, progress: 0.3, monthly: 650, daysAhead: 12, done: false
    )
}

enum DebtyAPI {
    static let store = UserDefaults.standard

    static var serverURL: URL? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: "DebtyServerURL") as? String else { return nil }
        return URL(string: s)
    }

    /// The widget's own random key, made once and kept in its container.
    static var deviceKey: String {
        if let k = store.string(forKey: "deviceKey"), k.count == 64 { return k }
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            bytes = (0..<32).map { _ in UInt8.random(in: 0...255) }
        }
        let k = bytes.map { String(format: "%02x", $0) }.joined()
        store.set(k, forKey: "deviceKey")
        return k
    }

    static var cached: WidgetStatus? {
        guard let data = store.data(forKey: "lastStatus") else { return nil }
        return try? JSONDecoder().decode(WidgetStatus.self, from: data)
    }

    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func fetch() async -> WidgetStatus? {
        guard let base = serverURL else { return cached }
        var req = URLRequest(url: base.appendingPathComponent("api/widget/status"))
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("Bearer \(deviceKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["today": dayFormatter.string(from: Date())])
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return cached }
            let status = try JSONDecoder().decode(WidgetStatus.self, from: data)
            store.set(data, forKey: "lastStatus")
            return status
        } catch {
            return cached
        }
    }
}

// MARK: - Timeline

struct DebtEntry: TimelineEntry {
    let date: Date
    let status: WidgetStatus?

    /// Days from this entry's day to the debt-free date, counted on the
    /// phone so the number ticks down at midnight even without a refresh.
    var daysLeft: Int? {
        guard let s = status?.debtFreeDate, let target = DebtyAPI.dayFormatter.date(from: s) else {
            return status?.daysLeft
        }
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: target)).day ?? 0
        return max(0, days)
    }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> DebtEntry {
        DebtEntry(date: Date(), status: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (DebtEntry) -> Void) {
        if context.isPreview {
            completion(DebtEntry(date: Date(), status: DebtyAPI.cached ?? .preview))
            return
        }
        Task {
            let status = await DebtyAPI.fetch()
            completion(DebtEntry(date: Date(), status: status))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DebtEntry>) -> Void) {
        Task {
            let status = await DebtyAPI.fetch()
            let cal = Calendar.current
            let now = Date()
            var entries = [DebtEntry(date: now, status: status)]
            // One entry per midnight for the next week, so the count keeps
            // going down even if the phone can't reach the server.
            var day = cal.startOfDay(for: now)
            for _ in 0..<7 {
                guard let next = cal.date(byAdding: .day, value: 1, to: day) else { break }
                day = next
                entries.append(DebtEntry(date: day, status: status))
            }
            // Ask to check back every 15 minutes (iOS rations widget
            // refreshes, so it may wait longer). Payments logged in the app
            // don't wait for this: the app tells iOS to refresh right away
            // (ios-extras/App/WidgetReloadPlugin.swift).
            let minutes = (status?.paired ?? false) ? 15 : 5
            let refresh = cal.date(byAdding: .minute, value: minutes, to: now) ?? now.addingTimeInterval(3600)
            completion(Timeline(entries: entries, policy: .after(refresh)))
        }
    }
}

// MARK: - Views

extension Color {
    static let debtyRed = Color(red: 0.94, green: 0.27, blue: 0.27)
    static let debtyBackground = Color(red: 0.05, green: 0.05, blue: 0.05)
}

func money(_ value: Double?, _ currency: String?) -> String {
    guard let value else { return "–" }
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = currency ?? "CAD"
    f.maximumFractionDigits = 0
    return f.string(from: NSNumber(value: value)) ?? String(Int(value))
}

struct DebtyWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: DebtEntry

    private var status: WidgetStatus? { entry.status }
    private var isAccessory: Bool {
        family == .accessoryCircular || family == .accessoryRectangular || family == .accessoryInline
    }

    var body: some View {
        content
            .containerBackground(for: .widget) {
                if isAccessory { Color.clear } else { Color.debtyBackground }
            }
    }

    @ViewBuilder private var content: some View {
        if let status, !status.paired {
            pairing(code: status.code ?? "------")
        } else if let status, status.active == true {
            if status.done == true { done } else { countdown(status) }
        } else if status != nil {
            message("Start the debt-free challenge in Debty", icon: "flag.checkered")
        } else {
            message("Open Debty to set up the widget", icon: "wifi.exclamationmark")
        }
    }

    private var daysText: String {
        guard let d = entry.daysLeft else { return "∞" }
        return d.formatted()
    }

    private var dateText: String {
        guard let s = status?.debtFreeDate, let d = DebtyAPI.dayFormatter.date(from: s) else { return "Payment too low" }
        return d.formatted(.dateTime.month(.abbreviated).day().year())
    }

    // MARK: Countdown

    @ViewBuilder private func countdown(_ s: WidgetStatus) -> some View {
        let progress = min(1, max(0, s.progress ?? 0))
        switch family {
        case .accessoryInline:
            Text(entry.daysLeft.map { "\($0) days to debt-free" } ?? "Debty: raise your payment")
        case .accessoryCircular:
            Gauge(value: progress) {
                Image(systemName: "flag.checkered")
            } currentValueLabel: {
                Text(daysText).minimumScaleFactor(0.5)
            }
            .gaugeStyle(.accessoryCircular)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Text("\(daysText) days").font(.headline).widgetAccentable()
                Text("to debt-free · \(dateText)").font(.caption).lineLimit(1)
                ProgressView(value: progress)
            }
        case .systemMedium:
            HStack(alignment: .top, spacing: 16) {
                bigCount(progress: progress)
                VStack(alignment: .leading, spacing: 8) {
                    stat("Still owed", money(s.totalDebt, s.currency))
                    stat("Paying", "\(money(s.monthly, s.currency))/mo")
                    if let ahead = s.daysAhead, ahead != 0 {
                        stat(ahead > 0 ? "Ahead" : "Behind", "\(abs(ahead)) days")
                    } else {
                        stat("Paid off", "\(Int((progress * 100).rounded()))%")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        default:
            bigCount(progress: progress)
        }
    }

    private func bigCount(progress: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("DEBT-FREE IN")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.debtyRed)
            Text(daysText)
                .font(.system(size: 46, weight: .black, design: .rounded))
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .foregroundStyle(.white)
            Text("days")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.8))
            Spacer(minLength: 4)
            ProgressView(value: progress).tint(Color.debtyRed)
            Text(dateText)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased()).font(.caption2).foregroundStyle(.white.opacity(0.5))
            Text(value).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.7)
        }
    }

    // MARK: Other states

    @ViewBuilder private var done: some View {
        switch family {
        case .accessoryInline: Text("Debt-free! 🎉")
        case .accessoryCircular: Image(systemName: "checkmark.seal.fill").font(.title)
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Text("Debt-free! 🎉").font(.headline)
                Text("Every balance paid off").font(.caption)
            }
        default:
            VStack(spacing: 6) {
                Text("🎉").font(.largeTitle)
                Text("Debt-free!").font(.headline).foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private func pairing(code: String) -> some View {
        let spaced = code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
        switch family {
        case .accessoryInline: Text("Debty code \(spaced)")
        case .accessoryCircular:
            VStack(spacing: 0) {
                Text("Link").font(.caption2)
                Text(code).font(.system(size: 11, weight: .bold, design: .monospaced)).minimumScaleFactor(0.5)
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("Link Debty widget").font(.caption)
                Text(spaced).font(.system(.title3, design: .monospaced).weight(.bold))
                Text("Debt → Home screen widget").font(.caption2).lineLimit(1)
            }
        default:
            VStack(alignment: .leading, spacing: 4) {
                Text("LINK TO DEBTY")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.debtyRed)
                Text(spaced)
                    .font(.system(size: 30, weight: .heavy, design: .monospaced))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .foregroundStyle(.white)
                Spacer(minLength: 2)
                Text("In Debty: Debt → Debt-free challenge → Home screen widget, then enter this code.")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.7))
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func message(_ text: String, icon: String) -> some View {
        switch family {
        case .accessoryInline: Text(text)
        case .accessoryCircular: Image(systemName: icon).font(.title2)
        default:
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: icon).foregroundStyle(Color.debtyRed)
                Text(text)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(isAccessory ? Color.primary : Color.white)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Widget

@main
struct DebtyWidget: Widget {
    let kind = "DebtyWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            DebtyWidgetView(entry: entry)
        }
        .configurationDisplayName("Debt-free countdown")
        .description("Days until you're debt-free, from your Debty challenge.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
