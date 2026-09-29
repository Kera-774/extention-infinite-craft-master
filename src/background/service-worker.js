/**
 * Service worker volontairement minimal : MV3 le termine après ~30 s
 * d'inactivité, donc aucune boucle ni état ici. Il configure seulement
 * l'ouverture du side panel au clic sur l'icône.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
