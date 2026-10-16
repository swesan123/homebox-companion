/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Versioned cache: `version` changes on every build, so each deploy gets a fresh cache.
const CACHE_PREFIX = 'homebox-companion-shell-';
const CACHE = `${CACHE_PREFIX}${version}`;

// App shell used as the offline fallback for navigations (SPA fallback page).
const SHELL_URL = '/index.html';

// Hashed build output plus everything in static/. These are only served from cache
// when the exact URL was precached.
const PRECACHE_URLS = [...build, ...files];
const PRECACHED = new Set(PRECACHE_URLS);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE_URLS);
			try {
				// Best-effort: bypass the HTTP cache so the shell matches this build.
				await cache.add(new Request(SHELL_URL, { cache: 'reload' }));
			} catch {
				// Offline navigation fallback is optional; do not fail the install.
			}
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith(CACHE_PREFIX) && key !== CACHE) {
					await caches.delete(key);
				}
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;

	// Never touch non-GET requests; let the browser handle them directly.
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Same-origin only, and never the API (auth, uploads, SSE streams, etc.).
	if (url.origin !== sw.location.origin) return;
	if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

	// Navigations: network-first so a deploy is never masked by a stale index.html.
	// Fall back to the cached shell only when the network is unavailable.
	if (request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					return await fetch(request);
				} catch (err) {
					const cached = await (await caches.open(CACHE)).match(SHELL_URL);
					if (cached) return cached;
					throw err;
				}
			})()
		);
		return;
	}

	// Precached assets only: cache-first. Everything else goes straight to the network.
	if (PRECACHED.has(url.pathname)) {
		event.respondWith(
			(async () => {
				const cache = await caches.open(CACHE);
				const cached = await cache.match(url.pathname);
				return cached ?? fetch(request);
			})()
		);
	}
});
