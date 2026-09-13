# Editing skills

Each `*.md` file here is a **skill**: a brief the AI editor follows in addition to
its core rules (word-precise cuts, JSON plan, every cut explained). Pick one in the
GUI (AI editor → Editing skill) or with `--skill <id>` on the CLI. The file name
without `.md` is the id.

Format:

```markdown
---
name: Film Director          # shown in the GUI
emoji: 🎬                    # optional
order: 2                     # optional sort key
description: one line shown under the selector
---
The brief itself, in plain language. Precedence: user instructions > skill > core defaults.
```

Add your own by dropping a file in this folder and pressing ↻ next to the
selector (or restarting the GUI). A folder layout `skills/<id>/SKILL.md` is
accepted too — that is the standard Agent Skills layout, so a skill folder can be
copied unchanged into other agents (for Claude Code: `~/.claude/skills/<id>/SKILL.md`).

## Using the skills from other agents

- **CLI**: `ai-video-editor process talk.mp4 --skill film-director -i "under 2 minutes"`
- **MCP** (Claude Desktop / Claude Code): `list_skills()` then
  `process_video(video_path=..., skill="film-director", instructions="...")`;
  `plan_only=True` returns the plan without rendering.
- **GUI**: AI editor → Editing skill.

## Sources the built-in skills are distilled from

- Walter Murch's *Rule of Six* and dramaturgy notes as summarised in
  [smixs/visual-skills](https://github.com/smixs/visual-skills) (`video/references/dramaturgy.md`)
- Retention editing guidance: [Pixflow — YouTube retention editing](https://pixflow.net/blog/youtube-video-retention-editing/),
  [Uppbeat — audience retention](https://uppbeat.io/blog/youtube-growth/youtube-analytics/youtube-audience-retention),
  [AIR Media-Tech — advanced retention editing](https://air.io/en/youtube-hacks/advanced-retention-editing-cutting-patterns-that-keep-viewers-past-minute-8)
- Short-form data: [OpusClip — ideal Shorts length & format](https://www.opus.pro/blog/ideal-youtube-shorts-length-format-retention),
  [OpusClip — Shorts hook formulas](https://www.opus.pro/blog/youtube-shorts-hook-formulas)
- Agent skill format & talking-head workflows: [browser-use/video-use](https://github.com/browser-use/video-use),
  [linyqh/speclip-skills](https://github.com/linyqh/speclip-skills)

Only cut-based advice was kept — this tool chooses which spoken moments survive and in
what order; it does not add b-roll, captions or zooms.
