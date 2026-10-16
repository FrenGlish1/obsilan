// Découpe un extrait de recherche en morceaux à surligner,
// sans tenir compte des accents ni de la casse.

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export interface Part {
  text: string;
  hit: boolean;
}

export function highlightParts(text: string, query: string): Part[] {
  const terms = query.split(/\s+/).map(fold).filter((t) => t.length > 0);
  const nfc = text.normalize('NFC');
  const folded = fold(nfc);
  if (terms.length === 0 || folded.length !== nfc.length) return [{ text, hit: false }];

  // Marque chaque caractère couvert par au moins un terme.
  const mark = new Array<boolean>(nfc.length).fill(false);
  for (const t of terms) {
    let i = folded.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) mark[k] = true;
      i = folded.indexOf(t, i + t.length);
    }
  }
  const parts: Part[] = [];
  for (let i = 0; i < nfc.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === mark[i]) last.text += nfc[i];
    else parts.push({ text: nfc[i], hit: mark[i] });
  }
  return parts;
}
