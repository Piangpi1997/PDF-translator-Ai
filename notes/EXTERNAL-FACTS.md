# External technical references

## Kimi API

- [Official Kimi model list](https://platform.kimi.ai/docs/models), checked 2026-10-02: model identifier `kimi-k3`; the prior `kimi-k2.5` model is marked discontinued.
- [Official API overview](https://platform.kimi.ai/docs/api/overview), checked 2026-10-02: OpenAI Chat Completions-compatible base URL `https://api.moonshot.ai/v1`, endpoint `/chat/completions`, and Bearer authentication. The documentation warns against exposing API keys in client code, public repositories, or logs.
- The project adapter uses those values by default and reads `KIMI_API_KEY` only on the server. No live Kimi API call was performed because no key was configured in this environment.

## Android build toolchain

- [Android developer tools](https://developer.android.com/tools) and [SDK manager guide](https://developer.android.com/studio/command-line/sdkmanager): SDK build tools and platform tools are installed under the Android SDK root; the current CLI recommends `android sdk` over the deprecated `sdkmanager` binary.
- [Capacitor 7 Android documentation](https://capacitorjs.com/docs/v7/android): the project uses Capacitor 7 and API 35; a device or emulator is required for runtime execution.
- [Android JDK guidance](https://developer.android.com/build/jdks): Android Gradle Plugin 8.x requires JDK 17 or newer. The APK build uses OpenJDK 21.
