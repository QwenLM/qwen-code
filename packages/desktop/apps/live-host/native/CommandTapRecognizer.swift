import Foundation

enum CommandTapEvent: Equatable {
    case commandDown(UInt16, hasOtherModifiers: Bool)
    case commandUp(UInt16, hasOtherModifiers: Bool)
    case ordinaryKey
    case otherModifier
    case tapDisabled
}

struct CommandTapRecognizer {
    private enum Phase {
        case idle
        case firstDown(startedAtMs: Double)
        case firstUp(startedAtMs: Double)
        case secondDown(startedAtMs: Double)
    }

    private let maximumIntervalMs: Double
    private let cooldownMs: Double
    private var phase: Phase = .idle
    private var pressedCommandKeys = Set<UInt16>()
    private var blockedUntilAllCommandKeysUp = false
    private var cooldownUntilMs: Double = 0

    init(maximumIntervalMs: Double = 350, cooldownMs: Double = 350) {
        self.maximumIntervalMs = maximumIntervalMs
        self.cooldownMs = cooldownMs
    }

    mutating func consume(_ event: CommandTapEvent, at nowMs: Double) -> Bool {
        expireSequence(at: nowMs)

        switch event {
        case .tapDisabled, .ordinaryKey, .otherModifier:
            cancelSequence()
            return false

        case let .commandDown(keyCode, hasOtherModifiers):
            if pressedCommandKeys.contains(keyCode) {
                return false
            }
            if hasOtherModifiers {
                pressedCommandKeys.insert(keyCode)
                blockedUntilAllCommandKeysUp = true
                phase = .idle
                return false
            }
            if !pressedCommandKeys.isEmpty {
                pressedCommandKeys.insert(keyCode)
                blockedUntilAllCommandKeysUp = true
                phase = .idle
                return false
            }
            pressedCommandKeys.insert(keyCode)

            if blockedUntilAllCommandKeysUp || nowMs < cooldownUntilMs {
                return false
            }

            switch phase {
            case .idle:
                phase = .firstDown(startedAtMs: nowMs)
                return false
            case .firstDown:
                return false
            case let .firstUp(startedAtMs):
                guard nowMs - startedAtMs <= maximumIntervalMs else {
                    phase = .firstDown(startedAtMs: nowMs)
                    return false
                }
                phase = .secondDown(startedAtMs: startedAtMs)
                return false
            case .secondDown:
                return false
            }

        case let .commandUp(keyCode, hasOtherModifiers):
            pressedCommandKeys.remove(keyCode)
            if hasOtherModifiers {
                phase = .idle
                blockedUntilAllCommandKeysUp = !pressedCommandKeys.isEmpty
                return false
            }
            if pressedCommandKeys.isEmpty && blockedUntilAllCommandKeysUp {
                blockedUntilAllCommandKeysUp = false
                phase = .idle
                return false
            }

            guard nowMs >= cooldownUntilMs else {
                return false
            }

            switch phase {
            case let .firstDown(startedAtMs)
                where nowMs - startedAtMs <= maximumIntervalMs:
                phase = .firstUp(startedAtMs: startedAtMs)
                return false
            case let .secondDown(startedAtMs)
                where nowMs - startedAtMs <= maximumIntervalMs:
                phase = .idle
                cooldownUntilMs = nowMs + cooldownMs
                return true
            default:
                phase = .idle
                return false
            }
        }
    }

    private mutating func expireSequence(at nowMs: Double) {
        switch phase {
        case let .firstDown(startedAtMs),
             let .firstUp(startedAtMs),
             let .secondDown(startedAtMs):
            if nowMs - startedAtMs > maximumIntervalMs {
                phase = .idle
            }
        case .idle:
            break
        }
    }

    private mutating func cancelSequence() {
        phase = .idle
        if !pressedCommandKeys.isEmpty {
            blockedUntilAllCommandKeysUp = true
        }
    }
}
