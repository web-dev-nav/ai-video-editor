"""Devanagari → Roman ("Hinglish") transliteration for display.

Whisper writes Hindi in Devanagari; many editors read Roman spelling faster
("kaisa hai" rather than "कैसा है"). This is a readable, approximate scheme —
the common informal spelling, not a scholarly one — with basic schwa deletion
(कैसा → kaisa, करता → karta, नमस्ते → namaste, मतलब → matlab).

Keep `gui/static/js/translit.js` in sync: same tables, same rules.
"""

from __future__ import annotations

import re

CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
    # nukta forms (precomposed)
    "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f", "य़": "y",
}
NUKTA = {"क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f", "य": "y"}
VOWELS = {"अ": "a", "आ": "aa", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e"}
MATRAS = {"ा": "aa", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e"}
VIRAMA, NUKTA_SIGN, ANUSVARA, CHANDRABINDU, VISARGA = "्", "़", "ं", "ँ", "ः"
DIGITS = {chr(0x966 + i): str(i) for i in range(10)}
DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def has_devanagari(text: str) -> bool:
    return bool(text) and bool(DEVANAGARI.search(text))


def _word(word: str) -> str:
    """Transliterate one Devanagari word (no spaces)."""
    # Step 1: break into syllable units: [consonant_roman, vowel_roman|None, explicit_vowel]
    units: list[list] = []   # each: [cons, vowel, has_virama]
    i, n = 0, len(word)
    while i < n:
        ch = word[i]
        nxt = word[i + 1] if i + 1 < n else ""
        if ch in CONSONANTS:
            cons = CONSONANTS[ch]
            if nxt == NUKTA_SIGN:
                cons = NUKTA.get(ch, cons); i += 1
            units.append([cons, None, False])
        elif ch in VOWELS:
            units.append(["", VOWELS[ch], False])
        elif ch in MATRAS:
            if units and units[-1][0] and units[-1][1] is None:
                units[-1][1] = MATRAS[ch]
            else:
                units.append(["", MATRAS[ch], False])
        elif ch == VIRAMA:
            if units:
                units[-1][2] = True
        elif ch in (ANUSVARA, CHANDRABINDU):
            units.append(["n", "", True])   # nasal: consonant with no vowel
        elif ch == VISARGA:
            units.append(["h", "", True])
        elif ch in DIGITS:
            units.append([DIGITS[ch], "", True])
        else:
            units.append([ch, "", True])     # punctuation / Latin passthrough
        i += 1

    # Step 2: inherent vowel + schwa deletion.
    # A consonant with no matra and no virama carries an inherent "a" — except at the end of the
    # word (kaisa, matlab) and in the classic V-C-a-C-V position (karta) unless a cluster follows.
    out = []
    count = len(units)
    for idx, (cons, vowel, virama) in enumerate(units):
        if vowel is None and not virama:
            last = idx == count - 1
            prev_has_vowel = idx > 0 and bool(units[idx - 1][1])   # resolved below, so inherent "a" counts too
            nxt = units[idx + 1] if idx + 1 < count else None
            # the next syllable must carry a real vowel: an explicit matra, or an inherent "a" that will
            # survive (i.e. it is not the word-final consonant, whose inherent "a" is dropped)
            next_is_cons_with_vowel = bool(nxt) and bool(nxt[0]) and nxt[0].isalpha() and not nxt[2] and (
                bool(nxt[1]) or (nxt[1] is None and idx + 1 < count - 1))
            if last and count > 1:
                vowel = ""
            elif prev_has_vowel and next_is_cons_with_vowel:
                vowel = ""
            else:
                vowel = "a"
            units[idx][1] = vowel
        # word-final long aa is written as a single "a" informally (kya, kaisa, acha)
        if vowel == "aa" and idx == count - 1:
            vowel = "a"
        # word-final "ें" reads as "ein" (mein, karein), not "en"
        if vowel == "e" and idx == count - 2 and units[idx + 1][0] == "n" and units[idx + 1][2]:
            vowel = "ei"
        out.append(cons + (vowel or ""))
    s = "".join(out)
    s = s.replace("chchh", "chh").replace("kkh", "kh")
    return s


def to_roman(text: str) -> str:
    """Transliterate every Devanagari run in `text`; everything else passes through unchanged."""
    if not has_devanagari(text):
        return text
    text = text.replace("।", ".").replace("॥", ".")

    def repl(m: re.Match) -> str:
        return _word(m.group(0))

    return re.sub(r"[ऀ-ॿ]+", repl, text)
