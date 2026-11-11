/**
 * Prodigy Client Game Patches (v1.50.0 Compatibility Fixes)
 * Encapsulated inside a modular GamePatch class structure.
 */

class GamePatch {
  constructor() {
    if (window.ProdigyGamePatchInstance) {
      console.warn("[GamePatch] Instance already exists. Returning singleton.");
      return window.ProdigyGamePatchInstance;
    }

    this.installed = false;
    this.utilPatched = false;
    this.playerPatched = false;
    this.phaserCachePatched = false;

    console.log("[GamePatch] Initializing GamePatch Class...");
    window.ProdigyGamePatchInstance = this;
  }

  /**
   * Installs immediate prototype & utility patches before Phaser preloads assets.
   */
  installImmediatePatches() {
    this.patchUtil();
    this.patchPlayer();
    this.patchPhaserCache();
  }

  /**
   * Patches Util.trimText to gracefully handle undefined/null strings.
   */
  patchUtil() {
    if (this.utilPatched) return;
    if (window.Util && typeof window.Util.trimText === "function") {
      const originalTrimText = window.Util.trimText;
      window.Util.trimText = function (e, t, i) {
        if (e === undefined || e === null) {
          e = "Wizard";
        } else if (typeof e !== "string") {
          e = String(e);
        }
        return originalTrimText.call(this, e, t, i);
      };
      window.Util.trimText.__patched = true;
      this.utilPatched = true;
      console.log("[GamePatch] Util.trimText patch installed.");
    }
  }

  /**
   * Patches Player.prototype.getName to ensure it always returns a string.
   */
  patchPlayer() {
    if (this.playerPatched) return;
    if (window.Player && window.Player.prototype && typeof window.Player.prototype.getName === "function") {
      const originalGetName = window.Player.prototype.getName;
      window.Player.prototype.getName = function () {
        const name = originalGetName.call(this);
        if (!name || typeof name !== "string") {
          return "Wizard";
        }
        return name;
      };
      window.Player.prototype.getName.__patched = true;
      this.playerPatched = true;
      console.log("[GamePatch] Player.prototype.getName patch installed.");
    }
  }

  /**
   * Intercepts Phaser.Cache.prototype.getImage for missing texture key fallbacks.
   */
  patchPhaserCache() {
    if (this.phaserCachePatched) return;
    if (window.Phaser && window.Phaser.Cache && window.Phaser.Cache.prototype) {
      const originalGetImage = window.Phaser.Cache.prototype.getImage;
      window.Phaser.Cache.prototype.getImage = function (key, silent) {
        let image = originalGetImage.call(this, key, silent);

        if (!image && typeof key === "string" && key.includes("undefined")) {
          console.warn(`[GamePatch] Intercepted missing asset key "${key}". Applying fallback...`);
          const fallbackKey = key.replace(/undefined/g, "1");
          image = originalGetImage.call(this, fallbackKey, true);

          if (image && this._cache && this._cache.image) {
            this._cache.image[key] = image;
          }
        }
        return image;
      };
      window.Phaser.Cache.prototype.getImage.__patched = true;
      this.phaserCachePatched = true;
      console.log("[GamePatch] Phaser.Cache.prototype.getImage patch installed.");
    }
  }

  /**
   * Patches Prodigy network endpoints and socket handlers.
   */
  patchNetworkEndpoints(prodigyNetwork) {
    if (!prodigyNetwork || !prodigyNetwork.url) return;

    console.log("[GamePatch] Patching network base URLs...");
    prodigyNetwork.url.multiplayer = prodigyNetwork.url.multiplayer || window.location.origin;
    prodigyNetwork.url.events = prodigyNetwork.url.events || (window.location.origin + "/events-api/");
    prodigyNetwork.url.game = prodigyNetwork.url.game || (window.location.origin + "/game-api/");

    if (typeof prodigyNetwork.joinMultiplayerServer === "function" && !prodigyNetwork.joinMultiplayerServer.__patched) {
      const originalJoin = prodigyNetwork.joinMultiplayerServer;

      prodigyNetwork.joinMultiplayerServer = function (worldId, zone, callbacks, onMessage, onPlayerList, onPlayerJoined, onPlayerLeft, onDisconnect) {
        console.log(`[GamePatch] Intercepting joinMultiplayerServer -> World: ${worldId}, Zone: ${zone}`);

        const safeOnMessage = (data) => {
          if (data === undefined || data === null) {
            console.warn("[GamePatch] Intercepted undefined message frame. Suppressing error.");
            return;
          }

          // Handle raw string parsing if packet arrives unparsed
          let parsedData = data;
          if (typeof data === "string") {
            try {
              parsedData = JSON.parse(data);
            } catch (e) {
              parsedData = { type: "raw", content: data };
            }
          }

          if (typeof onMessage === "function") onMessage(parsedData);
        };

        // Retrieve valid player ID using window.game.prodigy.player.userID as primary fallback
        const extractPlayerID = (data) => {
          if (data !== undefined && data !== null) {
            if (typeof data === "number" || typeof data === "string") return String(data);

            const directId =
              data.playerId ||
              data.userID ||
              data.userId ||
              data.id ||
              (data.user && (data.user.userID || data.user.id)) ||
              (data.data && (data.data.userID || data.data.id || data.data.playerId));

            if (directId !== undefined && directId !== null && directId !== "undefined") {
              return String(directId);
            }
          }

          // Fallback directly to game instance player ID
          if (window.game && window.game.prodigy && window.game.prodigy.player && window.game.prodigy.player.userID) {
            return String(window.game.prodigy.player.userID);
          }

          return null;
        };

        const safeOnPlayerJoined = (data) => {
          const id = extractPlayerID(data);
          if (id && typeof onPlayerJoined === "function") {
            onPlayerJoined(id);
          } else {
            console.warn("[GamePatch] playerJoined payload received but missing valid UID:", data);
          }
        };

        const safeOnPlayerLeft = (data) => {
          const id = extractPlayerID(data);
          if (id && typeof onPlayerLeft === "function") {
            onPlayerLeft(id);
          }
        };

        return originalJoin.call(this, worldId, zone, callbacks, safeOnMessage, onPlayerList, safeOnPlayerJoined, safeOnPlayerLeft, onDisconnect);
      };

      prodigyNetwork.joinMultiplayerServer.__patched = true;
    }
  }

  /**
   * Intercepts PVP Matchmaking state transitions.
   */
  patchMatchmaking(prodigyGame) {
    if (!prodigyGame || !prodigyGame.state || !prodigyGame.prodigy || !prodigyGame.prodigy.network) return;

    const network = prodigyGame.prodigy.network;
    if (typeof network.startMatchmaking === "function" && !network.startMatchmaking.__patched) {
      const originalStartMatchmaking = network.startMatchmaking;

      network.startMatchmaking = function (level, arenaScore, playerData, onSuccess, onError) {
        console.log("[GamePatch] Finding PvP Opponent...");

        const triggerArenaMessage = (rawMatchData) => {
          if (!rawMatchData) return;

          // Normalize payload if nested inside rawMatchData.arenaEvent or rawMatchData.data
          const matchData = rawMatchData.arenaEvent || rawMatchData.data || rawMatchData;
          const matchID = matchData.matchID || rawMatchData.matchID || `match_${Date.now()}`;
          
          const arenaPayload = {
            matchID: matchID,
            playerA: matchData.playerA || {
              id: matchData.opponent ? (matchData.opponent.userID || matchData.opponent.id) : "100001",
              data: matchData.opponent || {}
            },
            playerB: matchData.playerB || {
              id: prodigyGame.prodigy.player.userID,
              data: playerData
            }
          };

          console.log("[GamePatch] Dispatching normalized 'arena' message...", arenaPayload);

          // Standardize ID comparison (Handles String vs Number mismatch)
          const myID = String(prodigyGame.prodigy.player.userID);
          const playerA_ID = String(arenaPayload.playerA ? arenaPayload.playerA.id : "");

          const oppData = (playerA_ID !== myID) 
            ? (arenaPayload.playerA ? arenaPayload.playerA.data : {}) 
            : (arenaPayload.playerB ? arenaPayload.playerB.data : {});

          let opponentPlayer = null;
          if (window.Player) {
            opponentPlayer = new window.Player(prodigyGame);
            if (typeof opponentPlayer.init === "function") {
              opponentPlayer.init(oppData);
            }
          }

          // 1. Dispatch to messageListener ensuring listener gets the exact object expected
          if (prodigyGame.prodigy && prodigyGame.prodigy.messageListener) {
            const listener = prodigyGame.prodigy.messageListener;
            if (typeof listener.broadcast === "function") {
              listener.broadcast("arena", arenaPayload);
            } else if (typeof listener.onMessage === "function") {
              listener.onMessage({ type: "arena", data: arenaPayload });
            }
          }

          // 2. Trigger PVPLoading state transition directly when 2 players match
          setTimeout(() => {
            const states = prodigyGame.state.states;
            const loadingKey = Object.keys(states).find(k => k.toLowerCase() === "pvploading") || "PVPLoading";
            
            console.log(`[GamePatch] Match confirmed! Starting Phaser State '${loadingKey}' with match payload.`);
            
            prodigyGame.state.start(loadingKey, true, false, {
              opponent: opponentPlayer || oppData,
              matchID: matchID,
              playerA: arenaPayload.playerA,
              playerB: arenaPayload.playerB
            });

            // If prodigy.pvp is initialized, ensure state machine advances seamlessly
            if (prodigyGame.prodigy && prodigyGame.prodigy.pvp) {
              setTimeout(() => {
                const pvpState = states[loadingKey] || states.PVP || states.pvp;
                if (pvpState && typeof pvpState.onMessage === "function") {
                  console.log("[GamePatch] Driving PVP state machine sequence...");
                  
                  pvpState.onMessage({
                    action: "data",
                    data: oppData
                  });

                  setTimeout(() => {
                    pvpState.onMessage({
                      action: "init",
                      data: {}
                    });
                  }, 300);
                }
              }, 400);
            }
          }, 200);
        };

        const startPolling = () => {
          const pollInterval = setInterval(() => {
            originalStartMatchmaking.call(network, level, arenaScore, playerData, (pollData) => {
              if (pollData && (pollData.matched || pollData.opponent || pollData.arenaEvent)) {
                clearInterval(pollInterval);
                if (typeof onSuccess === "function") onSuccess(pollData);
                triggerArenaMessage(pollData);
              }
            }, onError);
          }, 2000);
        };

        const wrappedSuccess = (data) => {
          const responseData = data || {};
          if (responseData.opponent || responseData.matched || responseData.arenaEvent) {
            if (typeof onSuccess === "function") onSuccess(responseData);
            triggerArenaMessage(responseData);
          } else {
            // Player 1 enqueued -> start polling
            startPolling();
          }
        };

        return originalStartMatchmaking.call(this, level, arenaScore, playerData, wrappedSuccess, onError);
      };

      network.startMatchmaking.__patched = true;
    }
  }

  /**
   * Starts game instance polling loop to attach patches when Prodigy object loads.
   */
  hookGameInstance() {
    const earlyHook = setInterval(() => this.installImmediatePatches(), 50);
    setTimeout(() => clearInterval(earlyHook), 5000);

    const checkGameInstance = setInterval(() => {
      this.installImmediatePatches();

      if (window.game && window.game.prodigy) {
        clearInterval(checkGameInstance);
        console.log("[GamePatch] Game instance attached. Executing main patch sequence...");

        if (window.game.prodigy.network) {
          this.patchNetworkEndpoints(window.game.prodigy.network);
        }
        this.patchMatchmaking(window.game);
        this.installed = true;
      }
    }, 100);
  }
}

// Auto-instantiate and run on load
const gamePatchInstance = new GamePatch();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => gamePatchInstance.hookGameInstance());
} else {
  gamePatchInstance.hookGameInstance();
}
