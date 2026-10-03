import { InputValidationError } from '../github/types';

export function replaceExactOnce(content: string, oldText: string, newText: string): string {
  const first = content.indexOf(oldText);
  if (first < 0) throw new InputValidationError('Le texte attendu est introuvable ; relisez le fichier.', 'TEXT_NOT_FOUND');
  if (content.indexOf(oldText, first + 1) >= 0) {
    throw new InputValidationError('Le texte attendu apparaît plusieurs fois ; fournissez un contexte plus précis.', 'TEXT_NOT_UNIQUE');
  }
  if (oldText === newText) throw new InputValidationError('Le remplacement ne change pas le fichier.', 'NO_CHANGE');
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}

export function appendExact(content: string, text: string): string {
  return content + text;
}
