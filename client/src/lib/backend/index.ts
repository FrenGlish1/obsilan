// Choix automatique du mode d'accès aux notes.
import type { Backend } from './types.ts';
import { HttpBackend } from './http.ts';
import { TauriBackend } from './tauri.ts';

export { BackendError, type Backend } from './types.ts';

/** Vrai quand l'interface tourne dans l'application native (Tauri). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const backend: Backend = isTauri ? new TauriBackend() : new HttpBackend();
