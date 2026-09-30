# Idea Inbox

**Anything → save once → searchable text & knowledge.**

## The idea
You see something useful while scrolling — an Instagram Reel, a carousel, a Threads post, a YouTube video, an article. You tap **Share → Notion → Idea Inbox** and keep scrolling. Nothing else to do.

A few minutes later the same Notion page contains:
- the original link, author, publish date and post text;
- the full transcript of what was said (videos) and the text on the slides (carousels, photos);
- **Key points** — the concrete points/steps exactly as the author gives them ("5 things: …");
- a short summary and why it may be useful later;
- products/tools, people and links mentioned;
- a category and tags.

Instead of hundreds of forgotten bookmarks you get a personal searchable knowledge base: "that Reel about an AI tool for UX research from two months ago" → Notion search → the video, its transcript and the original source.

Old Instagram **Saved** posts are imported into the same queue and go through the same pipeline.

Instagram is the first and most important source; the idea is wider than Instagram.

Constraints the design follows: free (no paid APIs), open-source components, works from the phone, no web app to maintain, the user's Mac does not need to be on.

Acceptance test: https://www.instagram.com/reel/DdryL7zMUOj/

## How it works
```
iPhone: Share → Notion → "Idea Inbox" database         (new row, Status empty)
   │ Notion webhook "page.created" (5–25 s)
   ▼
Cloudflare Worker "idea-inbox-relay"  (relay/)         checks Notion signature,
   │ GitHub API workflow_dispatch                      starts the job
   ▼
GitHub Actions "idea-inbox"  (.github/workflows/idea-inbox.yml, processor/)
   1. install: yt-dlp, ffmpeg, tesseract, parakeet.cpp + model, Ollama + model (cached)
   2. start Cobalt (docker) on the runner
   3. for each row with Status empty/New:
      media      Cobalt → yt-dlp fallback  (audio of the video)
      metadata   yt-dlp -J (author, date, caption); page text for articles
      transcript parakeet.cpp, Parakeet TDT 0.6B v3 (25 langs incl. ru/uk/en), CPU
      slides     Cobalt picker → Tesseract OCR (rus+eng), up to 20 images
      screen     short videos (Reels, Threads, Shorts): frames at scene changes → Tesseract, each line once
      digest     Ollama qwen2.5:7b → title, key points, summary, why useful,
                 category, tags, tools, people, links  (written in Russian)
      screen     every video: up to 40 frames (scene changes, or evenly spaced if > 150 s) → Tesseract OCR
   4. write back to the same Notion page, Status = Done
   5. Resource Catalog rule: every tool the digest finds (with URL/domain when it appears in text or on screen)
      is filed into the Resources data source as 📥 Inbox — skipped if a row with that domain or name exists.
      The capture page lists them under "Каталог ресурсов" with links. Needs the catalog page shared with
      the Idea Inbox connection; otherwise the page says so in "Не получено".
```
A GitHub cron (every 15 min) is a fallback trigger; in practice GitHub runs it rarely, so the webhook is the real trigger.

### Where things live
| Part | Where | Account |
|---|---|---|
| Database + results | Notion page "🧠 Idea Inbox" → database "Idea Inbox" (data source `4fd5ba03-9001-4bd8-ad00-b42ccc6a0f72`) | Notion: Kablucco (hyperjorney@gmail.com) |
| Notion connection | notion.so/my-integrations → "Idea Inbox" (API token + webhook subscription) | same |
| Relay | Cloudflare Worker `idea-inbox-relay` → https://idea-inbox-relay.zakabluk-a-a.workers.dev | Cloudflare: zakabluk.a.a@gmail.com |
| Processor + schedule | this repo `zkblk/ai-office` (public) | GitHub: zkblk |

### Secrets (never in this repo)
| Secret | Stored in | Purpose |
|---|---|---|
| `NOTION_TOKEN` | GitHub Actions secrets | processor reads/writes Notion |
| `YTDLP_COOKIES` | GitHub Actions secrets | YouTube login (separate Google account a.kablucho@gmail.com) |
| `IG_COOKIES` | GitHub Actions secrets | Instagram login for yt-dlp (burner account), merged with YTDLP_COOKIES at run time |
| `COBALT_COOKIES` | GitHub Actions secrets | Same Instagram session for Cobalt (carousel slides), JSON built from the cookies.txt |
| `GITHUB_TOKEN` | Cloudflare Worker secret | fine-grained PAT, Actions read/write on this repo only; expires after 1 year |
| `NOTION_VERIFICATION_TOKEN` | Cloudflare Worker secret | verifies webhook signatures (comma-separated if several) |

### Notion views
- **По категориям** — board grouped by Category (works like folders), Done only.
- **Все** — all rows, newest first.
- **В работе / ошибки** — New / Processing / Error with the error text.

Each row is a page: Key points, Summary, Post text, Transcript, Slides text.

## Limits
- Time: ~1.5 min runner setup + ~2–3 min per Reel, ~4–5 min per long article (LLM on CPU). One run at a time; ≤15 items / 45 min per run; 20 s pause between Instagram items.
- Partial: when the page was filled but something is missing (video not downloaded, only 1 carousel slide, list gated behind "comment X"), Status = Partial and the reason is in Error and in a "Не получено" section at the top of the page.
- Retries: 3 attempts, then Status = Error with the reason. Setting Status back to New does **not** trigger the webhook (only new rows do) — run the workflow manually or wait for cron.
- Instagram: without login, many posts return "empty media response" (yt-dlp) and only the first carousel image (Cobalt). Fix: log in to Instagram with a separate account, export its cookies and add them to `YTDLP_COOKIES` (Netscape cookies.txt may hold instagram.com and youtube.com together) and to `COBALT_COOKIES`.
- YouTube: needs `YTDLP_COOKIES` (GitHub IPs are bot-checked); cookies expire if the account logs in elsewhere — re-export then.
- LinkedIn: login wall, not supported yet.
- Quality: brand names can be misspelled in transcripts; on-screen text is read by OCR of up to 40 frames, so small or stylised text can still be missed; the LLM reads the first 12 000 chars.
- GitHub cache (~5.6 GB models) is evicted after 7 days without runs → next run downloads again (+ a few minutes).
- Public repo: code and logs are public; logs contain page ids only, never URLs or content.
- Free quotas: GitHub Actions unlimited for public repos; Cloudflare Workers 100k requests/day; Notion API ~3 req/s.

## Operations
- Run now: GitHub → Actions → idea-inbox → Run workflow (optional `url` input adds a link first), or `gh workflow run idea-inbox`.
- Relay logs: `cd relay && npx wrangler tail idea-inbox-relay`.
- Deploy relay: `cd relay && npx wrangler deploy`.
- Renew GitHub token / cookies: create new → `npx wrangler secret put GITHUB_TOKEN` / `gh secret set YTDLP_COOKIES < cookies.txt`.

## Old Instagram Saved
Export: Instagram → Accounts Center → Your information and permissions → Download your information → Saved, JSON. Then:
```bash
NOTION_TOKEN=… NOTION_DATA_SOURCE_ID=4fd5ba03-9001-4bd8-ad00-b42ccc6a0f72 node processor/import-instagram.mjs ~/Downloads/instagram-export
```
Rows are added as New (duplicates skipped) and processed ~15 per run.

## Files
- `processor/index.mjs` — the pipeline (Notion queue → media → transcript/OCR → digest → Notion).
- `processor/import-instagram.mjs` — imports old Saved into the queue.
- `relay/` — Cloudflare Worker: Notion webhook → GitHub workflow_dispatch.
- `.github/workflows/idea-inbox.yml` — the job.
- `docs/ios-shortcut.md` — optional iOS Shortcut that triggers the job directly (not needed with the webhook).
