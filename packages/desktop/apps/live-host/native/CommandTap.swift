import ApplicationServices
import Foundation

private let leftCommandKeyCode: UInt16 = 55
private let rightCommandKeyCode: UInt16 = 54
private let otherModifierFlags: CGEventFlags = [
    .maskShift,
    .maskControl,
    .maskAlternate,
    .maskSecondaryFn,
    .maskAlphaShift,
]

private func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object)
    else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private final class CommandTapMonitor {
    private var recognizer = CommandTapRecognizer()
    private var eventTap: CFMachPort?

    func start() -> Bool {
        let eventMask =
            (CGEventMask(1) << CGEventType.flagsChanged.rawValue) |
            (CGEventMask(1) << CGEventType.keyDown.rawValue)
        let context = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: { _, type, event, userInfo in
                guard let userInfo else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<CommandTapMonitor>
                    .fromOpaque(userInfo)
                    .takeUnretainedValue()
                monitor.handle(type: type, event: event)
                return Unmanaged.passUnretained(event)
            },
            userInfo: context
        ) else {
            return false
        }

        eventTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CFRelease(source)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    private func handle(type: CGEventType, event: CGEvent) {
        let nowMs = ProcessInfo.processInfo.systemUptime * 1_000

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            _ = recognizer.consume(.tapDisabled, at: nowMs)
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            return
        }

        if type == .keyDown {
            if recognizer.consume(.ordinaryKey, at: nowMs) {
                emitToggle(at: nowMs)
            }
            return
        }

        guard type == .flagsChanged else { return }
        let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
        guard keyCode == leftCommandKeyCode || keyCode == rightCommandKeyCode else {
            _ = recognizer.consume(.otherModifier, at: nowMs)
            return
        }

        let isDown = CGEventSource.keyState(
            .combinedSessionState,
            key: CGKeyCode(keyCode)
        )
        let hasOtherModifiers = !event.flags
            .intersection(otherModifierFlags)
            .isEmpty
        let commandEvent: CommandTapEvent = isDown
            ? .commandDown(keyCode, hasOtherModifiers: hasOtherModifiers)
            : .commandUp(keyCode, hasOtherModifiers: hasOtherModifiers)
        if recognizer.consume(commandEvent, at: nowMs) {
            emitToggle(at: nowMs)
        }
    }

    private func emitToggle(at nowMs: Double) {
        emit([
            "type": "toggle",
            "monotonicMs": Int(nowMs),
        ])
    }
}

@main
private enum CommandTapMain {
    private static func activate(_ monitor: CommandTapMonitor) {
        guard monitor.start() else {
            emit([
                "type": "error",
                "code": "event_tap_unavailable",
            ])
            exit(4)
        }
        emit([
            "type": "ready",
            "pid": ProcessInfo.processInfo.processIdentifier,
        ])
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            if !CGPreflightListenEventAccess() {
                emit([
                    "type": "permission",
                    "inputMonitoring": false,
                ])
                exit(3)
            }
        }
    }

    static func main() {
        let shouldRequest = CommandLine.arguments.contains("--request-access")
        var granted = CGPreflightListenEventAccess()
        if shouldRequest && !granted {
            granted = CGRequestListenEventAccess()
        }

        emit([
            "type": "permission",
            "inputMonitoring": granted,
        ])
        let monitor = CommandTapMonitor()
        if granted {
            activate(monitor)
            CFRunLoopRun()
            return
        }

        guard shouldRequest else {
            exit(3)
        }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
            if CGPreflightListenEventAccess() {
                timer.invalidate()
                emit([
                    "type": "permission",
                    "inputMonitoring": true,
                ])
                activate(monitor)
            }
        }
        CFRunLoopRun()
    }
}
