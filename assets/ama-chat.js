// GitHub Pages frontend must NOT contain secret keys.
// Replace this with your deployed backend endpoint.
const CHAT_API_URL = "https://YOUR-BACKEND-DOMAIN/api/chat";

const amaState = {
  open: false,
  sending: false,
  messages: [
    {
      role: "assistant",
      content: "Hey, I’m Julen 👋 Ask me anything about my studies, finance interests, career goals, or mindset."
    }
  ]
};

const amaEl = {
  toggle: document.getElementById("ama-toggle"),
  panel: document.getElementById("ama-panel"),
  close: document.getElementById("ama-close"),
  form: document.getElementById("ama-form"),
  input: document.getElementById("ama-input"),
  send: document.getElementById("ama-send"),
  messages: document.getElementById("ama-messages"),
  typing: document.getElementById("ama-typing")
};

function amaOpen() {
  amaState.open = true;
  amaEl.panel.classList.add("open");
  amaEl.panel.setAttribute("aria-hidden", "false");
  amaEl.toggle.setAttribute("aria-expanded", "true");
  setTimeout(() => amaEl.input.focus(), 120);
}

function amaClose() {
  amaState.open = false;
  amaEl.panel.classList.remove("open");
  amaEl.panel.setAttribute("aria-hidden", "true");
  amaEl.toggle.setAttribute("aria-expanded", "false");
}

function amaAppendMessage(role, text) {
  const node = document.createElement("div");
  node.className = `ama-message ${role === "user" ? "ama-user" : "ama-assistant"}`;
  node.textContent = text;
  amaEl.messages.appendChild(node);
  amaEl.messages.scrollTop = amaEl.messages.scrollHeight;
}

function amaSetTyping(show) {
  amaEl.typing.hidden = !show;
}

function amaSetSending(sending) {
  amaState.sending = sending;
  amaEl.send.disabled = sending;
  amaEl.input.disabled = sending;
}

async function amaFetchReply(messages) {
  const response = await fetch(CHAT_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages })
  });

  if (!response.ok) {
    throw new Error(`Backend error: ${response.status}`);
  }

  const data = await response.json();
  if (!data.reply || typeof data.reply !== "string") {
    throw new Error("Invalid backend response payload.");
  }

  return data.reply;
}

async function amaHandleSubmit(event) {
  event.preventDefault();
  if (amaState.sending) return;

  const value = amaEl.input.value.trim();
  if (!value) return; // Prevent empty message.

  if (!amaState.open) amaOpen();

  amaState.messages.push({ role: "user", content: value });
  amaAppendMessage("user", value);
  amaEl.input.value = "";

  try {
    amaSetSending(true);
    amaSetTyping(true);

    const reply = await amaFetchReply(amaState.messages);
    amaState.messages.push({ role: "assistant", content: reply });
    amaAppendMessage("assistant", reply);
  } catch (error) {
    console.error(error);
    amaAppendMessage(
      "assistant",
      "I couldn’t reply right now. Please try again in a moment."
    );
  } finally {
    amaSetTyping(false);
    amaSetSending(false);
    amaEl.input.focus();
  }
}

amaEl.toggle.addEventListener("click", () => (amaState.open ? amaClose() : amaOpen()));
amaEl.close.addEventListener("click", amaClose);
amaEl.form.addEventListener("submit", amaHandleSubmit);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && amaState.open) amaClose();
});
