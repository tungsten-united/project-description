// Deliberately minimal service worker. It caches nothing and intercepts no requests: every
// fetch goes straight to the network, so a deploy is visible on the next load and every
// feature still talks to the live orchestrator. It exists only so browsers that want a
// registered worker for installability are satisfied. Do not add a fetch handler or a
// cache here without deciding how stale builds are invalidated.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
