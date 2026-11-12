// Prodigy Rewritten 1.30.0 — math-question (QI) stub.
//
// The retail game loaded the "QI" question widget from Prodigy's servers. That
// widget is not part of this revival (the game is "no longer a math game"), but
// the battle code still calls QI.showQuestion() — and it hides the battle UI
// *before* asking. With no QI object present that call throws a ReferenceError,
// the flow aborts halfway, and the battle screen is left blank.
//
// This stub answers every question as correct immediately (deferred one tick so
// the game can finish wiring its listeners first), which is how the other
// revival versions handle it. It must be loaded before any battle starts.

(function () {
	if (window.QI && typeof window.QI.showQuestion === "function") return;

	var makeEmitter = function () {
		var api = {
			on: function () { return api; },
			once: function () { return api; },
			off: function () { return api; },
			emit: function () {}
		};
		return api;
	};

	window.QI = {
		showQuestion: function (opts) {
			var handle = makeEmitter();
			window.setTimeout(function () {
				try {
					if (opts && typeof opts.callback === "function") {
						opts.callback({
							correct: true,
							wasCorrect: true,
							tta: 1,
							respTime: 1,
							ID: 0,
							answer: 0,
							skillID: 0,
							assignmentID: 0
						});
					}
				} catch (e) {
					console.log("QI stub callback failed: " + e);
				}
			}, 0);
			return handle;
		},
		close: function () {},
		init: function () {},
		getMasteredSkills: function () { return 0; },
		getUpdatedData: function () { return 0; },
		getAllTopicBadges: function () { return []; },
		enableLogging: function () {},
		disableLogging: function () {}
	};
})();
