// agentthumbs-mirroring: drives the macOS iPhone Mirroring window.
//
// Speaks JSON lines on stdin/stdout. Each request is {"id": n, "cmd": "...", ...}
// and gets exactly one response {"id": n, "ok": true, ...} or {"id": n, "ok": false, "error": "..."}.
//
// Coordinates in requests are pixels of the latest screenshot. The helper maps
// them to screen points using the window's current position, so the window can
// move between calls.

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

let mirroringBundleId = "com.apple.ScreenContinuity"

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

// MARK: - Window

struct MirroringWindow {
  let windowId: CGWindowID
  /// Global screen points, top-left origin.
  let frame: CGRect
}

/// The largest on-screen window owned by iPhone Mirroring. Uses the Core Graphics
/// window list, which is synchronous and cheap enough to call before every action.
func findWindow() -> MirroringWindow? {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: mirroringBundleId).first else {
    return nil
  }
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
  var best: MirroringWindow?
  for info in list {
    guard (info[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier,
      (info[kCGWindowLayer as String] as? Int) == 0,
      let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: boundsDict),
      let number = info[kCGWindowNumber as String] as? CGWindowID,
      bounds.width > 100, bounds.height > 100
    else { continue }
    if best == nil || bounds.width * bounds.height > best!.frame.width * best!.frame.height {
      best = MirroringWindow(windowId: number, frame: bounds)
    }
  }
  return best
}

func requireWindow() throws -> MirroringWindow {
  guard let window = findWindow() else {
    throw HelperError(
      "The iPhone Mirroring window is not open. Open iPhone Mirroring, connect to the iPhone and keep the window visible.")
  }
  return window
}

func activateMirroring() {
  NSRunningApplication.runningApplications(withBundleIdentifier: mirroringBundleId).first?.activate()
}

// MARK: - Capture

/// Pixels per point of the latest screenshot; maps request pixels back to points.
var lastScale: CGFloat = 2

func screenshot() async throws -> (png: Data, width: Int, height: Int, scale: CGFloat) {
  let window = try requireWindow()
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let scWindow = content.windows.first(where: { $0.windowID == window.windowId }) else {
    throw HelperError("iPhone Mirroring window is not capturable right now.")
  }
  let scale = NSScreen.screens.first(where: { $0.frame.intersects(window.frame) })?.backingScaleFactor
    ?? NSScreen.main?.backingScaleFactor ?? 2
  let filter = SCContentFilter(desktopIndependentWindow: scWindow)
  let config = SCStreamConfiguration()
  config.width = Int(window.frame.width * scale)
  config.height = Int(window.frame.height * scale)
  config.showsCursor = false
  config.ignoreShadowsSingleWindow = true
  config.captureResolution = .best
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  lastScale = CGFloat(image.width) / window.frame.width
  let rep = NSBitmapImageRep(cgImage: image)
  guard let png = rep.representation(using: .png, properties: [:]) else {
    throw HelperError("Could not encode the screenshot.")
  }
  return (png, image.width, image.height, lastScale)
}

// MARK: - OCR

func recognizeText(png: Data) throws -> [[String: Any]] {
  guard let source = CGImageSourceCreateWithData(png as CFData, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { throw HelperError("Could not decode the image for OCR.") }
  let width = CGFloat(image.width)
  let height = CGFloat(image.height)

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.automaticallyDetectsLanguage = true
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])

  var elements: [[String: Any]] = []
  for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.3 else { continue }
    // Vision boxes are normalized with a bottom-left origin.
    let box = observation.boundingBox
    elements.append([
      "label": candidate.string,
      "x": Int(box.minX * width),
      "y": Int((1 - box.maxY) * height),
      "width": Int(box.width * width),
      "height": Int(box.height * height),
      "confidence": candidate.confidence,
    ])
  }
  return elements
}

// MARK: - Input

func toScreenPoint(x: Double, y: Double, in window: MirroringWindow) -> CGPoint {
  CGPoint(x: window.frame.minX + CGFloat(x) / lastScale, y: window.frame.minY + CGFloat(y) / lastScale)
}

let eventSource = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, at point: CGPoint) {
  CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}

/// Runs mouse input and puts the user's cursor back where it was.
func withCursorRestored(_ body: () -> Void) {
  let original = CGEvent(source: nil)?.location
  body()
  if let original { CGWarpMouseCursorPosition(original) }
}

func sleepMs(_ ms: Double) {
  usleep(useconds_t(max(0, ms) * 1000))
}

func prepareInput() throws -> MirroringWindow {
  guard AXIsProcessTrusted() else {
    throw HelperError(
      "Accessibility permission is missing. Allow the app running agentthumbs in System Settings > Privacy & Security > Accessibility.")
  }
  let window = try requireWindow()
  activateMirroring()
  sleepMs(120)
  return window
}

func tap(x: Double, y: Double) throws {
  let window = try prepareInput()
  let point = toScreenPoint(x: x, y: y, in: window)
  withCursorRestored {
    post(.mouseMoved, at: point)
    sleepMs(30)
    post(.leftMouseDown, at: point)
    sleepMs(60)
    post(.leftMouseUp, at: point)
    sleepMs(30)
  }
}

func drag(from: (Double, Double), to: (Double, Double), durationMs: Double, holdMs: Double = 0) throws {
  let window = try prepareInput()
  let start = toScreenPoint(x: from.0, y: from.1, in: window)
  let end = toScreenPoint(x: to.0, y: to.1, in: window)
  let steps = max(8, Int(durationMs / 16))
  withCursorRestored {
    post(.mouseMoved, at: start)
    sleepMs(30)
    post(.leftMouseDown, at: start)
    sleepMs(max(40, holdMs))
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      post(.leftMouseDragged, at: CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
      sleepMs(durationMs / Double(steps))
    }
    post(.leftMouseUp, at: end)
    sleepMs(30)
  }
}

func pressKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
    sleepMs(20)
  }
}

func typeText(_ text: String) throws {
  _ = try prepareInput()
  for character in text {
    if character == "\n" {
      pressKey(36)
      continue
    }
    let units = Array(String(character).utf16)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down)
      event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      event?.post(tap: .cghidEventTap)
    }
    sleepMs(12)
  }
}

/// iPhone Mirroring's own shortcuts: ⌘1 Home Screen, ⌘2 App Switcher, ⌘3 Spotlight.
func key(_ name: String) throws {
  _ = try prepareInput()
  switch name {
  case "home": pressKey(18, flags: .maskCommand)
  case "app_switch": pressKey(19, flags: .maskCommand)
  case "spotlight": pressKey(20, flags: .maskCommand)
  case "enter": pressKey(36)
  case "delete": pressKey(51)
  default: throw HelperError("iPhone Mirroring has no \"\(name)\" key.")
  }
}

func launch() async throws -> MirroringWindow {
  if let window = findWindow() { return window }
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: mirroringBundleId) else {
    throw HelperError("iPhone Mirroring is not available on this Mac (macOS 15 or later).")
  }
  _ = try await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
  for _ in 0..<60 {
    if let window = findWindow() { return window }
    try await Task.sleep(nanoseconds: 250_000_000)
  }
  throw HelperError("iPhone Mirroring opened but no window appeared. Check the app for a connection prompt.")
}

// MARK: - Protocol

func frameJSON(_ frame: CGRect) -> [String: Any] {
  ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
}

func handle(_ request: [String: Any]) async throws -> [String: Any] {
  let cmd = request["cmd"] as? String ?? ""
  func number(_ key: String) throws -> Double {
    guard let value = request[key] as? Double ?? (request[key] as? Int).map(Double.init) else {
      throw HelperError("Missing number \"\(key)\".")
    }
    return value
  }

  switch cmd {
  case "status":
    let window = findWindow()
    return [
      "running": !NSRunningApplication.runningApplications(withBundleIdentifier: mirroringBundleId).isEmpty,
      "window": window.map { frameJSON($0.frame) } ?? NSNull(),
      "permissions": ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()],
    ]
  case "request_permissions":
    let screen = CGRequestScreenCaptureAccess()
    let accessibility = AXIsProcessTrustedWithOptions(
      [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    return ["screenRecording": screen, "accessibility": accessibility]
  case "launch":
    return ["window": frameJSON(try await launch().frame)]
  case "screenshot":
    let shot = try await screenshot()
    return ["png": shot.png.base64EncodedString(), "width": shot.width, "height": shot.height, "scale": shot.scale]
  case "ocr":
    guard let base64 = request["png"] as? String, let data = Data(base64Encoded: base64) else {
      throw HelperError("Missing \"png\".")
    }
    return ["elements": try recognizeText(png: data)]
  case "tap":
    try tap(x: try number("x"), y: try number("y"))
  case "long_press":
    let x = try number("x")
    let y = try number("y")
    try drag(from: (x, y), to: (x, y), durationMs: 50, holdMs: (request["ms"] as? Double) ?? 800)
  case "swipe":
    try drag(
      from: (try number("x1"), try number("y1")), to: (try number("x2"), try number("y2")),
      durationMs: (request["ms"] as? Double) ?? 300)
  case "type":
    guard let text = request["text"] as? String else { throw HelperError("Missing \"text\".") }
    try typeText(text)
  case "key":
    guard let name = request["key"] as? String else { throw HelperError("Missing \"key\".") }
    try key(name)
  default:
    throw HelperError("Unknown command \"\(cmd)\".")
  }
  return [:]
}

func respond(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// Needed for NSRunningApplication.activate and screen metrics without a full app.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.prohibited)

Task {
  for try await line in FileHandle.standardInput.bytes.lines {
    guard let data = line.data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      respond(["ok": false, "error": "Invalid JSON request."])
      continue
    }
    let id = request["id"] ?? NSNull()
    do {
      var result = try await handle(request)
      result["id"] = id
      result["ok"] = true
      respond(result)
    } catch {
      respond(["id": id, "ok": false, "error": "\(error)"])
    }
  }
  exit(0)
}

RunLoop.main.run()
