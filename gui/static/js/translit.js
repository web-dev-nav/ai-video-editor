// Devanagari → Roman ("Hinglish") for display. Mirrors src/utils/translit.py — keep the two in sync.
const CONSONANTS = { "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f", "य़": "y" };
const NUKTA = { "क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f", "य": "y" };
const VOWELS = { "अ": "a", "आ": "aa", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e" };
const MATRAS = { "ा": "aa", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e" };
const VIRAMA = "्", NUKTA_SIGN = "़", ANUSVARA = "ं", CHANDRABINDU = "ँ", VISARGA = "ः";
const DEV = /[ऀ-ॿ]/;

export const hasDevanagari = (t) => !!t && DEV.test(t);

function word(w) {
  const units = [];   // [cons, vowel|null, virama]
  for (let i = 0; i < w.length; i++) {
    const ch = w[i], nxt = w[i + 1] || "";
    if (CONSONANTS[ch]) {
      let cons = CONSONANTS[ch];
      if (nxt === NUKTA_SIGN) { cons = NUKTA[ch] || cons; i++; }
      units.push([cons, null, false]);
    } else if (VOWELS[ch]) units.push(["", VOWELS[ch], false]);
    else if (MATRAS[ch]) { const u = units[units.length - 1]; if (u && u[0] && u[1] === null) u[1] = MATRAS[ch]; else units.push(["", MATRAS[ch], false]); }
    else if (ch === VIRAMA) { if (units.length) units[units.length - 1][2] = true; }
    else if (ch === ANUSVARA || ch === CHANDRABINDU) units.push(["n", "", true]);
    else if (ch === VISARGA) units.push(["h", "", true]);
    else if (ch >= "०" && ch <= "९") units.push([String(ch.charCodeAt(0) - 0x966), "", true]);
    else units.push([ch, "", true]);
  }
  const count = units.length, out = [];
  for (let idx = 0; idx < count; idx++) {
    let [cons, vowel, virama] = units[idx];
    if (vowel === null && !virama) {
      const last = idx === count - 1;
      const prevHasVowel = idx > 0 && !!units[idx - 1][1];
      const n = units[idx + 1];
      const nextHasVowel = !!n && !!n[0] && /[a-z]/i.test(n[0]) && !n[2] && (!!n[1] || (n[1] === null && idx + 1 < count - 1));
      vowel = last && count > 1 ? "" : prevHasVowel && nextHasVowel ? "" : "a";
      units[idx][1] = vowel;
    }
    if (vowel === "aa" && idx === count - 1) vowel = "a";
    if (vowel === "e" && idx === count - 2 && units[idx + 1][0] === "n" && units[idx + 1][2]) vowel = "ei";
    out.push(cons + (vowel || ""));
  }
  return out.join("").replace(/chchh/g, "chh").replace(/kkh/g, "kh");
}

export function toRoman(text) {
  if (!hasDevanagari(text)) return text;
  return String(text).replace(/[।॥]/g, ".").replace(/[ऀ-ॿ]+/g, word);
}

// Display preference (only affects Devanagari text).
let ROMAN = localStorage.getItem("ave.roman") !== "0";
export const romanOn = () => ROMAN;
export function setRoman(on) { ROMAN = !!on; localStorage.setItem("ave.roman", on ? "1" : "0"); }
export const disp = (t) => (ROMAN ? toRoman(t) : t);
