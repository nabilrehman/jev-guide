// axhelper: eyes and hands for jev-guide --mac.
// Long-running process. Reads one JSON command per line on stdin, writes one JSON
// reply per line on stdout. Uses the macOS Accessibility API to list every
// actionable control of the target app, presses them, types, fires hotkeys,
// glides the real cursor, and draws a caption bar + highlight ring on screen.
//
// Build: swiftc -O -framework Cocoa -framework ApplicationServices -framework AVFoundation mac/axhelper.swift -o mac/axhelper
import Cocoa
import ApplicationServices
import AVFoundation
import Foundation

// MARK: - IO
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    outLock.lock(); defer { outLock.unlock() }
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"json\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// MARK: - AX helpers
func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    if let a = v as? NSAttributedString { return a.string }
    if let u = v as? URL { return u.absoluteString }
    return nil
}
func boolAttr(_ el: AXUIElement, _ name: String) -> Bool? {
    guard let v = attr(el, name) else { return nil }
    if let n = v as? NSNumber { return n.boolValue }
    return nil
}
func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func actionNames(_ el: AXUIElement) -> [String] {
    var a: CFArray?
    AXUIElementCopyActionNames(el, &a)
    return (a as? [String]) ?? []
}
func clean(_ s: String?, _ max: Int = 80) -> String {
    guard let s = s else { return "" }
    let t = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    return String(t.prefix(max))
}

let interactiveRoles: Set<String> = [
    "AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea",
    "AXComboBox", "AXLink", "AXMenuItem", "AXRow", "AXCell", "AXDisclosureTriangle", "AXSlider", "AXIncrementor",
    "AXTab", "AXColorWell", "AXDockItem", "AXSwitch", "AXToggle", "AXSearchField",
]
let containerRoles: Set<String> = [
    "AXWindow", "AXGroup", "AXScrollArea", "AXSplitGroup", "AXTabGroup", "AXToolbar", "AXList", "AXTable", "AXOutline",
    "AXWebArea", "AXSheet", "AXDrawer", "AXLayoutArea", "AXLayoutItem", "AXGenericElement", "AXUnknown", "AXBrowser",
    "AXPopover", "AXRow", "AXCell", "AXColumn", "AXMenu", "AXMenuBar", "AXApplication", "AXHeading", "AXSection",
    "AXLandmark", "AXNavigation", "AXBusyIndicator", "AXGrid", "AXRadioGroup", "AXDisclosureTriangle", "AXMatte", "AXScrollBar",
]

func kindOf(_ role: String, _ subrole: String?, parentRole: String?) -> String {
    switch role {
    case "AXButton": return "button"
    case "AXPopUpButton": return "dropdown"
    case "AXMenuButton": return "menu button"
    case "AXCheckBox": return "checkbox"
    case "AXRadioButton": return parentRole == "AXTabGroup" ? "tab" : "radio"
    case "AXTextField": return subrole == "AXSearchField" ? "search box" : "text field"
    case "AXSearchField": return "search box"
    case "AXTextArea": return "text area"
    case "AXComboBox": return "combo box"
    case "AXLink": return "link"
    case "AXMenuItem": return "menu item"
    case "AXRow": return "row"
    case "AXCell": return "cell"
    case "AXDisclosureTriangle": return "disclosure"
    case "AXSlider": return "slider"
    case "AXIncrementor": return "stepper"
    case "AXTab": return "tab"
    case "AXDockItem": return "dock item"
    case "AXSwitch", "AXToggle": return "switch"
    default: return "clickable"
    }
}

// Concatenate static text in descendants (labels for rows/cells/groups).
func innerText(_ el: AXUIElement, depth: Int = 0, budget: inout Int) -> String {
    if depth > 3 || budget <= 0 { return "" }
    var parts: [String] = []
    for c in children(el) {
        budget -= 1
        let role = str(c, kAXRoleAttribute) ?? ""
        if role == "AXStaticText" || role == "AXTextField" || role == "AXHeading" {
            let v = clean(str(c, kAXValueAttribute) ?? str(c, kAXTitleAttribute), 60)
            if !v.isEmpty { parts.append(v) }
        } else if role == "AXImage" {
            let v = clean(str(c, kAXDescriptionAttribute), 40)
            if !v.isEmpty { parts.append(v) }
        } else {
            let t = innerText(c, depth: depth + 1, budget: &budget)
            if !t.isEmpty { parts.append(t) }
        }
        if parts.joined(separator: " ").count > 80 { break }
    }
    return clean(parts.joined(separator: " "), 80)
}

func labelOf(_ el: AXUIElement, role: String) -> String {
    let title = clean(str(el, kAXTitleAttribute))
    if !title.isEmpty { return title }
    let desc = clean(str(el, kAXDescriptionAttribute))
    if !desc.isEmpty { return desc }
    if let te = attr(el, kAXTitleUIElementAttribute) {
        let t = clean(str(te as! AXUIElement, kAXValueAttribute) ?? str(te as! AXUIElement, kAXTitleAttribute))
        if !t.isEmpty { return t }
    }
    let ph = clean(str(el, "AXPlaceholderValue"))
    if !ph.isEmpty { return ph }
    if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" || role == "AXSearchField" {
        return ""  // value is reported separately
    }
    var budget = 60
    let inner = innerText(el, budget: &budget)
    if !inner.isEmpty { return inner }
    let help = clean(str(el, kAXHelpAttribute))
    if !help.isEmpty { return help }
    if role == "AXLink" { return clean(str(el, "AXURL"), 60) }
    return ""
}

// MARK: - State
var elementCache: [String: AXUIElement] = [:]
let axDebug = ProcessInfo.processInfo.environment["JEV_AXDEBUG"] != nil
// Last complete read of each background window (see snapshot), and the elements behind its ids.
var windowCache: [String: (nodes: [(Node, AXUIElement)], texts: [String])] = [:]
var counter = 0
var targetPid: pid_t? = nil
let screenBounds: CGRect = NSScreen.screens.reduce(CGRect.null) { $0.union(flipped($1.frame)) }
func primaryHeight() -> CGFloat { NSScreen.screens.first?.frame.height ?? 0 }
func flipped(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: primaryHeight() - r.maxY, width: r.width, height: r.height) } // AppKit -> Quartz

struct Node { var id: String; var kind: String; var label: String; var extra: String; var inViewport: Bool; var top: Int; var left: Int; var w: Int; var h: Int }

func targetApp() -> NSRunningApplication? {
    if let pid = targetPid, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated { return app }
    return NSWorkspace.shared.frontmostApplication
}

func enableWebAX(_ appEl: AXUIElement) {
    // Chromium/Electron only expose web content when an assistive tech asks for it.
    AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

func snapshot(maxNodes: Int) -> [String: Any] {
    elementCache.removeAll(); counter = 0
    guard let app = targetApp() else { return ["error": "no target app"] }
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(appEl, 2.0)
    enableWebAX(appEl)
    var nodes: [Node] = []
    var texts: [String] = []
    var textLen = 0
    var visited = 0
    var timing: [String] = []
    var tick = Date()
    func lap(_ what: String) { timing.append("\(what) \(Int(Date().timeIntervalSince(tick) * 1000))ms"); tick = Date() }
    var windows: [AXUIElement] = []
    if let fw = attr(appEl, kAXFocusedWindowAttribute) { windows.append(fw as! AXUIElement) }
    for w in (attr(appEl, kAXWindowsAttribute) as? [AXUIElement]) ?? [] where !windows.contains(where: { CFEqual($0, w) }) {
        if boolAttr(w, kAXMinimizedAttribute) == true { continue }
        windows.append(w)
    }
    // windows[0] is the focused (front) window: a Save/Open/Print panel or alert when one is up.
    // Chrome's panels look like ordinary windows, so "front" is the signal, not a dialog flag.
    lap("windows")
    let windowTitle = windows.first.flatMap { clean(str($0, kAXTitleAttribute), 120) } ?? ""
    func place(_ w: AXUIElement, front: Bool) -> String {
        let t = clean(str(w, kAXTitleAttribute), 60)
        return (front ? "front window" : "background window") + (t.isEmpty ? "" : " \"\(t)\"")
    }
    var context = ""  // where the element being walked lives, e.g. front window "Save"
    var deadline: Date? = nil  // background windows only
    var timedOut = false

    func walk(_ el: AXUIElement, clip: CGRect, depth: Int, parentRole: String?) {
        if visited > 6000 || nodes.count >= maxNodes || depth > 40 { return }
        if let d = deadline, Date() > d { timedOut = true; return }
        visited += 1
        let tEl = Date()
        defer { let ms = Int(Date().timeIntervalSince(tEl) * 1000); if axDebug, ms > 300 { FileHandle.standardError.write("slow \(ms)ms depth \(depth) \(str(el, kAXRoleAttribute) ?? "?") \(str(el, kAXSubroleAttribute) ?? "") \(clean(str(el, kAXTitleAttribute) ?? str(el, kAXDescriptionAttribute), 40))\n".data(using: .utf8)!) } }
        let role = str(el, kAXRoleAttribute) ?? ""
        if role == "AXMenuBar" || role == "AXMenu" && depth > 0 && parentRole != "AXMenuButton" { return }
        let outer = context
        if role == "AXSheet" { context = "sheet in " + outer }
        defer { context = outer }
        let fr = frame(el)
        var myClip = clip
        if let f = fr, role == "AXScrollArea" || role == "AXWindow" || role == "AXSheet" { myClip = clip.intersection(f) }
        let isInteractive = interactiveRoles.contains(role) || actionNames(el).contains("AXPress") && (role == "AXGroup" || role == "AXStaticText" || role == "AXImage")
        if role == "AXStaticText", textLen < 1500, let v = str(el, kAXValueAttribute) {
            let c = clean(v, 200); if !c.isEmpty { texts.append(c); textLen += c.count }
        }
        if isInteractive, let f = fr, f.width >= 2, f.height >= 2, f.intersects(screenBounds) {
            let enabled = boolAttr(el, kAXEnabledAttribute) ?? true
            if enabled {
                let subrole = str(el, kAXSubroleAttribute)
                let kind = kindOf(role, subrole, parentRole: parentRole)
                let label = labelOf(el, role: role)
                var extra: [String] = []
                if kind == "text field" || kind == "text area" || kind == "search box" || kind == "combo box" {
                    let v = clean(str(el, kAXValueAttribute), 40); if !v.isEmpty { extra.append("value=" + v) }
                } else if kind == "dropdown" || kind == "checkbox" || kind == "radio" || kind == "switch" || kind == "tab" || kind == "slider" {
                    let v = clean(str(el, kAXValueAttribute), 30); if !v.isEmpty { extra.append("value=" + v) }
                }
                if boolAttr(el, kAXSelectedAttribute) == true { extra.append("selected") }
                if boolAttr(el, kAXFocusedAttribute) == true { extra.append("focused") }
                if let ex = boolAttr(el, kAXExpandedAttribute) { extra.append(ex ? "expanded" : "collapsed") }
                if role == "AXLink", let u = str(el, "AXURL") { extra.append("href=" + clean(u, 300)) }
                if windows.count > 1 || context.hasPrefix("sheet") { extra.append("in " + context) }
                if !label.isEmpty || kind.contains("field") || kind.contains("box") || kind == "text area" {
                    counter += 1
                    let id = "a\(counter)"
                    elementCache[id] = el
                    nodes.append(Node(id: id, kind: kind, label: label, extra: extra.joined(separator: ", "),
                                      inViewport: f.intersects(myClip), top: Int(f.minY), left: Int(f.minX), w: Int(f.width), h: Int(f.height)))
                }
            }
        }
        // Rows/cells: still recurse (they may contain buttons), but not into menus.
        if containerRoles.contains(role) || isInteractive && (role == "AXRow" || role == "AXCell" || role == "AXGroup") || role == "AXWebArea" || role.isEmpty {
            if role == "AXScrollArea" || role == "AXOutline" || role == "AXTable" || role == "AXList" {
                // Prefer visible rows to avoid walking 10k off-screen rows.
                if let vis = attr(el, "AXVisibleRows") as? [AXUIElement], !vis.isEmpty {
                    for c in vis { walk(c, clip: myClip, depth: depth + 1, parentRole: role) }
                    for c in children(el) where str(c, kAXRoleAttribute) != "AXRow" { walk(c, clip: myClip, depth: depth + 1, parentRole: role) }
                    return
                }
                // Lists without rows (e.g. the file list in Save/Open panels: a folder with 400+
                // files took 14 s to read in full) can still say which children are on screen.
                if role != "AXScrollArea", let vis = attr(el, "AXVisibleChildren") as? [AXUIElement], !vis.isEmpty {
                    for c in vis { walk(c, clip: myClip, depth: depth + 1, parentRole: role) }
                    return
                }
            }
            for c in children(el) { walk(c, clip: myClip, depth: depth + 1, parentRole: role) }
        }
    }
    // The front window is always read in full. Windows behind it get a short time budget: while a
    // panel is up, Chrome answers slowly for the page behind it (15-30 s for a full read). If the
    // budget runs out, reuse the last full read of that window: it is frozen behind the panel anyway.
    for (i, w) in windows.enumerated() {
        context = place(w, front: i == 0)
        let key = "\(app.processIdentifier)-\(CFHash(w))"
        let n0 = nodes.count, t0 = texts.count
        deadline = i == 0 ? nil : Date().addingTimeInterval(1.5)
        timedOut = false
        walk(w, clip: screenBounds, depth: 0, parentRole: "AXApplication")
        lap("w\(i) \(nodes.count - n0) nodes\(timedOut ? " (timed out)" : "")")
        if !timedOut {
            windowCache[key] = (nodes[n0...].compactMap { n in elementCache[n.id].map { (n, $0) } }, Array(texts[t0...]))
        } else if i > 0, let cached = windowCache[key] {
            for n in nodes[n0...] { elementCache.removeValue(forKey: n.id) }
            nodes.removeSubrange(n0...); texts.removeSubrange(t0...)
            for (var c, el) in cached.nodes where nodes.count < maxNodes {
                counter += 1; c.id = "a\(counter)"; elementCache[c.id] = el
                c.extra = c.extra.isEmpty ? "from earlier read" : c.extra + ", from earlier read"
                nodes.append(c)
            }
            texts.append(contentsOf: cached.texts)
        }
    }
    // If the app has no windows (e.g. Finder desktop), still offer the Dock.
    return [
        "app": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "", "pid": app.processIdentifier,
        "window": windowTitle, "text": clean(texts.joined(separator: " "), 1500),
        "elements": nodes.map { ["id": $0.id, "kind": $0.kind, "label": $0.label, "extra": $0.extra, "inViewport": $0.inViewport, "top": $0.top, "left": $0.left, "w": $0.w, "h": $0.h] },
        "truncated": nodes.count >= maxNodes, "timing": timing.joined(separator: ", "),
    ]
}

func menus(max: Int) -> [String: Any] {
    guard let app = targetApp() else { return ["error": "no target app"] }
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(appEl, 2.0)
    var items: [[String: Any]] = []
    guard let bar = attr(appEl, kAXMenuBarAttribute) else { return ["items": items] }
    for top in children(bar as! AXUIElement) {
        let topTitle = clean(str(top, kAXTitleAttribute))
        if topTitle.isEmpty || topTitle == "Apple" { continue }
        for menu in children(top) {
            for item in children(menu) {
                if items.count >= max { break }
                let t = clean(str(item, kAXTitleAttribute))
                if t.isEmpty || boolAttr(item, kAXEnabledAttribute) == false { continue }
                counter += 1; let id = "m\(counter)"; elementCache[id] = item
                let sc = clean(str(item, "AXMenuItemCmdChar"), 4)
                items.append(["id": id, "label": "\(topTitle) > \(t)", "shortcut": sc])
                // one level of submenu
                for sub in children(item) {
                    for si in children(sub) {
                        if items.count >= max { break }
                        let st = clean(str(si, kAXTitleAttribute))
                        if st.isEmpty || boolAttr(si, kAXEnabledAttribute) == false { continue }
                        counter += 1; let sid = "m\(counter)"; elementCache[sid] = si
                        items.append(["id": sid, "label": "\(topTitle) > \(t) > \(st)", "shortcut": ""])
                    }
                }
            }
        }
    }
    return ["items": items]
}

// MARK: - Input synthesis
func postMouse(_ type: CGEventType, _ p: CGPoint, button: CGMouseButton = .left, clicks: Int = 1) {
    guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    e.post(tap: .cghidEventTap)
}
func mousePos() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
func glide(to p: CGPoint, ms: Int) {
    let from = mousePos()
    let steps = max(8, ms / 16)
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let e = 1 - pow(1 - t, 3) // ease-out
        postMouse(.mouseMoved, CGPoint(x: from.x + (p.x - from.x) * e, y: from.y + (p.y - from.y) * e))
        usleep(useconds_t(max(1, ms / steps) * 1000))
    }
}
func click(at p: CGPoint, count: Int = 1) {
    postMouse(.mouseMoved, p); usleep(60_000)
    for i in 1...count {
        postMouse(.leftMouseDown, p, clicks: i); usleep(40_000)
        postMouse(.leftMouseUp, p, clicks: i); usleep(60_000)
    }
}
func scroll(lines: Int32, at p: CGPoint) {
    postMouse(.mouseMoved, p); usleep(30_000)
    if let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0) {
        e.location = p; e.post(tap: .cghidEventTap)
    }
}
let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51, "enter": 36, "return": 36, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
func hotkey(_ combo: String) -> Bool {
    let parts = combo.lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
    var flags: CGEventFlags = []
    var key: CGKeyCode? = nil
    for p in parts {
        switch p {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: key = keyCodes[p]
        }
    }
    guard let k = key else { return false }
    postKey(k, flags: flags); usleep(30_000)
    return true
}
var keyTap: CGEventTapLocation = .cgSessionEventTap
let eventSource = CGEventSource(stateID: .combinedSessionState)
// US-layout characters reachable with Shift.
let shifted: [Character: String] = ["A":"a","B":"b","C":"c","D":"d","E":"e","F":"f","G":"g","H":"h","I":"i","J":"j","K":"k","L":"l","M":"m","N":"n","O":"o","P":"p","Q":"q","R":"r","S":"s","T":"t","U":"u","V":"v","W":"w","X":"x","Y":"y","Z":"z",
    "!":"1","@":"2","#":"3","$":"4","%":"5","^":"6","&":"7","*":"8","(":"9",")":"0","_":"-","+":"=","{":"[","}":"]","|":"\\",":":";","\"":"'","<":",",">":".","?":"/","~":"`"]
func postKey(_ code: CGKeyCode, flags: CGEventFlags, unicode: String? = nil) {
    guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false) else { return }
    if let u = unicode { var arr = Array(u.utf16); down.keyboardSetUnicodeString(stringLength: arr.count, unicodeString: &arr); up.keyboardSetUnicodeString(stringLength: arr.count, unicodeString: &arr) }
    down.flags = flags; up.flags = flags
    down.post(tap: keyTap); usleep(12_000); up.post(tap: keyTap)
}
func typeText(_ text: String, delayMs: Int) {
    for ch in text {
        if ch == "\n" { _ = hotkey("return"); continue }
        let lower = String(ch)
        if let code = keyCodes[lower], lower.count == 1 {              // plain US key
            postKey(code, flags: [])
        } else if ch == " " { postKey(49, flags: [])
        } else if ch == "\t" { postKey(48, flags: [])
        } else if let base = shifted[ch], let code = keyCodes[base] {   // shifted US key
            postKey(code, flags: .maskShift)
        } else {                                                        // anything else: unicode event
            postKey(0, flags: [], unicode: String(ch))
        }
        usleep(useconds_t(delayMs * 1000))
    }
}

// Paste text with Cmd+V, then put the user's clipboard back. Much faster than typing long text.
func pasteText(_ text: String) {
    let pb = NSPasteboard.general
    let saved: [[NSPasteboard.PasteboardType: Data]] = (pb.pasteboardItems ?? []).map { item in
        var d: [NSPasteboard.PasteboardType: Data] = [:]
        for t in item.types { if let v = item.data(forType: t) { d[t] = v } }
        return d
    }
    pb.clearContents()
    pb.setString(text, forType: .string)
    usleep(50_000)
    _ = hotkey("cmd+v")
    usleep(400_000) // let the app read the clipboard before restoring it
    pb.clearContents()
    if !saved.isEmpty {
        pb.writeObjects(saved.map { d -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (t, v) in d { item.setData(v, forType: t) }
            return item
        })
    }
}

// MARK: - Overlay windows (caption + highlight ring)
final class RingView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 3, dy: 3), xRadius: 8, yRadius: 8)
        NSColor(calibratedRed: 1, green: 0.23, blue: 0.19, alpha: 0.35).setStroke(); path.lineWidth = 9; path.stroke()
        NSColor(calibratedRed: 1, green: 0.23, blue: 0.19, alpha: 1).setStroke(); path.lineWidth = 3; path.stroke()
    }
}
func makePanel() -> NSPanel {
    let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false; p.level = .screenSaver
    p.ignoresMouseEvents = true; p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
    p.isReleasedWhenClosed = false
    return p
}
let captionPanel = makePanel()
let captionBox = NSView(); let captionLabel = NSTextField(labelWithString: ""); let statusLabel = NSTextField(labelWithString: "")
let ringPanel = makePanel(); let ringView = RingView()
func setupOverlay() {
    captionBox.wantsLayer = true; captionBox.layer?.backgroundColor = NSColor(calibratedWhite: 0, alpha: 0.78).cgColor; captionBox.layer?.cornerRadius = 10
    captionLabel.font = NSFont.systemFont(ofSize: 22, weight: .semibold); captionLabel.textColor = .white; captionLabel.alignment = .center
    captionLabel.lineBreakMode = .byWordWrapping; captionLabel.maximumNumberOfLines = 3
    statusLabel.font = NSFont.systemFont(ofSize: 14, weight: .medium); statusLabel.textColor = NSColor(calibratedRed: 0.61, green: 0.91, blue: 0.64, alpha: 1); statusLabel.alignment = .center
    captionBox.addSubview(captionLabel); captionBox.addSubview(statusLabel)
    captionPanel.contentView = captionBox
    ringPanel.contentView = ringView
}
func setCaption(_ text: String, _ status: String) {
    if text.isEmpty && status.isEmpty { captionPanel.orderOut(nil); return }
    guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
    captionLabel.stringValue = text; statusLabel.stringValue = status
    let maxW = screen.frame.width * 0.7
    captionLabel.preferredMaxLayoutWidth = maxW - 36
    let ts = captionLabel.sizeThatFits(NSSize(width: maxW - 36, height: 200))
    let ss = status.isEmpty ? NSSize.zero : statusLabel.sizeThatFits(NSSize(width: maxW - 36, height: 40))
    let w = min(maxW, max(ts.width, ss.width) + 36), h = ts.height + (status.isEmpty ? 0 : ss.height + 4) + 20
    statusLabel.frame = NSRect(x: 18, y: 10, width: w - 36, height: ss.height)
    captionLabel.frame = NSRect(x: 18, y: (status.isEmpty ? 10 : 10 + ss.height + 4), width: w - 36, height: ts.height)
    captionBox.frame = NSRect(x: 0, y: 0, width: w, height: h)
    let x = screen.frame.midX - w / 2, y = screen.frame.minY + 64
    captionPanel.setFrame(NSRect(x: x, y: y, width: w, height: h), display: true)
    captionPanel.orderFrontRegardless()
}
func setRing(_ r: CGRect?) {
    guard let r = r else { ringPanel.orderOut(nil); return }
    let pad: CGFloat = 6
    let ak = NSRect(x: r.minX - pad, y: primaryHeight() - r.maxY - pad, width: r.width + 2 * pad, height: r.height + 2 * pad) // Quartz -> AppKit
    ringPanel.setFrame(ak, display: true); ringView.frame = NSRect(origin: .zero, size: ak.size); ringView.needsDisplay = true
    ringPanel.orderFrontRegardless()
}


// MARK: - Streaming audio (Gemini Live)
// Mic: while the talk key is held, 16 kHz mono 16-bit PCM is emitted as {"event":"mic","data":<base64>}.
// Speaker: {"op":"play","data":<base64 24 kHz mono 16-bit PCM>} queues audio; {"op":"play_stop"} cuts it
// off (barge-in). {"event":"play_idle"} is emitted when everything queued has played.
let micEngine = AVAudioEngine()
let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
var micStreaming = false
var streamMode = false

func startMicStream() -> String? {
    let input = micEngine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0, let conv = AVAudioConverter(from: inFormat, to: micFormat) else { return "no microphone input" }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buf, _ in
        let cap = AVAudioFrameCount(Double(buf.frameLength) * micFormat.sampleRate / inFormat.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        guard out.frameLength > 0, let ch = out.int16ChannelData else { return }
        emit(["event": "mic", "data": Data(bytes: ch[0], count: Int(out.frameLength) * 2).base64EncodedString()])
    }
    micEngine.prepare()
    do { try micEngine.start() } catch {
        input.removeTap(onBus: 0)
        return "could not start the microphone (check Privacy & Security → Microphone)"
    }
    micStreaming = true
    return nil
}
func stopMicStream() {
    guard micStreaming else { return }
    micEngine.inputNode.removeTap(onBus: 0)
    micEngine.stop()
    micStreaming = false
}

let playEngine = AVAudioEngine()
let player = AVAudioPlayerNode()
let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
var playAttached = false
var playQueued = 0
var playGen = 0 // bumped on play_stop so completions of cut-off buffers are ignored

func playPCM(_ b64: String) -> [String: Any] {
    guard let data = Data(base64Encoded: b64), data.count >= 2 else { return ["error": "bad audio"] }
    if !playAttached {
        playEngine.attach(player)
        playEngine.connect(player, to: playEngine.mainMixerNode, format: playFormat)
        playAttached = true
    }
    if !playEngine.isRunning { do { try playEngine.start() } catch { return ["error": "could not start audio output"] } }
    let n = data.count / 2
    guard let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)) else { return ["error": "audio buffer"] }
    buf.frameLength = AVAudioFrameCount(n)
    let dst = buf.floatChannelData![0]
    data.withUnsafeBytes { raw in
        let src = raw.bindMemory(to: Int16.self)
        for i in 0..<n { dst[i] = Float(Int16(littleEndian: src[i])) / 32768 }
    }
    let gen = playGen
    playQueued += 1
    player.scheduleBuffer(buf) {
        DispatchQueue.main.async {
            guard gen == playGen else { return }
            playQueued -= 1
            if playQueued == 0 { emit(["event": "play_idle"]) }
        }
    }
    if !player.isPlaying { player.play() }
    return ["ok": true]
}
func stopPlayback() {
    guard playAttached else { return }
    playGen += 1
    playQueued = 0
    player.stop()
}

// MARK: - Push-to-talk (hold a key anywhere, speak, release)
// Emits unsolicited events: {"event":"ptt_start"}, {"event":"ptt_stop","file":...,"ms":...},
// {"event":"ptt_tap"} (released too quickly: treated as a tap), {"event":"quit"}.
var pttKeyCode: UInt16 = 61          // 61 = right Option, 54 = right Command, 63 = fn
var pttDown = false
var pttStart = Date()
var pttOtherKey = false
var recorder: AVAudioRecorder?
var recFile = ""
var statusItem: NSStatusItem?

func modifierFlag(for code: UInt16) -> NSEvent.ModifierFlags {
    switch code {
    case 54, 55: return .command
    case 58, 61: return .option
    case 59, 62: return .control
    case 56, 60: return .shift
    case 63: return .function
    default: return .option
    }
}
func startRecording() {
    recFile = NSTemporaryDirectory() + "jev-ptt-\(Int(Date().timeIntervalSince1970 * 1000)).wav"
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                                   AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
    recorder = try? AVAudioRecorder(url: URL(fileURLWithPath: recFile), settings: settings)
    if recorder?.record() != true { emit(["event": "ptt_error", "error": "could not start the microphone (check Privacy & Security → Microphone)"]); recorder = nil }
}
func stopRecording() -> String? {
    guard let r = recorder else { return nil }
    r.stop(); recorder = nil
    return recFile
}
func handleFlags(_ e: NSEvent) {
    guard e.keyCode == pttKeyCode else { return }
    let down = e.modifierFlags.contains(modifierFlag(for: pttKeyCode))
    if down && !pttDown {
        pttDown = true; pttStart = Date(); pttOtherKey = false
        if streamMode {
            stopPlayback()
            if let err = startMicStream() { emit(["event": "ptt_error", "error": err]) }
        } else { startRecording() }
        emit(["event": "ptt_start"])
    } else if !down && pttDown {
        pttDown = false
        let ms = Int(Date().timeIntervalSince(pttStart) * 1000)
        if streamMode { stopMicStream() }
        let file = streamMode ? nil : stopRecording()
        if pttOtherKey { if let f = file { try? FileManager.default.removeItem(atPath: f) }; emit(["event": "ptt_cancel"]); return }
        if ms < 350 { if let f = file { try? FileManager.default.removeItem(atPath: f) }; emit(["event": "ptt_tap"]); return }
        emit(["event": "ptt_stop", "file": file ?? "", "ms": ms])
    }
}
@objc final class MenuTarget: NSObject {
    @objc func quit() { emit(["event": "quit"]) }
    @objc func stop() { emit(["event": "stop"]) }
    @objc func chat() { emit(["event": "open_chat"]) }
}
var stopMenuItem: NSMenuItem?

// Floating "Stop" button under the caption while a task runs. Non-activating, so clicking
// it doesn't steal focus from the app being driven.
final class StopButtonPanel: NSPanel { override var canBecomeKey: Bool { false } }
let stopPanel: NSPanel = {
    let p = StopButtonPanel(contentRect: NSRect(x: 0, y: 0, width: 120, height: 36), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = true; p.level = .screenSaver
    p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]; p.isReleasedWhenClosed = false
    p.becomesKeyOnlyIfNeeded = true
    return p
}()
func setupStopButton() {
    let b = NSButton(title: "■  Stop", target: menuTarget, action: #selector(MenuTarget.stop))
    b.isBordered = false; b.wantsLayer = true
    b.layer?.backgroundColor = NSColor(calibratedRed: 0.86, green: 0.18, blue: 0.16, alpha: 0.95).cgColor
    b.layer?.cornerRadius = 18
    b.attributedTitle = NSAttributedString(string: "■  Stop", attributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 15, weight: .semibold)])
    b.frame = NSRect(x: 0, y: 0, width: 120, height: 36)
    stopPanel.contentView = b
}
func setBusyUI(_ busy: Bool) {
    stopMenuItem?.isEnabled = busy
    guard busy, let screen = NSScreen.main ?? NSScreen.screens.first else { stopPanel.orderOut(nil); return }
    stopPanel.setFrameOrigin(NSPoint(x: screen.frame.midX - 60, y: screen.frame.minY + 16))
    stopPanel.orderFrontRegardless()
}
let menuTarget = MenuTarget()

// Small black oval dome stuck to the bottom of the screen (above the Dock), like Willow's, with
// five voice bars: still when idle, dancing while push-to-talk is held (on red), a slow wave
// while a task runs. Click it during a task to stop it.
final class DomeView: NSView {
    var state = "idle" { didSet { if state != oldValue { restartTimer(); needsDisplay = true } } }
    var phase = 0.0
    var timer: Timer?
    func restartTimer() {
        timer?.invalidate(); timer = nil
        guard state != "idle" else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.phase += 1.0 / 30; self?.needsDisplay = true }
    }
    override func draw(_ dirtyRect: NSRect) {
        let r = bounds, rad = r.width / 2
        let path = NSBezierPath()
        path.move(to: NSPoint(x: 0, y: 0))
        path.line(to: NSPoint(x: 0, y: r.height - rad))
        path.appendArc(withCenter: NSPoint(x: rad, y: r.height - rad), radius: rad, startAngle: 180, endAngle: 0, clockwise: true)
        path.line(to: NSPoint(x: r.width, y: 0)); path.close()
        (state == "listening" ? NSColor(calibratedRed: 0.80, green: 0.13, blue: 0.13, alpha: 1) : NSColor.black).setFill()
        path.fill()
        let base: [Double] = [0.38, 0.66, 1.0, 0.66, 0.38]
        let barW: CGFloat = 2.6, gap: CGFloat = 2.4, maxH: CGFloat = 14
        let total = CGFloat(base.count) * barW + CGFloat(base.count - 1) * gap
        let midY = r.height * 0.45
        NSColor.white.setFill()
        for (i, b) in base.enumerated() {
            var k = b
            if state == "listening" { k = b * (0.45 + 0.55 * abs(sin(phase * 7 + Double(i) * 1.3))) }
            else if state == "busy" { k = b * (0.55 + 0.45 * (0.5 + 0.5 * sin(phase * 3 - Double(i) * 0.9))) }
            let h = max(barW, maxH * CGFloat(k))
            let x = r.midX - total / 2 + CGFloat(i) * (barW + gap)
            NSBezierPath(roundedRect: NSRect(x: x, y: midY - h / 2, width: barW, height: h), xRadius: barW / 2, yRadius: barW / 2).fill()
        }
    }
    override func mouseDown(with event: NSEvent) { emit(["event": state == "busy" ? "stop" : "open_chat"]) }
}
let domeView = DomeView(frame: NSRect(x: 0, y: 0, width: 40, height: 34))
let domePanel: NSPanel = {
    let p = StopButtonPanel(contentRect: domeView.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false; p.level = .statusBar
    p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]; p.isReleasedWhenClosed = false
    p.contentView = domeView
    return p
}()
func showDome() {
    guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
    // Left of center: Willow Voice already sits in the middle.
    let x = screen.frame.midX - domeView.frame.width / 2 - CGFloat(Double(ProcessInfo.processInfo.environment["JEV_DOME_OFFSET"] ?? "") ?? 60)
    domePanel.setFrameOrigin(NSPoint(x: x, y: screen.visibleFrame.minY))
    domePanel.orderFrontRegardless()
}
func enablePTT(key: Int?) -> [String: Any] {
    if let k = key { pttKeyCode = UInt16(k) }
    showDome()
    NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { handleFlags($0) }
    NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { handleFlags($0); return $0 }
    // Holding Option while typing a character (e.g. Option+E) is not a voice command.
    NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { _ in if pttDown { pttOtherKey = true } }
    var mic = "unknown"
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: mic = "granted"
    case .notDetermined: mic = "asking"; AVCaptureDevice.requestAccess(for: .audio) { ok in emit(["event": "mic_permission", "granted": ok]) }
    default: mic = "denied"
    }
    return ["ok": true, "mic": mic]
}
func setStatus(_ title: String) {
    if statusItem == nil {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.autoenablesItems = false
        let st = NSMenuItem(title: "Stop current task", action: #selector(MenuTarget.stop), keyEquivalent: ""); st.target = menuTarget; st.isEnabled = false
        menu.addItem(st); stopMenuItem = st
        let ch = NSMenuItem(title: "Open chat window", action: #selector(MenuTarget.chat), keyEquivalent: ""); ch.target = menuTarget
        menu.addItem(ch)
        menu.addItem(NSMenuItem.separator())
        let q = NSMenuItem(title: "Quit Jev Guide", action: #selector(MenuTarget.quit), keyEquivalent: "q"); q.target = menuTarget
        menu.addItem(q)
        statusItem?.menu = menu
    }
    statusItem?.button?.title = title
    domeView.state = title == "🔴" ? "listening" : title == "⏳" ? "busy" : "idle"
}

// MARK: - Commands
func elementFor(_ id: String) -> AXUIElement? { elementCache[id] }

// Never send input unless the target app is actually in front (the human may
// have switched apps meanwhile). Activates it, then verifies; nil = ok.
func ensureFront() -> String? {
    guard let pid = targetPid, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return nil }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return nil }
    app.activate(options: [.activateIgnoringOtherApps])
    for _ in 0..<20 {
        usleep(50_000)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { usleep(150_000); return nil }
    }
    return "target app \(app.localizedName ?? "") is not in front (\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?") is); refusing to send input"
}
func center(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }

func handle(_ cmd: [String: Any]) -> [String: Any] {
    let op = cmd["op"] as? String ?? ""
    switch op {
    case "check":
        let trusted = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": (cmd["prompt"] as? Bool ?? false)] as CFDictionary)
        return ["trusted": trusted]
    case "target":
        if let name = cmd["app"] as? String, !name.isEmpty {
            let apps = NSWorkspace.shared.runningApplications.filter { ($0.localizedName ?? "").lowercased() == name.lowercased() || ($0.bundleIdentifier ?? "") == name }
            guard let app = apps.first else { return ["error": "app not running: \(name)"] }
            targetPid = app.processIdentifier
            app.activate(options: [.activateIgnoringOtherApps])
            return ["ok": true, "app": app.localizedName ?? "", "pid": app.processIdentifier]
        }
        targetPid = nil; return ["ok": true]
    case "apps":
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { ["name": $0.localizedName ?? "", "bundle": $0.bundleIdentifier ?? "", "pid": $0.processIdentifier, "active": $0.isActive] }
        let front = NSWorkspace.shared.frontmostApplication
        return ["running": running, "frontmost": front?.localizedName ?? "", "frontmostBundle": front?.bundleIdentifier ?? ""]
    case "snapshot":
        return snapshot(maxNodes: cmd["max"] as? Int ?? 1500)
    case "menus":
        return menus(max: cmd["max"] as? Int ?? 300)
    case "point":
        guard let id = cmd["id"] as? String, let el = elementFor(id), let f = frame(el) else { return ["error": "unknown element"] }
        setRing(f); glide(to: center(f), ms: cmd["ms"] as? Int ?? 450)
        return ["ok": true, "x": f.midX, "y": f.midY]
    case "press":
        guard let id = cmd["id"] as? String, let el = elementFor(id) else { return ["error": "unknown element"] }
        if let e = ensureFront() { return ["error": e] }
        let f = frame(el)
        if let f = f { setRing(f); glide(to: center(f), ms: 450); usleep(150_000) }
        var how = "click"
        let role = str(el, kAXRoleAttribute) ?? ""
        let preferAX = role == "AXMenuItem" || id.hasPrefix("m") || f == nil || (cmd["ax"] as? Bool ?? false)
        if preferAX, actionNames(el).contains("AXPress"), AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
            how = "axpress"
        } else if let f = f {
            click(at: center(f))
        } else if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
            how = "axpress"
        } else { return ["error": "cannot press"] }
        usleep(200_000); setRing(nil)
        return ["ok": true, "how": how]
    case "focus":
        guard let id = cmd["id"] as? String, let el = elementFor(id) else { return ["error": "unknown element"] }
        if let e = ensureFront() { return ["error": e] }
        if let f = frame(el) { setRing(f); glide(to: center(f), ms: 400); click(at: center(f)) }
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(150_000); setRing(nil)
        return ["ok": true]
    case "setvalue":
        guard let id = cmd["id"] as? String, let el = elementFor(id) else { return ["error": "unknown element"] }
        let ok = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, (cmd["text"] as? String ?? "") as CFString) == .success
        return ["ok": ok]
    case "click":
        if let e = ensureFront() { return ["error": e] }
        let p = CGPoint(x: cmd["x"] as? Double ?? 0, y: cmd["y"] as? Double ?? 0)
        glide(to: p, ms: 400); click(at: p, count: cmd["count"] as? Int ?? 1)
        return ["ok": true]
    case "move":
        glide(to: CGPoint(x: cmd["x"] as? Double ?? 0, y: cmd["y"] as? Double ?? 0), ms: cmd["ms"] as? Int ?? 400)
        return ["ok": true]
    case "type":
        if let e = ensureFront() { return ["error": e] }
        typeText(cmd["text"] as? String ?? "", delayMs: cmd["delay"] as? Int ?? 30)
        return ["ok": true]
    case "paste":
        if let e = ensureFront() { return ["error": e] }
        pasteText(cmd["text"] as? String ?? "")
        return ["ok": true]
    case "key":
        if let e = ensureFront() { return ["error": e] }
        return ["ok": hotkey(cmd["combo"] as? String ?? "")]
    case "scroll":
        if let e = ensureFront() { return ["error": e] }
        var p = mousePos()
        if let app = targetApp() {
            let appEl = AXUIElementCreateApplication(app.processIdentifier)
            if let w = attr(appEl, kAXFocusedWindowAttribute), let f = frame(w as! AXUIElement) { p = center(f) }
        }
        scroll(lines: Int32(cmd["lines"] as? Int ?? -10), at: p)
        return ["ok": true]
    case "caption":
        setCaption(cmd["text"] as? String ?? "", cmd["status"] as? String ?? "")
        return ["ok": true]
    case "ring":
        if let x = cmd["x"] as? Double, let y = cmd["y"] as? Double, let w = cmd["w"] as? Double, let h = cmd["h"] as? Double { setRing(CGRect(x: x, y: y, width: w, height: h)) } else { setRing(nil) }
        return ["ok": true]
    case "tap":
        keyTap = (cmd["tap"] as? String) == "hid" ? .cghidEventTap : .cgSessionEventTap
        return ["ok": true]
    case "mouse":
        let p = mousePos(); return ["x": p.x, "y": p.y]
    case "play":
        return playPCM(cmd["data"] as? String ?? "")
    case "mic": // start/stop the mic stream directly (tests; later hands-free mode)
        if cmd["on"] as? Bool ?? false { if let e = startMicStream() { return ["error": e] } } else { stopMicStream() }
        return ["ok": true]
    case "play_stop":
        stopPlayback()
        return ["ok": true]
    case "ptt":
        streamMode = cmd["stream"] as? Bool ?? false
        return enablePTT(key: cmd["key"] as? Int)
    case "busy":
        setBusyUI(cmd["busy"] as? Bool ?? false); return ["ok": true]
    case "status":
        setStatus(cmd["title"] as? String ?? "🎤"); return ["ok": true]
    case "quit":
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { NSApp.terminate(nil) }
        return ["ok": true]
    default:
        return ["error": "unknown op \(op)"]
    }
}

// MARK: - Main
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
setupOverlay()
setupStopButton()
emit(["ready": true, "trusted": AXIsProcessTrusted()])
let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8), let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { emit(["error": "bad json"]); continue }
        var reply: [String: Any] = [:]
        DispatchQueue.main.sync { reply = handle(cmd) }
        if let rid = cmd["rid"] { reply["rid"] = rid }
        emit(reply)
    }
    DispatchQueue.main.async { NSApp.terminate(nil) }
}
reader.start()
app.run()
