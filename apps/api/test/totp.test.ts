import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, totpAt, verifyTotp } from "../src/lib/totp.js";

describe("TOTP (RFC 6238)", () => {
  // Testvector uit RFC 6238 bijlage B: geheim "12345678901234567890", SHA-1, 8 cijfers -> wij gebruiken de laatste 6.
  const secret = base32Encode(Buffer.from("12345678901234567890"));

  it("komt overeen met de RFC-testvectoren", () => {
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe("005924");
  });

  it("base32 is omkeerbaar", () => {
    const buf = Buffer.from("willekeurige bytes \u0000ÿ");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("accepteert ±1 stap en weigert verder", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step + 3), now)).toBeNull();
    expect(verifyTotp(secret, "abc", now)).toBeNull();
  });
});
