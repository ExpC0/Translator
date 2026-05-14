#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <bcrypt.h>
#include <initguid.h>
#include <ksmedia.h>

#include <atomic>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr int kPort = 52341;
constexpr int kOutputRate = 16000;
constexpr int kMaxFrameSamples = 1600;
constexpr GUID kAudioSubtypeIeeeFloat =
    {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

struct SocketGuard {
  SOCKET s = INVALID_SOCKET;
  ~SocketGuard() { if (s != INVALID_SOCKET) closesocket(s); }
};

struct CoTaskMemDeleter {
  void operator()(void* p) const { CoTaskMemFree(p); }
};

template <typename T>
using CoTaskPtr = std::unique_ptr<T, CoTaskMemDeleter>;

std::string getenv_string(const char* name) {
  const char* value = std::getenv(name);
  return value ? std::string(value) : std::string();
}

bool starts_with(const std::string& s, const char* prefix) {
  return s.rfind(prefix, 0) == 0;
}

bool is_origin_allowed(const std::string& origin) {
  const std::string configured = getenv_string("LIVE_TRANSLATOR_ALLOWED_ORIGINS");
  if (!configured.empty()) {
    std::stringstream ss(configured);
    std::string item;
    while (std::getline(ss, item, ',')) {
      while (!item.empty() && item.front() == ' ') item.erase(item.begin());
      while (!item.empty() && item.back() == ' ') item.pop_back();
      if (origin == item) return true;
    }
    return false;
  }

  return origin.empty() ||
         origin == "null" ||
         starts_with(origin, "http://localhost") ||
         starts_with(origin, "https://localhost") ||
         starts_with(origin, "http://127.0.0.1") ||
         starts_with(origin, "https://127.0.0.1");
}

std::string header_value(const std::string& req, const std::string& name) {
  const std::string needle = "\r\n" + name + ":";
  size_t pos = req.find(needle);
  if (pos == std::string::npos) return {};
  pos += needle.size();
  while (pos < req.size() && req[pos] == ' ') ++pos;
  size_t end = req.find("\r\n", pos);
  if (end == std::string::npos) return {};
  return req.substr(pos, end - pos);
}

std::string request_path(const std::string& req) {
  size_t first = req.find(' ');
  if (first == std::string::npos) return "/";
  size_t second = req.find(' ', first + 1);
  if (second == std::string::npos) return "/";
  return req.substr(first + 1, second - first - 1);
}

std::string base64(const uint8_t* data, size_t len) {
  static constexpr char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = data[i] << 16;
    if (i + 1 < len) v |= data[i + 1] << 8;
    if (i + 2 < len) v |= data[i + 2];
    out.push_back(kTable[(v >> 18) & 63]);
    out.push_back(kTable[(v >> 12) & 63]);
    out.push_back(i + 1 < len ? kTable[(v >> 6) & 63] : '=');
    out.push_back(i + 2 < len ? kTable[v & 63] : '=');
  }
  return out;
}

std::string websocket_accept(const std::string& key) {
  const std::string magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  uint8_t hash[20] = {};
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE h = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA1_ALGORITHM, nullptr, 0) != 0) return {};
  if (BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return {};
  }
  NTSTATUS st = BCryptHashData(h,
      reinterpret_cast<PUCHAR>(const_cast<char*>(magic.data())),
      static_cast<ULONG>(magic.size()), 0);
  if (st == 0) st = BCryptFinishHash(h, hash, sizeof(hash), 0);
  BCryptDestroyHash(h);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (st != 0) return {};
  return base64(hash, sizeof(hash));
}

bool send_all(SOCKET s, const uint8_t* data, size_t len) {
  while (len > 0) {
    int n = send(s, reinterpret_cast<const char*>(data),
                 static_cast<int>(std::min<size_t>(len, 16384)), 0);
    if (n <= 0) return false;
    data += n;
    len -= n;
  }
  return true;
}

bool send_text(SOCKET s, const std::string& text) {
  return send_all(s, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}

bool send_ws_binary(SOCKET s, const uint8_t* data, size_t len) {
  uint8_t hdr[10] = {};
  size_t hdr_len = 0;
  hdr[0] = 0x82;
  if (len < 126) {
    hdr[1] = static_cast<uint8_t>(len);
    hdr_len = 2;
  } else if (len <= 0xffff) {
    hdr[1] = 126;
    hdr[2] = static_cast<uint8_t>((len >> 8) & 0xff);
    hdr[3] = static_cast<uint8_t>(len & 0xff);
    hdr_len = 4;
  } else {
    return false;
  }
  return send_all(s, hdr, hdr_len) && send_all(s, data, len);
}

struct Resampler {
  double pos = 0.0;
  float prev = 0.0f;
  bool has_prev = false;

  std::vector<int16_t> process(const std::vector<float>& mono, int in_rate) {
    std::vector<float> input;
    input.reserve(mono.size() + 1);
    if (has_prev) input.push_back(prev);
    input.insert(input.end(), mono.begin(), mono.end());
    if (input.empty()) return {};

    const double ratio = static_cast<double>(in_rate) / kOutputRate;
    std::vector<int16_t> out;
    while (pos + 1.0 < input.size()) {
      const size_t i = static_cast<size_t>(pos);
      const double frac = pos - i;
      float v = input[i] + static_cast<float>((input[i + 1] - input[i]) * frac);
      if (v > 1.0f) v = 1.0f;
      if (v < -1.0f) v = -1.0f;
      out.push_back(v < 0 ? static_cast<int16_t>(v * 32768.0f)
                          : static_cast<int16_t>(v * 32767.0f));
      pos += ratio;
    }
    pos -= static_cast<double>(mono.size());
    prev = input.back();
    has_prev = true;
    return out;
  }
};

float sample_to_float(const BYTE* p, WORD bits, bool is_float) {
  if (is_float && bits == 32) return *reinterpret_cast<const float*>(p);
  if (bits == 16) return *reinterpret_cast<const int16_t*>(p) / 32768.0f;
  if (bits == 24) {
    int32_t v = (p[0] | (p[1] << 8) | (p[2] << 16));
    if (v & 0x800000) v |= 0xff000000;
    return v / 8388608.0f;
  }
  if (bits == 32) return *reinterpret_cast<const int32_t*>(p) / 2147483648.0f;
  return 0.0f;
}

bool is_float_format(const WAVEFORMATEX* fmt) {
  if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    auto ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
    return IsEqualGUID(ext->SubFormat, kAudioSubtypeIeeeFloat);
  }
  return false;
}

void capture_loopback_to_websocket(SOCKET s, std::atomic<bool>& alive) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  IMMDeviceEnumerator* enumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  WAVEFORMATEX* raw_format = nullptr;
  HANDLE task = nullptr;
  DWORD task_index = 0;

  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (SUCCEEDED(hr)) hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (SUCCEEDED(hr)) hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
  if (SUCCEEDED(hr)) hr = client->GetMixFormat(&raw_format);
  CoTaskPtr<WAVEFORMATEX> format(raw_format);

  REFERENCE_TIME buffer_duration = 10000000;
  if (SUCCEEDED(hr)) {
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK,
                            buffer_duration, 0, format.get(), nullptr);
  }
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (SUCCEEDED(hr)) task = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);
  if (SUCCEEDED(hr)) hr = client->Start();

  const WORD channels = format ? format->nChannels : 2;
  const WORD bits = format ? format->wBitsPerSample : 32;
  const WORD block_align = format ? format->nBlockAlign : 8;
  const int in_rate = format ? static_cast<int>(format->nSamplesPerSec) : 48000;
  const bool float_fmt = format ? is_float_format(format.get()) : true;
  Resampler resampler;
  std::vector<int16_t> pending;

  while (alive && SUCCEEDED(hr)) {
    UINT32 packet = 0;
    hr = capture->GetNextPacketSize(&packet);
    if (FAILED(hr)) break;
    if (packet == 0) {
      Sleep(5);
      continue;
    }

    BYTE* data = nullptr;
    UINT32 frames = 0;
    DWORD flags = 0;
    hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
    if (FAILED(hr)) break;

    std::vector<float> mono(frames);
    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
      std::fill(mono.begin(), mono.end(), 0.0f);
    } else {
      for (UINT32 i = 0; i < frames; ++i) {
        float sum = 0.0f;
        const BYTE* frame = data + i * block_align;
        for (WORD ch = 0; ch < channels; ++ch) {
          sum += sample_to_float(frame + ch * (bits / 8), bits, float_fmt);
        }
        mono[i] = sum / std::max<WORD>(channels, 1);
      }
    }

    std::vector<int16_t> out = resampler.process(mono, in_rate);
    pending.insert(pending.end(), out.begin(), out.end());
    while (pending.size() >= kMaxFrameSamples) {
      const size_t bytes = kMaxFrameSamples * sizeof(int16_t);
      if (!send_ws_binary(s, reinterpret_cast<const uint8_t*>(pending.data()), bytes)) {
        alive = false;
        break;
      }
      pending.erase(pending.begin(), pending.begin() + kMaxFrameSamples);
    }
    capture->ReleaseBuffer(frames);
  }

  if (client) client->Stop();
  if (task) AvRevertMmThreadCharacteristics(task);
  if (capture) capture->Release();
  if (client) client->Release();
  if (device) device->Release();
  if (enumerator) enumerator->Release();
  CoUninitialize();
}

void handle_client(SOCKET accepted) {
  SocketGuard client{accepted};
  char buf[8192] = {};
  int n = recv(client.s, buf, sizeof(buf) - 1, 0);
  if (n <= 0) return;
  std::string req(buf, n);
  const std::string path = request_path(req);
  const std::string origin = header_value(req, "Origin");

  const std::string cors =
      "Access-Control-Allow-Origin: " + (origin.empty() ? std::string("null") : origin) + "\r\n"
      "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
      "Access-Control-Allow-Headers: Content-Type, X-Live-Translator\r\n"
      "Access-Control-Allow-Private-Network: true\r\n";

  if (!is_origin_allowed(origin)) {
    send_text(client.s, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  if (starts_with(req, "OPTIONS ")) {
    send_text(client.s, "HTTP/1.1 204 No Content\r\n" + cors + "Content-Length: 0\r\n\r\n");
    return;
  }

  if (path == "/status") {
    const std::string body = "{\"status\":\"ok\",\"version\":\"0.1.0\",\"audio\":\"pcm16-16000-mono\"}";
    send_text(client.s, "HTTP/1.1 200 OK\r\n" + cors +
                        "Content-Type: application/json\r\n"
                        "Cache-Control: no-store\r\n"
                        "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    return;
  }

  if (path == "/audio") {
    const std::string key = header_value(req, "Sec-WebSocket-Key");
    const std::string accept = websocket_accept(key);
    if (key.empty() || accept.empty()) {
      send_text(client.s, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    send_text(client.s,
              "HTTP/1.1 101 Switching Protocols\r\n"
              "Upgrade: websocket\r\n"
              "Connection: Upgrade\r\n"
              "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");

    std::atomic<bool> alive{true};
    std::thread capture([&] { capture_loopback_to_websocket(client.s, alive); });
    while (alive) {
      char tmp[2] = {};
      int r = recv(client.s, tmp, sizeof(tmp), 0);
      if (r <= 0) alive = false;
    }
    if (capture.joinable()) capture.join();
    return;
  }

  send_text(client.s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
}

}  // namespace

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  FreeConsole();
  WSADATA wsa = {};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

  SocketGuard server{socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)};
  if (server.s == INVALID_SOCKET) return 1;

  BOOL reuse = TRUE;
  setsockopt(server.s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));

  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(kPort);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

  if (bind(server.s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) return 1;
  if (listen(server.s, SOMAXCONN) != 0) return 1;

  while (true) {
    SOCKET client = accept(server.s, nullptr, nullptr);
    if (client == INVALID_SOCKET) continue;
    std::thread(handle_client, client).detach();
  }

  WSACleanup();
  return 0;
}
