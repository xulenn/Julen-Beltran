import express from "express";
import cors from "cors";

const app = express();

// Allow requests from your GitHub Pages domain.
app.use(
  cors({
    origin: [
      "https://YOUR-USERNAME.github.io",
      "https://YOUR-CUSTOM-DOMAIN.com"
    ]
  })
);

app.use(express.json());

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages payload." });
    }

    const systemPrompt = `
You are Julen's website assistant. Write in first person as Julen.
Tone: friendly, personal, concise, confident, natural.
Never say "As an AI".
Context:
- Business/finance student
- Interested in investing and finance
- Looking for finance, banking, and corporate financial roles
- Values discipline, resilience, consistency
- Trains regularly and takes self-improvement seriously
- Wants a personal, modern, professional website feel
If details are unknown, answer honestly and briefly.
`.trim();

    const providerResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content }))
        ]
      })
    });

    if (!providerResponse.ok) {
      const err = await providerResponse.text();
      console.error("Provider error:", err);
      return res.status(502).json({ error: "Model provider request failed." });
    }

    const data = await providerResponse.json();
    const reply =
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      "Thanks for your question.";

    return res.json({ reply });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error." });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`AMA backend running on port ${PORT}`);
});
