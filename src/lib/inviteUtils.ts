import { randomBytes } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid confusing chars

export function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

export function generateInviteCode(): string {
  const chars = [] as string[];
  for (let i = 0; i < 8; i += 1) {
    const index = Math.floor(Math.random() * CODE_ALPHABET.length);
    chars.push(CODE_ALPHABET[index]);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
