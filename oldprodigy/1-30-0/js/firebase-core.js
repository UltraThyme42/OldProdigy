// Prodigy Rewritten — Firebase core (classic script, loaded after game.min.js).
// Wires the game's Online view to Email/Password auth and Firestore, with the
// cloud save mirrored to docs/<uid> in products "saves" and "players".
// Also wires the multiplayer relay (see PRODIGY_RELAY_URL in firebase-config.js):
// credentials for the relay socket, world pick flow, public char data mirror,
// and offline mail delivery.
// Firestore layout:
//   saves/{uid}         — the same blob LocalSave buildSave() writes to localStorage
//   players/{uid}       — { isMember, username, usernameLower, updatedAt }
//   publicPlayers/{uid} — { appearance, equipment, data, house, isMember, level,
//     arenaScore, updatedAt } — the public mirror other players read
//   usernames/{lower-handle} — { uid, email, username, createdAt } (public read;
//     the sign-in lookup is the only way to know which email a handle maps to)
//   mail/{uid}/items/{id} — targeted messages for players who were offline when
//     they were sent (written by the relay, read/deleted by the owner)

var FirebaseCore = function () {};

FirebaseCore.game = null;
FirebaseCore.user = null;
FirebaseCore.initialized = !1;

FirebaseCore.init = function () {
	if (FirebaseCore.initialized) return !0;
	try {
		if (typeof firebase === "undefined") return console.log("Firebase SDK failed to load."), !1;
		if (!firebase.apps || 0 === firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
		FirebaseCore.initialized = !0;
		return !0
	} catch (e) {
		return console.log("Firebase init failed: " + e), !1
	}
};

FirebaseCore.getGame = function () {
	try {
		if (!FirebaseCore.game && typeof Phaser !== "undefined" && Phaser.GAMES && Phaser.GAMES.length) FirebaseCore.game = Phaser.GAMES[0];
		return FirebaseCore.game
	} catch (e) {
		return null
	}
};

// ---- Username support ----------------------------------------------------
// Usernames are public handles players can sign in with. The wizard name is
// the display name: renaming the wizard syncs auth displayName + players doc.
// The handle is chosen once at sign-up and never changes.
FirebaseCore.USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _'-]{1,18}[A-Za-z0-9])?$/;
FirebaseCore.RESERVED_USERNAMES = {
	admin: 1, administrator: 1, moderator: 1, mod: 1, staff: 1, prodigy: 1,
	"prodigy game": 1, classdigy: 1, support: 1, help: 1, official: 1, owner: 1,
	root: 1, system: 1, "game master": 1, gm: 1, teacher: 1, principal: 1,
	"old prodigy": 1, entrap: 1, "null": 1, undefined: 1
};

FirebaseCore.normalizeUsername = function (name) {
	return String(name || "").replace(/\s+/g, " ").trim();
};

FirebaseCore.isValidUsername = function (name) {
	var n = FirebaseCore.normalizeUsername(name);
	if (n.length < 3 || n.length > 20) return !1;
	if (!FirebaseCore.USERNAME_RE.test(n)) return !1;
	return !FirebaseCore.RESERVED_USERNAMES[n.toLowerCase()];
};

FirebaseCore.usernameLower = function (name) {
	return FirebaseCore.normalizeUsername(name).toLowerCase();
};

// Look up the email bound to a handle. Reads are public (see Firestore rules).
FirebaseCore.resolveUsername = function (name, done) {
	if (!FirebaseCore.init()) return done({ code: "offline" });
	var key = FirebaseCore.usernameLower(name);
	firebase.firestore().collection("usernames").doc(key).get().then(function (doc) {
		done(null, doc.exists ? doc.data().email : null);
	}, function (e) {
		console.log("Username lookup failed: " + e);
		done({ code: "auth/username-lookup-failed" });
	});
};

// Optimistic pre-check; the transaction in claimUsername is the real gate.
// done(null) means "unknown" (e.g. rules/network trouble) — proceed and let the
// transaction decide, instead of blocking sign up outright.
FirebaseCore.isUsernameAvailable = function (name, done) {
	if (!FirebaseCore.init()) return done(null);
	var key = FirebaseCore.usernameLower(name);
	firebase.firestore().collection("usernames").doc(key).get().then(function (doc) {
		done(!doc.exists);
	}, function () {
		done(null);
	});
};

// Atomically claim a handle. Sets players/{uid}.usernameLower so account
// deletion can remove the handle later without list permission.
FirebaseCore.claimUsername = function (user, username, done) {
	var key = FirebaseCore.usernameLower(username),
		ref = firebase.firestore().collection("usernames").doc(key),
		display = FirebaseCore.normalizeUsername(username);
	firebase.firestore().runTransaction(function (t) {
		return t.get(ref).then(function (doc) {
			if (doc.exists) throw { code: "auth/username-taken" };
			t.set(ref, {
				uid: user.uid,
				email: user.email,
				username: display,
				createdAt: Date.now()
			});
		});
	}).then(function () {
		firebase.firestore().collection("players").doc(user.uid).set({
			usernameLower: key,
			username: display
		}, { merge: !0 }).catch(function (e) {
			console.log("players username mirror failed: " + e);
		});
		done(null);
	}, function (err) {
		done(err && err.code ? err : { code: "auth/username-claim-failed" });
	});
};

// Wizard name is the source of truth: call this whenever it becomes known or changes.
FirebaseCore.syncDisplayName = function (name) {
	if (!FirebaseCore.user) return;
	var display = FirebaseCore.normalizeUsername(name);
	if (!display) return;
	var p = FirebaseCore.user.updateProfile({ displayName: display });
	if (p && p.catch) p.catch(function (e) {
		console.log("displayName update failed: " + e);
	});
	firebase.firestore().collection("players").doc(FirebaseCore.user.uid).set({
		username: display,
		updatedAt: Date.now()
	}, { merge: !0 }).catch(function (e) {
		console.log("players display-name sync failed: " + e);
	});
};

FirebaseCore.auth = function (isSignUp, emailOrUsername, password, rawUsername, done) {
	if (!FirebaseCore.init()) return done(new Error("offline"));
	var input = FirebaseCore.normalizeUsername(emailOrUsername);
	var finish = function (user) {
		FirebaseCore.user = user;
		// A different account may legitimately have a different save; never let
		// the previous account's write signatures suppress this one's first save.
		FirebaseCore.resetCloudDedupe();
		FirebaseCore.ensurePlayerDoc(user).then(function () {
			done(null)
		}, function () {
			done(null) // doc creation is best-effort; auth already succeeded
		})
	};
	var fail = function (err) {
		console.log("Firebase auth failed: " + (err && err.code));
		done(err || new Error("auth"))
	};
	if (isSignUp) {
		var uname = FirebaseCore.normalizeUsername(rawUsername);
		if (!FirebaseCore.isValidUsername(uname)) return done({ code: "auth/invalid-username" });
		firebase.auth().createUserWithEmailAndPassword(input, password).then(function (cred) {
			FirebaseCore.claimUsername(cred.user, uname, function (err) {
				if (err && "auth/username-taken" === err.code) {
					// The handle was claimed between our pre-check and now:
					// roll back the just-created account so it can't squat the email.
					var u = cred.user;
					FirebaseCore.user = null;
					u.delete().then(function () {
						done(err);
					}, function () {
						console.log("Auth-account rollback after username-taken failed");
						done(err);
					});
					return
				}
				if (err) console.log("Username claim failed: " + (err && err.code));
				finish(cred.user) // keep the account even if the claim failed; login by email still works
			});
		}, fail);
		return
	}
	// Login: accept an email, or a username (resolved to its email first).
	var signIn = function (email) {
		firebase.auth().signInWithEmailAndPassword(email, password).then(function (cred) {
			finish(cred.user)
		}, fail);
	};
	if (input.indexOf("@") >= 0) return signIn(input);
	FirebaseCore.resolveUsername(input, function (err, email) {
		if (err) return done(err);
		if (!email) return done({ code: "auth/username-not-found" });
		signIn(email);
	})
};

FirebaseCore.ensurePlayerDoc = function (user) {
	var ref = firebase.firestore().collection("players").doc(user.uid);
	return ref.get().then(function (doc) {
		if (doc.exists) return null;
		return ref.set({
			isMember: !1,
			createdAt: Date.now()
		})
	}, function (e) {
		console.log("players doc check failed: " + e)
	})
};

FirebaseCore.describeError = function (err) {
	var code = err && err.code || "";
	switch (code) {
		case "auth/invalid-email":
			return "That email address looks invalid.";
		case "auth/user-not-found":
		case "auth/wrong-password":
		case "auth/invalid-credential":
		case "auth/invalid-login-credentials":
			return "Wrong email or password.";
		case "auth/email-already-in-use":
			return "That email is already registered. Try logging in instead.";
		case "auth/invalid-username":
			return "That username isn't valid. Use 3-20 characters: letters, numbers, spaces, - _ ' and don't start or end with a space, dash, underscore or apostrophe.";
		case "auth/username-not-found":
			return "No account with that username. Check the spelling, or sign in with your email.";
		case "auth/username-taken":
			return "That username is already taken. Pick another one.";
		case "auth/username-lookup-failed":
			return "Could not look up that username. Check your connection.";
		case "auth/username-claim-failed":
			return "Could not reserve that username (service error). Your account was created — you can sign in with your email.";
		case "auth/weak-password":
			return "Password must be at least 6 characters long.";
		case "auth/too-many-requests":
			return "Too many attempts. Wait a bit and try again.";
		case "auth/network-request-failed":
			return "No connection to the online service. Check your internet.";
		default:
			return "Online service error (" + (code || "unknown") + "). See the browser console."
	}
};

FirebaseCore.readCloudSave = function () {
	return firebase.firestore().collection("saves").doc(FirebaseCore.user.uid).get().then(function (doc) {
		var d = doc.exists ? doc.data() : null;
		return d && d.appearancedata && d.data ? d : null
	})
};

FirebaseCore.applySaveSafely = function (state, save) {
	try {
		return LocalSave.applySave(save) !== !1
	} catch (e) {
		return console.log("Save apply threw: " + e), !1
	}
};

FirebaseCore.mostRecentLocalSave = function () {
	var saves = LocalSave.readSaves(),
		keys = Object.keys(saves);
	if (!keys.length) return null;
	keys.sort(function (a, b) {
		return (saves[b].savedAt || 0) - (saves[a].savedAt || 0)
	});
	return saves[keys[0]]
};

// Shown only on SIGN UP (not sign-in) when an offline/local save exists.
// OK = migrate the offline save into the account; Cancel = start a fresh character online.
FirebaseCore.confirmMigrate = function (local) {
	var name = local.appearancedata && local.appearancedata.name || "your offline wizard";
	return window.confirm("An offline save for \"" + name + "\" was found in this browser.\n\nMigrate it to your online account and play online with it?\n\nOK = migrate the save\nCancel = start a fresh character online (your offline save stays as-is).");
};

// Fresh online character for the account. Pushes the fresh save to the cloud
// unless skipPush is set (e.g. cloud read failed and we can't know its state).
FirebaseCore.startFresh = function (state, skipPush) {
	var P = state.game.prodigy;
	P.player.username = state.username;
	state.offlineModeLoad();
	if (state.signupUsername && P.player.appearance.data) {
		// On sign-up, the chosen username IS the fresh wizard's name.
		P.player.appearance.data.name = state.signupUsername;
		FirebaseCore.syncDisplayName(state.signupUsername);
	}
	if (!skipPush) FirebaseCore.pushSave()
	FirebaseCore.loadMail()
};

// Called by the Login state after a successful sign-in / sign-up.
// Picks the best available save, applies it, and arms the cloud sync.
// On sign-up with an existing offline save, asks before migrating.
FirebaseCore.handleAuth = function (state, isSignUp) {
	var game = state.game;
	state.error.setText("Loading your save..."), state.closeButton.visible = !1;
	FirebaseCore.getGame();
	FirebaseCore.readCloudSave().then(function (cloud) {
		if (cloud) {
			if (FirebaseCore.applySaveSafely(state, cloud)) {
				if (cloud.appearancedata && cloud.appearancedata.name) FirebaseCore.syncDisplayName(cloud.appearancedata.name);
				FirebaseCore.loadMail();
				return void FirebaseCore.pushSave();
			}
			return state.setView("progress"), state.error.setText("Could not load your cloud save. It may be from a different version."), void (state.closeButton.visible = !0)
		}
		var local = FirebaseCore.mostRecentLocalSave();
		if (local) {
			if (isSignUp && !FirebaseCore.confirmMigrate(local)) return void FirebaseCore.startFresh(state);
			if (FirebaseCore.applySaveSafely(state, local)) {
				if (local.appearancedata && local.appearancedata.name) FirebaseCore.syncDisplayName(local.appearancedata.name);
				FirebaseCore.loadMail();
				return void FirebaseCore.pushSave();
			}
			return state.setView("progress"), state.error.setText("Could not load your local save."), void (state.closeButton.visible = !0)
		}
		FirebaseCore.startFresh(state)
	}, function (e) {
		console.log("Cloud save read failed: " + e);
		var local = FirebaseCore.mostRecentLocalSave();
		if (local) {
			if (isSignUp && !FirebaseCore.confirmMigrate(local)) return void FirebaseCore.startFresh(state, !0);
			if (FirebaseCore.applySaveSafely(state, local)) { FirebaseCore.loadMail(); return }
		}
		FirebaseCore.startFresh(state, !0)
	})
};

// Permanently delete the signed-in account and its cloud data.
// Re-authenticates first (Firebase requires a recent login for user.delete()),
// then deletes both Firestore docs, then the auth user. If any step fails we
// stop and leave the account intact so the player can retry.
FirebaseCore.deleteAccount = function (password, done) {
	if (!FirebaseCore.user) return done({ code: "auth/not-signed-in" });
	var user = FirebaseCore.user,
		resolve = function () {
			var cred = firebase.auth.EmailAuthProvider.credential(user.email, password);
			return user.reauthenticateWithCredential(cred)
		};
	if (!FirebaseCore.init()) return done({ code: "offline" });
	var handle = null;
	resolve().then(function () {
		// Best-effort: remember the handle so we can release it after deletion.
		return firebase.firestore().collection("players").doc(user.uid).get().then(function (doc) {
			handle = doc.exists && doc.data().usernameLower || null;
		}, function () {});
	}).then(function () {
		return firebase.firestore().collection("saves").doc(user.uid).delete()
	}).then(function () {
		return firebase.firestore().collection("players").doc(user.uid).delete()
	}).then(function () {
		if (!handle) return null;
		// Release the handle too; a miss here must not block account deletion.
		return firebase.firestore().collection("usernames").doc(handle).delete().catch(function (e) {
			console.log("Username handle cleanup failed: " + (e && e.code));
		});
	}).then(function () {
		// Also wipe the public mirror and any undelivered mail.
		return firebase.firestore().collection("publicPlayers").doc(user.uid).delete().catch(function (e) {
			console.log("publicPlayers cleanup failed: " + (e && e.code));
		});
	}).then(function () {
		return firebase.firestore().collection("mail").doc(user.uid).collection("items").get().then(function (snap) {
			if (!snap || snap.empty) return null;
			var batch = firebase.firestore().batch();
			snap.forEach(function (item) { batch.delete(item.ref); });
			return batch.commit();
		}).catch(function (e) {
			console.log("mail cleanup failed: " + (e && e.code));
		});
	}).then(function () {
		return user.delete()
	}).then(function () {
		FirebaseCore.user = null;
		FirebaseCore.resetCloudDedupe();
		done(null)
	}, function (err) {
		console.log("Account deletion failed at some step: " + (err && err.code));
		done(err || { code: "unknown" })
	})
};

FirebaseCore.describeDeleteError = function (err) {
	var code = err && err.code || "";
	switch (code) {
		case "auth/not-signed-in":
			return "You are not signed in.";
		case "offline":
			return "The online service could not be reached. Try again when you are online.";
		case "auth/wrong-password":
		case "auth/invalid-credential":
		case "auth/invalid-login-credentials":
			return "Wrong password. Your account was not deleted.";
		case "auth/too-many-requests":
			return "Too many attempts. Wait a bit and try again.";
		case "auth/requires-recent-login":
			return "Please sign out, sign back in, and try deleting again.";
		case "auth/network-request-failed":
			return "No connection to the online service. Check your internet.";
		default:
			return "Could not delete your account (" + (code || "unknown") + "). Nothing was deleted — please try again."
	}
};

// Deep-copy arbitrary game data into a value Firestore accepts.
//
// Firestore rejects `undefined`. Sparse array holes are a trap: forEach() and
// Object.keys() skip them (so a scan can look clean), but Firestore sees them
// as undefined and throws inside set() — synchronously. Rebuild arrays index by
// index, mapping holes/undefined to null, and drop undefined object keys.
FirebaseCore.toFirestoreData = function (value, seen) {
	if (value === null) return null;
	var type = typeof value;
	if (type === "undefined" || type === "function" || type === "symbol") return undefined;
	if (type !== "object") return value;
	if (Object.prototype.toString.call(value) === "[object Date]") return value;
	seen = seen || [];
	for (var s = 0; s < seen.length; s++) if (seen[s] === value) return undefined;
	seen.push(value);
	var out, i, k, v;
	if (Array.isArray(value)) {
		out = new Array(value.length);
		for (i = 0; i < value.length; i++) {
			v = FirebaseCore.toFirestoreData(value[i], seen);
			out[i] = v === undefined ? null : v
		}
	} else {
		out = {};
		for (k in value) {
			if (!Object.prototype.hasOwnProperty.call(value, k) || k === "__proto__") continue;
			v = FirebaseCore.toFirestoreData(value[k], seen);
			if (v !== undefined) out[k] = v
		}
	}
	seen.pop();
	return out;
};

// Signature of the last successfully written document. The autosave hook runs
// every 60s, but the player's data rarely changes between runs; skipping
// identical writes keeps Firestore usage inside the free tier and avoids
// pointless writes mid-battle. Cleared on failure so the next run retries.
FirebaseCore._lastSaveSig = null;
FirebaseCore._lastPublicSig = null;
FirebaseCore._lastMember = null;

// Forget what we last wrote. Call on every user change (sign-in, sign-out,
// account deletion) so one account's cache can never suppress another's writes.
// Fix: arena matchmaking used playerA.id as the opponent id unconditionally, so
// the player who happened to be "playerA" fought themselves. Use the other
// player's id as the opponent.
(function () {
	if (typeof Prodigy === "undefined" || !Prodigy.Container || !Prodigy.Container.Arena) return;
	Prodigy.Container.Arena.prototype.messageRecieved = function (e) {
		console.log(e);
		if (Util.isDefined(this.timer)) window.clearInterval(this.timer);
		this.message.setText("Match found! Connecting now...");
		this.game.prodigy.network.sendAnalytics("PVP", "found-match", "Events");
		var t = function (g) { g.state.start("Arena"); };
		var i = new Player;
		var me = this.game.prodigy.player.userID;
		var opponentId;
		if (e.playerA.id !== me) { i.init(e.playerA.data); opponentId = e.playerA.id; }
		else { i.init(e.playerB.data); opponentId = e.playerB.id; }
		this.game.prodigy.pvp.start(opponentId, this.game.prodigy.player, i, t.bind(this, this.game), !0, "Arena");
	};
})();

FirebaseCore.resetCloudDedupe = function () {
	FirebaseCore._lastSaveSig = null;
	FirebaseCore._lastPublicSig = null;
	FirebaseCore._lastMember = null;
};

// Free-text chat: the retail client only knows how to render phrase IDs, so
// anything typed that isn't a known phrase is dropped. Make the phrase table
// echo arbitrary text back, and let Enter send the raw typed string as a
// chatID (the receiver's chatText then renders it verbatim).
(function () {
	if (typeof Prodigy === "undefined" || !Prodigy.ChatManager || !Prodigy.Menu || !Prodigy.Menu.Chat) return;
	var origGetPhrase = Prodigy.ChatManager.prototype.getPhrase;
	Prodigy.ChatManager.prototype.getPhrase = function (e) {
		if (typeof e === "string") return e;
		return origGetPhrase.call(this, e);
	};
	var origCreate = Prodigy.Menu.Chat.prototype.create;
	Prodigy.Menu.Chat.prototype.create = function () {
		origCreate.call(this);
		var self = this;
		var inputEl = this.input && this.input.input;
		if (!inputEl) return;
		var BLOCKED_CHAT_TERMS = ["nigger","nigga","n1gger","n1gga","chink","spic","kike","faggot","fag","tranny","retard","retarded","wetback","beaner","coon","gook","dyke","queer","homo","slut","whore"];
		// Also guard the receive side so blocked text never renders, even if sent.
		try {
			for (var _k in Prodigy) {
				var _o = Prodigy[_k];
				if (_o && _o.prototype && typeof _o.prototype.chatText === "function" && !_o.prototype.__chatTextPatched) {
					var _orig = _o.prototype.chatText;
					_o.prototype.chatText = function (e) {
						if (typeof e === "string") {
							var norm = e.toLowerCase().replace(/[^a-z0-9]/g, "");
							for (var i = 0; i < BLOCKED_CHAT_TERMS.length; i++) {
								var t = BLOCKED_CHAT_TERMS[i].replace(/[^a-z0-9]/g, "");
								if (t && norm.indexOf(t) !== -1) return;
							}
						}
						return _orig.call(this, e);
					};
					_o.prototype.__chatTextPatched = true;
				}
			}
		} catch (e) {}
		var isBlockedChat = function (text) {
			var norm = String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
			for (var i = 0; i < BLOCKED_CHAT_TERMS.length; i++) {
				var t = BLOCKED_CHAT_TERMS[i].replace(/[^a-z0-9]/g, "");
				if (t && norm.indexOf(t) !== -1) return true;
			}
			return false;
		};
		var sendRaw = function () {
			var text = (self.input.getValue() || "").trim();
			if (!text) return;
			if (isBlockedChat(text)) {
				try { self.input.setValue(""); } catch (e) {}
				try { self.game.prodigy.open.message("That message isn't allowed."); } catch (e) {}
				return;
			}
			self.clearSearch();
			try { self.input.setFocus(null); } catch (e) {}
			self.game.prodigy.player.chatID = text;
			self.game.prodigy.network.emitMessage({
				action: "chat",
				data: { userID: self.game.prodigy.player.userID, chatID: text }
			});
		};
		var handler = function (ev) {
			var code = ev && (ev.keyCode || ev.which);
			if (code === 13 || code === 10) {
				sendRaw();
				if (ev.preventDefault) ev.preventDefault();
				if (ev.stopPropagation) ev.stopPropagation();
				return false;
			}
		};
		inputEl.onkeydown = handler;
		if (inputEl.addEventListener) inputEl.addEventListener("keydown", handler, true);
	};
})();

FirebaseCore._sigOf = function (obj, ignore) {
	var sig = {};
	for (var k in obj) {
		if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
		if (ignore && ignore.indexOf(k) !== -1) continue;
		sig[k] = obj[k];
	}
	try {
		return JSON.stringify(sig);
	} catch (e) {
		return null;
	}
};

FirebaseCore.pushSave = function (done) {
	done = typeof done === "function" ? done : function () {};
	if (!FirebaseCore.user || !FirebaseCore.init()) { done(new Error("not-signed-in")); return; }
	var game = FirebaseCore.getGame();
	if (!game || !game.prodigy) return;
	// Every branch below is isolated: a failed cloud write must never interrupt
	// gameplay (this runs from the save hook, sometimes mid-battle).
	try {
		var save = LocalSave.buildSave();
		save.updatedAt = Date.now();
		var cleanSave = FirebaseCore.toFirestoreData(save);
		var saveSig = FirebaseCore._sigOf(cleanSave, ["savedAt", "updatedAt"]);
		if (saveSig !== FirebaseCore._lastSaveSig) {
			firebase.firestore().collection("saves").doc(FirebaseCore.user.uid).set(cleanSave).then(function () {
				FirebaseCore._lastSaveSig = saveSig;
				console.log("Cloud save pushed: " + (save.appearancedata && save.appearancedata.name));
				done(null);
			}, function (e) {
				FirebaseCore._lastSaveSig = null;
				console.log("Cloud save push failed: " + e);
				done(e);
			});
		} else {
			done(null);
		}
	} catch (e) {
		console.log("Cloud save build/push failed: " + e);
		done(e);
		return;
	}
	try {
		var isMember = !!game.prodigy.player.isMember;
		if (isMember !== FirebaseCore._lastMember) {
			firebase.firestore().collection("players").doc(FirebaseCore.user.uid).set({
				isMember: isMember,
				updatedAt: Date.now()
			}, {
				merge: !0
			}).then(function () {
				FirebaseCore._lastMember = isMember;
			}, function (e) {
				FirebaseCore._lastMember = null;
				console.log("membership mirror failed: " + e)
			});
		}
	} catch (e) {
		console.log("membership mirror failed: " + e)
	}
	// Public mirror: other players (and the relay's leaderboard) read this.
	// Contains nothing secret — it's the same data the game sends to battle peers.
	try {
		var player = game.prodigy.player;
		if (player && player.getLevel) {
			var pub = FirebaseCore.toFirestoreData({
				appearance: player.appearance && player.appearance.data ? player.appearance.data : {},
				equipment: player.equipment && player.equipment.data ? player.equipment.data : {},
				data: player.data ? player.data : {},
				pets: (player.kennel && player.kennel.data) ? player.kennel.data : [],
				house: player.house && player.house.data ? player.house.data : {},
				isMember: !!player.isMember,
				level: player.getLevel(),
				arenaScore: player.getArenaScore ? player.getArenaScore() : 0,
				updatedAt: Date.now()
			});
			var pubSig = FirebaseCore._sigOf(pub, ["updatedAt"]);
			if (pubSig !== FirebaseCore._lastPublicSig) {
				firebase.firestore().collection("publicPlayers").doc(FirebaseCore.user.uid).set(pub, {
					merge: !0
				}).then(function () {
					FirebaseCore._lastPublicSig = pubSig;
				}, function (e) {
					FirebaseCore._lastPublicSig = null;
					console.log("publicPlayers mirror failed: " + (e && e.code))
				});
			}
		}
	} catch (e) {
		console.log("publicPlayers mirror failed: " + e)
	}
};

FirebaseCore.installSaveHook = function () {
	if (typeof LocalSave === "undefined" || LocalSave.__firebaseWrapped) return !0;
	var original = LocalSave.saveToBrowser;
	LocalSave.saveToBrowser = function () {
		var ok = original.apply(this, arguments);
		if (ok) {
			try {
				FirebaseCore.pushSave();
			} catch (e) {
				console.log("Cloud save hook failed: " + e);
			}
		}
		return ok
	};
	LocalSave.__firebaseWrapped = !0;
	return !0
};

// ---- Multiplayer relay ------------------------------------------------------
// Offline-targeted player messages are persisted by the relay to
// mail/{uid}/items and surfaced here as in-game mail on the next login.
FirebaseCore._classesPatched = !1;
FirebaseCore._tokenTimer = null;

// Fresh ID token for the relay handshake/REST calls. Falls back to the
// cached token if a refresh fails, so credentials never go stale-empty.
FirebaseCore.getFreshToken = function (cb) {
	if (!FirebaseCore.user) return cb(null, null);
	FirebaseCore.user.getIdToken(!0).then(function (token) {
		cb(null, token);
	}, function () {
		FirebaseCore.user.getIdToken().then(function (token) {
			cb(null, token);
		}, function (e) {
			cb(e);
		});
	});
};

// Point the game's ApiClient credentials at the relay and keep them fresh.
FirebaseCore.refreshNetworkCredentials = function (game) {
	var net = game && game.prodigy && game.prodigy.network;
	if (!net || !net.api || !FirebaseCore.user) return;
	net.api.userID = FirebaseCore.user.uid;
	if (game && game.prodigy && game.prodigy.player) game.prodigy.player.userID = FirebaseCore.user.uid;
	var apply = function (n) {
		FirebaseCore.getFreshToken(function (err, token) {
			if (token) n.api.uniqueKey = token;
		});
	};
	apply(net);
	if (!FirebaseCore._tokenTimer) {
		FirebaseCore._tokenTimer = setInterval(function () {
			var g = FirebaseCore.getGame();
			var n = g && g.prodigy && g.prodigy.network;
			if (n && n.api && FirebaseCore.user) apply(n);
		}, 15 * 60 * 1000);
	}
};

// Read another player's public mirror (implements getCharData).
FirebaseCore.getPublicPlayer = function (uid, fields, cb) {
	cb = typeof cb === "function" ? cb : function () {};
	var done = function (entry) {
		var out = {};
		if (entry) out[uid] = entry;
		cb(out);
	};
	if (!FirebaseCore.init() || !uid) return done(null);
	firebase.firestore().collection("publicPlayers").doc(String(uid)).get().then(function (doc) {
		var d = doc.exists && doc.data() ? doc.data() : null;
		if (d && fields && fields.length) {
			var picked = {};
			for (var i = 0; i < fields.length; i++) {
				var f = fields[i];
				if (Object.prototype.hasOwnProperty.call(d, f)) picked[f] = d[f];
			}
			done(picked);
		} else {
			done(d);
		}
	}, function (e) {
		console.log("publicPlayers read failed: " + (e && e.code));
		done(null);
	});
};

// Turn on the retail multiplayer code paths for a signed-in player.
//
// The revival logs in through Firebase and joins a world through the relay, so
// the legacy `network.login()` never runs — and that call is the only place
// that ever sets `network.loggedIn`. The retail client gates everything
// multiplayer on it: zone switching (which drives presence), chat, player
// movement updates and the PVP handshake all check canUseMP(), which requires
// loggedIn. Without it the world is single-player even though the socket is
// connected.
//
// The legacy progress endpoints behind network.updateCharacter() don't exist
// on the relay (Firestore owns the save), so they are answered locally. That
// keeps the 1s check-in loop quiet and prevents its "update failed → log the
// player off" countdown from firing mid-game.
FirebaseCore.enableOnlineMultiplayer = function (game) {
	try {
		var net = game && game.prodigy && game.prodigy.network;
		if (!net || !net.api) return;
		var api = net.api;
		if (!api.__relayStubbed) {
			var ok = function (callbacks) {
				if (callbacks && typeof callbacks["200"] === "function") callbacks["200"]();
				return !0
			};
			api.updateCharacter = ok;
			api.updateUser = ok;
			api.saveAnswer = ok;
			api.updateUserAbility = ok;
			api.__relayStubbed = !0;
		}
		net.loggedIn = !0;
	} catch (e) {
		console.log("enableOnlineMultiplayer failed: " + e);
	}
};

// Replace the game's getCharData with the public-mirror read.
FirebaseCore.patchCharData = function (game) {
	var net = game && game.prodigy && game.prodigy.network;
	if (!net || net.__charDataPatched) return;
	net.getCharData = function (uid, fields, cb) {
		FirebaseCore.getPublicPlayer(uid, fields, cb);
	};
	net.__charDataPatched = !0;
};

// Rewire the character screen's "next" button and the world picker so that
// signed-in players go through the world-selection flow, and picking a world
// doesn't disconnect the multiplayer socket (the 1.30.0 code path logged the
// user out before the world ever loaded).
FirebaseCore.patchGameClasses = function () {
	try {
		if (FirebaseCore._classesPatched) return !0;
		if (typeof Prodigy === "undefined" || !Prodigy.Menu) return !1;
		var cs = Prodigy.Menu.CharSelect && Prodigy.Menu.CharSelect.prototype;
		if (cs && !cs.__prodigyOnlinePatched) {
			var origOffline = cs.offlineMode;
			cs.offlineMode = function () {
				if (window.FirebaseCore && FirebaseCore.user && FirebaseCore.afterOnlineLogin) {
					try { this.close(); } catch (e) { console.log("charSelect close failed: " + e); }
					FirebaseCore.afterOnlineLogin(this.game);
					return;
				}
				if (origOffline) return origOffline.apply(this, arguments);
			};
			cs.offlineMode.__prodigyOnlinePatched = !0;
		}
		var sv = Prodigy.Menu.Server && Prodigy.Menu.Server.prototype;
		if (sv && !sv.__prodigyClosePatched) {
			sv.close = function (e, t, i) {
				try {
					if (this.callback) this.callback(e, t, i);
				} catch (err) {
					console.log("world chosen callback failed: " + err);
				}
				return Prodigy.Control.Menu.prototype.close.call(this);
			};
			sv.__prodigyClosePatched = !0;
		}
		if (cs && sv) FirebaseCore._classesPatched = !0;
		return !0;
	} catch (e) {
		console.log("patchGameClasses failed: " + e);
		return !1;
	}
};

// Signed-in "next": fetch the world list from the relay and open the picker.
FirebaseCore.afterOnlineLogin = function (game) {
	try {
		if (!FirebaseCore.user) return;
		game = game || FirebaseCore.getGame();
		if (!game || !game.prodigy) return;
		FirebaseCore.refreshNetworkCredentials(game);
		FirebaseCore.enableOnlineMultiplayer(game);
		FirebaseCore.patchCharData(game);
		FirebaseCore.patchGameClasses();
		var net = game.prodigy.network;
		net.getWorldList(function (list) {
			if (list && list.length) {
				game.prodigy.open.server(list, function (e, t, i) {
					FirebaseCore.worldChosen(game, e, t, i);
				});
			} else {
				FirebaseCore.relayDownFallback(game);
			}
		}, function () {
			FirebaseCore.relayDownFallback(game);
		});
	} catch (e) {
		console.log("afterOnlineLogin failed: " + e);
		try { FirebaseCore.relayDownFallback(game); } catch (e2) { console.log("relay fallback failed: " + e2); }
	}
};

// e = truthy for "play offline"; i = truthy when the picker's back button
// was used; everything else means a world was (or wasn't) joined and the
// game should simply start.
FirebaseCore.worldChosen = function (game, e, t, i) {
	try {
		if (i || (t && !e)) {
			game.prodigy.open.charSelect();
			return;
		}
		FirebaseCore.enableOnlineMultiplayer(game);
		var zone = game.prodigy.player && game.prodigy.player.data && game.prodigy.player.data.zone;
		if (zone && String(zone).indexOf("-") > 0) {
			try {
				game.prodigy.world.teleport(zone);
				return;
			} catch (e2) {
				console.log("world teleport failed: " + e2);
			}
		}
		game.state.start("Intro");
	} catch (e) {
		console.log("worldChosen failed: " + e);
		try { game.state.start("Intro"); } catch (e2) { console.log("intro start failed: " + e2); }
	}
};

// The relay is unreachable (or waking): warn the player and fall back to
// offline play so they are never stuck on a login screen.
FirebaseCore.relayDownFallback = function (game) {
	try {
		var openOffline = function () {
			FirebaseCore.worldChosen(game, null, !0, !1);
		};
		game.prodigy.open.message(
			"The multiplayer worlds can't be reached right now. The free server may be waking up — try again in a minute.\n\nYou can keep playing offline; your progress syncs next time you sign in.",
			openOffline, "star", "multiplayer unavailable");
	} catch (e) {
		console.log("relay fallback message failed: " + e);
		try { game.state.start("Intro"); } catch (e2) { console.log("intro start failed: " + e2); }
	}
};

// Move the relay's persisted mail into the local mailbox on login.
FirebaseCore.loadMail = function () {
	if (!FirebaseCore.user || !FirebaseCore.init()) return;
	var game = FirebaseCore.getGame();
	if (!game || !game.prodigy || !game.prodigy.mail) return;
	firebase.firestore().collection("mail").doc(FirebaseCore.user.uid).collection("items").get().then(function (snap) {
		if (!snap || snap.empty) return null;
		var batch = firebase.firestore().batch();
		snap.forEach(function (doc) {
			var d = doc.data();
			var msg = d && d.payload;
			if (!msg) {
				batch.delete(doc.ref);
				return;
			}
			msg.time = 7 * 24 * 3600 * 1000; // challenges stay valid for a week
			try {
				game.prodigy.mail.add(msg);
			} catch (e) {
				console.log("mail add failed: " + e);
			}
			batch.delete(doc.ref);
		});
		return batch.commit();
	}).catch(function (e) {
		console.log("mail load failed: " + (e && e.code));
	});
};

// local save is defined by game.min.js, which loads before this file
FirebaseCore.patchGameClasses();
FirebaseCore.installSaveHook();
