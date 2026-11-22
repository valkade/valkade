# ValkAde press kit

Captured from the real **ValkAde v0.6.0** desktop app (default *ValkAde Dark Royal Ocean* theme) at 1.5× HiDPI (2880×1620 native capture downsampled to 1920×1080) on a clean profile. Local inference and multi-GPU placement were recorded live on an **RTX 5090 (32 GB)** and **RTX 5070 Ti (16 GB)** running **Gemma 4 12B (Q4)** and **Qwen 3.8 27B (Q6)** via managed `llama-server`.

## Cinematic clips (`clips/`)

Each clip is exported as a **1920×1080 30 fps H.264 MP4** (for social posts, release notes, and video embeds) and a palette-optimized **880×495 GIF** (for fast inline rendering in GitHub Markdown), with smooth camera zooms into each active UI component.

| Clip | Length | Shows |
| ---- | ------ | ----- |
| `agent-turn` | 18 s | Live Gemma 4 12B local turn adding a 5-day forecast strip across five files, zooming into the composer, change summary, and Monaco diff. Streaming waits sped up. |
| `gpu-placement` | 15 s | Switching to dual-GPU split (`RTX 5090 + RTX 5070 Ti`) and dragging the interactive layer split handle with live per-card VRAM gauges and `--tensor-split` updates. |
| `subagents-health` | 15 s | Configuring specialized sub-agent roles (`Explorer`, `Reviewer`, `Implementer`) and viewing live GPU telemetry and `llama-server` consoles in Health. |
| `turn-review` | 14 s | Opening before-and-after diffs for each file edited in a turn, then resetting one file and resetting the full turn. |
| `local-models` | 12 s | Browsing Featured models and 25+ GGUF quantizations inside Model Manager. |
| `first-run-tour` | 15 s | First launch and the cross-window guided tour across Home, Dependencies, and Settings. |
| `updates` | 10 s | Opening the Updates window, inspecting `v0.6.0` release notes, and highlighting the verified Update action. |

## Marketing images (`marketing/`)

| File | Dimensions | Use |
| ---- | ---------- | --- |
| `banner-1920x1080.png` | 1920×1080 | README hero header, release announcements |
| `social-preview-1280x640.png` | 1280×640 | GitHub social preview, OpenGraph link cards |
| `feature-local-agent-1920x1080.png` | 1920×1080 | Local & cloud agentic editing |
| `feature-gpu-placement-1920x1080.png` | 1920×1080 | Multi-GPU placement & live VRAM gauges (with close-up loupe) |
| `feature-subagents-1920x1080.png` | 1920×1080 | Sub-agent roles & per-role model routing |
| `feature-review-1920x1080.png` | 1920×1080 | Turn review diffs & one-click reset |
| `feature-models-1920x1080.png` | 1920×1080 | Model Manager & Hugging Face GGUF downloads |
| `feature-tour-1920x1080.png` | 1920×1080 | Cross-window guided tour |
| `feature-updates-1920x1080.png` | 1920×1080 | Signed built-in updates |

## Screenshots (`screenshots/`)

All **1920×1080 PNG**: `first-launch`, `guided-tour`, `agent-turn`, `turn-review`, `turn-diff`, `model-manager`, `gpu-placement`, `subagent-roles`, `health-servers`, `updates`.

## Brand — Valkyrie Gold

| | |
| - | - |
| App icon | [`build/icon.png`](../../build/icon.png) (1024×1024), master SVG [`assets/valkade-logo-gold.svg`](../../assets/valkade-logo-gold.svg) |
| Obsidian plate | `#0e0d0c` icon plate, `#0a0a0d` marketing canvas |
| Ivory glyph | `#f6f2e9` (primary mark leg & display text) |
| Valkyrie Gold | `#ffde82` (highlight), `#f5a826` (primary gold), `#c46d12` (deep bronze) |
| UI accent | `#4da3ff` (electric blue in *ValkAde Dark Royal Ocean*), `#ffb35c` (amber) |
| Type | Segoe UI Variable / Inter (headlines and body), Cascadia Mono / JetBrains Mono (labels and code) |
