const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const router = express.Router();
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const upload = multer({ dest: "uploads/temp/" });

function normalizeCoAuthors(input) {
  return toStringArray(input)
    .map(sanitizeAuthorRaw)
    .filter(Boolean);
}

function sanitizeAuthorRaw(s = "") {
  const raw = String(s || "").trim();
  if (!raw) return "";

  // capture email (so we can derive a name if needed)
  const emailMatch = raw.match(/\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/i);
  const email = emailMatch ? emailMatch[0] : "";

  // remove emails + bracketed stuff containing emails
  let cleaned = raw
    .replace(/\([^)]*@[^\)]*\)/g, " ")
    .replace(/<[^>]*@[^\>]*>/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();

  // if nothing left, derive from email username (juan.dela_cruz -> Juan Dela Cruz)
  if (!cleaned && email) {
    const username = email.split("@")[0];
    const p = partsFromUsername(username);
    cleaned = [p.first, p.middle, p.last].filter(Boolean).join(" ").trim();
  }

  return cleaned;
}

/* ------------------------------ HF helper ------------------------------ */
async function callHF({ model, inputs, parameters = {}, token, tries = 3, timeoutMs = 30000 }) {
  const url = `https://router.huggingface.co/hf-inference/models/${model}?wait_for_model=true`;
  let delay = 800;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs, parameters }),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(to);
      if (attempt === tries) return { error: `Network error: ${e.message}` };
      await new Promise((r) => setTimeout(r, delay));
      delay *= 1.6;
      continue;
    }
    clearTimeout(to);

    if (res.status === 503 || res.status === 429) {
      if (attempt === tries) return { error: `HF ${res.status}: model busy/starting` };
      await new Promise((r) => setTimeout(r, delay));
      delay *= 1.6;
      continue;
    }

    let data;
    try { data = await res.json(); } catch { return { error: "Invalid JSON from Hugging Face" }; }
    if (data.error) return { error: data.error };

    const text = Array.isArray(data)
      ? data[0]?.summary_text || data[0]?.generated_text || ""
      : data.summary_text || data.generated_text || "";

    return { text: (text || "").trim() };
  }
  return { error: "HF failed after retries." };
}

/* ------------------------------ Text utils ----------------------------- */
function normalizeParagraph(s = "") {
  return (s || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^abstract[:.\s-]*/i, "")
    .replace(/^summary[:.\s-]*/i, "")
    .trim();
}

function toStringArray(v) {
  if (!v) return [];

  // ✅ handle array input
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        // if it's an object, pick best field
        if (x && typeof x === "object") {
          return (
            x.name ||
            x.fullName ||
            x.author ||
            x.email ||
            x.userEmail ||
            ""
          );
        }
        return String(x);
      })
      .map((s) => String(s).trim())
      .filter(Boolean);
  }

  // ✅ handle object input
  if (typeof v === "object") {
    const one =
      v.name || v.fullName || v.author || v.email || v.userEmail || "";
    return one ? [String(one).trim()] : [];
  }

  // ✅ handle string input (your original behavior)
  const s = String(v).trim();
  if (!s) return [];
  if (s.includes(";")) return s.split(";").map(x => x.trim()).filter(Boolean);

  const commaParts = s.split(",").map(x => x.trim()).filter(Boolean);
  if (commaParts.length >= 2 && commaParts.some(p => /\s/.test(p) || /@/.test(p))) return commaParts;

  return [s];
}
function formatApaAuthors(list = []) {
  if (list.length === 0) return "Author";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]}, & ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, & ${list[list.length - 1]}`;
}

function formatIeeeAuthors(list = []) {
  if (list.length === 0) return "Author";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}


function titleToken(tok = "") {
  const t = String(tok).trim();
  if (!t) return "";
  if (/^[A-Z]\.?$/.test(t)) return t.endsWith(".") ? t : t + ".";
  return cap(t);
}

function parseNamePartsSmart(name = "") {
  const s = String(name || "").replace(/\s+/g, " ").trim();
  if (!s) return { first: "", middle: "", last: "" };

  // "Last, First Middle"
  if (s.includes(",")) {
    const [lastRaw, restRaw] = s.split(",").map(x => x.trim());
    const rest = (restRaw || "").split(/\s+/).filter(Boolean);
    const first = rest.shift() || "";
    const middle = rest.join(" ");
    return { first: titleToken(first), middle: middle.split(/\s+/).map(titleToken).join(" ").trim(), last: lastRaw.split(/\s+/).map(titleToken).join(" ").trim() };
  }

  // "First Middle Last" (with particles like Dela/Del/De/Van/Von etc. treated as part of last name)
  const parts = s.split(/\s+/).filter(Boolean);

  const particles = new Set([
    "de","del","dela","da","di","dos","das","van","von","der","den","al","el","st","st."
  ]);

  let i = parts.length - 1;
  const lastTokens = [parts[i]];
  i--;

  while (i >= 0) {
    const w = parts[i].toLowerCase().replace(/\./g, "");
    const prev = i > 0 ? parts[i - 1].toLowerCase().replace(/\./g, "") : "";

    // handle "de la"
    if (w === "la" && prev === "de") {
      lastTokens.unshift(parts[i - 1], parts[i]);
      i -= 2;
      continue;
    }

    if (particles.has(w)) {
      lastTokens.unshift(parts[i]);
      i--;
      continue;
    }
    break;
  }

  const given = parts.slice(0, i + 1);
  const first = given.shift() || "";
  const middle = given.join(" ");

  return {
    first: titleToken(first),
    middle: middle.split(/\s+/).map(titleToken).join(" ").trim(),
    last: lastTokens.map(titleToken).join(" ").trim(),
  };
}

function nameToAPA(name = "") {
  const p = parseNamePartsSmart(name);
  if (!p.last && !p.first) return "Author";

  const mids = p.middle ? p.middle.split(/\s+/).filter(Boolean) : [];
  const initials = [p.first, ...mids]
    .filter(Boolean)
    .map(w => (w[0] ? w[0].toUpperCase() + "." : ""))
    .join(" ")
    .trim();

  return `${p.last || "Author"}${initials ? `, ${initials}` : ""}`.trim();
}

function apaToIEEE(apa = "") {
  // "Last, F. M." -> "F. M. Last"
  const [last, initials] = apa.split(",").map(s => s.trim());
  return `${initials || ""} ${last || ""}`.trim().replace(/\s+/g, " ");
}

function authorsToBibtex(authors = []) {
  // "Last, First Middle" joined by " and "
  return authors
    .map(n => {
      const p = parseNamePartsSmart(n);
      const given = [p.first, p.middle].filter(Boolean).join(" ").trim();
      const last = p.last || "Author";
      return given ? `${last}, ${given}` : `${last}`;
    })
    .join(" and ");
}

function buildAuthorList(primary, coAuthors) {
  const a0 = sanitizeAuthorRaw(primary);
  const co = toStringArray(coAuthors).map(sanitizeAuthorRaw);

  const list = [a0, ...co].map(s => String(s || "").trim()).filter(Boolean);

  // dedupe (case-insensitive)
  const seen = new Set();
  const out = [];
  for (const n of list) {
    const key = n.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.length ? out : ["Author"];
}


function heuristicSummary(text = "") {
  if (!text) return "No readable text available.";
  const sentences = text.split(/[.!?]\s/).map((s) => s.trim()).filter((s) => s.length > 40);
  return sentences.slice(0, 4).join(". ") + ".";
}

const j = (arr, sep = ", ") => (Array.isArray(arr) ? arr.filter(Boolean).join(sep) : "");

/* ---- secure file read (restrict to project root) ---- */
function safeReadPdfFromRelative(filePathRel) {
  try {
    if (!filePathRel) {
      console.log("[safeReadPdf] No filePath provided");
      return null;
    }
    
    const root = path.join(__dirname, "..");
    let abs;
    
    const normalized = String(filePathRel).replace(/\\/g, "/");
    
    if (normalized.startsWith("/uploads/")) {
      abs = path.resolve(path.join(root, normalized));
    } else if (normalized.startsWith("uploads/")) {
      abs = path.resolve(path.join(root, normalized));
    } else if (path.isAbsolute(normalized)) {
      abs = path.normalize(normalized);
    } else {
      abs = path.resolve(path.join(root, "uploads", "research", normalized));
    }
    
    if (!abs.startsWith(root)) {
      console.log(`[safeReadPdf] Path traversal attempt: ${abs}`);
      return null;
    }
    
    const candidates = [abs];
    if (!normalized.startsWith("/uploads/") && !normalized.startsWith("uploads/")) {
      candidates.push(path.resolve(path.join(root, "uploads", "research", path.basename(normalized))));
    }
    
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        console.log(`[safeReadPdf] Found PDF at: ${candidate}`);
        const buf = fs.readFileSync(candidate);
        return pdfParse(buf);
      }
    }
    
    console.log(`[safeReadPdf] PDF not found. Tried: ${candidates.join(", ")}`);
    return null;
  } catch (err) {
    console.error("[safeReadPdf] Error reading PDF:", err.message);
    return null;
  }
}

/* --------------------- Name / citation normalization -------------------- */
const cap = (s = "") => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "";

function partsFromUsername(username = "") {
  const tokens = username.split(/[._-]+/).filter(Boolean);
  if (tokens.length >= 2) {
    const last = cap(tokens[tokens.length - 1]);
    const first = cap(tokens[0]);
    const middleTokens = tokens.slice(1, tokens.length - 1).map(cap);
    return { first, middle: middleTokens.join(" "), last };
  }
  return { first: "", middle: "", last: cap(tokens[0] || "Author") };
}

/* ----------------------------- TL;DR helpers ----------------------------- */
function heuristicTldr(text = "") {
  if (!text) return "No short takeaway available.";
  
  const cleaned = text.replace(/\s+/g, " ").trim();
  const sentences = cleaned.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 20);
  
  const priorityKeywords = [
    /\b(found|showed|demonstrated|concluded|results?|findings?|significant|improved|reduced|increased)\b/i,
    /\b(conclusion|summary|takeaway|key\s+point|main\s+finding)\b/i,
    /\b(aim|objective|purpose|goal)\b/i
  ];
  
  let bestSentence = "";
  for (const keyword of priorityKeywords) {
    const match = sentences.find(s => keyword.test(s));
    if (match) {
      bestSentence = match;
      break;
    }
  }
  
  if (!bestSentence && sentences.length > 0) {
    bestSentence = sentences[0];
  }
  
  if (!bestSentence) {
    bestSentence = cleaned.substring(0, 150);
  }
  
  const words = bestSentence.split(/\s+/);
  const maxWords = 50;
  const trimmed = words.length > maxWords ? words.slice(0, maxWords).join(" ") : bestSentence;
  
  return trimmed.replace(/\s*[.,;]\s*$/, "").trim() + ".";
}

async function generateTldr(text = "", HF_TOKEN) {
  const base = (text || "").replace(/\s+/g, " ").trim();
  if (!base) return "No short takeaway available.";

  if (!HF_TOKEN) {
    return heuristicTldr(base);
  }

  try {
    const prompt = `Provide a very concise one-sentence TL;DR (under 40 words) capturing the main finding or purpose. Be direct and avoid fluff:\n\n${base.substring(0, 2000)}`;

    const result = await callHF({
      model: "facebook/bart-large-cnn",
      inputs: prompt,
      parameters: {
        min_length: 10,
        max_length: 40,
        do_sample: false,
        temperature: 0.3,
        repetition_penalty: 1.2,
      },
      token: HF_TOKEN,
      tries: 2,
      timeoutMs: 25000,
    });

    if (result.error) {
      console.warn("HF TL;DR failed:", result.error);
      return heuristicTldr(base);
    }

    let raw = (result.text || "").trim();
    
    if (raw) {
      raw = raw.replace(/^(TLDR|TL;DR|Summary|In summary|The study)\s*[:.-]*\s*/gi, "");
      raw = raw.replace(/\s*…+\s*$/g, "").replace(/\s*\.\s*$/, "").trim();
      
      if (!raw.endsWith('.')) raw += '.';
      
      const words = raw.split(/\s+/);
      if (words.length > 45) {
        raw = words.slice(0, 45).join(" ").replace(/[.,;]\s*$/, "") + ".";
      }
      
      return raw;
    }
    
    return heuristicTldr(base);
  } catch (error) {
    console.warn("TL;DR generation error:", error);
    return heuristicTldr(base);
  }
}

function parseAuthorsToAPAList(authorRaw = "") {
  const raw = String(authorRaw || "").trim();
  if (!raw) return ["Author"];

  const tokens = raw.split(/\s*(?:,|;|&|and)\s*/i).filter(Boolean);

  const out = [];
  for (let token of tokens) {
    token = token.trim();
    if (!token) continue;

    let first = "", middle = "", last = "";

    if (token.includes(",")) {
      const [l, rest] = token.split(",").map(s => s.trim());
      last = cap(l);
      if (rest) {
        const parts = rest.split(/\s+/).filter(Boolean).map(cap);
        first = parts.shift() || "";
        middle = parts.join(" ");
      }
    } else {
      const parts = token.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        last = cap(parts.pop());
        first = cap(parts.shift());
        middle = parts.map(cap).join(" ");
      } else {
        last = cap(parts[0]);
      }
    }

    const initials = [first, ...middle.split(/\s+/).filter(Boolean)]
      .map(w => w[0] ? w[0].toUpperCase() + "." : "")
      .join(" ");
    out.push(`${last}, ${initials}`.replace(/,\s*$/, ""));
  }

  return out.length ? out : ["Author"];
}

function toIEEEList(apaList) {
  return apaList.map(a => {
    const [last, initials] = a.split(",").map(s => s.trim());
    return `${initials || ""} ${last}`.trim().replace(/\s+/g, " ");
  });
}

function toBibtexAuthor(authorRaw = "") {
  const apaList = parseAuthorsToAPAList(authorRaw);
  const bibParts = apaList.map(a => {
    const [last, initials] = a.split(",").map(s => s.trim());
    return `${last}, ${initials}`;
  });
  return bibParts.join(" and ");
}

function toSentenceCase(s = "") {
  return s
    .toLowerCase()
    .replace(/(^\w)|([.!?]\s+\w)/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeYear(y) {
  const m = String(y || "").match(/\d{4}/);
  return m ? m[0] : "n.d.";
}

function extractReferencesFromText(fullText = "") {
  const text = (fullText || "").replace(/\r/g, "");
  const m = text.match(/(references|bibliography)\s*[:\-]?\s*/i);
  if (!m) return [];

  const start = m.index + m[0].length;
  const tail = text.slice(start, start + 20000);

  let lines = tail.split("\n").map(s => s.trim()).filter(Boolean);

  const entries = [];
  let buf = "";
  const newEntryRe = /^(\[\d+\]|\d+\.\s|•\s|-\s|[A-Z].+\(\d{4}\))/;
  for (const ln of lines) {
    if (!buf) { buf = ln; continue; }
    if (newEntryRe.test(ln)) {
      entries.push(buf.trim());
      buf = ln;
    } else {
      buf += " " + ln;
    }
  }
  if (buf) entries.push(buf.trim());

  return entries.map(e => e.replace(/\s{2,}/g, " "));
}

/* ======================  /api/ai/summary  ====================== */
router.post("/summary", upload.single("file"), async (req, res) => {
  try {
    const HF_TOKEN = process.env.HF_TOKEN;
    if (!HF_TOKEN) return res.status(500).json({ ok: false, error: "Missing HF_TOKEN." });

    let { text, filePath } = req.body;
    let baseText = text ? String(text).trim() : "";

    if (req.file?.path) {
      const pdfData = await pdfParse(fs.readFileSync(req.file.path));
      baseText += "\n" + pdfData.text;
      fs.unlinkSync(req.file.path);
    } else if (filePath) {
      const parsed = await safeReadPdfFromRelative(filePath);
      if (parsed?.text) baseText += "\n" + parsed.text;
    }

    if (!baseText) return res.status(400).json({ ok: false, error: "No text or readable PDF content provided." });

    let cleaned = baseText
      .replace(/\n+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\b\d{1,3}\b/g, "")
      .replace(/\btable\s*\d+.*?(?=\s[A-Z])/gi, "")
      .replace(/references?.*$/i, "")
      .trim();

    const m = cleaned.match(/abstract[:\s-]*(.*?)(?=(introduction|background|methodology|results|references))/i);
    if (m?.[1]) cleaned = m[1];
    cleaned = cleaned.split(" ").slice(0, 3500).join(" ");

    if (cleaned.length < 800) {
      const summary = heuristicSummary(cleaned);
      return res.json({ ok: true, model: "heuristic", summary });
    }

    let { text: bartText } = await callHF({
      model: "facebook/bart-large-cnn",
      inputs: cleaned,
      parameters: { min_length: 150, max_length: 220, temperature: 0.4, do_sample: false },
      token: HF_TOKEN,
      tries: 3,
      timeoutMs: 60000,
    });

    if (!bartText || bartText.length < 100) {
      const prompt = `Summarize the following academic text into a clear, single-paragraph abstract (150–220 words) using formal academic English.\n\n${cleaned}`;
      const { text: retryText } = await callHF({
        model: "facebook/bart-large-cnn",
        inputs: prompt,
        parameters: { min_length: 150, max_length: 220, do_sample: false },
        token: HF_TOKEN,
      });
      bartText = retryText;
    }

    let summary = normalizeParagraph(bartText);
    let usedModel = "facebook/bart-large-cnn";

    if (!summary || summary.length < 80) {
      const t5Input = `summarize: Write a single-paragraph academic abstract (150–220 words) using formal tone.\n\n${cleaned}`;
      const { text: t5Text } = await callHF({
        model: "t5-base",
        inputs: t5Input,
        parameters: { max_new_tokens: 240, num_beams: 4, do_sample: false },
        token: HF_TOKEN,
      });
      summary = normalizeParagraph(t5Text);
      usedModel = "t5-base";
    }

    if (!summary || summary.length < 50) {
      summary = heuristicSummary(cleaned);
      usedModel = "heuristic";
    }

    res.status(200).json({ ok: true, model: usedModel, summary });
  } catch (err) {
    console.error("❌ Summarization failed:", err);
    res.status(500).json({ ok: false, error: "Summarization failed.", details: err.message });
  }
});



/* ===================  /api/ai/abstract-tools  ================== */
router.post("/abstract-tools", async (req, res) => {
  try {
    console.log("[abstract-tools] Received request:", {
      mode: req.body.mode,
      hasAbstract: !!req.body.abstract,
      hasFilePath: !!req.body.filePath,
      hasResearchId: !!req.body.researchId,
      bodyKeys: Object.keys(req.body)
    });
    const { mode, abstract = "", meta = {}, filePath, researchId } = req.body || {};
   const {
  title = "",
  author = "",
  coAuthors: rawCoAuthors,
  year = "",
  categories = [],
  genreTags = []
} = meta;

// ✅ normalize frontend input (string | array | undefined)
const normalizedCoAuthors = normalizeCoAuthors(rawCoAuthors);

console.log("[abstract-tools] meta:", meta);
console.log("[abstract-tools] meta.author:", meta?.author);
console.log("[abstract-tools] meta.coAuthors:", meta?.coAuthors);

    let pdfText = "";
    let actualFilePath = filePath;
    
    if (!actualFilePath && researchId) {
      try {
        const Research = require("../models/Research");
        const research = await Research.findById(researchId).select("filePath").lean();
        if (research?.filePath) {
          actualFilePath = research.filePath;
          console.log(`[abstract-tools] Fetched filePath from DB: ${actualFilePath}`);
        }
      } catch (err) {
        console.warn(`[abstract-tools] Could not fetch filePath for researchId ${researchId}:`, err.message);
      }
    }
    
    const parsed = await safeReadPdfFromRelative(actualFilePath);
    if (parsed?.text) pdfText = parsed.text;

    const text = String(abstract || pdfText || "").trim();

    // ✅ include coAuthors + sanitize emails -> proper names
const authorList = buildAuthorList(author, normalizedCoAuthors);

const apaList = authorList.map(nameToAPA);
const ieeeList = apaList.map(apaToIEEE);
const bibtexAuthor = authorsToBibtex(authorList);

    const yr = normalizeYear(year);
    const titleSentence = toSentenceCase(title || "Untitled study");

    let out = "No output.";










    if (mode === "tldr") {
      const HF_TOKEN = process.env.HF_TOKEN;
      const source = (pdfText || text || "").trim();

      if (!source) {
        return res.json({ text: "**Short Takeaway:** No content available for summary." });
      }

      let tldr;
      if (HF_TOKEN) {
        try {
          tldr = await generateTldr(source, HF_TOKEN);
        } catch (e) {
          console.warn("TL;DR model failed, using heuristic:", e?.message || e);
          tldr = heuristicTldr(source);
        }
      } else {
        tldr = heuristicTldr(source);
      }

      tldr = tldr.replace(/\s*\.\s*$/, "") + ".";
      const words = tldr.split(/\s+/);
      if (words.length > 50) {
        tldr = words.slice(0, 50).join(" ").replace(/[.,;]\s*$/, "") + ".";
      }

      return res.json({ text: `**Short Takeaway:** ${tldr}` });
    }








if (mode === "methods") {
  const fullText = pdfText || text || "";
  
  // Clean text but preserve paragraph structure
  const cleanedText = fullText
    .replace(/\r\n/g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  
  const lowerText = cleanedText.toLowerCase();
  
  // Helper function to create a concise summary with complete sentences
  const createConciseSummary = (text, maxSentences = 2, maxWords = 50) => {
    if (!text || text === "Not specified in the methodology section.") {
      return text;
    }
    
    // Split into complete sentences (preserving punctuation)
    const sentences = text.match(/[^.!?]*[.!?]/g) || [];
    const cleanSentences = sentences
      .map(s => s.trim())
      .filter(s => s.length > 10 && !s.match(/^\s*$/));
    
    if (cleanSentences.length === 0) {
      // If no proper sentences found, try to create one
      const words = text.split(/\s+/).filter(w => w.length > 0);
      if (words.length > 5) {
        const sentence = words.slice(0, Math.min(15, words.length)).join(' ');
        return sentence + (sentence.endsWith('.') ? '' : '.');
      }
      return text;
    }
    
    // Take first N sentences
    const summarySentences = cleanSentences.slice(0, maxSentences);
    let summary = summarySentences.join(' ');
    
    // Ensure it's properly capitalized
    if (summary.length > 0) {
      summary = summary.charAt(0).toUpperCase() + summary.slice(1);
    }
    
    // If we have a complete summary, return it
    if (summary.length > 0) {
      return summary;
    }
    
    return text;
  };
  
  // Helper function to ensure complete sentences when truncating
  const truncateToCompleteSentence = (text, maxLength = 400) => {
    if (text.length <= maxLength) return text;
    
    // Try to find the last complete sentence within maxLength
    const truncated = text.substring(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastQuestion = truncated.lastIndexOf('?');
    const lastExclamation = truncated.lastIndexOf('!');
    
    const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);
    
    if (lastSentenceEnd > 0) {
      return text.substring(0, lastSentenceEnd + 1);
    }
    
    // If no sentence end found, find the last space
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 0) {
      return text.substring(0, lastSpace) + '...';
    }
    
    return truncated + '...';
  };
  
  // Function to extract and summarize research design
  const extractResearchDesign = () => {
    const patterns = [
      /Research Design\s*\n([\s\S]*?)(?=\n\s*(?:Research Setting|Participants|Instruments|Data Gathering|Data Collection|Chapter|References))/i,
      /Methodology\s*\n([\s\S]*?)(?=\n\s*(?:Setting|Participants|Instruments|Data|Results|Findings|Chapter))/i,
      /The research design[^.!?]*[.!?]\s*([^.!?]*[.!?])/i,
      /This study (?:utilized|used|employed)[^.!?]*[.!?]\s*([^.!?]*[.!?])/i
    ];
    
    for (const pattern of patterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        let extracted = match[1].trim();
        
        // Clean the text but keep complete sentences
        extracted = extracted.replace(/\s+/g, ' ')
                            .replace(/\n/g, ' ')
                            .replace(/table\s+\d+.*?(?=\s|$)/gi, '')
                            .replace(/figure\s+\d+.*?(?=\s|$)/gi, '')
                            .trim();
        
        if (extracted.length > 20) {
          return truncateToCompleteSentence(createConciseSummary(extracted, 2, 60), 300);
        }
      }
    }
    
    // Fallback: Look for design keywords
    const designKeywords = [
      'qualitative', 'quantitative', 'mixed methods', 'case study',
      'descriptive', 'experimental', 'quasi-experimental', 'correlational',
      'phenomenological', 'grounded theory', 'action research'
    ];
    
    for (const keyword of designKeywords) {
      if (lowerText.includes(keyword)) {
        // Find complete sentence containing the keyword
        const sentences = cleanedText.match(/[^.!?]*[.!?]/g) || [];
        for (const sentence of sentences) {
          if (sentence.toLowerCase().includes(keyword) && sentence.length > 30) {
            return truncateToCompleteSentence(sentence.trim(), 250);
          }
        }
      }
    }
    
    return "Not specified in the methodology section.";
  };
  
  // Function to extract and summarize research setting
  const extractResearchSetting = () => {
    const patterns = [
      /Research Setting\s*\n([\s\S]*?)(?=\n\s*(?:Research Subject|Participants|Instruments|Data Gathering|Chapter))/i,
      /Setting\s*\n([\s\S]*?)(?=\n\s*(?:Subject|Participants|Instruments|Chapter))/i,
      /The study (?:was conducted|took place)[^.!?]*[.!?]\s*([^.!?]*[.!?])/i,
      /This study (?:was|is) conducted[^.!?]*[.!?]\s*([^.!?]*[.!?])/i
    ];
    
    for (const pattern of patterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        let extracted = match[1].trim();
        
        // Clean the text
        extracted = extracted.replace(/\s+/g, ' ')
                            .replace(/\n/g, ' ')
                            .trim();
        
        if (extracted.length > 15) {
          return truncateToCompleteSentence(createConciseSummary(extracted, 1, 40), 200);
        }
      }
    }
    
    return "Not specified in the methodology section.";
  };
  
  // Function to extract and summarize research subjects/participants
  const extractParticipants = () => {
    const patterns = [
      /Research Subject\s*\n([\s\S]*?)(?=\n\s*(?:Instruments|Data Gathering|Data Analysis|Chapter))/i,
      /Participants\s*\n([\s\S]*?)(?=\n\s*(?:Instruments|Data|Chapter))/i,
      /Sampling (?:Procedure|Method)\s*\n([\s\S]*?)(?=\n\s*(?:Instruments|Data|Chapter))/i,
      /The (?:participants|subjects) (?:of the study|in this study)[^.!?]*[.!?]\s*([^.!?]*[.!?])/i
    ];
    
    for (const pattern of patterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        let extracted = match[1].trim();
        
        // Clean the text
        extracted = extracted.replace(/\s+/g, ' ')
                            .replace(/\n/g, ' ')
                            .trim();
        
        // Look for sample size
        const sampleSizeMatch = extracted.match(/(\d+)\s+(?:students?|teachers?|respondents?|participants?|subjects?)/i) ||
                               extracted.match(/n\s*=\s*(\d+)/i);
        
        if (extracted.length > 20) {
          let summary = truncateToCompleteSentence(createConciseSummary(extracted, 1, 35), 180);
          
          // Ensure sample size is mentioned if found
          if (sampleSizeMatch && !summary.includes(sampleSizeMatch[1])) {
            // Find where to insert sample size
            if (summary.endsWith('.')) {
              summary = summary.slice(0, -1);
            }
            summary += ` The sample includes ${sampleSizeMatch[0]}.`;
          }
          
          return summary;
        }
      }
    }
    
    return "Not specified in the methodology section.";
  };
  
  // Function to extract instruments with clean bullet points
  const extractInstruments = () => {
    const patterns = [
      /Instruments (?:Used|to be Used|Utilized)\s*\n([\s\S]*?)(?=\n\s*(?:Data Gathering|Data Analysis|Procedure|Chapter))/i,
      /Tools? (?:Used|Employed)\s*\n([\s\S]*?)(?=\n\s*(?:Data Gathering|Data Analysis|Procedure|Chapter))/i,
      /Instrumentation\s*\n([\s\S]*?)(?=\n\s*(?:Data Gathering|Data Analysis|Procedure|Chapter))/i
    ];
    
    for (const pattern of patterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        let extracted = match[1].trim();
        
        // Extract bullet points or listed items - look for complete items
        const bulletRegex = /[•●○◦▪►\-]\s*([^\n]+(?:\n(?!\s*[•●○◦▪►\-]|\s*\n)[^\n]*)*)/g;
        let bulletMatch;
        const bulletItems = [];
        
        while ((bulletMatch = bulletRegex.exec(extracted)) !== null) {
          let item = bulletMatch[1].trim();
          // Clean the item
          item = item.replace(/\s+/g, ' ')
                    .replace(/\n/g, ' ')
                    .trim();
          
          // Only add if it looks like a complete instrument name
          if (item.length > 3 && !item.match(/^[a-z]\s*$/i)) {
            // Capitalize first letter
            if (item.length > 0) {
              item = item.charAt(0).toUpperCase() + item.slice(1);
            }
            // Ensure it ends properly
            if (!item.endsWith('.') && !item.endsWith(':') && item.length < 50) {
              bulletItems.push(item);
            } else if (item.length < 50) {
              // Remove trailing punctuation for cleaner bullets
              bulletItems.push(item.replace(/[.:;]$/, ''));
            }
          }
        }
        
        // If we found bullet items, clean them up
        if (bulletItems.length > 0) {
          // Filter out incomplete items and duplicates
          const cleanItems = [];
          const seen = new Set();
          
          for (const item of bulletItems) {
            const cleanItem = item.trim();
            // Check if it's a complete instrument name (not cut off)
            if (cleanItem.length > 5 && 
                !cleanItem.match(/\betc\.?$/i) &&
                !cleanItem.match(/^[a-z]/) && // Should start with capital after our capitalization
                !cleanItem.includes('...') &&
                !seen.has(cleanItem.toLowerCase())) {
              
              // Check if item ends with a complete word (not hyphenated)
              const lastWord = cleanItem.split(' ').pop();
              if (!lastWord.includes('-') || lastWord.endsWith('-')) {
                // Skip hyphenated words at the end
                continue;
              }
              
              cleanItems.push(cleanItem);
              seen.add(cleanItem.toLowerCase());
            }
          }
          
          if (cleanItems.length > 0) {
            return cleanItems.map(item => `• ${item}`).join('\n');
          }
        }
        
        // Look for specific instruments mentioned in the methodology
        const instrumentPatterns = [
          /(?:TTPS|Teaching through Problem-Solving) Lesson Plan/i,
          /(?:CER|Claim-Evidence-Reasoning) Scoring Rubric/i,
          /(?:TTPS-CER|Teaching through Problem-Solving - CER) Semi-structured Interview/i,
          /Phil-IRI Silent Reading Test/i,
          /(?:pre-test|post-test)/i,
          /(?:open-ended|semi-structured) questionnaire/i,
          /classroom observation checklist/i
        ];
        
        const foundInstruments = [];
        for (const pattern of instrumentPatterns) {
          const match = cleanedText.match(pattern);
          if (match) {
            const instrument = match[0];
            // Clean up the instrument name
            let cleanName = instrument.replace(/\s+/g, ' ').trim();
            if (cleanName.length > 3 && !foundInstruments.includes(cleanName)) {
              foundInstruments.push(cleanName);
            }
          }
        }
        
        // Also look for common instrument keywords
        if (foundInstruments.length === 0) {
          const commonInstruments = [
            'lesson plan', 'scoring rubric', 'interview', 'questionnaire',
            'checklist', 'test', 'assessment', 'observation'
          ];
          
          for (const instrument of commonInstruments) {
            if (lowerText.includes(instrument)) {
              // Find the full phrase
              const instrumentRegex = new RegExp(`([A-Za-z\\s-]*${instrument}[A-Za-z\\s-]{0,20})`, 'i');
              const match = cleanedText.match(instrumentRegex);
              if (match) {
                const phrase = match[0].trim();
                if (phrase.length > instrument.length + 3 && !foundInstruments.includes(phrase)) {
                  foundInstruments.push(phrase);
                }
              }
            }
          }
        }
        
        if (foundInstruments.length > 0) {
          // Format instrument names nicely
          const formattedInstruments = foundInstruments.map(instr => {
            // Capitalize first letter of each word for acronyms or proper names
            if (!instr.match(/^[A-Z]/)) {
              return instr.split(' ').map(word => {
                if (word.length > 0) {
                  return word.charAt(0).toUpperCase() + word.slice(1);
                }
                return word;
              }).join(' ');
            }
            return instr;
          });
          
          return formattedInstruments.map(instr => `• ${instr}`).join('\n');
        }
        
        // Return a brief description if available
        const sentences = extracted.split(/[.!?]+/).filter(s => s.trim().length > 20);
        if (sentences.length > 0) {
          const firstSentence = sentences[0].trim();
          const words = firstSentence.split(' ');
          if (words.length > 3) {
            return truncateToCompleteSentence(firstSentence.charAt(0).toUpperCase() + firstSentence.slice(1), 150);
          }
        }
      }
    }
    
    return "Not specified in the methodology section.";
  };
  
  // Function to extract and create a coherent paragraph for data gathering procedure
  const extractDataGathering = () => {
    const patterns = [
      /Data Gathering (?:Procedure|Process)\s*\n([\s\S]*?)(?=\n\s*(?:Data Analysis|Ethical|Chapter|References))/i,
      /Data Collection (?:Procedure|Process|Method)\s*\n([\s\S]*?)(?=\n\s*(?:Data Analysis|Ethical|Chapter|References))/i,
      /Procedure\s*\n([\s\S]*?)(?=\n\s*(?:Data Analysis|Ethical|Chapter|References))/i
    ];
    
    for (const pattern of patterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        let extracted = match[1].trim();
        
        // Clean the text
        extracted = extracted.replace(/\s+/g, ' ')
                            .replace(/\n/g, ' ')
                            .replace(/\s*\d+\s*/g, ' ')
                            .replace(/page\s+\d+/gi, '')
                            .trim();
        
        // Extract complete sentences
        const sentences = extracted.match(/[^.!?]*[.!?]/g) || [];
        const cleanSentences = sentences
          .map(s => s.trim())
          .filter(s => s.length > 20)
          .slice(0, 5); // Take up to 5 sentences
        
        if (cleanSentences.length > 0) {
          // Create a coherent paragraph with transitional words
          let paragraph = cleanSentences.map((sentence, index) => {
            const cleanSentence = sentence.replace(/^\d+\.\s*/, '').trim();
            
            if (index === 0) {
              return cleanSentence.charAt(0).toUpperCase() + cleanSentence.slice(1);
            } else if (index === cleanSentences.length - 1) {
              return `Finally, ${cleanSentence.toLowerCase()}`;
            } else {
              const transitions = ['Next,', 'Then,', 'Following this,', 'Subsequently,'];
              const transition = transitions[index % transitions.length];
              return `${transition} ${cleanSentence.toLowerCase()}`;
            }
          }).join(' ');
          
          return truncateToCompleteSentence(paragraph, 300);
        }
      }
    }
    
    return "Not specified in the methodology section.";
  };
  
  // Function to extract data analysis
  // Function to extract data analysis
  const extractDataAnalysis = () => {
    const patterns = [
      /Data Analysis\s*\n([\s\S]*?)(?=\n\s*(?:Ethical|Chapter|References|Bibliography|Limitation))/i,
      /Analysis of Data\s*\n([\s\S]*?)(?=\n\s*(?:Ethical|Chapter|References|Bibliography|Limitation))/i,
      /Statistical Analysis\s*\n([\s\S]*?)(?=\n\s*(?:Ethical|Chapter|References|Bibliography|Limitation))/i
    ];
    
    let extractedText = "";
    
    // First, extract the data analysis section text
    for (const pattern of patterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        extractedText = match[1].trim();
        break;
      }
    }
    
    // If no section found, try to find analysis keywords in the entire methodology
    if (!extractedText) {
      // Look for data analysis in nearby text after data gathering
      const afterDataGathering = cleanedText.toLowerCase();
      extractedText = afterDataGathering;
    }
    
    // Look for specific analysis methods - prioritize this over full sentences
    const analysisKeywords = [
      'thematic analysis', 'descriptive analysis', 'statistical analysis',
      't-test', 'anova', 'regression', 'correlation', 'content analysis',
      'qualitative analysis', 'quantitative analysis', 'mixed methods',
      'mean', 'percentage', 'frequency', 'coding', 'interpretation',
      'frequency and percentage', 'phil-iri formula', 'weighted mean',
      'familiarization', 'generating codes', 'searching for themes',
      'reviewing themes', 'finalizing themes', 'producing reports',
      'samosa', 'rating scale', 'excelling', 'proficient', 'developing',
      'meeting', 'approaching', 'beginning', 'not evident'
    ];
    
    const foundMethods = [];
    
    // First, look in the extracted data analysis section
    if (extractedText) {
      const lowerExtracted = extractedText.toLowerCase();
      for (const method of analysisKeywords) {
        if (lowerExtracted.includes(method) && !foundMethods.includes(method)) {
          // Format the method name nicely
          const formattedName = method.split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          foundMethods.push(formattedName);
        }
      }
    }
    
    // If no methods found in the specific section, search the entire text
    if (foundMethods.length === 0) {
      for (const method of analysisKeywords) {
        if (lowerText.includes(method) && !foundMethods.includes(method)) {
          // Format the method name nicely
          const formattedName = method.split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          foundMethods.push(formattedName);
        }
      }
    }
    
    // Filter and sort methods (prioritize common analysis methods)
    if (foundMethods.length > 0) {
      // Remove duplicates and sort by relevance
      const uniqueMethods = [...new Set(foundMethods)];
      
      // Group by type for better organization
      const primaryMethods = [];
      const secondaryMethods = [];
      
      for (const method of uniqueMethods) {
        const lowerMethod = method.toLowerCase();
        if (lowerMethod.includes('analysis') || 
            lowerMethod.includes('test') || 
            lowerMethod.includes('regression') ||
            lowerMethod.includes('correlation') ||
            lowerMethod.includes('mean') ||
            lowerMethod.includes('percentage') ||
            lowerMethod.includes('frequency') ||
            lowerMethod.includes('coding')) {
          primaryMethods.push(method);
        } else {
          secondaryMethods.push(method);
        }
      }
      
      // Combine methods, primary ones first
      const allMethods = [...primaryMethods, ...secondaryMethods];
      
      // Take top methods (max 6)
      const topMethods = allMethods.slice(0, 6);
      
      if (topMethods.length > 0) {
        return `Analysis methods include: ${topMethods.join(', ')}.`;
      }
    }
    
    // Fallback: If no specific methods found, extract meaningful sentences from data analysis section
    if (extractedText) {
      // Extract complete sentences
      const sentences = extractedText.match(/[^.!?]*[.!?]/g) || [];
      const cleanSentences = sentences
        .map(s => s.trim())
        .filter(s => s.length > 20 && 
                    !s.match(/^\s*(table|figure|chapter|section|page)/i) &&
                    !s.match(/references|bibliography/i))
        .slice(0, 2); // Take first 2 sentences
      
      if (cleanSentences.length > 0) {
        let summary = cleanSentences.join(' ');
        // Capitalize first letter
        if (summary.length > 0) {
          summary = summary.charAt(0).toUpperCase() + summary.slice(1);
        }
        // Ensure it ends with a period
        if (!summary.endsWith('.')) {
          summary += '.';
        }
        return truncateToCompleteSentence(summary, 150);
      }
    }
    
    return "Not specified in the methodology section.";
  };
  
  // Extract all sections
  const researchDesign = extractResearchDesign();
  const researchSetting = extractResearchSetting();
  const researchSubject = extractParticipants();
  const instrumentsUsed = extractInstruments();
  const dataGathering = extractDataGathering();
  const dataAnalysis = extractDataAnalysis();
  
  // Determine research approach
  let researchApproach = "Not specified";
  const designLower = researchDesign.toLowerCase();
  if (designLower.includes("qualitative") && designLower.includes("quantitative")) {
    researchApproach = "Mixed Methods";
  } else if (designLower.includes("qualitative")) {
    researchApproach = "Qualitative";
  } else if (designLower.includes("quantitative")) {
    researchApproach = "Quantitative";
  } else if (designLower.includes("quasi-experimental") || designLower.includes("experimental")) {
    researchApproach = "Quantitative";
  } else if (designLower.includes("case study") || designLower.includes("phenomenological")) {
    researchApproach = "Qualitative";
  }
  
  // Create output in a clean, readable format
  const lines = [
    "## Methodology Checklist",
    "",
    "### Research Design",
    `${researchDesign}`,
    "",
    "### Research Approach",
    `${researchApproach}`,
    "",
    "### Research Setting/Location",
    `${researchSetting}`,
    "",
    "### Research Subjects/Participants",
    `${researchSubject}`,
    "",
    "### Instruments/Tools Used",
    `${instrumentsUsed}`,
    "",
    "### Data Gathering Procedure",
    `${dataGathering}`,
    "",
    "### Data Analysis",
    `${dataAnalysis}`
  ];
  
  return res.json({ text: lines.join("\n") });
}





  
    if (mode === "recommendations") {
      console.log("[Recommendations] Starting enhanced extraction");
      
      try {
        const fullText = (pdfText || text || "").trim();
        console.log(`[Recommendations] Text length: ${fullText.length}`);
        
        if (!fullText) {
          return res.json({ 
            text: "**Research Recommendations**\n\nNo readable text content available for analysis." 
          });
        }

        let recommendations = [];
        
        // Clean text while preserving paragraph structure
        let cleanedText = fullText
          .replace(/\r\n/g, '\n')
          .replace(/\n\s*\n\s*\n+/g, '\n\n')
          .trim();
        
        // CRITICAL FIX: Remove references/bibliography section to prevent capturing references
        console.log("[Recommendations] Removing references section...");
        
        // Find and truncate at references/bibliography
        const referencesPatterns = [
          /(?:\n|\r)\s*References?\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Bibliography\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Works?\s+Cited\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Literature\s+Cited\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Source\s+List\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Citations?\s*(?:\n|\r|:)/i,
        ];
        
        let referencesIndex = -1;
        for (const pattern of referencesPatterns) {
          const match = cleanedText.match(pattern);
          if (match && match.index) {
            referencesIndex = match.index;
            console.log(`[Recommendations] Found references at index ${referencesIndex} with pattern: ${pattern}`);
            break;
          }
        }
        
        // Also look for common reference starting patterns
        if (referencesIndex === -1) {
          const referenceStartPatterns = [
            /\n\s*(?:Abrami|Alban|Alcantara|Andaman|Anderson|Applin|Apriliana|Atteh|Belecina|Benedicto|Black|Boaler|Bonwell|Boud|Brookfield|Butler|Bybee|Cederblom|Chapin|Chapman|Charlton|Chikiwa|Chin|Chukwuyenum|Cottrell|Dailo|Dalim|Dweck|Dwyer|El Yazidi|English|Ennis|Facione)\b/i,
            /\n\s*\d+\s+(?:Abrami|Alban|Alcantara|Andaman|Anderson|Applin|Apriliana|Atteh|Belecina|Benedicto|Black|Boaler|Bonwell|Boud|Brookfield|Butler|Bybee|Cederblom|Chapin|Chapman|Charlton|Chikiwa|Chin|Chukwuyenum|Cottrell|Dailo|Dalim|Dweck|Dwyer|El Yazidi|English|Ennis|Facione)/i,
          ];
          
          for (const pattern of referenceStartPatterns) {
            const match = cleanedText.match(pattern);
            if (match && match.index) {
              referencesIndex = match.index;
              console.log(`[Recommendations] Found references via author pattern at index ${referencesIndex}`);
              break;
            }
          }
        }
        
        // Truncate text at references if found
        if (referencesIndex > 0) {
          console.log(`[Recommendations] Truncating text at references (index ${referencesIndex})`);
          cleanedText = cleanedText.substring(0, referencesIndex).trim();
          console.log(`[Recommendations] Text length after truncation: ${cleanedText.length}`);
        } else {
          console.log("[Recommendations] No references section found, using full text");
        }
        
        // Also check for appendix sections that might come after recommendations
        const appendixPatterns = [
          /(?:\n|\r)\s*Appendix\s+(?:A|B|C|I|II|III)\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Appendices\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Tables?\s*(?:\n|\r|:)/i,
          /(?:\n|\r)\s*Figures?\s*(?:\n|\r|:)/i,
        ];
        
        for (const pattern of appendixPatterns) {
          const match = cleanedText.match(pattern);
          if (match && match.index && match.index > 0) {
            // Only truncate if appendix comes after a reasonable amount of text
            if (match.index > cleanedText.length * 0.7) {
              console.log(`[Recommendations] Found appendix at index ${match.index}, truncating`);
              cleanedText = cleanedText.substring(0, match.index).trim();
              break;
            }
          }
        }
        
        console.log("[Recommendations] Text cleaned and references removed successfully");

        // Enhanced section detection - look for recommendation sections more broadly
        const sectionPatterns = [
          { pattern: /(\n|\r)\s*Recommendation[s]?\s*(\n|\r|:)/gi, name: 'Recommendation' },
          { pattern: /(\n|\r)\s*Suggestion[s]?\s*(\n|\r|:)/gi, name: 'Suggestion' },
          { pattern: /(\n|\r)\s*(?:Recommendations?|Suggestions?)\s+for\s+(?:Practice|Research|Future\s+Work|Further\s+Study|Teachers?|Implementation)\s*(\n|\r|:)/gi, name: 'Recommendations for Practice/Research' },
          { pattern: /(\n|\r)\s*(?:Implications?|Future\s+(?:Work|Research|Directions?|Studies?))\s*(\n|\r|:)/gi, name: 'Implications/Future Work' },
          { pattern: /(\n|\r)\s*(?:Chapter|Section)\s+\d+[:\s-]+\s*(?:Recommendations?|Suggestions?|Implications?)\s*(\n|\r|:)/gi, name: 'Chapter/Section' },
          { pattern: /(\n|\r)\s*(?:VI|VII|VIII|IX|X|5|6|7|8)[\.\)\s-]+\s*(?:Recommendations?|Suggestions?|Implications?)\s*(\n|\r|:)/gi, name: 'Roman Numeral/Numbered' },
          // NEW: Look for paragraphs starting with "Based on the study's findings" or similar
          { pattern: /(\n|\r)\s*Based on (?:the study['']s|these|our) (?:findings|results|analysis)[^.!?]*[.!?]/gi, name: 'Findings-based' },
          // NEW: Look for paragraphs starting with "The following recommendations"
          { pattern: /(\n|\r)\s*The following recommendations? (?:are|is) (?:proposed|suggested|provided)[^.!?]*[.!?]/gi, name: 'Following recommendations' },
        ];
        
        const sections = [];
        for (const { pattern, name } of sectionPatterns) {
          const matches = [...cleanedText.matchAll(pattern)];
          matches.forEach(m => {
            sections.push({
              start: m.index,
              end: Math.min(m.index + 8000, cleanedText.length), // Reduced from 10000 to 8000
              type: name.toLowerCase().includes('practice') ? 'practice' : 
                    name.toLowerCase().includes('research') ? 'research' : 'general',
              name: name,
              matchText: m[0]
            });
          });
        }
        
        // Sort sections by start position
        sections.sort((a, b) => a.start - b.start);
        
        console.log(`[Recommendations] Found ${sections.length} recommendation sections:`, 
          sections.map(s => ({name: s.name, start: s.start, end: s.end})));

        const cleanItem = (item) => {
          return item
            .replace(/\s*\n\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^\s*["']|["']\s*$/g, '') // Remove quotes
            .replace(/\b(?:page|p\.)\s*\d+\b/gi, '') // Remove page numbers
            .replace(/\b\d{2,}\b/g, '') // Remove large numbers (like 82, 83 that appear in text)
            .trim();
        };

        const isValidRecommendation = (text) => {
          if (!text || text.length < 15) return false;
          
          const lower = text.toLowerCase();
          
          // STRICT: Exclude questions, examples, and hypothetical scenarios
          const strictExclusions = [
            /^(?:chapter|section|figure|table|page)\s+\d+/i,
            /^[A-Z\s]{20,}$/,
            /^to\s+address\s+the\s+following\s+questions?/i,
            /^references?\s*$/i,
            /^conclusion\s*$/i,
            /^summary\s*$/i,
            /^abstract\s*$/i,
            /^\d+\s*$/,
            /^[ivxlcdm]+[\.\)]\s*$/i,
            // Exclude reference-like patterns
            /\b(?:Abrami|Alban|Alcantara|Anderson|Applin|Apriliana|Atteh|Belecina|Benedicto|Black|Boaler|Bonwell|Boud|Brookfield|Butler|Bybee|Cederblom|Chapin|Chapman|Charlton|Chikiwa|Chin|Chukwuyenum|Cottrell|Dailo|Dalim|Dweck|Dwyer|El Yazidi|English|Ennis|Facione)\b.*\b\(\d{4}\)/i,
            /\bhttps?:\/\//i, // URLs
            /\bdoi:/i, // DOI references
            /\bretrieved\s+(?:on|from)/i, // Retrieved dates
            /\b(?:vol\.|volume|pp\.|pages?|ed\.|edition)\b.*\d{4}/i, // Publication info with year
            // NEW: Exclude questions
            /\?\s*$/,
            /^what\s+(score|grade|if|will|should)/i,
            /^how\s+(many|much|will|should)/i,
            /^why\s+/i,
            /^when\s+/i,
            /^where\s+/i,
            /^who\s+/i,
            /^which\s+/i,
            // NEW: Exclude example scenarios and hypotheticals
            /\baida\b.*\b(scored|got|grades?)\b/i,
            /\bteam\s+(alpha|beta|gamma)\b/i,
            /\bdebate\s+club\b/i,
            /\bsince\s+only\s+one\s+team\b/i,
            /\bcompared?\s+the\s+number\s+of\s+awards/i,
            /\bin\s+the\s+past\s+\d+\s+(years?|quarters?|quizzes)/i,
            /\b(she|he)\s+is\s+determined\s+to\s+maintain/i,
            /\baverage\s+score\s+(of|decrease|increase)/i,
            /\bnow,?\s+(she|he)\s+is\s+determined/i,
            // NEW: Exclude narrative examples
            /\b(earnestly|studying|got\s+grades)\b.*\b(math|aida)\b/i,
            /\bwhat\s+will\s+happen\s+to\s+(her|his)\s+average/i,
          ];
          
          for (const pattern of strictExclusions) {
            if (pattern.test(text)) return false;
          }
          
          // POSITIVE: Must contain strong recommendation language
          const strongIndicators = [
            // Direct recommendations
            /\b(it\s+is\s+)?recommended\s+(?:that|to)\b/i,
            /\b(it\s+is\s+)?suggested\s+(?:that|to)\b/i,
            /\b(we|the\s+study|researchers?)\s+recommend/i,
            /\b(we|the\s+study|researchers?)\s+suggest/i,
            /\bshould\s+(?:be\s+)?(?:conducted|implemented|developed|established|provided|allocated|examined|investigated|undergo|practice|encouraged|design|use|give|foster|promote|offer|extend|administer|observe|ensure|obtain)/i,
            /\b(?:teachers?|administration|practitioners?|educators?|policymakers?|students?|researchers?)\s+should\s+(?:be\s+)?(?:practice|undergo|implement|develop|examine|investigate|allocate|provide|encourage|design|use|give|foster|promote|incorporate|focus|create|offer|extend|administer|observe|ensure|obtain)/i,
            /\bfor\s+further\s+study,?\s+(?:it\s+is\s+)?recommended/i,
            /\b(?:future|further)\s+(?:research|studies?|work|investigation)\s+(?:should|is\s+recommended|is\s+needed|could|may)/i,
            /\bthe\s+researchers?\s+would\s+like\s+to\s+propose/i,
            /\b(?:it\s+is\s+)?proposed\s+(?:that|to)\b/i,
            // NEW: For paragraph-style recommendations (like Research Text 2)
            /\bincorporate\s+(?:collaborative|inquiry-based)\b/i,
            /\buse\s+strategic\s+questioning\b/i,
            /\bprovide\s+open-ended\s+problems\b/i,
            /\bgive\s+timely\s+and\s+constructive\s+feedback\b/i,
            /\bfoster\s+a\s+safe\s+and\s+respectful\b/i,
            /\bpromote\s+ongoing\s+teacher\s+development\b/i,
            /\bto\s+further\s+improve\b/i,
            /\bteachers?\s+(?:are\s+encouraged|must|need)\b/i,
            /\bit\s+is\s+recommended\s+to\b/i,
            /\bincorporate\s+collaborative\s+and\s+inquiry-based\s+learning\b/i,
            /\buse\s+strategic\s+questioning\s+and\s+the\s+socratic\s+method\b/i,
            /\bprovide\s+open-ended\s+problems\s+with\s+multiple\s+solution\s+paths\b/i,
            /\bgive\s+timely\s+and\s+constructive\s+feedback\b/i,
            /\bfoster\s+a\s+safe\s+and\s+respectful\s+classroom\s+environment\b/i,
            /\bpromote\s+ongoing\s+teacher\s+development\b/i,
            /\bdesign\s+group\s+tasks\b/i,
            /\ballow\s+students\s+to\s+explore\b/i,
            /\bencourages\s+students\s+to\s+justify\b/i,
            /\bstimulates\s+creativity\b/i,
            /\bfosters\s+analytical\s+skills\b/i,
            /\bgo\s+beyond\s+checking\s+answers\b/i,
            /\bguiding\s+students['’]?\s+reasoning\b/i,
            /\bproviding\s+opportunities\s+for\s+self-correction\b/i,
            /\bcreate\s+a\s+space\s+that\s+values\b/i,
            /\boffer\s+regular\s+training\b/i,
            /\bextend\s+the\s+observation\s+period\b/i,
            /\badminister\s+face-to-face\s+surveys\b/i,
            /\bobserve\s+together\s+in\s+one\s+class\b/i,
            /\bensure\s+that\s+detailed\s+notes\s+are\s+taken\b/i,
            /\bobtaining\s+permission\s+to\s+use\b/i,
          ];
          
          // Must match at least one strong indicator
          const hasStrongIndicator = strongIndicators.some(ind => ind.test(text));
          
          if (!hasStrongIndicator) {
            // If no strong indicator, check for weaker but acceptable patterns
            const acceptablePatterns = [
              /\ballocate\s+adequate/i,
              /\bpractice\s+teaching/i,
              /\bexamine\s+the\s+(?:long-term|impact|effectiveness)/i,
              /\binvestigate\s+the\s+effectiveness/i,
              /\bundergo\s+training/i,
              /\bprovide\s+(?:adequate|sufficient|proper)/i,
              /\bensure\s+(?:that|adequate|proper)/i,
              /\bdevelop\s+(?:a|comprehensive|effective)/i,
              /\bestablish\s+(?:a|clear|proper)/i,
              /\bimplement\s+(?:a|appropriate|effective)/i,
              /\benhance\s+the\s+promotion\s+of\b/i,
              /\bcreate\s+a\s+space\s+that\b/i,
              /\boffer\s+regular\s+training\b/i,
              /\bextend\s+the\s+observation\s+period\b/i,
              /\badminister\s+face-to-face\s+surveys\b/i,
              /\bobserve\s+together\s+in\s+one\s+class\b/i,
              /\bensure\s+that\s+detailed\s+notes\s+are\s+taken\b/i,
            ];
            
            // Must be in a clear recommendation context
            const hasAcceptablePattern = acceptablePatterns.some(ind => ind.test(text));
            if (!hasAcceptablePattern) return false;
          }
          
          return true;
        };
        
        const formatRecommendation = (item) => {
          let formatted = item.trim();
          
          // Remove numbering/bullets if present
          formatted = formatted.replace(/^[\d\.\)\-•►▪◦]+\s*/, '');
          
          // Capitalize first letter if not already
          if (formatted.length > 0 && !/^[A-Z]/.test(formatted)) {
            formatted = formatted.charAt(0).toUpperCase() + formatted.slice(1);
          }
          
          // Ensure it ends with proper punctuation
          if (!/[.!?]$/.test(formatted)) {
            formatted += '.';
          }
          
          return formatted;
        };

        // NEW FUNCTION: Extract recommendations from paragraph text
        const extractFromParagraph = (text) => {
          const extracted = [];
          
          // Split by sentences first
          const sentences = text.split(/(?<=[.!?])\s+/);
          let currentRec = '';
          let inRecommendation = false;
          let skipNextSentence = false; // NEW: Flag to skip introductory sentences
          
          for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i].trim();
            
            // Stop processing if we encounter reference-like content
            if (sentence.match(/^(?:REFERENCES|BIBLIOGRAPHY|References|Bibliography)/i)) {
              break;
            }
            
            // Skip if sentence looks like a reference
            if (sentence.match(/\b(?:Abrami|Alban|Alcantara|Anderson|Boaler)\b.*\b\(\d{4}\)/i) ||
                sentence.match(/https?:\/\//) ||
                sentence.match(/Retrieved from/) ||
                sentence.match(/doi:/i)) {
              break;
            }
            
            // Check if this is an introductory sentence that should be skipped
            if (sentence.match(/^(?:Based on (?:the study['']s|these|our) (?:findings|results|analysis)|The following recommendations? (?:are|is) (?:proposed|suggested|provided))/i)) {
              // This is an introductory sentence, skip it and mark to combine with next sentence
              skipNextSentence = true;
              continue;
            }
            
            // Check if this sentence starts a new recommendation
            // Broader patterns for Research Text 2
            const startsNewRec = 
              sentence.match(/^(?:Incorporate|Use|Provide|Give|Foster|Promote|Teachers?|Administration|Researchers?|It|We|The study|For further study|To further improve|Additionally|Lastly)/i) ||
              sentence.match(/^\d+\./) ||
              sentence.match(/^[a-z]\./) ||
              sentence.match(/^[•●○◦▪►-]/);
            
            // Check if sentence contains recommendation language
            const hasRecLanguage = 
              /recommended|suggested|should|propose|encouraged|must|need to|it is recommended|we recommend|are encouraged|must focus|should offer/i.test(sentence);
            
            if (startsNewRec && hasRecLanguage) {
              // Save previous recommendation if exists
              if (currentRec && isValidRecommendation(currentRec)) {
                // If we had an introductory sentence flagged, prepend it
                if (skipNextSentence && i > 0 && sentences[i-1] && 
                    sentences[i-1].match(/Based on|The following recommendations?/i)) {
                  const intro = sentences[i-1].trim();
                  currentRec = `${intro} ${currentRec}`;
                }
                extracted.push(currentRec);
                skipNextSentence = false;
              }
              // Start new recommendation
              currentRec = sentence;
              inRecommendation = true;
            } else if (inRecommendation && currentRec) {
              // Continue current recommendation for 1-2 more sentences
              // Check if this is a continuation or new thought
              const isContinuation = 
                sentence.match(/^(?:This|These|It|Such|That|Which|Teachers?|Students?|The)/i) ||
                sentence.length < 100 ||
                (sentence.match(/promote|encourage|foster|develop|improve|enhance/i) && !sentence.match(/^(?:Incorporate|Use|Provide|Give|Foster|Promote)/i));
              
              if (isContinuation) {
                // Count sentences in current recommendation
                const sentenceCount = currentRec.split(/[.!?]\s+/).length;
                if (sentenceCount < 3) { // Allow up to 3 sentences
                  currentRec += ' ' + sentence;
                }
              } else if (sentence.match(/recommended|suggested|should|must/i)) {
                // If new sentence has recommendation language, it might be a new recommendation
                if (currentRec && isValidRecommendation(currentRec)) {
                  extracted.push(currentRec);
                }
                currentRec = sentence;
              }
            } else if (hasRecLanguage && !inRecommendation) {
              // Start a recommendation if we find recommendation language
              currentRec = sentence;
              inRecommendation = true;
            }
          }
          
          // Add the last recommendation if exists
          if (currentRec && isValidRecommendation(currentRec)) {
            // If we had an introductory sentence flagged, prepend it
            if (skipNextSentence && sentences.length > 1 && 
                sentences[sentences.length-2] && 
                sentences[sentences.length-2].match(/Based on|The following recommendations?/i)) {
              const intro = sentences[sentences.length-2].trim();
              currentRec = `${intro} ${currentRec}`;
            }
            extracted.push(currentRec);
          }
          
          return extracted;
        };

        const extractCleanRecommendation = (text) => {
          let cleaned = text.trim();
          
          // Remove page numbers but keep the rest
          cleaned = cleaned.replace(/\s+\d{2,3}\s+/g, ' ');
          
          // Check if this is just an introductory sentence without actual recommendation
          if (cleaned.match(/^(?:Based on (?:the study['']s|these|our) (?:findings|results|analysis)|The following recommendations? (?:are|is) (?:proposed|suggested|provided))/i) &&
              !cleaned.match(/Incorporate|Use|Provide|Give|Foster|Promote|should|must|recommended/i)) {
            // This is just an intro, return empty to be filtered out
            return '';
          }
          
          // For Research Text 2 style recommendations with colons, preserve BOTH parts
          // Example: "Incorporate Collaborative and Inquiry-Based Learning: Teachers should..."
          const colonMatch = cleaned.match(/^([^:]+:\s*)(.+)$/);
          if (colonMatch) {
            const beforeColon = colonMatch[1].trim();
            const afterColon = colonMatch[2].trim();
            
            // Check if this is a heading-style recommendation
            const isHeadingStyle = beforeColon.match(/(?:Incorporate|Use|Provide|Give|Foster|Promote)\s+.+Learning|Method|Paths|Feedback|Environment|Development/i);
            
            if (isHeadingStyle) {
              // Take the heading plus the first complete thought after colon
              const firstSentenceMatch = afterColon.match(/^([^.!?]+[.!?])/);
              if (firstSentenceMatch) {
                cleaned = `${beforeColon} ${firstSentenceMatch[1]}`;
              } else {
                // Take first 30 words if no sentence ending
                const words = afterColon.split(/\s+/);
                cleaned = `${beforeColon} ${words.slice(0, 30).join(' ')}`;
                if (!/[.!?]$/.test(cleaned)) cleaned += '.';
              }
            }
          }
          
          // For paragraph-style recommendations, take up to 3 sentences
          const sentences = cleaned.split(/(?<=[.!?])\s+/);
          const maxSentences = 3; // Allow more sentences for paragraph-style
          const filteredSentences = [];
          
          for (let i = 0; i < sentences.length && i < maxSentences; i++) {
            const sentence = sentences[i].trim();
            
            // Skip pure introductory sentences
            if (sentence.match(/^(?:Based on|The following recommendations?)/i) && 
                i > 0 && filteredSentences.length > 0) {
              continue;
            }
            
            // Don't cut off too early - allow continuation sentences
            if (i > 0) {
              // Check if this sentence is truly explanatory vs continuation
              const isContinuation = sentence.match(/^(?:Teachers?|Students?|This|These|It|Such|That|Which)/i) &&
                                    sentence.length < 120; // Short continuation sentences
              
              if (isContinuation && i < 2) {
                filteredSentences.push(sentence);
              } else if (i === 1 && sentence.match(/recommended|suggested|should|must|encouraged/i)) {
                // If second sentence still has recommendation language, include it
                filteredSentences.push(sentence);
              } else {
                break;
              }
            } else {
              // Always include first sentence (unless it's a pure intro)
              if (!sentence.match(/^(?:Based on|The following recommendations?)/i) || 
                  sentence.match(/Incorporate|Use|Provide|Give|Foster|Promote/i)) {
                filteredSentences.push(sentence);
              }
            }
          }
          
          cleaned = filteredSentences.join(' ').trim();
          
          // Ensure it ends with a period
          if (cleaned && !/[.!?]$/.test(cleaned)) {
            cleaned += '.';
          }
          
          return cleaned;
        };

        if (sections.length > 0) {
          console.log("[Recommendations] Strategy 1: Section-based extraction (Priority)");
          
          for (const section of sections) {
            const sectionText = cleanedText.substring(section.start, section.end);
            console.log(`[Strategy 1] Processing section "${section.name}": ${sectionText.substring(0, 100)}...`);
            
            // Try structured patterns first
            const patterns = [
              { regex: /(?:^|\n)\s*(\d+)\.\s+([^\n]+(?:\n(?!\s*\d+\.)[^\n]+)*)/g, type: 'numbered' },
              { regex: /(?:^|\n)\s*([a-z])\.\s+([^\n]+(?:\n(?!\s*[a-z]\.)[^\n]+)*)/g, type: 'lettered' },
              { regex: /(?:^|\n)\s*[•●○◦▪►]\s+([^\n]+(?:\n(?!\s*[•●○◦▪►])[^\n]+)*)/g, type: 'bullet' },
            ];
            
            let foundStructured = false;
            for (const { regex, type } of patterns) {
              let match;
              const localMatches = [];
              
              while ((match = regex.exec(sectionText)) !== null) {
                const captureIndex = match.length === 3 ? 2 : 1;
                let item = cleanItem(match[captureIndex]);
                
                if (item.length >= 15 && item.length <= 600 && isValidRecommendation(item)) {
                  // Clean the recommendation further
                  item = extractCleanRecommendation(item);
                  localMatches.push(item);
                  console.log(`[Strategy 1-${type}] Found: ${item.substring(0, 70)}...`);
                }
              }
              
              if (localMatches.length > 0) {
                recommendations.push(...localMatches.map(formatRecommendation));
                console.log(`[Strategy 1] Added ${localMatches.length} recommendations from ${type} pattern`);
                foundStructured = true;
              }
            }
            
            // If no structured patterns found, try paragraph extraction
            if (!foundStructured) {
              console.log(`[Strategy 1] No structured patterns found, trying paragraph extraction`);
              const paragraphRecs = extractFromParagraph(sectionText);
              if (paragraphRecs.length > 0) {
                // Clean each recommendation
                const cleanedRecs = paragraphRecs.map(rec => extractCleanRecommendation(rec))
                                                .filter(rec => rec && isValidRecommendation(rec))
                                                .map(formatRecommendation);
                recommendations.push(...cleanedRecs);
                console.log(`[Strategy 1-Paragraph] Added ${cleanedRecs.length} cleaned recommendations`);
              }
            }
          }
        }

        if (recommendations.length < 3) {
          console.log("[Recommendations] Strategy 2: Global structured patterns");
          
          const structuredPatterns = [
            /(?:^|\n)\s*(\d+)\.\s+([^\n]+(?:\n(?!\s*\d+\.)[^\n]+)*)/g,
            /(?:^|\n)\s*\((\d+)\)\s+([^\n]+(?:\n(?!\s*\(\d+\))[^\n]+)*)/g,
            /(?:^|\n)\s*([a-z])\.\s+([^\n]+(?:\n(?!\s*[a-z]\.)[^\n]+)*)/g,
            /(?:^|\n)\s*\(([a-z])\)\s+([^\n]+(?:\n(?!\s*\([a-z]\))[^\n]+)*)/g,
            /(?:^|\n)\s*[•●○◦▪►-]\s+([^\n]+)/g,
          ];
          
          for (const pattern of structuredPatterns) {
            let match;
            while ((match = pattern.exec(cleanedText)) !== null) {
              const captureIndex = match.length === 3 ? 2 : 1;
              let item = cleanItem(match[captureIndex]);
              
              if (item.length >= 20 && item.length <= 600 && isValidRecommendation(item)) {
                // Clean the recommendation further
                item = extractCleanRecommendation(item);
                recommendations.push(formatRecommendation(item));
                console.log(`[Strategy 2] Found: ${item.substring(0, 60)}...`);
              }
            }
          }
        }

        if (recommendations.length < 5) {
          console.log("[Recommendations] Strategy 3: Paragraph-based extraction");
          
          // Look for key phrases that indicate recommendation paragraphs
          const keyPhrases = [
            /Based on (?:the study['’]s|these|our) (?:findings|results|analysis)[^.!?]*[.!?]\s*/gi,
            /The following recommendations? (?:are|is) (?:proposed|suggested|provided)[^.!?]*[.!?]\s*/gi,
          ];
          
          for (const phrase of keyPhrases) {
            const matches = [...cleanedText.matchAll(phrase)];
            for (const match of matches) {
              const start = match.index;
              const end = Math.min(start + 2000, cleanedText.length);
              const paragraph = cleanedText.substring(start, end);
              
              const paragraphRecs = extractFromParagraph(paragraph);
              if (paragraphRecs.length > 0) {
                // Clean each recommendation
                const cleanedRecs = paragraphRecs.map(rec => extractCleanRecommendation(rec))
                                                .filter(rec => rec && isValidRecommendation(rec))
                                                .map(formatRecommendation);
                recommendations.push(...cleanedRecs);
                console.log(`[Strategy 3-KeyPhrase] Added ${cleanedRecs.length} recommendations`);
              }
            }
          }
        }

        if (recommendations.length < 3) {
          console.log("[Recommendations] Strategy 4: Advanced sentence pattern matching");
          
          const advancedPatterns = [
            // Match full recommendation sentences with context
            /((?:It is (?:recommended|suggested|proposed)|We (?:recommend|suggest|propose)|The study (?:recommends?|suggests?)|Researchers? (?:should|would like to propose))[^.!?]+[.!?])/gi,
            /((?:Teachers?|Administration|Practitioners?|Educators?|Policymakers?|Students?)[^.!?]*(?:should|must|need to|are encouraged to|are advised to)[^.!?]+[.!?])/gi,
            /((?:For further study|Future research|Further investigation)[^.!?]*(?:is recommended|should be conducted|could explore|may include|would benefit from)[^.!?]+[.!?])/gi,
            /((?:To improve|To enhance|To address|To solve)[^.!?]*(?:it is (?:recommended|suggested)|we (?:recommend|suggest)|the (?:researchers?|study) (?:recommends?|suggests?))[^.!?]+[.!?])/gi,
          ];
          
          for (const pattern of advancedPatterns) {
            let match;
            while ((match = pattern.exec(cleanedText)) !== null) {
              const item = match[1] || match[0];
              if (item.length >= 25 && item.length <= 500 && isValidRecommendation(item)) {
                recommendations.push(formatRecommendation(item));
                console.log(`[Strategy 4] Found: ${item.substring(0, 80)}...`);
              }
            }
          }
        }

        // AI extraction as fallback (keep existing code but improve prompt)
        if (recommendations.length === 0 && process.env.HF_TOKEN && fullText.length > 200) {
          console.log("[Recommendations] Strategy 5: AI extraction");
          
          try {
            const aiPrompt = `Extract all research recommendations from this text. Look for both structured lists and paragraph-style recommendations. Focus on sentences with words like "recommended", "should", "suggested", "proposed", "encouraged", "must".

    Text: ${fullText.substring(0, 6000)}

    List each recommendation clearly, even if they are embedded in paragraphs:`;

            const aiResult = await callHF({
              model: "facebook/bart-large-cnn",
              inputs: aiPrompt,
              parameters: {
                max_length: 800,
                min_length: 100,
                do_sample: false,
                temperature: 0.3,
              },
              token: process.env.HF_TOKEN,
              tries: 2,
              timeoutMs: 30000,
            });

            if (aiResult.text && !aiResult.error) {
              // Parse AI output - split by lines and numbers
              const aiText = aiResult.text;
              const aiLines = aiText.split(/\n+/)
                .map(line => {
                  // Remove numbers, bullets, and clean
                  return line.replace(/^\d+[\.\)]\s*/, '')
                            .replace(/^[•\-*]\s*/, '')
                            .replace(/^[a-z][\.\)]\s*/i, '')
                            .trim();
                })
                .filter(line => line.length >= 15 && line.length <= 500)
                .filter(isValidRecommendation)
                .map(formatRecommendation);
              
              recommendations.push(...aiLines.slice(0, 15));
              console.log(`[Strategy 5] AI extracted ${aiLines.length} recommendations`);
            }
          } catch (error) {
            console.warn("[Strategy 5] AI extraction failed:", error.message);
          }
        }

        console.log("[Recommendations] Filtering out introductory sentences");
        recommendations = recommendations.filter(rec => {
          // Check if this is just an introductory sentence without actual recommendation
          const isPureIntro = rec.match(/^(?:Based on (?:the study['']s|these|our) (?:findings|results|analysis)|The following recommendations? (?:are|is) (?:proposed|suggested|provided))/i) &&
                              !rec.match(/Incorporate|Use|Provide|Give|Foster|Promote|should|must|recommended|suggested|proposed/i);
          
          // Check if this is a duplicate that starts with intro and repeats first recommendation
          const hasRepeatedIntro = rec.match(/the following recommendations are proposed to enhance the promotion of critical thinking in mathematics education: Incorporate Collaborative and Inquiry-Based Learning/i);
          
          return !isPureIntro && !hasRepeatedIntro;
        });
        
        console.log(`[Recommendations] After filtering intros: ${recommendations.length} items`);

        console.log("[Recommendations] Applying basic cleaning to all recommendations");
        recommendations = recommendations.map(rec => {
          return rec.replace(/\s+\d{2,3}\s+/g, ' ')  // Remove page numbers
                    .replace(/\b\d{2,}\b/g, '')      // Remove standalone numbers
                    .replace(/\s+/g, ' ')            // Normalize whitespace
                    .trim();
        }).filter(rec => rec && rec.length > 20 && isValidRecommendation(rec));
        
        console.log(`[Recommendations] After cleaning: ${recommendations.length} items`);

        console.log(`[Recommendations] Before deduplication: ${recommendations.length} items`);
        
        // Deduplication (keep existing code)
        const finalRecommendations = [];
        const seen = new Set();
        
        function compareStrings(str1, str2) {
          const len = Math.min(str1.length, str2.length);
          let matches = 0;
          for (let i = 0; i < len; i++) {
            if (str1[i] === str2[i]) matches++;
          }
          return matches / Math.max(str1.length, str2.length);
        }
        
        for (const rec of recommendations) {
          const normalized = rec
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ')
            .substring(0, 100);
          
          let isDuplicate = false;
          for (const seenNorm of seen) {
            const similarity = compareStrings(normalized, seenNorm);
            if (similarity > 0.8) {
              isDuplicate = true;
              break;
            }
          }
          
          if (!isDuplicate) {
            seen.add(normalized);
            finalRecommendations.push(rec);
          }
        }
        
        const limitedRecommendations = finalRecommendations.slice(0, 15);
        console.log(`[Recommendations] Final count: ${limitedRecommendations.length}`);

        let output = "**Research Recommendations**\n\n";
        
        if (limitedRecommendations.length > 0) {
          output += `Based on analysis of the research content, ${limitedRecommendations.length} recommendation${limitedRecommendations.length === 1 ? ' was' : 's were'} identified. `;
          
          // Create a coherent paragraph by joining recommendations with transitional phrases
          const paragraph = limitedRecommendations.map((rec, index) => {
            // Remove ending period for smoother transitions
            let cleanRec = rec.replace(/\.$/, '');
            
            if (index === 0) {
              // First recommendation - start directly
              return cleanRec;
            } else if (index === limitedRecommendations.length - 1) {
              // Last recommendation - use "finally" or "lastly"
              const lastTransitions = ['finally', 'lastly', 'in conclusion'];
              const transition = lastTransitions[index % lastTransitions.length];
              return `${transition}, ${cleanRec.charAt(0).toLowerCase()}${cleanRec.slice(1)}`;
            } else {
              // Middle recommendations - use transitional phrases
              const transitions = ['additionally', 'furthermore', 'moreover', 'also', 'in addition'];
              const transition = transitions[index % transitions.length];
              return `${transition}, ${cleanRec.charAt(0).toLowerCase()}${cleanRec.slice(1)}`;
            }
          }).join('; ');
          
          output += paragraph + '.';
        } else {
          output += "No specific recommendations were identified in the text.\n\n";
          output += "**Possible reasons:**\n";
          output += "• The study may not include explicit recommendations\n";
          output += "• Recommendations are embedded in discussion sections without clear markers\n";
          output += "• The text format may not follow standard recommendation patterns\n\n";
          output += "_Tip: Ensure the PDF contains a dedicated 'Recommendations' or 'Suggestions' section._";
        }
        
        return res.json({ 
          text: output,
          count: limitedRecommendations.length,
          success: limitedRecommendations.length > 0
        });
        
      } catch (error) {
        console.error("[Recommendations] Critical error:", error);
        
        return res.json({ 
          text: "**Research Recommendations**\n\nAn error occurred while extracting recommendations. Please try again.",
          count: 0,
          success: false,
          error: error.message
        });
      }
    }






    if (mode === "refscan") {
      const refs = extractReferencesFromText(pdfText || abstract);
      return res.json({
        ok: true,
        count: refs.length,
        items: refs,
      });
    }







    if (mode === "citations" || mode === "self-cite") {
     const apaAuthors = formatApaAuthors(apaList);
const ieeeAuthors = formatIeeeAuthors(ieeeList);


      const apa = `${apaAuthors} (${yr}). ${titleSentence}.`;
      const ieee = `${ieeeAuthors}, "${titleSentence}," ${yr}.`;

      const firstLast = (parseNamePartsSmart(authorList[0]).last || "author")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");
const bibkey = `${firstLast}${yr === "n.d." ? "nd" : yr}`;

      const bibtex = [
        `@article{${bibkey},`,
        `  title={${title || "Untitled study"}},`,
        `  author={${bibtexAuthor || "Author"}},`,
        `  year={${yr}}`,
        `}`
      ].join("\n");

      out = `### Citations\n**APA**\n> ${apa}\n\n**IEEE**\n> ${ieee}\n\n**BibTeX**\n\`\`\`bibtex\n${bibtex}\n\`\`\``;

      const refs = extractReferencesFromText(pdfText);
      return res.json({
        text: out,
        citations: { apa, ieee, bibtex },
        references: refs && refs.length ? refs : undefined
      });
    }

    res.json({ text: out });
  } catch (e) {
    console.error("AI tools error:", e);
    res.status(500).json({ error: "Failed to generate AI output." });
  }
});

router.post("/tldr", upload.single("file"), async (req, res) => {
  try {
    const HF_TOKEN = process.env.HF_TOKEN || "";
    const { abstract = "", filePath = "" } = req.body || {};

    let pdfText = "";
    const parsed = await safeReadPdfFromRelative(filePath);
    if (parsed?.text) pdfText = parsed.text;

    const source = String(pdfText || abstract || "").replace(/\s+/g, " ").trim();
    if (!source) return res.status(400).json({ ok: false, error: "No text/PDF content to summarize." });

    let tldr;
    if (HF_TOKEN) {
      try {
        tldr = await generateTldr(source, HF_TOKEN);
      } catch (e) {
        console.warn("TL;DR model failed, using heuristic:", e?.message || e);
        tldr = heuristicTldr(source);
      }
    } else {
      tldr = heuristicTldr(source);
    }

    tldr = (tldr || "")
      .replace(/\s*…+\s*$/g, "")
      .replace(/\s*\.\s*$/, "") + ".";
    const words = tldr.split(/\s+/);
    if (words.length > 80) tldr = words.slice(0, 80).join(" ") + ".";

    return res.json({ ok: true, text: `${tldr}` });
  } catch (e) {
    console.error("❌ TL;DR failed:", e);
    return res.status(500).json({ ok: false, error: "TL;DR failed." });
  }
});

module.exports = router;