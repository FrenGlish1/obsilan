// Réglages du site : à adapter une seule fois ici, toutes les pages en profitent.
window.OBSILAN = {
  /** Dernière version publiée. */
  version: '0.6.1',
  /** Page des téléchargements (GitHub Releases du dépôt). */
  releases: 'https://github.com/FrenGlish1/obsilan/releases/latest',
  /** Liens directs vers les fichiers de la dernière version. */
  windows: 'https://github.com/FrenGlish1/obsilan/releases/latest/download/ObsiLan_x64-setup.exe',
  android: 'https://github.com/FrenGlish1/obsilan/releases/latest/download/ObsiLan.apk',
  /** Adresse de contact (questions, données personnelles). */
  contact: 'mathisdeleglise2648@gmail.com',
};

// Applique les réglages aux liens marqués data-link="…" et aux textes data-text="…".
document.addEventListener('DOMContentLoaded', () => {
  const c = window.OBSILAN;
  document.querySelectorAll('[data-link]').forEach((a) => {
    const key = a.dataset.link;
    if (key === 'contact') a.href = 'mailto:' + c.contact;
    else if (c[key]) a.href = c[key];
  });
  document.querySelectorAll('[data-text]').forEach((el) => {
    if (c[el.dataset.text]) el.textContent = c[el.dataset.text];
  });
  document.querySelectorAll('.year').forEach((el) => (el.textContent = new Date().getFullYear()));
});
