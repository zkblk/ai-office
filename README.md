# Idea Inbox

Cloud-first capture and transcription inbox.

## Goal
Anything → searchable text.

Inputs: Instagram/Threads/video URLs and uploaded video/audio. Every capture preserves the original URL and is designed to store a full transcript, summary, metadata and tags.

## Current milestone
The UI shell and acceptance-test Reel are in place. Next deployment milestone wires Cloudflare Worker + D1 + Workers AI and server-side media extraction.

Acceptance test: https://www.instagram.com/reel/DdryL7zMUOj/

## Local
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```

No secrets belong in this public repository.
