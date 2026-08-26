export function shouldRecheckAudioInput(captureRequested: boolean): boolean {
  return !captureRequested;
}

export function audioInputConstraints(
  selectedDeviceId?: string,
): MediaTrackConstraints {
  return {
    channelCount: 1,
    noiseSuppression: true,
    ...(selectedDeviceId
      ? { deviceId: { exact: selectedDeviceId } }
      : undefined),
  };
}

export function isUnavailableDevicePreference(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
  );
}

export function hasAudioInputDevice(
  devices: readonly Pick<MediaDeviceInfo, 'kind'>[],
): boolean {
  return devices.some((device) => device.kind === 'audioinput');
}
