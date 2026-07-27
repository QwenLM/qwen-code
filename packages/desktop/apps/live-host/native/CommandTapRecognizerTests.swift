import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}

@main
private enum CommandTapRecognizerTests {
    static func main() {
        var basic = CommandTapRecognizer()
        expect(!basic.consume(.commandDown(55, hasOtherModifiers: false), at: 0), "first down")
        expect(!basic.consume(.commandUp(55, hasOtherModifiers: false), at: 40), "first up")
        expect(!basic.consume(.commandDown(55, hasOtherModifiers: false), at: 180), "second down")
        expect(basic.consume(.commandUp(55, hasOtherModifiers: false), at: 200), "second up toggles")
        expect(!basic.consume(.commandDown(55, hasOtherModifiers: false), at: 240), "triple tap cooldown")

        var secondTapShortcut = CommandTapRecognizer()
        expect(!secondTapShortcut.consume(.commandDown(55, hasOtherModifiers: false), at: 0), "shortcut first down")
        expect(!secondTapShortcut.consume(.commandUp(55, hasOtherModifiers: false), at: 30), "shortcut first up")
        expect(!secondTapShortcut.consume(.commandDown(55, hasOtherModifiers: false), at: 120), "shortcut second down")
        expect(!secondTapShortcut.consume(.ordinaryKey, at: 140), "second tap becomes chord")
        expect(!secondTapShortcut.consume(.commandUp(55, hasOtherModifiers: false), at: 160), "chord release must not toggle")

        var slow = CommandTapRecognizer()
        expect(!slow.consume(.commandDown(55, hasOtherModifiers: false), at: 0), "slow first down")
        expect(!slow.consume(.commandUp(55, hasOtherModifiers: false), at: 20), "slow first up")
        expect(!slow.consume(.commandDown(55, hasOtherModifiers: false), at: 351), "slow second down")
        expect(!slow.consume(.commandUp(55, hasOtherModifiers: false), at: 370), "slow second up")

        var shortcut = CommandTapRecognizer()
        expect(!shortcut.consume(.commandDown(55, hasOtherModifiers: false), at: 0), "shortcut command down")
        expect(!shortcut.consume(.ordinaryKey, at: 20), "shortcut key")
        expect(!shortcut.consume(.commandUp(55, hasOtherModifiers: false), at: 30), "shortcut command up")
        expect(!shortcut.consume(.commandDown(55, hasOtherModifiers: false), at: 100), "shortcut restart")

        var otherModifier = CommandTapRecognizer()
        expect(!otherModifier.consume(.commandDown(55, hasOtherModifiers: false), at: 0), "modifier command")
        expect(!otherModifier.consume(.otherModifier, at: 10), "other modifier")
        expect(!otherModifier.consume(.commandUp(55, hasOtherModifiers: false), at: 20), "modifier command up")
        expect(!otherModifier.consume(.commandDown(55, hasOtherModifiers: false), at: 100), "modifier new start")

        var simultaneous = CommandTapRecognizer()
        expect(!simultaneous.consume(.commandDown(55, hasOtherModifiers: false), at: 0), "left command")
        expect(!simultaneous.consume(.commandDown(54, hasOtherModifiers: false), at: 20), "right command")
        expect(!simultaneous.consume(.commandUp(55, hasOtherModifiers: false), at: 30), "left release")
        expect(!simultaneous.consume(.commandUp(54, hasOtherModifiers: false), at: 40), "right release")
        expect(!simultaneous.consume(.commandDown(55, hasOtherModifiers: false), at: 80), "new first down")

        for label in ["Shift", "Option", "Control", "Fn", "CapsLock"] {
            var preheld = CommandTapRecognizer()
            expect(
                !preheld.consume(.commandDown(55, hasOtherModifiers: true), at: 0),
                "\(label) pre-held first command"
            )
            expect(
                !preheld.consume(.commandUp(55, hasOtherModifiers: true), at: 30),
                "\(label) pre-held release"
            )
            expect(
                !preheld.consume(.commandDown(55, hasOtherModifiers: true), at: 100),
                "\(label) pre-held second command must not toggle"
            )
        }

        print("CommandTapRecognizerTests: PASS")
    }
}
