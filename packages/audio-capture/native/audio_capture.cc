/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#if defined(__APPLE__)
// Implemented in mac_permission.mm (AVFoundation). 0=notDetermined, 1=restricted,
// 2=denied, 3=authorized.
extern "C" int qwen_mic_authorization_status(void);
#endif

namespace {

// Silence auto-stop: stop after this much trailing silence below the amplitude
// threshold (fraction of int16 full-scale). Mirrors the SoX `silence` effect
// (3% / 2.0s). Only armed after speech is first detected, so leading silence
// before the user speaks does not trigger a stop.
constexpr double kSilenceThreshold = 0.03 * 32768.0;
constexpr double kSilenceDurationSecs = 2.0;
// Reserve room for the 44-byte WAV header so ToWav output stays under 10 MiB.
constexpr size_t kMaxPcmBytes = 10 * 1024 * 1024 - 44;
constexpr size_t kMaxPcmSamples = kMaxPcmBytes / sizeof(int16_t);

struct RecorderState {
  ma_device device;
  std::atomic<bool> deviceInitialized{false};
  std::atomic<bool> recording{false};
  uint32_t sampleRate = 16000;
  uint32_t channels = 1;
  std::vector<int16_t> pcm;
  size_t pcmSize = 0;
  std::mutex mutex;
  std::atomic<bool> silenceDetectionEnabled{false};
  std::atomic<bool> speechStarted{false};
  std::atomic<uint64_t> silentFrames{0};
  // Recent input level (0..1), guarded by mutex — drives the waveform.
  double level = 0.0;
  // Read from the JS thread.
  std::atomic<bool> silenceDetected{false};
};

RecorderState gRecorder;

void StopRecorderDevice() {
  if (!gRecorder.recording.load() || !gRecorder.deviceInitialized.load()) {
    return;
  }
  ma_device_stop(&gRecorder.device);
  ma_device_uninit(&gRecorder.device);
  gRecorder.recording.store(false);
  gRecorder.deviceInitialized.store(false);
}

void CleanupRecorder(void*) {
  StopRecorderDevice();
}

bool GetBoolProperty(
    napi_env env,
    napi_value object,
    const char* key,
    bool fallback) {
  bool hasProperty = false;
  napi_has_named_property(env, object, key, &hasProperty);
  if (!hasProperty) return fallback;

  napi_value value;
  napi_get_named_property(env, object, key, &value);
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type != napi_boolean) return fallback;

  bool result = fallback;
  napi_get_value_bool(env, value, &result);
  return result;
}

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

uint32_t GetUint32Property(
    napi_env env,
    napi_value object,
    const char* key,
    uint32_t fallback) {
  bool hasProperty = false;
  napi_has_named_property(env, object, key, &hasProperty);
  if (!hasProperty) return fallback;

  napi_value value;
  napi_get_named_property(env, object, key, &value);
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type != napi_number) return fallback;

  uint32_t result = fallback;
  napi_get_value_uint32(env, value, &result);
  return result;
}

void WriteU16(std::vector<uint8_t>& out, uint16_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xff));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xff));
}

void WriteU32(std::vector<uint8_t>& out, uint32_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xff));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xff));
  out.push_back(static_cast<uint8_t>((value >> 16) & 0xff));
  out.push_back(static_cast<uint8_t>((value >> 24) & 0xff));
}

void WriteAscii(std::vector<uint8_t>& out, const char* value) {
  out.insert(out.end(), value, value + std::strlen(value));
}

std::vector<uint8_t> ToWav(
    const std::vector<int16_t>& pcm,
    uint32_t sampleRate,
    uint32_t channels) {
  const uint16_t bitsPerSample = 16;
  const uint16_t blockAlign = static_cast<uint16_t>(channels * 2);
  const uint32_t byteRate = sampleRate * blockAlign;
  const uint32_t dataBytes = static_cast<uint32_t>(pcm.size() * sizeof(int16_t));

  std::vector<uint8_t> wav;
  wav.reserve(44 + dataBytes);
  WriteAscii(wav, "RIFF");
  WriteU32(wav, 36 + dataBytes);
  WriteAscii(wav, "WAVE");
  WriteAscii(wav, "fmt ");
  WriteU32(wav, 16);
  WriteU16(wav, 1);
  WriteU16(wav, static_cast<uint16_t>(channels));
  WriteU32(wav, sampleRate);
  WriteU32(wav, byteRate);
  WriteU16(wav, blockAlign);
  WriteU16(wav, bitsPerSample);
  WriteAscii(wav, "data");
  WriteU32(wav, dataBytes);

  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(pcm.data());
  wav.insert(wav.end(), bytes, bytes + dataBytes);
  return wav;
}

void DataCallback(
    ma_device* device,
    void* output,
    const void* input,
    ma_uint32 frameCount) {
  (void)output;
  if (!input) return;

  auto* state = static_cast<RecorderState*>(device->pUserData);
  const auto* samples = static_cast<const int16_t*>(input);
  const size_t sampleCount = static_cast<size_t>(frameCount) * state->channels;

  double sumAbs = 0.0;
  for (size_t i = 0; i < sampleCount; ++i) {
    sumAbs += std::abs(static_cast<double>(samples[i]));
  }
  const double meanAbs = sampleCount > 0 ? sumAbs / sampleCount : 0.0;

  if (
      state->silenceDetectionEnabled.load() &&
      !state->silenceDetected.load()) {
    if (meanAbs >= kSilenceThreshold) {
      state->speechStarted.store(true);
      state->silentFrames.store(0);
    } else if (state->speechStarted.load()) {
      const uint64_t silentFrames =
          state->silentFrames.load() + frameCount;
      state->silentFrames.store(silentFrames);
      const uint64_t needed =
          static_cast<uint64_t>(state->sampleRate * kSilenceDurationSecs);
      if (silentFrames >= needed) {
        state->silenceDetected.store(true);
      }
    }
  }

  std::lock_guard<std::mutex> lock(state->mutex);
  state->level = meanAbs / 32768.0;
  const size_t remaining = state->pcmSize < kMaxPcmSamples
                               ? kMaxPcmSamples - state->pcmSize
                               : 0;
  const size_t toCopy = std::min(sampleCount, remaining);
  if (toCopy > 0) {
    std::copy(samples, samples + toCopy, state->pcm.begin() + state->pcmSize);
    state->pcmSize += toCopy;
  }
  if (toCopy < sampleCount) {
    state->silenceDetected.store(true);
  }
}

napi_value StartRecording(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (gRecorder.recording.load()) {
    Throw(env, "Native audio capture is already recording.");
    return nullptr;
  }

  uint32_t sampleRate = 16000;
  uint32_t channels = 1;
  bool silenceDetection = false;
  if (argc > 0) {
    napi_valuetype type;
    napi_typeof(env, args[0], &type);
    if (type == napi_object) {
      sampleRate = GetUint32Property(env, args[0], "sampleRate", sampleRate);
      channels = GetUint32Property(env, args[0], "channels", channels);
      silenceDetection =
          GetBoolProperty(env, args[0], "silenceDetection", silenceDetection);
    }
  }

  if (sampleRate == 0 || sampleRate > 192000 || channels == 0 ||
      channels > 2) {
    Throw(env, "Native audio capture requires 1 or 2 channels and a sample rate.");
    return nullptr;
  }

  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.format = ma_format_s16;
  config.capture.channels = channels;
  config.sampleRate = sampleRate;
  config.dataCallback = DataCallback;
  config.pUserData = &gRecorder;

  {
    std::lock_guard<std::mutex> lock(gRecorder.mutex);
    gRecorder.sampleRate = sampleRate;
    gRecorder.channels = channels;
    gRecorder.silenceDetectionEnabled.store(silenceDetection);
    gRecorder.speechStarted.store(false);
    gRecorder.silentFrames.store(0);
    gRecorder.level = 0.0;
    gRecorder.silenceDetected.store(false);
    if (gRecorder.pcm.size() < kMaxPcmSamples) {
      gRecorder.pcm.resize(kMaxPcmSamples);
    }
    gRecorder.pcmSize = 0;
  }

  ma_result result = ma_device_init(nullptr, &config, &gRecorder.device);
  if (result != MA_SUCCESS) {
    Throw(env, "Native audio capture failed to initialize the input device.");
    return nullptr;
  }
  gRecorder.deviceInitialized.store(true);

  result = ma_device_start(&gRecorder.device);
  if (result != MA_SUCCESS) {
    ma_device_uninit(&gRecorder.device);
    gRecorder.deviceInitialized.store(false);
    Throw(env, "Native audio capture failed to start the input device.");
    return nullptr;
  }

  gRecorder.recording.store(true);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value StopRecording(napi_env env, napi_callback_info info) {
  (void)info;
  if (!gRecorder.recording.load() || !gRecorder.deviceInitialized.load()) {
    Throw(env, "Native audio capture is not recording.");
    return nullptr;
  }

  StopRecorderDevice();

  std::vector<int16_t> pcm;
  uint32_t sampleRate = 16000;
  uint32_t channels = 1;
  {
    std::lock_guard<std::mutex> lock(gRecorder.mutex);
    pcm.assign(gRecorder.pcm.begin(), gRecorder.pcm.begin() + gRecorder.pcmSize);
    gRecorder.pcmSize = 0;
    sampleRate = gRecorder.sampleRate;
    channels = gRecorder.channels;
  }

  if (pcm.empty()) {
    Throw(env, "Native audio capture produced empty audio.");
    return nullptr;
  }

  std::vector<uint8_t> wav = ToWav(pcm, sampleRate, channels);
  napi_value buffer;
  napi_create_buffer_copy(env, wav.size(), wav.data(), nullptr, &buffer);
  return buffer;
}

napi_value IsRecording(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value value;
  napi_get_boolean(env, gRecorder.recording.load(), &value);
  return value;
}

napi_value SilenceDetected(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value value;
  napi_get_boolean(env, gRecorder.silenceDetected.load(), &value);
  return value;
}

// Return (and clear) PCM captured since the last call — for streaming uploads.
napi_value DrainAudio(napi_env env, napi_callback_info info) {
  (void)info;
  std::vector<int16_t> pcm;
  {
    std::lock_guard<std::mutex> lock(gRecorder.mutex);
    pcm.assign(gRecorder.pcm.begin(), gRecorder.pcm.begin() + gRecorder.pcmSize);
    gRecorder.pcmSize = 0;
  }
  napi_value buffer;
  const size_t bytes = pcm.size() * sizeof(int16_t);
  napi_create_buffer_copy(
      env,
      bytes,
      bytes == 0 ? nullptr : reinterpret_cast<const uint8_t*>(pcm.data()),
      nullptr,
      &buffer);
  return buffer;
}

// Recent input level (0..1) for the waveform display.
napi_value AudioLevel(napi_env env, napi_callback_info info) {
  (void)info;
  double level;
  {
    std::lock_guard<std::mutex> lock(gRecorder.mutex);
    level = gRecorder.level;
  }
  napi_value value;
  napi_create_double(env, level, &value);
  return value;
}

napi_value MicrophoneAuthorizationStatus(
    napi_env env,
    napi_callback_info info) {
  (void)info;
  const char* status = "unknown";
#if defined(__APPLE__)
  switch (qwen_mic_authorization_status()) {
    case 3:
      status = "granted";
      break;
    case 2:  // denied
    case 1:  // restricted (e.g. MDM) — unusable, treat as denied
      status = "denied";
      break;
    case 0:
      status = "prompt";  // not yet determined; capture will trigger the dialog
      break;
    default:
      status = "unknown";
      break;
  }
#endif
  napi_value value;
  napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value);
  return value;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, CleanupRecorder, nullptr);
  napi_property_descriptor descriptors[] = {
      {"startRecording", nullptr, StartRecording, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"stopRecording", nullptr, StopRecording, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"isRecording", nullptr, IsRecording, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"silenceDetected", nullptr, SilenceDetected, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"drainAudio", nullptr, DrainAudio, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"audioLevel", nullptr, AudioLevel, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"microphoneAuthorizationStatus", nullptr, MicrophoneAuthorizationStatus,
       nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(
      env,
      exports,
      sizeof(descriptors) / sizeof(descriptors[0]),
      descriptors);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
