/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// macOS microphone authorization query via AVFoundation. Compiled only on mac
// (see binding.gyp). Returns the AVAuthorizationStatus as a small int so the
// C++ addon can map it without linking ObjC itself:
//   0 = notDetermined, 1 = restricted, 2 = denied, 3 = authorized
#import <AVFoundation/AVFoundation.h>

extern "C" int qwen_mic_authorization_status(void) {
  if (@available(macOS 10.14, *)) {
    AVAuthorizationStatus status =
        [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    switch (status) {
      case AVAuthorizationStatusAuthorized:
        return 3;
      case AVAuthorizationStatusDenied:
        return 2;
      case AVAuthorizationStatusRestricted:
        return 1;
      case AVAuthorizationStatusNotDetermined:
      default:
        return 0;
    }
  }
  // Pre-10.14 had no mic gate — treat as granted.
  return 3;
}
