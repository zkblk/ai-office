# Idea Inbox

Save anything once → searchable knowledge in Notion.

Share a link (Instagram Reel, Threads, YouTube, article, …) to the **Idea Inbox** Notion database. A GitHub Actions job picks it up and fills the same page with author, post text, full transcript, summary, why it is useful, category, tags, tools, people and links.

Acceptance test: https://www.instagram.com/reel/DdryL7zMUOj/

## How it works
```
iPhone Share → Notion (Web Clipper) → "Idea Inbox" database row (Status empty/New)
                                           │  every 15 min
GitHub Actions (free, public repo) ◄───────┘
  ├─ media:      Cobalt (docker, in the job) → yt-dlp fallback
  ├─ metadata:   yt-dlp -J; og tags / page text for articles
  ├─ transcript: parakeet.cpp, Parakeet TDT 0.6B v3 (25 languages incl. en/ru/uk), CPU
  └─ digest:     Ollama (qwen2.5:7b) → title, summary, why useful, category, tags, tools, people, links
        │
        └─► same Notion page: properties + Summary / Post text / Transcript blocks, Status = Done
```
Failures retry up to 3 times, then Status = Error with the reason in the Error property. Set Status back to New to retry.
All components are open source and free; nothing is billed.

## Setup
1. Notion: create an internal integration at https://www.notion.so/my-integrations, copy its token, and add it to the Idea Inbox database (••• → Connections).
2. GitHub repo → Settings → Secrets and variables → Actions:
   - secret `NOTION_TOKEN`
   - optional variables: `SUMMARY_LANGUAGE` (default: Russian), `LLM_MODEL`, `MAX_ITEMS`
   - optional secrets for Instagram login walls: `YTDLP_COOKIES` (Netscape cookies.txt), `COBALT_COOKIES` (Cobalt cookies.json)

YouTube is text-only (title + description, no transcript): it blocks GitHub runner IPs without login cookies.
3. iPhone: Share → Notion → Idea Inbox.

The repo is public, so workflow logs are public: the processor logs page ids only.

## Old Instagram Saved
Export: Instagram → Accounts Center → Your information and permissions → Download your information → Saved, JSON. Then:
```bash
NOTION_TOKEN=… NOTION_DATA_SOURCE_ID=… node processor/import-instagram.mjs ~/Downloads/instagram-export
```
Rows are added as New (duplicates skipped) and processed ~15 per run, 20 s apart.

No secrets belong in this public repository.
