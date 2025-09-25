import fetch from "node-fetch";

const ENDPOINT = process.env.OCR_URL || "http://localhost:3000/api/ocr";
const TOKEN = process.env.ID_TOKEN;
const GCS_URI = process.env.GCS_URI;
const MODE = process.env.OCR_MODE || "document";

if (!TOKEN || !GCS_URI) {
  throw new Error("Set ID_TOKEN and GCS_URI in env");
}

const payload = {
  gsUri: GCS_URI,
  mode: MODE,
};

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify(payload),
});

const body = await res.text();
console.log(res.status, body);
