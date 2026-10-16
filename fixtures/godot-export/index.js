// Test stand-in for a Godot 4.3 Web export loader (fixture only).
var Godot = (() => function Godot(moduleArg) { return Promise.resolve(moduleArg) })();
const Engine = (function () {
  function Engine(initConfig) { this.config = initConfig }
  Engine.getMissingFeatures = function (opts) {
    const missing = []
    if (opts && opts.threads && !globalThis.crossOriginIsolated) missing.push('Cross-Origin Isolation')
    return missing
  }
  Engine.prototype.startGame = function () { return Godot({ locateFile: f => f, wasm: 'index.wasm', pck: 'index.pck' }) }
  return Engine
})();
