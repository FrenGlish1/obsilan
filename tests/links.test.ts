// Tests des cas critiques des liens et tags : analyse, résolution, renommage.
import { describe, expect, it } from 'vitest';
import {
  LinkIndex,
  linkTextFor,
  newNotePathForLink,
  parseLinks,
  parseTags,
  resolveLink,
  rewriteLinks,
} from '../shared/links.ts';

describe('analyse des liens', () => {
  it('reconnaît cible, titre et alias', () => {
    const [l] = parseLinks('Voir [[Dossier/Note#Partie 2|ce passage]].');
    expect(l).toMatchObject({ target: 'Dossier/Note', heading: 'Partie 2', alias: 'ce passage' });
  });

  it('compte les intégrations ![[…]]', () => {
    expect(parseLinks('![[Image]] et [[Note]]').map((l) => l.target)).toEqual(['Image', 'Note']);
  });

  it('ignore les liens dans le code', () => {
    const text = 'a `[[Pas un lien]]` b\n```\n[[Toujours pas]]\n```\n[[Vrai]]';
    expect(parseLinks(text).map((l) => l.target)).toEqual(['Vrai']);
  });

  it('donne la position exacte de la cible', () => {
    const text = 'x [[ Ma note |alias]]';
    const [l] = parseLinks(text);
    expect(text.slice(l.targetFrom, l.targetTo)).toBe('Ma note');
  });
});

describe('analyse des tags', () => {
  it('trouve les tags simples et imbriqués, pas les titres ni les nombres', () => {
    const text = '# Titre\n#projet et #projet/web, issue #123, mail a#b\n`#code`';
    expect(parseTags(text)).toEqual(['projet', 'projet/web']);
  });

  it('lit les tags de l’en-tête YAML', () => {
    expect(parseTags('---\ntags: [lecture, "idée"]\n---\nTexte #perso')).toEqual(['lecture', 'idée', 'perso']);
    expect(parseTags('---\ntags:\n  - a\n  - b\n---\n')).toEqual(['a', 'b']);
  });

  it('gère les accents', () => {
    expect(parseTags('#été #réunion/équipe')).toEqual(['été', 'réunion/équipe']);
  });
});

describe('résolution', () => {
  const paths = ['Accueil.md', 'Projets/Idée.md', 'Archives/Idée.md', 'Projets/Web/Site.md'];

  it('par nom, sans tenir compte de la casse', () => {
    expect(resolveLink('site', 'Accueil.md', paths)).toBe('Projets/Web/Site.md');
  });

  it('par chemin complet ou partiel', () => {
    expect(resolveLink('Archives/Idée', 'Accueil.md', paths)).toBe('Archives/Idée.md');
    expect(resolveLink('Web/Site', 'Accueil.md', paths)).toBe('Projets/Web/Site.md');
  });

  it('homonymes : préfère le dossier de la note source', () => {
    expect(resolveLink('Idée', 'Archives/Autre.md', paths)).toBe('Archives/Idée.md');
    expect(resolveLink('Idée', 'Projets/Autre.md', paths)).toBe('Projets/Idée.md');
  });

  it('non résolu → null', () => {
    expect(resolveLink('Inexistante', 'Accueil.md', paths)).toBeNull();
  });

  it('texte de lien le plus court possible', () => {
    expect(linkTextFor('Accueil.md', paths)).toBe('Accueil');
    expect(linkTextFor('Archives/Idée.md', paths)).toBe('Archives/Idée');
  });

  it('chemin de création d’une note manquante', () => {
    expect(newNotePathForLink('Nouvelle', 'Projets/Idée.md')).toBe('Projets/Nouvelle.md');
    expect(newNotePathForLink('Ailleurs/Nouvelle', 'Projets/Idée.md')).toBe('Ailleurs/Nouvelle.md');
  });
});

describe('renommage', () => {
  it('met à jour les liens en gardant titre et alias', () => {
    const old = ['A.md', 'Vieux nom.md'];
    const now = ['A.md', 'Nouveau nom.md'];
    const moves = new Map([['Vieux nom.md', 'Nouveau nom.md']]);
    const r = rewriteLinks('Voir [[Vieux nom#Partie|ici]] et [[vieux nom]].', 'A.md', 'A.md', moves, old, now);
    expect(r.text).toBe('Voir [[Nouveau nom#Partie|ici]] et [[Nouveau nom]].');
    expect(r.changed).toBe(2);
  });

  it('utilise un chemin si le nouveau nom devient ambigu', () => {
    const old = ['A.md', 'X/Note.md', 'Y/Autre.md'];
    const now = ['A.md', 'X/Note.md', 'Y/Note.md'];
    const moves = new Map([['Y/Autre.md', 'Y/Note.md']]);
    const r = rewriteLinks('[[Autre]] [[Note]]', 'A.md', 'A.md', moves, old, now);
    expect(r.text).toBe('[[Y/Note]] [[Note]]');
  });

  it('ne touche ni au code ni aux autres liens', () => {
    const old = ['A.md', 'B.md', 'C.md'];
    const now = ['A.md', 'B2.md', 'C.md'];
    const text = '[[B]] `[[B]]` [[C]]';
    const r = rewriteLinks(text, 'A.md', 'A.md', new Map([['B.md', 'B2.md']]), old, now);
    expect(r.text).toBe('[[B2]] `[[B]]` [[C]]');
  });

  it('suit un dossier déplacé pour les liens avec chemin', () => {
    const old = ['A.md', 'Projets/Plan.md'];
    const now = ['A.md', 'Archives/Projets/Plan.md'];
    const moves = new Map([['Projets/Plan.md', 'Archives/Projets/Plan.md']]);
    const r = rewriteLinks('[[Projets/Plan]] [[Plan]]', 'A.md', 'A.md', moves, old, now);
    expect(r.text).toBe('[[Archives/Projets/Plan]] [[Plan]]');
  });
});

describe('index des liens', () => {
  it('rétroliens avec contexte', () => {
    const idx = new LinkIndex();
    idx.set('A.md', 'Ligne 1\nJe parle de [[B]] ici.');
    idx.set('B.md', 'Rien');
    idx.set('C.md', '[[B|bé]] et [[A]]');
    expect(idx.backlinks('B.md')).toEqual([
      { source: 'A.md', lines: ['Je parle de [[B]] ici.'] },
      { source: 'C.md', lines: ['[[B|bé]] et [[A]]'] },
    ]);
  });

  it('un lien non résolu se résout quand la note est créée', () => {
    const idx = new LinkIndex();
    idx.set('A.md', '[[Plus tard]]');
    expect(idx.resolve('Plus tard', 'A.md')).toBeNull();
    idx.set('Plus tard.md', '');
    expect(idx.resolve('Plus tard', 'A.md')).toBe('Plus tard.md');
  });

  it('tags : comptage et sous-tags', () => {
    const idx = new LinkIndex();
    idx.set('A.md', '#projet/web');
    idx.set('B.md', '#Projet');
    expect(idx.allTags()).toEqual([
      { tag: 'projet/web', count: 1 },
      { tag: 'Projet', count: 1 },
    ].sort((a, b) => a.tag.localeCompare(b.tag, 'fr')));
    expect(idx.notesWithTag('projet')).toEqual(['A.md', 'B.md']);
  });

  it('reste rapide avec 5 000 notes', () => {
    const idx = new LinkIndex();
    for (let i = 0; i < 5000; i++) idx.set(`D${i % 50}/N${i}.md`, `[[N${(i + 1) % 5000}]] [[N${(i * 7) % 5000}]] #t${i % 20}`);
    const t0 = performance.now();
    const bl = idx.backlinks('D1/N1.md');
    expect(bl.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
