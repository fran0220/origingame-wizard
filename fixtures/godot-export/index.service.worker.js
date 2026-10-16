// Test stand-in for Godot's PWA service worker (fixture only): it would inject COOP/COEP headers.
self.addEventListener('fetch', event => event.respondWith(fetch(event.request)))
