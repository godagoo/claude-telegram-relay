function normalizeScreenText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isKnownNonMessagesSurface(text) {
  const normalized = normalizeScreenText(text);
  return /\bgoogle suggestions\b/.test(normalized) ||
    /\btelegram\b/.test(normalized) ||
    /\bwilliam claude code\b/.test(normalized) ||
    /\bsearch actions\b/.test(normalized) ||
    /\bsearch web\b/.test(normalized);
}

function isLikelyMessagesComposeSurface(text) {
  const normalized = normalizeScreenText(text);
  if (!normalized) return false;
  if (isKnownNonMessagesSurface(normalized)) return false;

  return /\bimessage\b/.test(normalized) ||
    /\bnew message\b/.test(normalized) ||
    /\bmessages\b/.test(normalized);
}

module.exports = {
  normalizeScreenText,
  isKnownNonMessagesSurface,
  isLikelyMessagesComposeSurface,
};
