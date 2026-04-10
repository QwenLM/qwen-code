{
  "targets": [
    {
      "target_name": "modifiers_napi",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/modifiers.mm"],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
          "xcode_settings": {
            "CLANG_ENABLE_MODULES": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "OTHER_CFLAGS": ["-ObjC++"]
          },
          "link_settings": {
            "libraries": [
              "-framework CoreGraphics"
            ]
          }
        }]
      ]
    }
  ]
}
