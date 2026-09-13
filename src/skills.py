"""Editing skills — Markdown briefs (frontmatter + body) that shape how the AI editor cuts.

Two layouts are accepted:
  skills/<id>.md            — flat file (the built-ins)
  skills/<id>/SKILL.md      — Agent Skills layout, so a skill folder can be shared
                              with other agents (Claude Code, Codex, …) unchanged.
The id is the file stem (flat) or the folder name.
"""

from __future__ import annotations

import re
from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
DEFAULT_SKILL = "clean"

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)


def _parse(path: Path, skill_id: str | None = None) -> dict:
    text = path.read_text(encoding="utf-8")
    meta: dict = {}
    body = text
    m = _FRONTMATTER.match(text)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                meta[k.strip()] = v.strip().strip('"').strip("'")
        body = text[m.end():]
    try:
        order = int(meta.get("order", 999))
    except ValueError:
        order = 999
    sid = skill_id or path.stem
    return {
        "id": sid,
        "name": meta.get("name") or sid.replace("-", " ").title(),
        "emoji": meta.get("emoji", ""),
        "description": meta.get("description", ""),
        "order": order,
        "body": body.strip(),
    }


def load_skills() -> list[dict]:
    """All skills, sorted by `order` then name. Files starting with '_' or README are ignored."""
    if not SKILLS_DIR.is_dir():
        return []
    out = []
    seen: set[str] = set()
    for p in SKILLS_DIR.glob("*.md"):
        if p.stem.lower() == "readme" or p.stem.startswith("_"):
            continue
        try:
            sk = _parse(p)
        except OSError:
            continue
        out.append(sk)
        seen.add(sk["id"])
    for d in SKILLS_DIR.iterdir():
        f = d / "SKILL.md"
        if d.is_dir() and not d.name.startswith("_") and f.is_file() and d.name not in seen:
            try:
                out.append(_parse(f, d.name))
            except OSError:
                continue
    return sorted(out, key=lambda s: (s["order"], s["name"].lower()))


def get_skill(skill_id: str | None) -> dict | None:
    """Skill by id; unknown ids fall back to the default skill (None if none exist)."""
    skills = {s["id"]: s for s in load_skills()}
    if skill_id and skill_id in skills:
        return skills[skill_id]
    return skills.get(DEFAULT_SKILL) or (next(iter(skills.values())) if skills else None)
