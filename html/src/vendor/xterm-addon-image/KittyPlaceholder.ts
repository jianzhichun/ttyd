/**
 * Kitty Unicode-placeholder decode. A placeholder cell is the character U+10EEEE
 * whose FOREGROUND COLOR encodes an image id and whose COMBINING DIACRITICS encode
 * (row, col) of the image tile that belongs in this cell. This is the redraw-safe
 * mechanism: the placeholder is app-owned text that the emitter re-prints on every
 * redraw, so the image follows the cells automatically.
 *
 * Closed system note: OUR emitter (the MessageDisplay hook + __ccimg sidecar) always
 * assigns image ids in 24-bit (sidecar counter is 1..0xFFFFFF) and emits them as a
 * TRUECOLOR foreground + exactly two diacritics (row, col) — never the 3rd "high byte"
 * diacritic. So `fgToImageId` returns the full id directly and the >24-bit path below
 * is inert for us; it is retained only for generic kitty compatibility.
 */
import { Attributes } from './Types';
import { diacriticToNum } from './RowColumnDiacritics';

export const KITTY_PLACEHOLDER = 0x10EEEE;

/** raw 32-bit fg word (line.getFg(col)) → image id, or -1 for default fg (inherit). */
export function fgToImageId(rawFg: number): number {
  const mode = rawFg & Attributes.CM_MASK;
  if (mode === Attributes.CM_RGB) {
    return rawFg & Attributes.RGB_MASK;                 // truecolor → 24-bit id (our path)
  }
  if (mode === Attributes.CM_P256 || mode === Attributes.CM_P16) {
    return rawFg & Attributes.PCOLOR_MASK;              // palette → 8-bit id
  }
  return -1;                                            // default fg → inherit from left
}

export interface IPH { id: number; row: number; col: number; }

/**
 * Decode one placeholder cell. `s` is the full cell string (base char + combining
 * marks, from IBufferLine.getString). `prev` is the previously decoded cell on this
 * line (kitty run-length inherit) or null at a run start.
 */
export function decodePlaceholder(s: string, rawFg: number, prev: IPH | null): IPH | null {
  if (s.codePointAt(0) !== KITTY_PLACEHOLDER) {
    return null;
  }
  let i = 2;                                            // skip the U+10EEEE surrogate pair
  const dRow = i < s.length ? diacriticToNum(s.charCodeAt(i++)) : -1;   // diacritics are BMP
  const dCol = i < s.length ? diacriticToNum(s.charCodeAt(i++)) : -1;
  const dHigh = i < s.length ? diacriticToNum(s.charCodeAt(i++)) : -1;  // id bits 24..31 (unused by us)
  const idLow = fgToImageId(rawFg);
  let id: number;
  if (idLow < 0) {
    if (!prev) {
      return null;                                      // default fg with nothing to inherit
    }
    id = prev.id;
  } else {
    id = dHigh >= 0 ? ((idLow | (dHigh << 24)) >>> 0) : idLow;
  }
  const row = dRow >= 0 ? dRow : (prev ? prev.row : 0);
  const col = dCol >= 0 ? dCol : (prev ? prev.col + 1 : 0);
  return { id, row, col };
}
