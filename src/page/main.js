/**
 * Point d'entrée dans la page (monde MAIN) : crée le moteur et route les
 * commandes venant du side panel (via le content script).
 */
(function () {
  'use strict';
  const ICX = window.ICX;
  if (!ICX || ICX.engine) return;
  const engine = new ICX.Engine();
  ICX.engine = engine;

  ICX.bridge.onCommand(async (cmd, p) => {
    switch (cmd) {
      case 'hello':
        if (p && p.workerSource) engine.planner.setWorkerSource(p.workerSource);
        return { ok: true };
      case 'getState':
        return { snapshot: engine.snapshot(), settings: engine.settings, levels: ICX.power.LEVELS };
      case 'start':
        engine.start();
        return engine.snapshot();
      case 'pause':
        engine.pause();
        return engine.snapshot();
      case 'stop':
        await engine.stop();
        return engine.snapshot();
      case 'setLevel':
        engine.setLevel(p.level);
        return engine.snapshot();
      case 'setSettings':
        engine.setSettings(p || {});
        return { settings: engine.settings };
      case 'exportCache':
        return engine.exportCache();
      case 'importCache':
        return engine.importCache(p);
      case 'clearCache':
        return engine.clearCache();
      case 'startFocus':
        engine.startFocus(p.target, p.thenExplore);
        return engine.snapshot();
      case 'cancelFocus':
        engine.cancelFocus();
        return engine.snapshot();
      case 'searchElements':
        return engine.searchElements(p.q, p.limit);
      case 'diagnose':
        return engine.diagnose();
      case 'resetSettings':
        engine.resetSettings();
        return { settings: engine.settings };
      case 'reloadGame':
        await engine.stop();
        engine.game.reloadGame();
        return { ok: true };
      default:
        throw new Error('commande inconnue : ' + cmd);
    }
  });

  engine.init().catch((err) => {
    engine.state = 'error';
    engine.log('Échec de l’initialisation : ' + (err && err.message));
    console.error('[ICX]', err);
  });
  ICX.bridge.emit('page-ready');
})();
