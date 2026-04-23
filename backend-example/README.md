# Backend Example for AMA Chat

This backend is separate from GitHub Pages and keeps API keys secure.

## Run locally

```bash
npm install
OPENAI_API_KEY=your_key_here npm start
```

Windows PowerShell:

```powershell
$env:OPENAI_API_KEY="your_key_here"
npm start
```

## Important

- Do **not** put API keys in frontend JavaScript.
- Set `CHAT_API_URL` in `assets/ama-chat.js` to your deployed backend URL.
