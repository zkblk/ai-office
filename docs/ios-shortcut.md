# iOS Shortcut: Save to Idea Inbox

One tap in the Share Sheet: adds the link to the Notion queue and starts processing right away (result in ~3–5 min).

The Shortcut makes one request: GitHub `workflow_dispatch` with the link as input. The workflow adds the Notion row itself, so the phone only holds a GitHub token.

## Token
GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
- Repository access: Only select repositories → `zkblk/ai-office`
- Permissions → Repository → Actions: **Read and write**
- Expiration: up to 1 year (renew in the Shortcut when it expires)

## Shortcut
1. Shortcuts → + → name it **Save to Idea Inbox**. Details (ⓘ) → turn on **Show in Share Sheet**, types: URLs, Text, Safari web pages. If there is no input: **Get Clipboard**.
2. **Get URLs from** Shortcut Input.
3. **Get First Item from** URLs.
4. **Text**:
   ```
   {"ref":"main","inputs":{"url":"<First Item>"}}
   ```
   (insert the *First Item* variable in place of `<First Item>`)
5. **Get Contents of URL**
   - URL: `https://api.github.com/repos/zkblk/ai-office/actions/workflows/idea-inbox.yml/dispatches`
   - Method: POST
   - Headers: `Authorization` = `Bearer github_pat_…`, `Accept` = `application/vnd.github+json`
   - Request Body: **File** → the *Text* from step 4
6. **Show Notification**: `Saved to Idea Inbox ✓`

A successful call returns an empty response (HTTP 204). An error message in the result means the token is wrong or expired.

Do not share this Shortcut: it contains the token.
