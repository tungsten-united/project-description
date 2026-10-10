/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** "true" shows the debug cog: camera feed, logs, motion and payload inspection. */
  readonly VITE_DEBUG_MODE?: string;
}
