// The page for people who make a map with an AI tool: it shows the prompt with the address of llms.txt of this site.
(function () {
  "use strict";
  const prompt = document.getElementById("prompt");
  if (!prompt || typeof t !== "function") return;
  prompt.textContent = t("ai.prompt", { url: new URL("llms.txt", location.href).href });
})();
