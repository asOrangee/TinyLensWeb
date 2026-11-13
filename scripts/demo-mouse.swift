import AppKit
import CoreGraphics

let eventSource = CGEventSource(stateID: .hidSystemState)

struct Point: Decodable {
    let x: Double
    let y: Double

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

struct Request: Decodable {
    let action: String
    let pid: Int32?
    let points: [Point]?
    let seconds: Double?
    let names: [String]?
    let role: String?
    let value: String?
}

struct MouseError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

func ensureFocus(_ pid: Int32) throws {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw MouseError("演示窗口已失去焦点，已停止鼠标操作。")
    }
}

func location() throws -> CGPoint {
    guard let position = CGEvent(source: nil)?.location else {
        throw MouseError("无法读取系统光标位置。")
    }
    return position
}

func post(_ type: CGEventType, _ point: CGPoint) throws {
    guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type,
                              mouseCursorPosition: point, mouseButton: .left) else {
        throw MouseError("无法创建鼠标事件。")
    }
    if type == .leftMouseDown || type == .leftMouseUp {
        event.setIntegerValueField(.mouseEventClickState, value: 1)
    }
    event.post(tap: .cghidEventTap)
}

func travel(from start: CGPoint, to end: CGPoint, seconds: Double,
            event: CGEventType, pid: Int32) throws {
    let steps = max(1, Int(ceil(seconds * 60)))
    for step in 1...steps {
        if step == 1 || step % 8 == 0 || step == steps { try ensureFocus(pid) }
        if seconds > 0 { Thread.sleep(forTimeInterval: seconds / Double(steps)) }
        let t = Double(step) / Double(steps)
        let ease = t * t * (3 - 2 * t)
        try post(event, CGPoint(x: start.x + (end.x - start.x) * ease,
                               y: start.y + (end.y - start.y) * ease))
    }
}

func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success ? value : nil
}

struct Control: Encodable {
    let role: String
    let names: [String]
    let enabled: Bool
    let value: String?
}

func recordlyControls(_ node: AXUIElement, depth: Int = 0) -> [(AXUIElement, Control)] {
    guard depth < 24 else { return [] }
    let role = attribute(node, "AXRole") as? String ?? ""
    let names = ["AXTitle", "AXDescription", "AXHelp", "AXIdentifier"].compactMap {
        attribute(node, $0) as? String
    }.filter { !$0.isEmpty }
    let children = attribute(node, "AXChildren") as? [AXUIElement] ?? []
    let nested = children.flatMap { recordlyControls($0, depth: depth + 1) }
    guard ["AXWindow", "AXSheet", "AXPopover", "AXDialog", "AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox",
           "AXRadioButton", "AXMenuItem", "AXTextField", "AXTextArea"].contains(role) else { return nested }
    let enabled = attribute(node, "AXEnabled") as? Bool ?? true
    let value = role == "AXPopUpButton" ? attribute(node, "AXValue") as? String : nil
    return [(node, Control(role: role, names: names, enabled: enabled, value: value))] + nested
}

func useRecordly(_ request: Request) throws {
    guard AXIsProcessTrusted() else {
        throw MouseError("运行脚本的程序需要 macOS「辅助功能」权限来操作 Recordly。")
    }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.recordly.app").first else {
        throw MouseError("Recordly 尚未打开。")
    }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 0.5)
    let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
    let controls = windows.flatMap { recordlyControls($0) }
    if request.action == "recordly-controls" {
        print(String(decoding: try JSONEncoder().encode(controls.map(\.1)), as: UTF8.self))
        return
    }
    let names = Set(request.names ?? [])
    let matches = controls.filter { _, control in
        control.enabled && (request.role == nil || control.role == request.role)
        && !names.isDisjoint(with: control.names)
    }
    guard matches.count == 1, let (element, _) = matches.first else {
        throw MouseError("Recordly 控件未能唯一定位（\(names.sorted().joined(separator: " / "))）。")
    }
    let result: AXError
    if request.action == "recordly-press" {
        result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    } else if request.action == "recordly-value", let value = request.value {
        result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    } else {
        throw MouseError("不支持的 Recordly 操作。")
    }
    guard result == .success else { throw MouseError("Recordly 控件操作失败（\(result.rawValue)）。") }
}

func run(_ request: Request) throws {
    if request.action.hasPrefix("recordly-") {
        try useRecordly(request)
        return
    }
    guard CGPreflightPostEventAccess() else {
        throw MouseError("请在系统设置的「隐私与安全性 → 辅助功能」中允许运行脚本的程序控制鼠标。")
    }
    if request.action == "check" { return }
    guard let pid = request.pid, pid > 1 else { throw MouseError("缺少演示浏览器进程。") }
    if request.action == "activate" {
        guard NSRunningApplication(processIdentifier: pid)?.activate(options: []) == true else {
            throw MouseError("无法激活演示浏览器窗口。")
        }
        return
    }

    try ensureFocus(pid)
    if request.action == "position" {
        let point = try location()
        print("{\"x\":\(point.x),\"y\":\(point.y)}")
        return
    }
    let points = (request.points ?? []).map(\.cgPoint)
    let seconds = request.seconds ?? 0
    guard let first = points.first, points.count <= 8, (0...3).contains(seconds),
          points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else {
        throw MouseError("鼠标坐标或动作时长无效。")
    }
    let start = try location()
    if request.action == "move" {
        try travel(from: start, to: first, seconds: seconds, event: .mouseMoved, pid: pid)
        return
    }

    guard request.action == "click" || (request.action == "drag" && points.count > 1),
          hypot(start.x - first.x, start.y - first.y) <= 4 else {
        throw MouseError("系统光标已离开预定落点，已取消点击或拖拽。")
    }
    try post(.leftMouseDown, first)
    var released = false
    defer { if !released { try? post(.leftMouseUp, (try? location()) ?? first) } }
    Thread.sleep(forTimeInterval: 0.05)
    if request.action == "click" {
        try post(.leftMouseUp, first)
    } else {
        for (start, end) in zip(points, points.dropFirst()) {
            try travel(from: start, to: end, seconds: seconds / Double(points.count - 1),
                       event: .leftMouseDragged, pid: pid)
        }
        Thread.sleep(forTimeInterval: 0.075)
        try post(.leftMouseUp, points.last ?? first)
    }
    released = true
    Thread.sleep(forTimeInterval: 0.075)
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    try run(JSONDecoder().decode(Request.self, from: input))
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
