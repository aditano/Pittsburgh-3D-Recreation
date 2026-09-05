/** Reuse the real controls in mobile sheets so desktop and touch share state. */
const media = window.matchMedia('(max-width: 760px), (pointer: coarse)');
const sheet = document.getElementById('mobile-sheet');
const content = document.getElementById('mobile-sheet-content');
const title = document.getElementById('mobile-sheet-title');
const originalTools = document.querySelector('section.city-tools');
const transit = originalTools.querySelector(':scope > details');
const places = originalTools.querySelectorAll(':scope > details')[1];
const world = [...originalTools.children].filter(node => node !== transit && node !== places);
const groups = {
  explore: [document.getElementById('nav'), places],
  transit: [transit],
  world: [document.getElementById('weather'), ...world, document.getElementById('settings')],
};
const anchors = new Map();
for (const node of Object.values(groups).flat()) {
  const anchor = document.createComment('desktop control position');
  node.before(anchor);
  anchors.set(node, anchor);
}
let active = null;
let trigger = null;
let wasSettingsOpen = false;
function restore() {
  for (const [node, anchor] of anchors) anchor.after(node);
  document.getElementById('settings').hidden = !wasSettingsOpen;
  places.open = false;
  transit.open = true;
}
function resetSheet() {
  restore();
  active = null;
  document.body.classList.remove('mobile-sheet-open');
  document.querySelectorAll('[data-mobile-panel]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
function closeSheet() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener('close', () => {
  resetSheet();
  trigger?.focus({ preventScroll: true });
});
sheet.addEventListener('click', event => { if (event.target === sheet) {
  const rect = sheet.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSheet();
}});
document.getElementById('mobile-sheet-close').addEventListener('click', closeSheet);
function openPanel(panel, button) {
  if (!media.matches) return;
  if (sheet.open && active === panel) { closeSheet(); return; }
  if (!sheet.open) wasSettingsOpen = !document.getElementById('settings').hidden;
  restore();
  active = panel;
  trigger = button;
  title.textContent = { explore: 'Explore Pittsburgh', transit: 'Buses & the T', world: 'Time, weather & display' }[panel];
  for (const node of groups[panel]) content.append(node);
  if (panel === 'world') document.getElementById('settings').hidden = false;
  if (panel === 'explore') places.open = true;
  transit.open = true;
  sheet.dataset.panel = panel;
  document.body.classList.add('mobile-sheet-open');
  document.querySelectorAll('[data-mobile-panel]').forEach(b => b.setAttribute('aria-expanded', String(b.dataset.mobilePanel === panel)));
  if (!sheet.open) sheet.showModal();
  content.scrollTop = 0;
}
document.querySelectorAll('[data-mobile-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.mobilePanel, button)));
document.getElementById('mobile-walk').addEventListener('click', () => {
  document.getElementById('walk-toggle').click();
  closeSheet();
});
// Finish a camera jump or a business visit with the map back in full view.
content.addEventListener('click', event => {
  if (event.target.closest('[data-view], #business-list button, #route-stops button, #focus-route, #walk-toggle')) closeSheet();
});
const syncStatus = () => {
  const walking = document.body.classList.contains('walking');
  const button = document.getElementById('mobile-walk');
  button.querySelector('span').textContent = walking ? 'Exit walk' : 'Walk';
  button.setAttribute('aria-pressed', String(walking));
  document.getElementById('mobile-clock').textContent = document.getElementById('city-clock').textContent;
  const ready = document.getElementById('loader').classList.contains('hide');
  button.disabled = !ready;
  document.getElementById('mobile-status').textContent = walking ? 'Drag to look · hold arrows to move' : ready ? 'Drag to orbit · pinch to zoom' : 'Preparing your city';
};
new MutationObserver(syncStatus).observe(document.body, { attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncStatus).observe(document.getElementById('city-clock'), { childList: true, characterData: true, subtree: true });
new MutationObserver(syncStatus).observe(document.getElementById('loader'), { attributes: true, attributeFilter: ['class'] });
function adapt() {
  if (!media.matches) { closeSheet(); resetSheet(); }
  document.body.classList.toggle('mobile-ui', media.matches);
  syncStatus();
}
media.addEventListener('change', adapt);
adapt();
