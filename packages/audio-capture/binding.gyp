{
  "targets": [
    {
      "target_name": "audio_capture",
      "sources": ["native/audio_capture.cc"],
      "include_dirs": ["native"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["native/mac_permission.mm"],
          "libraries": [
            "-framework CoreAudio",
            "-framework AudioToolbox",
            "-framework AudioUnit",
            "-framework CoreFoundation",
            "-framework AVFoundation",
            "-framework Foundation"
          ]
        }],
        ["OS=='linux'", {
          "libraries": ["-ldl", "-lpthread", "-lm"]
        }],
        ["OS=='win'", {
          "libraries": ["winmm.lib", "ole32.lib", "uuid.lib", "ksuser.lib"]
        }]
      ]
    }
  ]
}
