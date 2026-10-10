/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** "true" shows the debug cog: camera feed, logs, motion and payload inspection. */
  readonly VITE_DEBUG_MODE?: string;
  /** "true" turns microphone voice isolation on by default. The debug panel can override it per device. */
  readonly VITE_VOICE_ISOLATION?: string;
  /** nav-engine map-api, where /map uploads mapping walks. Defaults to the team's Cloud Run service. */
  readonly VITE_MAP_API_URL?: string;
}
