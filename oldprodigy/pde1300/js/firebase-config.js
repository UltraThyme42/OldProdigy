// Prodigy Rewritten — Firebase client config for the "classdigy" project.
// This is a client-side web config, NOT a secret: Firestore security rules are
// what restrict reads/writes to the owning user (players/{uid}, saves/{uid}).
// Multiplayer relay (new in this fork). Deployed on Render, see render.yaml
// in the repo root and server/README.md.
//   Primary: "https://classidigy.xdijd.fyi/"
//   Fallback: "https://old-prodigy-relay.onrender.com/"
//   Local dev (server/ running): "http://127.0.0.1:3100/"
// For local development, swap in the local URL instead.
// Smart relay resolution: try classidigy.xdijd.fyi first; if it's not working, fall back to the Render relay.
(function () {
	var primary = "https://classidigy.xdijd.fyi/";
	var fallback = "https://old-prodigy-relay.onrender.com/";
	var local = "http://127.0.0.1:3100/";

	if (window.location.search.indexOf("relay=") >= 0) {
		var match = window.location.search.match(/[?&]relay=([^&]+)/);
		if (match && (match[1] === "render" || match[1] === "prod")) {
			window.PRODIGY_RELAY_URL = fallback;
		} else if (match && (match[1] === "classidigy" || match[1] === "primary")) {
			window.PRODIGY_RELAY_URL = primary;
		} else if (match) {
			window.PRODIGY_RELAY_URL = decodeURIComponent(match[1]);
		} else {
			window.PRODIGY_RELAY_URL = local;
		}
	} else {
		// Production: use online relays, never the local relay.
		// Online: prefer classidigy.xdijd.fyi; if it's not working, fall back to the Render relay.
		var chosen = primary;
		try {
			var xhr = new XMLHttpRequest();
			xhr.open("GET", primary + "status", false);
			xhr.send();
			if (xhr.status < 200 || xhr.status >= 400) {
				chosen = fallback;
			}
		} catch (e) {
			chosen = fallback;
		}
		window.PRODIGY_RELAY_URL = chosen;
		window.PRODIGY_RELAY_FALLBACK_URL = fallback;
	}
})();

window.FIREBASE_CONFIG = {
	apiKey: "AIzaSyCA3M-GSB9nVajwQpoSOga_aQHclwk_Ng8",
	authDomain: "classdigy.firebaseapp.com",
	projectId: "classdigy",
	storageBucket: "classdigy.firebasestorage.app",
	messagingSenderId: "30943947736",
	appId: "1:30943947736:web:384f814f08d71830bee0ad"
};
