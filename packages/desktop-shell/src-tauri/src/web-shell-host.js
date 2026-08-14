(() => {
  const hostWindow = globalThis;
  if (!hostWindow.qwenCodeHost) {
    const invoke = (command, args) =>
      hostWindow.__TAURI__.core.invoke(command, args);
    const subscribe = (event, callback) => {
      let disposed = false;
      let unlisten;
      hostWindow.__TAURI__.event.listen(event, callback).then((remove) => {
        if (disposed) remove();
        else unlisten = remove;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    };

    Object.defineProperty(hostWindow, 'qwenCodeHost', {
      configurable: false,
      value: {
        loadSettings: (language) =>
          invoke('desktop_host_settings', { language }),
        setSetting: (key, value) =>
          invoke('set_desktop_host_setting', { key, value }),
        onSettingsChanged: (callback) =>
          subscribe('desktop-host-settings-changed', callback),
        reportStreamingState: (state) =>
          void invoke('report_pet_streaming_state', { state }),
        reportSessionChange: (event) =>
          void invoke('report_pet_session_change', { event }),
      },
    });
  }
  hostWindow.dispatchEvent(new hostWindow.Event('qwen-code-host-ready'));
})();
